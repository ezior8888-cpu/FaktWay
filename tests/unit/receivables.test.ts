import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * §2.4 pkt 11 (PLAN-FINORA): należności liczy JEDNA funkcja
 * `lib/dashboard/receivables.ts`. Warunki jak w widoku `invoices_overdue`
 * (00145) i na stronie `/payments/overdue`, ale bez warunku daty; „po
 * terminie” wyłącznie z daty w Europe/Warsaw, nigdy z `payment_status`.
 */

const env = vi.hoisted(() => ({ value: 'production' as string }));
vi.mock('@/lib/ksef/claim-environment', () => ({
  requireConfiguredKsefEnvironment: () => env.value,
}));

import {
  getReceivables,
  isReceivableBase,
  receivableBaseFilterOps,
  RECEIVABLES_NOTE,
} from '@/lib/dashboard/receivables';
import type { OrFilterTerm, PaymentFilterOp } from '@/lib/invoices/list-query';
import type { PageContext } from '@/lib/supabase/page-context';

type Row = Record<string, unknown>;
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-10-17T10:00:00Z'); // 17.10.2026, 12:00 w Warszawie

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

/** Klient w pamięci udaje sesyjny klient Supabase (tylko metody, których używa moduł). */
type Supabase = PageContext['supabase'];
const run = (rows: Row[], now: Date = NOW, options: ClientOptions = {}) => {
  const c = client(rows, options);
  return { c, result: getReceivables(c as unknown as Supabase, TENANT, now) };
};

beforeEach(() => {
  env.value = 'production';
  seq = 0;
});

