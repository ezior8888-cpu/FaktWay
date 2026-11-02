import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P3 (PLAN-FINORA §5): kolumna „Do zapłaty” i ikona płatności na liście
 * faktur tylko dla faktur spełniających §2.4 pkt 11 (bez warunku statusu
 * płatności). Szkice, importy, korekty, waluta obca, inne środowisko
 * i faktury z dziećmi dostają „—”, chyba że są zapłacone: wpłata to fakt
 * (00158). Predykat jest TEN SAM co w `getReceivables` — lista nie ma drugiej
 * kopii warunków. Link „Korekta” tylko dla faktur, które przyjmuje formularz
 * korekty. „Zapłacone” dla każdej przyjętej sprzedaży z resztą do zapłaty.
 */

const env = vi.hoisted(() => ({ value: 'production' as string }));
vi.mock('@/lib/ksef/claim-environment', () => ({
  requireConfiguredKsefEnvironment: () => env.value,
}));

import { getReceivables } from '@/lib/dashboard/receivables';
import {
  canCorrectInvoice,
  canMarkInvoicePaid,
  LIST_ROW_FACT_COLUMNS,
  loadInvoiceListRowFacts,
  paymentFactsOf,
  type ListRowFactsRow,
} from '@/lib/invoices/list-row-facts';
import type { PageContext } from '@/lib/supabase/page-context';

type Row = Record<string, unknown>;
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-10-17T10:00:00Z');

let seq = 0;
function invoice(overrides: Row = {}): Row {
  seq += 1;
  return {
    id: `inv-${String(seq).padStart(5, '0')}`,
    tenant_id: TENANT,
    internal_number: `FV/${seq}/10/2026`,
    buyer_data: { name: `Nabywca ${seq}` },
    direction: 'outgoing',
    origin: 'app',
    ksef_status: 'accepted',
    ksef_environment: 'production',
    ksef_number: `1234567890-20261017-${String(seq).padStart(6, '0')}-AA`,
    invoice_kind: 'regular',
    invoice_type: 'VAT',
    currency: 'PLN',
    gross_total: 1000,
    paid_amount: 0,
    payment_data: null,
    payment_due_date: '2026-10-30',
    payment_status: 'unpaid',
    parent_invoice_id: null,
    advance_invoice_ids: [],
    ...overrides,
  };
}

interface ClientOptions {
  serverCap?: number;
  withholdCount?: boolean;
  failOn?: (filters: ReadonlyArray<[string, string, unknown]>) => boolean;
}

