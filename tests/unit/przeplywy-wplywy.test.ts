import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wpływy `/przeplywy` (plan Finora §2.4 pkt 14, etap E5): `getInflows` daje
 * fakturę sprzedaży w dniu prawdziwej zapłaty, inaczej w dniu terminu płatności
 * (bez terminu — wystawienia). Tu brzegi odczytu: dzień w Warszawie, strony,
 * firma, nabywca, zaliczka + ROZ. Reguła dnia (termin, FA(3), import, korekta,
 * waluta) — `wplywy-wg-terminow.test.tsx`; co jest wpływem —
 * `wplywy-prawdziwe-pieniadze.test.tsx`.
 */

const env = vi.hoisted(() => ({ value: 'production' as string }));
vi.mock('@/lib/ksef/claim-environment', () => ({
  requireConfiguredKsefEnvironment: () => env.value,
}));

import { getInflows } from '@/lib/dashboard/inflows';
import { orPredicate } from '@/lib/demo/fake-postgrest';
import { paidThisMonth } from '@/lib/invoices/list-stats';
import type { PageContext } from '@/lib/supabase/page-context';

import { withJsonAliases } from '../helpers/json-alias';

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
        // E11: dzień wpływu z kilku kolumn — alternatywa jak w atrapie PostgREST-a.
        or: (expr: string) => add('or', '', expr, orPredicate(expr)),
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
          const data = head ? null : matching.slice(start, start + Math.min(wanted, options.serverCap ?? Infinity)).map((r) => withJsonAliases(columns, r));
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

const OCTOBER = { from: '2026-10-01', toExclusive: '2026-11-01' };
const sum = (entries: Array<{ amount: number }>) => Math.round(entries.reduce((s, e) => s + e.amount, 0) * 100) / 100;