describe('getReceivables — co jest należnością (§2.4 pkt 11)', () => {
  it('liczy przyjętą fakturę VAT z aplikacji w PLN', async () => {
    const r = await run([invoice({ gross_total: 1230 })]).result;
    expect(r).toMatchObject({ total: 1230, notDue: 1230, overdue: 0, count: 1, overdueCount: 0 });
    expect(RECEIVABLES_NOTE).toBe('Bez importów i faktur skorygowanych');
  });

  it('szkic nie jest należnością', async () => {
    const r = await run([invoice({ ksef_status: 'draft', ksef_environment: null })]).result;
    expect(r.total).toBe(0);
    expect(r.count).toBe(0);
  });

  it('import z KSeF i z pliku nie są należnością', async () => {
    const r = await run([
      invoice({ origin: 'ksef_import' }),
      invoice({ origin: 'file_import' }),
      invoice({ origin: 'ksef_inbox' }),
    ]).result;
    expect(r.total).toBe(0);
  });

  it('korekta in minus nie jest należnością', async () => {
    const r = await run([invoice({ invoice_kind: 'correction', invoice_type: 'KOR', gross_total: -200 })]).result;
    expect(r.total).toBe(0);
    expect(r.count).toBe(0);
  });

  it('korekta in plus też nie (korekt nie liczymy nigdy)', async () => {
    const r = await run([invoice({ invoice_kind: 'correction', invoice_type: 'KOR', gross_total: 200 })]).result;
    expect(r.total).toBe(0);
  });

  it('oryginał z korektą w dowolnym statusie jest wykluczony', async () => {
    const a = invoice({ gross_total: 500 });
    const b = invoice({ gross_total: 700 });
    const c = invoice({ gross_total: 900 });
    const rows = [
      a, b, c,
      invoice({ invoice_kind: 'correction', invoice_type: 'KOR', parent_invoice_id: a.id, ksef_status: 'draft', ksef_environment: null, gross_total: -100 }),
      invoice({ invoice_kind: 'correction', invoice_type: 'KOR', parent_invoice_id: b.id, ksef_status: 'rejected', gross_total: -100 }),
    ];
    const r = await run(rows).result;
    expect(r.byInvoice.map((x) => x.id)).toEqual([c.id]);
    expect(r.total).toBe(900);
  });

  it('dziecko z innej firmy nie wyklucza oryginału', async () => {
    const a = invoice({ gross_total: 500 });
    const foreignChild = invoice({ tenant_id: OTHER_TENANT, parent_invoice_id: a.id, invoice_kind: 'correction', invoice_type: 'KOR' });
    const r = await run([a, foreignChild]).result;
    expect(r.byInvoice.map((x) => x.id)).toEqual([a.id]);
  });

  it('ROZ z zaliczkami: liczy resztę z payment_data.amountDue, zaliczka wykluczona', async () => {
    const zal = invoice({ invoice_kind: 'advance', invoice_type: 'ZAL', gross_total: 1000 });
    const roz = invoice({
      invoice_kind: 'final', invoice_type: 'ROZ', gross_total: 4000,
      advance_invoice_ids: [zal.id], payment_data: { amountDue: 3000 },
    });
    const r = await run([zal, roz]).result;
    expect(r.byInvoice).toEqual([expect.objectContaining({ id: roz.id, outstanding: 3000 })]);
    expect(r.total).toBe(3000);
  });

  it('ROZ: amountDue większe niż brutto albo nieliczbowe — liczone od brutto', async () => {
    const zal1 = invoice({ invoice_kind: 'advance', invoice_type: 'ZAL', gross_total: 100 });
    const zal2 = invoice({ invoice_kind: 'advance', invoice_type: 'ZAL', gross_total: 100 });
    const big = invoice({ invoice_kind: 'final', invoice_type: 'ROZ', gross_total: 4000, advance_invoice_ids: [zal1.id], payment_data: { amountDue: 5000 } });
    const bad = invoice({ invoice_kind: 'final', invoice_type: 'ROZ', gross_total: 2000, advance_invoice_ids: [zal2.id], payment_data: { amountDue: 'abc' } });
    const r = await run([zal1, zal2, big, bad]).result;
    expect(r.total).toBe(6000);
    expect(r.count).toBe(2);
  });

  it('zaliczka bez ROZ jest należnością', async () => {
    const zal = invoice({ invoice_kind: 'advance', invoice_type: 'ZAL', gross_total: 1000 });
    const r = await run([zal]).result;
    expect(r.total).toBe(1000);
  });

  it('niezgodna para rodzaj/typ (regular + KOR, advance + VAT) nie jest należnością', async () => {
    const r = await run([
      invoice({ invoice_kind: 'regular', invoice_type: 'KOR' }),
      invoice({ invoice_kind: 'advance', invoice_type: 'VAT' }),
    ]).result;
    expect(r.total).toBe(0);
  });

  it('faktura z innego środowiska KSeF jest pomijana bez wyjątku', async () => {
    const r = await run([invoice({ ksef_environment: 'test', gross_total: 999 }), invoice({ gross_total: 1 })]).result;
    expect(r.total).toBe(1);
  });

  it('przyjęta faktura bez środowiska KSeF — błąd zamiast cichej sumy', async () => {
    await expect(run([invoice({ ksef_environment: null })]).result)
      .rejects.toThrow('Przyjęte faktury wymagają uzgodnienia środowiska KSeF');
  });

  it('faktura w EUR: poza sumą, liczona w foreignCurrencyCount', async () => {
    const r = await run([invoice({ currency: 'EUR', gross_total: 5000 }), invoice({ gross_total: 100 })]).result;
    expect(r.total).toBe(100);
    expect(r.count).toBe(1);
    expect(r.foreignCurrencyCount).toBe(1);
  });

  it('waluta null liczona jak PLN (jak widok i /payments/overdue)', async () => {
    const r = await run([invoice({ currency: null, gross_total: 100 })]).result;
    expect(r.total).toBe(100);
    expect(r.foreignCurrencyCount).toBe(0);
  });

  it('gross_total = 0 pomijana', async () => {
    const r = await run([invoice({ gross_total: 0 })]).result;
    expect(r.count).toBe(0);
  });

  it('częściowo opłacona: kwota to outstandingOf (do zapłaty minus wpłaty)', async () => {
    const r = await run([invoice({ gross_total: 1000, paid_amount: 400, payment_status: 'partial' })]).result;
    expect(r.total).toBe(600);
  });

  it('wpłata pokrywa całość, a status nieświeży (unpaid) — pomijana', async () => {
    const r = await run([invoice({ gross_total: 1000, paid_amount: 1000, payment_status: 'unpaid' })]).result;
    expect(r.count).toBe(0);
    expect(r.total).toBe(0);
  });

  it('status paid wyklucza fakturę (warunek payment_status)', async () => {
    const r = await run([invoice({ payment_status: 'paid', paid_amount: 0 })]).result;
    expect(r.count).toBe(0);
  });

  it('cudza firma nie wchodzi do sumy', async () => {
    const r = await run([invoice({ tenant_id: OTHER_TENANT })]).result;
    expect(r.count).toBe(0);
  });
});