/** Klient w pamięci: filtry PostgREST użyte przez moduł, liczenie `exact`, strony. */
function client(rows: Row[], options: ClientOptions = {}) {
  const log: Array<{ table: string; filters: Array<[string, string, unknown]>; columns: string }> = [];
  return {
    log,
    from(table: string) {
      const filters: Array<[string, string, unknown]> = [];
      const predicates: Array<(row: Row) => boolean> = [];
      const ordering: string[] = [];
      let columns = '';
      let countRequested = false;
      let head = false;
      let range: [number, number] | null = null;
      const add = (op: string, column: string, value: unknown, fn: (row: Row) => boolean) => {
        filters.push([op, column, value]);
        predicates.push(fn);
        return builder;
      };
      const builder = {
        select: (cols: string, opts?: { count?: string; head?: boolean }) => {
          columns = cols;
          countRequested = opts?.count === 'exact';
          head = opts?.head === true;
          return builder;
        },
        eq: (c: string, v: unknown) => add('eq', c, v, (r) => r[c] === v),
        neq: (c: string, v: unknown) => add('neq', c, v, (r) => r[c] !== v),
        gt: (c: string, v: number) => add('gt', c, v, (r) => Number(r[c]) > v),
        gte: (c: string, v: string) => add('gte', c, v, (r) => r[c] !== null && String(r[c]) >= v),
        lt: (c: string, v: string) => add('lt', c, v, (r) => r[c] !== null && String(r[c]) < v),
        in: (c: string, v: unknown[]) => add('in', c, v, (r) => v.includes(r[c])),
        is: (c: string, v: null) => add('is', c, v, (r) => r[c] === v),
        not: (c: string, op: string, v: unknown) => add(`not.${op}`, c, v, (r) => {
          if (op === 'is' && v === null) return r[c] !== null && r[c] !== undefined;
          if (op === 'eq' && v === '{}') return Array.isArray(r[c]) && (r[c] as unknown[]).length > 0;
          throw new Error(`unsupported not.${op}`);
        }),
        overlaps: (c: string, v: string[]) => add('overlaps', c, v, (r) =>
          Array.isArray(r[c]) && (r[c] as string[]).some((x) => v.includes(x))),
        order: (c: string) => { ordering.push(c); return builder; },
        range: (from: number, to: number) => { range = [from, to]; return builder; },
        then<T, E = never>(
          resolve?: ((value: { data: Row[] | null; count: number | null; error: { message: string } | null }) => T | PromiseLike<T>) | null,
          reject?: ((reason: unknown) => E | PromiseLike<E>) | null,
        ) {
          log.push({ table, filters: [...filters], columns });
          if (options.failOn?.(filters)) {
            return Promise.resolve({ data: null, count: null, error: { message: 'boom' } }).then(resolve, reject);
          }
          const source = table === 'invoices' ? rows : [];
          const matching = source.filter((r) => predicates.every((p) => p(r)));
          matching.sort((a, b) => {
            for (const c of ordering) {
              const cmp = String(a[c] ?? '').localeCompare(String(b[c] ?? ''));
              if (cmp !== 0) return cmp;
            }
            return 0;
          });
          const start = range?.[0] ?? 0;
          const wanted = range ? range[1] - range[0] + 1 : matching.length;
          const data = head ? null : matching.slice(start, start + Math.min(wanted, options.serverCap ?? Infinity));
          const count = countRequested && !options.withholdCount ? matching.length : null;
          return Promise.resolve({ data: head ? null : data, count, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}


type Supabase = PageContext['supabase'];
const asRow = (r: Row) => r as unknown as ListRowFactsRow;

async function facts(all: Row[], page: Row[] = all, options: ClientOptions = {}, now: Date = NOW) {
  const c = client(all, options);
  const map = await loadInvoiceListRowFacts(c as unknown as Supabase, TENANT, page.map(asRow), now);
  return { c, map };
}

beforeEach(() => {
  env.value = 'production';
  seq = 0;
});

describe('kolumna „Do zapłaty” — „—” dla faktur spoza §2.4 pkt 11', () => {
  it.each([
    ['szkic', { ksef_status: 'draft', ksef_environment: null, ksef_number: null }],
    ['import z KSeF', { origin: 'ksef_import' }],
    ['import z pliku', { origin: 'file_import' }],
    ['korekta', { invoice_kind: 'correction', invoice_type: 'KOR', gross_total: -100 }],
    ['faktura w EUR', { currency: 'EUR' }],
    ['inne środowisko', { ksef_environment: 'test' }],
    ['przyjęta bez środowiska', { ksef_environment: null }],
  ])('%s → payment i outstanding null', async (_label, overrides) => {
    const row = invoice(overrides);
    const { map } = await facts([row]);
    expect(map.get(row.id as string)).toMatchObject({ payment: null, outstanding: null });
  });

  it('oryginał z korektą (nawet odrzuconą) → null', async () => {
    const original = invoice();
    const correction = invoice({ invoice_kind: 'correction', invoice_type: 'KOR', parent_invoice_id: original.id, ksef_status: 'rejected' });
    const { map } = await facts([original, correction], [original]);
    expect(map.get(original.id as string)).toMatchObject({ payment: null, outstanding: null });
  });

  it('zaliczka (ZAL) z fakturą rozliczeniową (ROZ) → null', async () => {
    const zal = invoice({ invoice_kind: 'advance', invoice_type: 'ZAL' });
    const roz = invoice({ invoice_kind: 'final', invoice_type: 'ROZ', gross_total: 4000, advance_invoice_ids: [zal.id], payment_data: { amountDue: 3000 } });
    const { map } = await facts([zal, roz]);
    expect(map.get(zal.id as string)).toMatchObject({ payment: null, outstanding: null });
    expect(map.get(roz.id as string)).toMatchObject({ payment: 'unpaid', outstanding: 3000 });
  });

  it('dziecko z innej firmy nie zmienia wiersza', async () => {
    const original = invoice();
    const foreign = invoice({ tenant_id: OTHER_TENANT, parent_invoice_id: original.id, invoice_kind: 'correction', invoice_type: 'KOR' });
    const { map } = await facts([original, foreign], [original]);
    expect(map.get(original.id as string)).toMatchObject({ payment: 'unpaid', outstanding: 1000 });
  });
});

describe('ikona płatności — z daty w Europe/Warsaw, nie z payment_status', () => {
  it('termin minął, status unpaid → overdue', async () => {
    const row = invoice({ payment_due_date: '2026-10-16', payment_status: 'unpaid' });
    const { map } = await facts([row]);
    expect(map.get(row.id as string)).toMatchObject({ payment: 'overdue', outstanding: 1000 });
  });

  it('granica dnia 22:30Z → już następny dzień w Warszawie', async () => {
    const row = invoice({ payment_due_date: '2026-10-17' });
    const { map } = await facts([row], [row], {}, new Date('2026-10-17T22:30:00Z'));
    expect(map.get(row.id as string)!.payment).toBe('overdue');
  });

  it('status overdue, ale termin w przyszłości → unpaid', async () => {
    const row = invoice({ payment_due_date: '2026-11-30', payment_status: 'overdue' });
    const { map } = await facts([row]);
    expect(map.get(row.id as string)!.payment).toBe('unpaid');
  });

  it('opłacona → paid, do zapłaty 0', async () => {
    const row = invoice({ payment_status: 'paid', paid_amount: 1000, payment_due_date: '2026-10-01' });
    const { map } = await facts([row]);
    expect(map.get(row.id as string)).toMatchObject({ payment: 'paid', outstanding: 0 });
  });

  it('wpłata pokrywa całość przy nieświeżym statusie → paid', async () => {
    const row = invoice({ payment_status: 'unpaid', paid_amount: 1000 });
    const { map } = await facts([row]);
    expect(map.get(row.id as string)).toMatchObject({ payment: 'paid', outstanding: 0 });
  });

  it('częściowa wpłata → unpaid z kwotą outstandingOf', async () => {
    const row = invoice({ payment_status: 'partial', gross_total: 1000, paid_amount: 250.5 });
    const { map } = await facts([row]);
    expect(map.get(row.id as string)).toMatchObject({ payment: 'unpaid', outstanding: 749.5 });
  });

  it('brak terminu → unpaid', async () => {
    const row = invoice({ payment_due_date: null });
    const { map } = await facts([row]);
    expect(map.get(row.id as string)!.payment).toBe('unpaid');
  });

  it('zapłata to fakt: faktura spoza należności, zapłacona naprawdę, mówi „Opłacona”, nie „—”', () => {
    const ctx = { environment: 'production' as const, childIds: new Set<string>() };
    const paid = { payment_status: 'paid', paid_amount: 1000 };
    for (const over of [
      { origin: 'ksef_import' },
      { origin: 'file_import' },
      { invoice_kind: 'correction', invoice_type: 'KOR' },
      { currency: 'EUR' },
    ]) {
      expect(paymentFactsOf(asRow(invoice({ ...paid, ...over })), ctx, '2026-10-17'), JSON.stringify(over))
        .toEqual({ payment: 'paid', outstanding: 0 });
    }
    // Faktura z dzieckiem po zapłacie też.
    const zDzieckiem = invoice(paid);
    expect(paymentFactsOf(asRow(zDzieckiem), { ...ctx, childIds: new Set([zDzieckiem.id as string]) }, '2026-10-17'))
      .toEqual({ payment: 'paid', outstanding: 0 });
    // Data zapłaty z FA(3): import, który nigdy nie dostanie wpłaty w `payments`.
    expect(paymentFactsOf(asRow(invoice({ origin: 'file_import', fa3_paid_date: '2026-09-20' })), ctx, '2026-10-17'))
      .toEqual({ payment: 'paid', outstanding: 0 });
    // Import bez wpłaty: nie wiemy, więc nie mówimy „Nieopłacona”.
    expect(paymentFactsOf(asRow(invoice({ origin: 'ksef_import' })), ctx, '2026-10-17'))
      .toEqual({ payment: null, outstanding: null });
    // Zapłacona, ale szkic, zakup albo inne środowisko: nie nasza sprawa.
    for (const over of [{ ksef_status: 'draft' }, { direction: 'incoming' }, { ksef_environment: 'test' }]) {
      expect(paymentFactsOf(asRow(invoice({ ...paid, ...over })), ctx, '2026-10-17'), JSON.stringify(over))
        .toEqual({ payment: null, outstanding: null });
    }
  });

  it.each<[string, Row, number, boolean]>([
    ['zwykła po terminie', {}, 0, true],
    ['import z pliku', { origin: 'file_import' }, 0, true],
    ['historia KSeF', { origin: 'ksef_import' }, 0, true],
    ['faktura w walucie obcej', { currency: 'EUR' }, 0, true],
    ['wpłata częściowa', { paid_amount: 400, payment_status: 'partial' }, 0, true],
    ['korekta częściowa', {}, -100, true],
    ['korekta do zera', {}, -1000, false],
    ['korekta in plus', { invoice_kind: 'correction', invoice_type: 'KOR', gross_total: 200 }, 0, true],
    ['korekta in minus', { invoice_kind: 'correction', invoice_type: 'KOR', gross_total: -200 }, 0, false],
    ['ROZ z resztą', { invoice_kind: 'final', invoice_type: 'ROZ', gross_total: 1000, payment_data: { amountDue: 300 } }, 0, true],
    ['ROZ pokryta zaliczkami', { invoice_kind: 'final', invoice_type: 'ROZ', gross_total: 1000, payment_data: { amountDue: 0 } }, 0, false],
    ['zapłacona', { paid_amount: 1000, payment_status: 'paid' }, 0, false],
    ['data zapłaty z FA(3)', { fa3_paid_date: '2026-09-20' }, 0, false],
    ['szkic', { ksef_status: 'draft' }, 0, false],
    ['błąd wysyłki', { ksef_status: 'failed' }, 0, false],
    ['zakup', { direction: 'incoming' }, 0, false],
    ['inne środowisko', { ksef_environment: 'test' }, 0, false],
  ])('canMarkInvoicePaid: %s', (_label, over, corrections, expected) => {
    expect(canMarkInvoicePaid(asRow(invoice(over)), 'production', corrections)).toBe(expected);
  });

  it('paymentFactsOf jest czystą funkcją', () => {
    const ctx = { environment: 'production' as const, childIds: new Set<string>() };
    expect(paymentFactsOf(asRow(invoice({ payment_due_date: '2026-10-01' })), ctx, '2026-10-17'))
      .toEqual({ payment: 'overdue', outstanding: 1000 });
    expect(paymentFactsOf(asRow(invoice({ origin: 'ocr' })), ctx, '2026-10-17'))
      .toEqual({ payment: null, outstanding: null });
  });
});

describe('Korekta w menu — warunki formularza korekty', () => {
  it('przyjęta zwykła faktura z numerem KSeF w aktywnym środowisku → true', async () => {
    const row = invoice();
    const { map } = await facts([row]);
    expect(map.get(row.id as string)!.canCorrect).toBe(true);
  });

  it('faktura w EUR też (formularz nie ma warunku waluty)', async () => {
    const row = invoice({ currency: 'EUR' });
    const { map } = await facts([row]);
    expect(map.get(row.id as string)!.canCorrect).toBe(true);
  });

  it.each([
    ['szkic', { ksef_status: 'draft', ksef_number: null }],
    ['błąd wysyłki', { ksef_status: 'failed', ksef_number: null }],
    ['bez numeru KSeF', { ksef_number: null }],
    ['zaliczka', { invoice_kind: 'advance', invoice_type: 'ZAL' }],
    ['ROZ', { invoice_kind: 'final', invoice_type: 'ROZ' }],
    ['korekta', { invoice_kind: 'correction', invoice_type: 'KOR' }],
    ['inne środowisko', { ksef_environment: 'test' }],
    ['zakup', { direction: 'incoming' }],
  ])('%s → false', async (_label, overrides) => {
    const row = invoice(overrides);
    const { map } = await facts([row]);
    expect(map.get(row.id as string)!.canCorrect).toBe(false);
  });

  it('korekta w toku (szkic) blokuje; przyjęta i odrzucona nie', async () => {
    const open = invoice();
    const accepted = invoice();
    const rejected = invoice();
    const rows = [
      open, accepted, rejected,
      invoice({ invoice_kind: 'correction', invoice_type: 'KOR', parent_invoice_id: open.id, ksef_status: 'draft', ksef_environment: null, ksef_number: null }),
      invoice({ invoice_kind: 'correction', invoice_type: 'KOR', parent_invoice_id: accepted.id, ksef_status: 'accepted' }),
      invoice({ invoice_kind: 'correction', invoice_type: 'KOR', parent_invoice_id: rejected.id, ksef_status: 'rejected' }),
    ];
    const { map } = await facts(rows, [open, accepted, rejected]);
    expect(map.get(open.id as string)!.canCorrect).toBe(false);
    expect(map.get(accepted.id as string)!.canCorrect).toBe(true);
    expect(map.get(rejected.id as string)!.canCorrect).toBe(true);
  });

  it('canCorrectInvoice jest czystą funkcją', () => {
    const row = asRow(invoice());
    expect(canCorrectInvoice(row, { environment: 'production', openCorrectionParents: new Set() })).toBe(true);
    expect(canCorrectInvoice(row, { environment: 'production', openCorrectionParents: new Set([row.id]) })).toBe(false);
    expect(canCorrectInvoice(asRow(invoice({ ksef_number: '' })), { environment: 'production', openCorrectionParents: new Set() })).toBe(false);
  });
});

describe('odczyt dzieci dla strony listy', () => {
  it('zapytania o dzieci są zawężone do firmy i do wierszy strony', async () => {
    const a = invoice();
    const b = invoice();
    const { c } = await facts([a, b]);
    const childReads = c.log.filter((q) => q.filters.some(([op]) => op === 'in' || op === 'overlaps'));
    expect(childReads).toHaveLength(2);
    for (const q of childReads) expect(q.filters).toContainEqual(['eq', 'tenant_id', TENANT]);
    expect(childReads.flatMap((q) => q.filters)).toEqual(expect.arrayContaining([
      ['in', 'parent_invoice_id', [a.id, b.id]],
      ['overlaps', 'advance_invoice_ids', [a.id, b.id]],
    ]));
  });

  it('„Zapłacone”: suma przyjętych korekt z odczytu dzieci; korekta do zera zdejmuje przycisk, częściowa nie', async () => {
    const czesciowa = invoice();
    const doZera = invoice();
    const wTrakcie = invoice();
    const dzieci = [
      invoice({ invoice_kind: 'correction', invoice_type: 'KOR', parent_invoice_id: czesciowa.id, gross_total: -100 }),
      invoice({ invoice_kind: 'correction', invoice_type: 'KOR', parent_invoice_id: doZera.id, gross_total: -1000 }),
      // Korekta w toku (szkic) jeszcze nie zmienia długu.
      invoice({ invoice_kind: 'correction', invoice_type: 'KOR', parent_invoice_id: wTrakcie.id, gross_total: -1000, ksef_status: 'draft' }),
    ];
    const { map } = await facts([czesciowa, doZera, wTrakcie, ...dzieci], [czesciowa, doZera, wTrakcie]);
    expect(map.get(czesciowa.id as string)!.canMarkPaid).toBe(true);
    expect(map.get(doZera.id as string)!.canMarkPaid).toBe(false);
    expect(map.get(wTrakcie.id as string)!.canMarkPaid).toBe(true);
  });

  it('strona bez kandydatów (same szkice) — bez zapytań', async () => {
    const draft = invoice({ ksef_status: 'draft', ksef_environment: null, ksef_number: null });
    const { c, map } = await facts([draft]);
    expect(c.log).toHaveLength(0);
    expect(map.get(draft.id as string)).toEqual({ payment: null, outstanding: null, canCorrect: false, canMarkPaid: false });
  });

  it('błąd odczytu dzieci — wyjątek, nie „bez dzieci”', async () => {
    const row = invoice();
    await expect(facts([row], [row], { failOn: (f) => f.some(([op]) => op === 'overlaps') })).rejects.toThrow();
  });

  it('kolumny listy zawierają wszystko, czego potrzebuje predykat', () => {
    for (const col of ['id', 'direction', 'origin', 'ksef_status', 'ksef_environment', 'ksef_number',
      'invoice_kind', 'invoice_type', 'currency', 'gross_total', 'paid_amount', 'payment_data',
      'payment_due_date', 'payment_status']) {
      expect(LIST_ROW_FACT_COLUMNS.split(',').map((s) => s.trim())).toContain(col);
    }
  });
});

describe('jeden predykat: lista i getReceivables się zgadzają', () => {
  it('dla każdego wiersza z otwartym statusem: należność ⇔ kolumna listy ma kwotę > 0', async () => {
    const zal = invoice({ invoice_kind: 'advance', invoice_type: 'ZAL' });
    const corrected = invoice({ gross_total: 800 });
    const rows = [
      invoice({ gross_total: 1230 }),
      invoice({ payment_due_date: '2026-10-01', payment_status: 'overdue' }),
      invoice({ payment_status: 'partial', paid_amount: 100 }),
      invoice({ paid_amount: 1000 }),
      invoice({ ksef_status: 'draft', ksef_environment: null, ksef_number: null }),
      invoice({ origin: 'ksef_import' }),
      invoice({ invoice_kind: 'correction', invoice_type: 'KOR', parent_invoice_id: corrected.id, gross_total: -50 }),
      corrected,
      invoice({ currency: 'EUR' }),
      invoice({ ksef_environment: 'test' }),
      invoice({ gross_total: 0 }),
      invoice({ invoice_kind: 'advance', invoice_type: 'VAT' }),
      zal,
      invoice({ invoice_kind: 'final', invoice_type: 'ROZ', gross_total: 4000, advance_invoice_ids: [zal.id], payment_data: { amountDue: 3000 } }),
      invoice({ invoice_kind: 'final', invoice_type: 'ROZ', gross_total: 500, payment_data: { amountDue: 0 } }),
      invoice({ invoice_kind: 'regular', invoice_type: 'UPR', currency: null }),
    ];
    const receivables = await getReceivables(client(rows) as unknown as Supabase, TENANT, NOW);
    const { map } = await facts(rows);
    const members = new Set(receivables.byInvoice.map((r) => r.id));
    for (const row of rows) {
      if (row.payment_status === 'paid') continue;
      const f = map.get(row.id as string)!;
      expect({ id: row.id, listed: f.outstanding !== null && f.outstanding > 0 })
        .toEqual({ id: row.id, listed: members.has(row.id as string) });
      if (members.has(row.id as string)) {
        expect(f.outstanding).toBe(receivables.byInvoice.find((r) => r.id === row.id)!.outstanding);
      }
    }
    expect(members.size).toBeGreaterThanOrEqual(5);
  });
});