describe('getInflows — brzegi odczytu wpływów', () => {
  it('bez faktur z dniem wpływu w zakresie → pusta lista', async () => {
    const { supabase } = sb({ invoices: [
      invoice({ issue_date: '2026-09-01', payment_due_date: '2026-09-15' }),
      paid(500, '2026-09-20T10:00:00Z'),
    ] });
    expect(await getInflows(supabase, TENANT, OCTOBER)).toEqual([]);
  });

  it('dni w Warszawie: 1.11 00:30 poza październikiem, 1.10 00:30 w środku', async () => {
    const { supabase } = sb({ invoices: [
      paid(100, '2026-10-02T08:00:00Z'),
      paid(200.5, '2026-10-31T23:30:00Z'),
      paid(300, '2026-09-30T22:30:00Z'),
      paid(400, '2026-09-30T21:30:00Z'),
    ] });
    const entries = await getInflows(supabase, TENANT, OCTOBER);
    // paid_at ma pierwszeństwo przed terminem (30.10) — dzień zapłaty w Warszawie.
    expect(entries.map((e) => [e.date, e.amount])).toEqual([['2026-10-01', 300], ['2026-10-02', 100]]);
  });

  it('prawdziwe wpłaty — ta sama suma co kafel „Opłacone” listy faktur', async () => {
    // Kafel „Opłacone” liczy `paid_at`, a wpływy prawdziwe pieniądze: obie drogi są zgodne.
    const rows = [
      paid(100, '2026-10-02T08:00:00Z'),
      paid(200.5, '2026-10-31T23:30:00Z'),
      paid(300, '2026-09-30T22:30:00Z'),
      paid(55.55, '2026-10-15T12:00:00Z', { invoice_kind: 'advance', invoice_type: 'ZAL' }),
    ];
    const { supabase } = sb({ invoices: rows });
    expect(sum(await getInflows(supabase, TENANT, OCTOBER))).toBe(await paidThisMonth(supabase, TENANT, NOW));
  });

  // Recenzja PR #358, pkt 2: kafel i Przepływy czytają tę samą drogą (`getInflows`), więc nawet z importem
  // z FA(3) (`paid_at` puste) i korektami przed zapłatą oraz po niej mówią tę samą kwotę.
  it('kafel „Opłacone” zgadza się z wpływami przy imporcie z FA(3) i korektach przed i po zapłacie', async () => {
    const przed = paid(1000, '2026-10-12T10:00:00Z', { issue_date: '2026-09-10', payment_due_date: null });
    const po = paid(1230, '2026-10-02T10:00:00Z');
    const korekta = (parent: Row, gross: number, issued: string) => invoice({
      invoice_kind: 'correction', invoice_type: 'KOR', gross_total: gross, parent_invoice_id: parent.id,
      issue_date: issued, payment_due_date: null,
    });
    const { supabase } = sb({ invoices: [
      przed,
      korekta(przed, -300, '2026-09-28'),
      po,
      korekta(po, -123, '2026-10-10'),
      invoice({ origin: 'ksef_import', gross_total: 500, fa3_data: { parsed: { paidDate: '2026-10-03' } } }),
    ] });
    const wplywy = sum(await getInflows(supabase, TENANT, OCTOBER));
    expect(wplywy).toBe(700 + 1107 + 500);
    expect(await paidThisMonth(supabase, TENANT, NOW)).toBe(wplywy);
  });

  it.each([
    ['inne środowisko', { ksef_environment: 'test' }],
    ['zakup', { direction: 'incoming' }],
    ['cudza firma', { tenant_id: OTHER_TENANT }],
    ['szkic', { ksef_status: 'draft' }],
  ])('%s nie jest wpływem', async (_label, overrides) => {
    const { supabase } = sb({ invoices: [paid(999, '2026-10-05T10:00:00Z', overrides), paid(1, '2026-10-05T10:00:00Z')] });
    expect(sum(await getInflows(supabase, TENANT, OCTOBER))).toBe(1);
  });

  it('opłacona zaliczka rozliczona w ROZ — obie wpłaty to wpływy (1000 + 3000)', async () => {
    const zal = paid(1000, '2026-10-03T10:00:00Z', { invoice_kind: 'advance', invoice_type: 'ZAL' });
    const roz = paid(3000, '2026-10-04T10:00:00Z', {
      invoice_kind: 'final', invoice_type: 'ROZ', gross_total: 4000, advance_invoice_ids: [zal.id], payment_data: { amountDue: 3000 },
    });
    const { supabase } = sb({ invoices: [zal, roz] });
    const entries = await getInflows(supabase, TENANT, OCTOBER);
    expect(sum(entries)).toBe(4000);
    expect(entries.map((e) => e.invoiceKind)).toEqual(['advance', 'final']);
  });

  it('opłacony oryginał z korektą — wpłata oryginału zostaje, korekta in minus pomniejsza wpływy (E11)', async () => {
    const original = paid(1230, '2026-10-05T10:00:00Z');
    const correction = invoice({
      invoice_kind: 'correction', invoice_type: 'KOR', gross_total: -123, parent_invoice_id: original.id,
    });
    const { supabase } = sb({ invoices: [original, correction] });
    expect(sum(await getInflows(supabase, TENANT, OCTOBER))).toBe(1107);
  });

  it('wpłata 0 zł (ROZ opłacona zaliczkami) nie jest wpływem', async () => {
    const roz = paid(0, '2026-10-20T10:00:00Z', {
      invoice_kind: 'final', invoice_type: 'ROZ', gross_total: 1000, payment_data: { amountDue: 0 },
    });
    const { supabase } = sb({ invoices: [roz] });
    expect(await getInflows(supabase, TENANT, OCTOBER)).toEqual([]);
  });

  it('przyjęta opłacona faktura bez środowiska w zakresie → wyjątek', async () => {
    const { supabase } = sb({ invoices: [paid(100, '2026-10-05T10:00:00Z', { ksef_environment: null })] });
    await expect(getInflows(supabase, TENANT, OCTOBER))
      .rejects.toThrow('Przyjęte faktury wymagają uzgodnienia środowiska KSeF');
  });

  it('faktura bez środowiska poza zakresem nie blokuje', async () => {
    const { supabase } = sb({ invoices: [
      paid(100, '2026-09-05T10:00:00Z', { ksef_environment: null, issue_date: '2026-09-01' }),
      paid(7, '2026-10-05T10:00:00Z'),
    ] });
    expect(sum(await getInflows(supabase, TENANT, OCTOBER))).toBe(7);
  });

  it('> 1000 opłaconych faktur — pełna lista', async () => {
    const rows = Array.from({ length: 1100 }, () => paid(10, '2026-10-05T10:00:00Z'));
    const { supabase } = sb({ invoices: rows }, { serverCap: 1000 });
    const entries = await getInflows(supabase, TENANT, OCTOBER);
    expect(entries).toHaveLength(1100);
    expect(sum(entries)).toBe(11_000);
  });

  it('ucięta strona → wyjątek', async () => {
    const rows = Array.from({ length: 600 }, () => paid(10, '2026-10-05T10:00:00Z'));
    const { supabase } = sb({ invoices: rows }, { serverCap: 100 });
    await expect(getInflows(supabase, TENANT, OCTOBER)).rejects.toThrow(/niepełna strona/);
  });

  it('odczyt zawężony do firmy, bez `payments` (dzień zapłaty tylko z faktury)', async () => {
    const { supabase, c } = sb({ invoices: [paid(10, '2026-10-05T10:00:00Z')] });
    await getInflows(supabase, TENANT, OCTOBER);
    expect(c.log.map((q) => q.table)).toEqual(['invoices']);
    for (const q of c.log) expect(q.filters).toContainEqual(['eq', 'tenant_id', TENANT]);
  });

  it('nabywca: NIP, nazwa albo „Konsumenci” (B2C)', async () => {
    const { supabase } = sb({ invoices: [
      paid(10, '2026-10-05T10:00:00Z', { buyer_nip: '123-456-78-90', buyer_data: { name: 'Alfa sp. z o.o.' } }),
      paid(20, '2026-10-06T10:00:00Z', { buyer_nip: null, buyer_data: { name: '  Beta  ' } }),
      paid(30, '2026-10-07T10:00:00Z', { is_b2c: true, buyer_data: { name: 'Jan Kowalski' } }),
      paid(40, '2026-10-08T10:00:00Z', { buyer_nip: null, buyer_data: null, internal_number: 'FV/9' }),
    ] });
    const entries = await getInflows(supabase, TENANT, OCTOBER);
    expect(entries.map((e) => [e.buyerKey, e.buyerName, e.consumers])).toEqual([
      ['nip:1234567890', 'Alfa sp. z o.o.', false],
      ['name:beta', 'Beta', false],
      ['b2c', 'Jan Kowalski', true],
      [`invoice:${entries[3]!.id}`, null, false],
    ]);
    expect(entries[3]!.internalNumber).toBe('FV/9');
  });
});