describe('getReceivables — po terminie liczone z daty w Europe/Warsaw', () => {
  it('termin wczoraj ze statusem unpaid → po terminie', async () => {
    const r = await run([invoice({ payment_due_date: '2026-10-16', payment_status: 'unpaid', gross_total: 300 })]).result;
    expect(r).toMatchObject({ overdue: 300, notDue: 0, overdueCount: 1, oldestOverdueDays: 1 });
    expect(r.byInvoice[0]).toMatchObject({ daysOverdue: 1, paymentDueDate: '2026-10-16' });
  });

  it('status overdue z terminem w przyszłości (nieświeży) → nie po terminie', async () => {
    const r = await run([invoice({ payment_due_date: '2026-11-01', payment_status: 'overdue' })]).result;
    expect(r.overdue).toBe(0);
    expect(r.notDue).toBe(1000);
  });

  it('granica dnia: 22:30Z 17.10 to już 18.10 w Warszawie — termin 17.10 jest po terminie', async () => {
    const r = await run([invoice({ payment_due_date: '2026-10-17' })], new Date('2026-10-17T22:30:00Z')).result;
    expect(r.overdue).toBe(1000);
    expect(r.byInvoice[0]!.daysOverdue).toBe(1);
  });

  it('termin dzisiaj → jeszcze nie po terminie', async () => {
    const r = await run([invoice({ payment_due_date: '2026-10-17' })]).result;
    expect(r).toMatchObject({ overdue: 0, notDue: 1000, oldestOverdueDays: null });
    expect(r.byInvoice[0]!.daysOverdue).toBe(0);
  });

  it('brak terminu → nie po terminie, ale wciąż należność', async () => {
    const r = await run([invoice({ payment_due_date: null })]).result;
    expect(r).toMatchObject({ overdue: 0, notDue: 1000, count: 1 });
  });

  it('oldestOverdueDays = największe opóźnienie; sortowanie: najstarsze najpierw', async () => {
    const a = invoice({ payment_due_date: '2026-10-10', gross_total: 10 });
    const b = invoice({ payment_due_date: '2026-09-17', gross_total: 20.005 });
    const c = invoice({ payment_due_date: '2026-10-30', gross_total: 30 });
    const r = await run([a, b, c]).result;
    expect(r.oldestOverdueDays).toBe(30);
    expect(r.byInvoice.map((x) => x.id)).toEqual([b.id, a.id, c.id]);
    expect(r.overdueCount).toBe(2);
    expect(r.overdue).toBe(30.01);
    expect(r.total).toBe(60.01);
    expect(r.byInvoice[0]).toMatchObject({ internalNumber: b.internal_number, buyerName: 'Nabywca 2' });
  });

  it('byInvoice niesie NIP nabywcy: buyer_nip, a bez niego buyer_data.nip (P13, kontrahenci)', async () => {
    const a = invoice({ buyer_nip: ' 1234567890 ' });
    const b = invoice({ buyer_nip: null, buyer_data: { name: 'B', nip: '5260001246' } });
    const c = invoice({ buyer_nip: '', buyer_data: { name: 'Konsument' } });
    const r = await run([a, b, c]).result;
    const nips = new Map(r.byInvoice.map((x) => [x.id, x.buyerNip]));
    expect(nips.get(a.id as string)).toBe('1234567890');
    expect(nips.get(b.id as string)).toBe('5260001246');
    expect(nips.get(c.id as string)).toBeNull();
  });

  it('przejście przez zmianę czasu: 26.10 → 25.10 to 1 dzień', async () => {
    const r = await run([invoice({ payment_due_date: '2026-10-25' })], new Date('2026-10-26T12:00:00Z')).result;
    expect(r.byInvoice[0]!.daysOverdue).toBe(1);
  });
});

describe('getReceivables — kompletność odczytu', () => {
  it('> 1000 wierszy (serwer tnie po 1000) — pełna suma przez readCompletePages', async () => {
    const rows = Array.from({ length: 1234 }, () => invoice({ gross_total: 100 }));
    const r = await run(rows, NOW, { serverCap: 1000 }).result;
    expect(r.count).toBe(1234);
    expect(r.total).toBe(123_400);
  });

  it('ucięta strona (serwer tnie poniżej rozmiaru strony) — błąd, nie za mała suma', async () => {
    const rows = Array.from({ length: 700 }, () => invoice({ gross_total: 100 }));
    await expect(run(rows, NOW, { serverCap: 200 }).result).rejects.toThrow(/niepełna strona/);
  });

  it('brak liczby rekordów — błąd', async () => {
    await expect(run([invoice()], NOW, { withholdCount: true }).result).rejects.toThrow(/liczby rekordów/);
  });

  it('błąd odczytu kandydatów — błąd, nie zero', async () => {
    await expect(run([invoice()], NOW, {
      failOn: (f) => f.some(([op, c]) => op === 'eq' && c === 'origin'),
    }).result).rejects.toThrow();
  });

  it('błąd odczytu korekt (dzieci) — błąd, nie „bez dzieci”', async () => {
    await expect(run([invoice()], NOW, {
      failOn: (f) => f.some(([op, c]) => op === 'not.is' && c === 'parent_invoice_id'),
    }).result).rejects.toThrow();
  });

  it('błąd odczytu ROZ (dzieci zaliczek) — błąd', async () => {
    await expect(run([invoice()], NOW, {
      failOn: (f) => f.some(([op, c]) => op === 'not.eq' && c === 'advance_invoice_ids'),
    }).result).rejects.toThrow();
  });

  it('każde zapytanie jest zawężone do firmy', async () => {
    const { c, result } = run([invoice()]);
    await result;
    expect(c.log.length).toBeGreaterThanOrEqual(3);
    for (const q of c.log) expect(q.filters).toContainEqual(['eq', 'tenant_id', TENANT]);
  });
});

