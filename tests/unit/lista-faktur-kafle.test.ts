import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P3 (PLAN-FINORA §5): kafle listy faktur — Kontrahenci, Faktury w tym
 * miesiącu, Opłacone, Do zapłaty. Każdy kafel to osobna funkcja (osobna karta
 * w <Suspense>, §2.4 pkt 15). Miesiąc liczony w Europe/Warsaw (pkt 10),
 * sprzedaż tylko z faktur przyjętych w aktywnym środowisku (pkt 2), wpływy
 * z `paid_amount` faktur z pkt 11 według `paid_at` (pkt 14) — bez warunku
 * dzieci, bo wpłata nie znika po korekcie ani ROZ (C2) — bez wpłat pusty
 * stan, nigdy „0 zł”.
 */

const env = vi.hoisted(() => ({ value: 'production' as string }));
vi.mock('@/lib/ksef/claim-environment', () => ({
  requireConfiguredKsefEnvironment: () => env.value,
}));

import {
  countContractors,
  countInvoicesThisMonth,
  paidThisMonth,
  PAID_EMPTY_STATE,
  PAID_NOTE,
  warsawMonthBounds,
} from '@/lib/invoices/list-stats';
import type { PageContext } from '@/lib/supabase/page-context';

type Row = Record<string, unknown>;
type Supabase = PageContext['supabase'];
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-10-17T10:00:00Z');

let seq = 0;
function invoice(overrides: Row = {}): Row {
  seq += 1;
  return {
    id: `inv-${String(seq).padStart(5, '0')}`,
    tenant_id: TENANT,
    direction: 'outgoing',
    origin: 'app',
    ksef_status: 'accepted',
    ksef_environment: 'production',
    invoice_kind: 'regular',
    invoice_type: 'VAT',
    currency: 'PLN',
    issue_date: '2026-10-05',
    gross_total: 1000,
    paid_amount: 0,
    paid_at: null,
    payment_data: null,
    payment_due_date: '2026-10-30',
    payment_status: 'unpaid',
    parent_invoice_id: null,
    advance_invoice_ids: [],
    ...overrides,
  };
}
const paid = (amount: number, paidAt: string, overrides: Row = {}) => invoice({
  gross_total: amount, paid_amount: amount, paid_at: paidAt, payment_status: 'paid', ...overrides,
});

interface ClientOptions {
  serverCap?: number;
  withholdCount?: boolean;
  failOn?: (filters: ReadonlyArray<[string, string, unknown]>) => boolean;
}