describe('isReceivableBase — czysty predykat (bez warunku payment_status)', () => {
  const ctx = { environment: 'production' as const, childIds: new Set<string>(['child-parent']) };

  it('opłacona faktura spełnia predykat (kolumna listy pokaże „Opłacona”)', () => {
    expect(isReceivableBase(invoice({ payment_status: 'paid', paid_amount: 1000 }) as never, ctx)).toBe(true);
  });

  it.each([
    ['szkic', { ksef_status: 'draft' }],
    ['import', { origin: 'ksef_import' }],
    ['korekta', { invoice_kind: 'correction', invoice_type: 'KOR' }],
    ['EUR', { currency: 'EUR' }],
    ['inne środowisko', { ksef_environment: 'test' }],
    ['brak środowiska', { ksef_environment: null }],
    ['zakup', { direction: 'incoming' }],
    ['brutto 0', { gross_total: 0 }],
    ['ujemna wpłata', { paid_amount: -5 }],
    ['ma dziecko', { id: 'child-parent' }],
  ])('%s → false', (_label, overrides) => {
    expect(isReceivableBase(invoice(overrides) as never, ctx)).toBe(false);
  });
});

/** Warunek PostgREST na wierszu, z semantyką SQL: NULL nie spełnia porównań. */
function matchesTerm(row: Row, term: OrFilterTerm): boolean {
  const value = row[term.column];
  if (term.op === 'is') return value === null || value === undefined;
  if (value === null || value === undefined) return false;
  if (term.op === 'eq') return String(value) === term.value;
  if (term.op === 'not_null') return true;
  return term.value.includes(String(value));
}

function matchesOps(row: Row, ops: readonly PaymentFilterOp[]): boolean {
  return ops.every((op) => {
    if (op.op === 'or') return op.anyOf.some((branch) => branch.every((term) => matchesTerm(row, term)));
    const value = row[op.column];
    if (value === null || value === undefined) return false;
    switch (op.op) {
      case 'eq': return String(value) === op.value;
      case 'neq': return String(value) !== op.value;
      case 'in': return op.value.includes(String(value));
      case 'lt': return String(value) < op.value;
      case 'gt': return Number(value) > op.value;
      case 'gte': return Number(value) >= op.value;
    }
  });
}

function product(dimensions: Record<string, readonly unknown[]>): Row[] {
  return Object.entries(dimensions).reduce<Row[]>(
    (rows, [column, values]) => rows.flatMap((row) => values.map((value) => ({ ...row, [column]: value }))),
    [{}],
  );
}

// C1 (rewizja E3): filtr płatności listy zapisuje predykat pkt 11 jako
// warunki PostgREST. Ten test pilnuje, żeby obie wersje się nie rozjechały.
describe('receivableBaseFilterOps — warunki PostgREST = isReceivableBase bez dzieci', () => {
  it('na pełnym iloczynie wartości kolumn obie wersje wybierają te same faktury', () => {
    const ctx = { environment: 'production' as const, childIds: new Set<string>() };
    const ops = receivableBaseFilterOps('production');
    const rows = product({
      direction: ['outgoing', 'incoming'],
      origin: ['app', 'ksef_import', 'file_import'],
      ksef_status: ['accepted', 'draft', 'rejected'],
      ksef_environment: ['production', 'test', null],
      invoice_kind: ['regular', 'advance', 'final', 'correction'],
      invoice_type: ['VAT', 'UPR', 'ZAL', 'ROZ', 'KOR', null],
      currency: ['PLN', null, 'EUR'],
      gross_total: [1000, 0, -5, null],
      paid_amount: [0, 500, -5],
    }).map((overrides) => invoice(overrides));
    const mismatches = rows.filter((row) => matchesOps(row, ops) !== isReceivableBase(row as never, ctx));
    expect(mismatches.slice(0, 3)).toEqual([]);
    expect(rows.filter((row) => matchesOps(row, ops)).length).toBeGreaterThan(0);
  });

  it('środowisko z argumentu, nie stałe', () => {
    expect(receivableBaseFilterOps('test')).toContainEqual({ op: 'eq', column: 'ksef_environment', value: 'test' });
    expect(receivableBaseFilterOps('test')).not.toContainEqual({ op: 'eq', column: 'ksef_environment', value: 'production' });
  });
});