/** Klient w pamięci: filtry PostgREST użyte przez moduł, liczenie `exact`, strony. */
function client(tables: Record<string, Row[]>, options: ClientOptions = {}) {
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
        lte: (c: string, v: string) => add('lte', c, v, (r) => r[c] !== null && String(r[c]) <= v),
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
          const source = tables[table] ?? [];
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


const sb = (tables: Record<string, Row[]>, options: ClientOptions = {}) => {
  const c = client(tables, options);
  return { c, supabase: c as unknown as Supabase };
};

beforeEach(() => {
  env.value = 'production';
  seq = 0;
});

describe('granice miesiąca w Europe/Warsaw', () => {
  it('środek miesiąca', () => {
    expect(warsawMonthBounds(NOW)).toEqual({ start: '2026-10-01', endExclusive: '2026-11-01', monthKey: '2026-10' });
  });

  it('31.10 23:30Z to już 1.11 w Warszawie (UTC dałoby październik)', () => {
    expect(warsawMonthBounds(new Date('2026-10-31T23:30:00Z')).monthKey).toBe('2026-11');
  });

  it('grudzień → styczeń następnego roku', () => {
    expect(warsawMonthBounds(new Date('2026-12-10T12:00:00Z'))).toEqual({ start: '2026-12-01', endExclusive: '2027-01-01', monthKey: '2026-12' });
  });
});

describe('Kontrahenci', () => {
  it('liczba kontrahentów firmy (bez cudzych)', async () => {
    const { supabase, c } = sb({ contractors: [
      { id: 'c1', tenant_id: TENANT }, { id: 'c2', tenant_id: TENANT }, { id: 'c3', tenant_id: OTHER_TENANT },
    ] });
    expect(await countContractors(supabase, TENANT)).toBe(2);
    expect(c.log[0]!.filters).toContainEqual(['eq', 'tenant_id', TENANT]);
  });

  it('błąd odczytu → wyjątek, nie 0', async () => {
    const { supabase } = sb({ contractors: [] }, { failOn: () => true });
    await expect(countContractors(supabase, TENANT)).rejects.toThrow();
  });
});

describe('Faktury w tym miesiącu', () => {
  it('przyjęte w aktywnym środowisku z miesiąca w Warszawie + szkice osobno', async () => {
    const { supabase } = sb({ invoices: [
      invoice(),
      invoice({ issue_date: '2026-10-31' }),
      invoice({ issue_date: '2026-09-30' }),
      invoice({ issue_date: '2026-11-01' }),
      invoice({ ksef_environment: 'test' }),
      invoice({ direction: 'incoming' }),
      invoice({ tenant_id: OTHER_TENANT }),
      invoice({ ksef_status: 'rejected' }),
      invoice({ ksef_status: 'draft', ksef_environment: null }),
      invoice({ ksef_status: 'draft', ksef_environment: null, issue_date: '2026-09-15' }),
    ] });
    expect(await countInvoicesThisMonth(supabase, TENANT, NOW)).toEqual({ accepted: 2, drafts: 1 });
  });

  it('1. dzień miesiąca, 00:30 w Warszawie (30.09 22:30Z) liczy już październik', async () => {
    const { supabase } = sb({ invoices: [invoice({ issue_date: '2026-10-01' }), invoice({ issue_date: '2026-09-30' })] });
    expect(await countInvoicesThisMonth(supabase, TENANT, new Date('2026-09-30T22:30:00Z')))
      .toEqual({ accepted: 1, drafts: 0 });
  });

  it('przyjęta faktura bez środowiska w miesiącu → wyjątek', async () => {
    const { supabase } = sb({ invoices: [invoice({ ksef_environment: null })] });
    await expect(countInvoicesThisMonth(supabase, TENANT, NOW))
      .rejects.toThrow('Przyjęte faktury wymagają uzgodnienia środowiska KSeF');
  });

  it('brak liczby rekordów → wyjątek', async () => {
    const { supabase } = sb({ invoices: [invoice()] }, { withholdCount: true });
    await expect(countInvoicesThisMonth(supabase, TENANT, NOW)).rejects.toThrow();
  });
});

describe('Opłacone (wpływy w tym miesiącu)', () => {
  it('podpisy karty', () => {
    expect(PAID_NOTE).toBe('według oznaczonych wpłat');
    // Od 00158 klient ma tę czynność („Zapłacone” przy fakturze), więc pusty stan do niej prowadzi.
    expect(PAID_EMPTY_STATE).toBe('Oznacz wpłatę przy fakturze');
  });

  it('bez opłaconych faktur w miesiącu → null (pusty stan), nie 0', async () => {
    const { supabase } = sb({ invoices: [invoice(), paid(500, '2026-09-20T10:00:00Z')] });
    expect(await paidThisMonth(supabase, TENANT, NOW)).toBeNull();
  });

  it('sumuje paid_amount według paid_at w Warszawie', async () => {
    const { supabase } = sb({ invoices: [
      paid(100, '2026-10-02T08:00:00Z'),
      paid(200.5, '2026-10-31T23:30:00Z'), // 1.11 00:30 w Warszawie (CET) → poza
      paid(300, '2026-09-30T22:30:00Z'), // 1.10 00:30 w Warszawie → w środku
      paid(400, '2026-09-30T21:30:00Z'), // 30.09 23:30 w Warszawie → poza
    ] });
    expect(await paidThisMonth(supabase, TENANT, NOW)).toBe(400);
  });

  // „Zapłacone” działa na imporcie, historii KSeF i korekcie in plus (00158): wpłata jest faktem, a kafel
  // ma się zgadzać z Przepływami. Świadomie zastępuje dawne „import i korekta nie są wpływem”.
  it.each([
    ['plik', { origin: 'file_import' }],
    ['historia KSeF', { origin: 'ksef_import' }],
    ['korekta in plus', { invoice_kind: 'correction', invoice_type: 'KOR' }],
  ])('%s oznaczona jako zapłacona jest wpływem', async (_label, overrides) => {
    const { supabase } = sb({ invoices: [paid(999, '2026-10-05T10:00:00Z', overrides), paid(1, '2026-10-05T10:00:00Z')] });
    expect(await paidThisMonth(supabase, TENANT, NOW)).toBe(1000);
  });

  it.each([
    ['EUR', { currency: 'EUR' }],
    ['inne środowisko', { ksef_environment: 'test' }],
    ['zakup', { direction: 'incoming' }],
    ['cudza firma', { tenant_id: OTHER_TENANT }],
  ])('%s nie jest wpływem', async (_label, overrides) => {
    const { supabase } = sb({ invoices: [paid(999, '2026-10-05T10:00:00Z', overrides), paid(1, '2026-10-05T10:00:00Z')] });
    expect(await paidThisMonth(supabase, TENANT, NOW)).toBe(1);
  });

  // C2 (rewizja E3): warunek „bez dzieci” z pkt 11 chroni należności przed
  // goniącymi kwotami, które zmieniła korekta. Wpłata, która już wpłynęła,
  // nie znika, gdy faktura dostanie korektę albo ROZ. `paid_amount` ROZ to
  // tylko reszta po zaliczkach (00145), więc zaliczka + ROZ to dwie różne
  // wpłaty, a nie podwójne liczenie.
  it('opłacona zaliczka rozliczona w ROZ — obie wpłaty to wpływy (1000 + 3000)', async () => {
    const zal = paid(1000, '2026-10-03T10:00:00Z', { invoice_kind: 'advance', invoice_type: 'ZAL' });
    const roz = paid(3000, '2026-10-04T10:00:00Z', {
      invoice_kind: 'final', invoice_type: 'ROZ', gross_total: 4000, advance_invoice_ids: [zal.id], payment_data: { amountDue: 3000 },
    });
    const { supabase } = sb({ invoices: [zal, roz] });
    expect(await paidThisMonth(supabase, TENANT, NOW)).toBe(4000);
  });

  it('zaliczka opłacona w całości + ROZ z amountDue = 0 (opłacona bez wpłaty) — wpływ zaliczki zostaje', async () => {
    const zal = paid(1000, '2026-10-03T10:00:00Z', { invoice_kind: 'advance', invoice_type: 'ZAL' });
    const roz = paid(0, '2026-10-20T10:00:00Z', {
      invoice_kind: 'final', invoice_type: 'ROZ', gross_total: 1000, advance_invoice_ids: [zal.id], payment_data: { amountDue: 0 },
    });
    const { supabase } = sb({ invoices: [zal, roz] });
    expect(await paidThisMonth(supabase, TENANT, NOW)).toBe(1000);
  });

  it('opłacony oryginał z korektą — wpłata oryginału zostaje, korekta nie jest wpływem', async () => {
    const original = paid(1230, '2026-10-05T10:00:00Z');
    const correction = invoice({
      invoice_kind: 'correction', invoice_type: 'KOR', gross_total: -123, parent_invoice_id: original.id,
    });
    const { supabase } = sb({ invoices: [original, correction] });
    expect(await paidThisMonth(supabase, TENANT, NOW)).toBe(1230);
  });

  it('nie czyta dzieci całej firmy (wpływy nie zależą od korekt ani ROZ)', async () => {
    const { supabase, c } = sb({ invoices: [paid(10, '2026-10-05T10:00:00Z')] });
    await paidThisMonth(supabase, TENANT, NOW);
    expect(c.log).toHaveLength(1);
  });

  it('przyjęta opłacona faktura bez środowiska → wyjątek', async () => {
    const { supabase } = sb({ invoices: [paid(100, '2026-10-05T10:00:00Z', { ksef_environment: null })] });
    await expect(paidThisMonth(supabase, TENANT, NOW))
      .rejects.toThrow('Przyjęte faktury wymagają uzgodnienia środowiska KSeF');
  });

  it('> 1000 opłaconych faktur — pełna suma', async () => {
    const rows = Array.from({ length: 1100 }, () => paid(10, '2026-10-05T10:00:00Z'));
    const { supabase } = sb({ invoices: rows }, { serverCap: 1000 });
    expect(await paidThisMonth(supabase, TENANT, NOW)).toBe(11_000);
  });

  it('ucięta strona → wyjątek', async () => {
    const rows = Array.from({ length: 600 }, () => paid(10, '2026-10-05T10:00:00Z'));
    const { supabase } = sb({ invoices: rows }, { serverCap: 100 });
    await expect(paidThisMonth(supabase, TENANT, NOW)).rejects.toThrow(/niepełna strona/);
  });

  it('odczyt zawężony do firmy', async () => {
    const { supabase, c } = sb({ invoices: [paid(10, '2026-10-05T10:00:00Z')] });
    await paidThisMonth(supabase, TENANT, NOW);
    for (const q of c.log) expect(q.filters).toContainEqual(['eq', 'tenant_id', TENANT]);
  });
});
