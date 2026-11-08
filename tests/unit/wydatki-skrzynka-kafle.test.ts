import { beforeEach, describe, expect, it } from 'vitest';

import {
  countExpensesToReview,
  getExpenseMonthTotals,
  getInboxMonthCosts,
  getLastInboxFetchAt,
  getRecurringExpenseStats,
} from '@/lib/dashboard/expense-stats';
import { KsefExpenseCurrencyNotSupportedError } from '@/lib/expenses/ksef-currency-review';
import type { PageContext } from '@/lib/supabase/page-context';

/**
 * Kafle Wydatków (P8) i Skrzynki KSeF (P9) — plan Finora §2.4 pkt 12: kwoty
 * tylko z `getCosts` (is_deductible, komplet stron, środowisko KSeF, waluta),
 * nigdy z listy na stronie. Atrapa PostgREST-a ucina strony na 1000 wierszy.
 */

type Row = Record<string, unknown>;
type Filter = [op: string, column: string, value: unknown];

const SERVER_CAP = 1000;
const TENANT = 'firma-a';

let tables: Record<string, Row[]>;
let queries: Array<{ table: string; filters: Filter[]; head: boolean }>;
let failingTables: Set<string>;

function database(): PageContext['supabase'] {
  return {
    from(table: string) {
      const entry = { table, filters: [] as Filter[], head: false };
      queries.push(entry);
      const predicates: Array<(row: Row) => boolean> = [];
      let columns: string[] | null = null;
      let sort: { key: string; ascending: boolean } | null = null;
      let window: [number, number] | null = null;
      let single = false;
      const add = (op: string, column: string, value: unknown, test: (row: Row) => boolean) => {
        entry.filters.push([op, column, value]);
        predicates.push(test);
        return query;
      };
      const run = () => {
        if (failingTables.has(table)) return { data: null, count: null, error: { message: 'connection reset' } };
        const matching = (tables[table] ?? []).filter((r) => predicates.every((p) => p(r)));
        if (sort) {
          const { key, ascending } = sort;
          matching.sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1));
        }
        const [from, to] = window ?? [0, matching.length - 1];
        const page = matching.slice(from, Math.min(to + 1, from + SERVER_CAP));
        const data = page.map((r) => (columns ? Object.fromEntries(columns.map((c) => [c, r[c]])) : r));
        if (single) return { data: data[0] ?? null, error: null };
        return { data: entry.head ? null : data, count: matching.length, error: null };
      };
      const query = {
        select(selection = '*', options?: { head?: boolean }) {
          const parts = selection.split(',').map((s) => s.trim()).filter(Boolean);
          columns = parts.includes('*') ? null : parts;
          entry.head = Boolean(options?.head);
          return query;
        },
        eq: (c: string, v: unknown) => add('eq', c, v, (r) => r[c] === v),
        neq: (c: string, v: unknown) => add('neq', c, v, (r) => r[c] != null && r[c] !== v),
        in: (c: string, v: unknown[]) => add('in', c, v, (r) => v.includes(r[c])),
        gte: (c: string, v: string) => add('gte', c, v, (r) => String(r[c]) >= v),
        lt: (c: string, v: string) => add('lt', c, v, (r) => String(r[c]) < v),
        order(key: string, options?: { ascending?: boolean }) {
          sort = { key, ascending: options?.ascending ?? true };
          return query;
        },
        range(from: number, to: number) { window = [from, to]; return query; },
        limit(n: number) { window = [0, n - 1]; return query; },
        maybeSingle() { single = true; return query; },
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve(run()).then(resolve);
        },
      };
      return query;
    },
  } as unknown as PageContext['supabase'];
}

function expense(id: string, fields: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT,
    source: 'manual',
    ksef_invoice_id: null,
    issue_date: '2026-10-10',
    seller_nip: '1234567890',
    seller_name: 'Dostawca sp. z o.o.',
    is_deductible: true,
    is_reviewed: true,
    document_type: 'invoice',
    net_amount: 100,
    vat_amount: 23,
    gross_amount: 123,
    vat_deductible_amount: 23,
    ocr_extracted_data: null,
    ...fields,
  };
}

function incoming(id: string, fields: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT,
    direction: 'incoming',
    // `origin` jest NOT NULL (00065) — faktura ze Skrzynki KSeF.
    origin: 'ksef_inbox',
    ksef_status: 'accepted',
    ksef_environment: 'test',
    currency: 'PLN',
    created_at: '2026-10-01T08:00:00Z',
    ...fields,
  };
}

beforeEach(() => {
  tables = { expenses: [], invoices: [] };
  queries = [];
  failingTables = new Set();
});

describe('getExpenseMonthTotals i getRecurringExpenseStats — kafle P8', () => {
  it('brutto i VAT do odliczenia tylko z miesiąca; paragon bez VAT do odliczenia', async () => {
    tables.expenses = [
      expense('e-1'),
      expense('e-2', { document_type: 'receipt', gross_amount: 50, vat_deductible_amount: 9.35 }),
      expense('e-3', { issue_date: '2026-09-30', gross_amount: 999 }),
    ];

    const stats = await getExpenseMonthTotals(database(), TENANT, '2026-10');

    expect(stats.gross).toBe(173);
    expect(stats.vatDeductible).toBe(23);
  });

  it('is_deductible = false i koszt KSeF z innego środowiska odpadają (droga getCosts)', async () => {
    tables.invoices = [incoming('inv-test'), incoming('inv-prod', { ksef_environment: 'production' })];
    tables.expenses = [
      expense('e-1'),
      expense('e-2', { is_deductible: false, gross_amount: 5000 }),
      expense('e-3', { source: 'ksef_inbox', ksef_invoice_id: 'inv-prod', gross_amount: 700 }),
      expense('e-4', { source: 'ksef_inbox', ksef_invoice_id: 'inv-test', gross_amount: 77 }),
    ];

    const stats = await getExpenseMonthTotals(database(), TENANT, '2026-10');

    expect(stats.gross).toBe(200);
    const monthQueries = queries.filter((q) => q.table === 'expenses');
    expect(monthQueries.length).toBeGreaterThan(0);
    for (const q of monthQueries) {
      expect(q.filters).toContainEqual(['eq', 'is_deductible', true]);
      expect(q.filters).toContainEqual(['eq', 'tenant_id', TENANT]);
      // Brutto i VAT: tylko wybrany miesiąc.
      expect(q.filters).toContainEqual(['gte', 'issue_date', '2026-10-01']);
      expect(q.filters).toContainEqual(['lt', 'issue_date', '2026-11-01']);
    }

    queries = [];
    await getRecurringExpenseStats(database(), TENANT, '2026-10');
    const windowQueries = queries.filter((q) => q.table === 'expenses');
    expect(windowQueries.length).toBeGreaterThan(0);
    for (const q of windowQueries) {
      expect(q.filters).toContainEqual(['eq', 'is_deductible', true]);
      // Stałe koszty: okno 4 miesięcy do końca wybranego miesiąca.
      expect(q.filters).toContainEqual(['gte', 'issue_date', '2026-07-01']);
      expect(q.filters).toContainEqual(['lt', 'issue_date', '2026-11-01']);
    }
  });

  it('korekta zakupu in minus obniża brutto i VAT miesiąca', async () => {
    tables.expenses = [
      expense('e-1', { gross_amount: 1230, vat_deductible_amount: 230 }),
      expense('e-2', { gross_amount: -246, vat_deductible_amount: -46 }),
    ];

    const stats = await getExpenseMonthTotals(database(), TENANT, '2026-10');

    expect(stats.gross).toBe(984);
    expect(stats.vatDeductible).toBe(184);
  });

  it('koszt KSeF w EUR bez kursu zatrzymuje kafle (wyjątek, nie zero)', async () => {
    tables.invoices = [incoming('inv-eur', { currency: 'EUR' })];
    tables.expenses = [expense('e-1', { source: 'ksef_inbox', ksef_invoice_id: 'inv-eur', is_reviewed: false })];

    await expect(getExpenseMonthTotals(database(), TENANT, '2026-10'))
      .rejects.toBeInstanceOf(KsefExpenseCurrencyNotSupportedError);
  });

  it('koszt KSeF w EUR bez kursu z lipca nie blokuje brutto i VAT października (osobne zapytanie miesiąca)', async () => {
    tables.invoices = [incoming('inv-eur', { currency: 'EUR' })];
    tables.expenses = [
      expense('e-lipiec', { source: 'ksef_inbox', ksef_invoice_id: 'inv-eur', issue_date: '2026-07-15', is_reviewed: false }),
      expense('e-1'),
    ];

    const stats = await getExpenseMonthTotals(database(), TENANT, '2026-10');

    expect(stats.gross).toBe(123);
    expect(stats.vatDeductible).toBe(23);
    // Wadliwy koszt jest w oknie stałych kosztów — tylko ten kafel dostaje wyjątek.
    await expect(getRecurringExpenseStats(database(), TENANT, '2026-10'))
      .rejects.toBeInstanceOf(KsefExpenseCurrencyNotSupportedError);
  });

  it('ponad 1000 kosztów w miesiącu: suma pełna', async () => {
    tables.expenses = Array.from({ length: 1203 }, (_, i) =>
      expense(`e-${String(i).padStart(5, '0')}`, { gross_amount: 12.3, vat_deductible_amount: 2.3 }));

    const stats = await getExpenseMonthTotals(database(), TENANT, '2026-10');

    expect(stats.gross).toBe(14796.9);
    expect(stats.vatDeductible).toBe(2766.9);
  });

  it('stałe koszty z okna 4 miesięcy (N3), suma średnich', async () => {
    tables.expenses = [
      expense('a-7', { issue_date: '2026-07-03', seller_nip: '1111111111', gross_amount: 60 }),
      expense('a-8', { issue_date: '2026-08-03', seller_nip: '1111111111', gross_amount: 60 }),
      expense('a-9', { issue_date: '2026-09-04', seller_nip: '1111111111', gross_amount: 60 }),
      expense('b-10', { issue_date: '2026-10-20', seller_nip: '2222222222', gross_amount: 900 }),
    ];

    const stats = await getRecurringExpenseStats(database(), TENANT, '2026-10');

    expect(stats.recurring.map((r) => [r.sellerNip, r.averageAmount, r.typicalDay])).toEqual([['1111111111', 60, 3]]);
    expect(stats.recurringTotal).toBe(60);
    expect((await getExpenseMonthTotals(database(), TENANT, '2026-10')).gross).toBe(900);
  });

  it('niepełny odczyt: polski komunikat, nie zero', async () => {
    failingTables.add('expenses');

    await expect(getExpenseMonthTotals(database(), TENANT, '2026-10')).rejects.toThrow(/^Nie można odczytać kosztów/);
    await expect(getRecurringExpenseStats(database(), TENANT, '2026-10')).rejects.toThrow(/^Nie można odczytać kosztów/);
  });
});

describe('getInboxMonthCosts — kafel P9 „Faktury kosztowe w miesiącu”', () => {
  it('tylko koszty ze skrzynki KSeF z bieżącego miesiąca w Polsce (1. dzień, 00:30)', async () => {
    tables.invoices = [incoming('inv-1'), incoming('inv-2')];
    tables.expenses = [
      expense('e-1', { source: 'ksef_inbox', ksef_invoice_id: 'inv-1', issue_date: '2026-11-01', gross_amount: 300 }),
      expense('e-2', { source: 'ksef_inbox', ksef_invoice_id: 'inv-2', issue_date: '2026-10-31', gross_amount: 999 }),
      expense('e-3', { source: 'ocr_photo', issue_date: '2026-11-01', gross_amount: 40 }),
    ];

    // 1 listopada 00:30 czasu polskiego = 31 października 23:30 UTC.
    const result = await getInboxMonthCosts(database(), TENANT, new Date('2026-10-31T23:30:00Z'));

    expect(result).toEqual({ month: '2026-11', gross: 300, count: 1 });
  });
});

describe('countExpensesToReview — „Do opisania” i „Nowe faktury”', () => {
  it('liczy is_reviewed = false firmy; „Nowe faktury” tylko ze skrzynki', async () => {
    tables.expenses = [
      expense('e-1', { is_reviewed: false }),
      expense('e-2', { is_reviewed: false, source: 'ksef_inbox' }),
      expense('e-3', { is_reviewed: true, source: 'ksef_inbox' }),
      expense('e-4', { is_reviewed: false, tenant_id: 'firma-b' }),
    ];

    expect(await countExpensesToReview(database(), TENANT)).toBe(2);
    expect(await countExpensesToReview(database(), TENANT, { source: 'ksef_inbox' })).toBe(1);
    expect(queries.every((q) => q.head)).toBe(true);
  });

  it('błąd odczytu → polski komunikat (kafel pokazuje go zamiast zera)', async () => {
    failingTables.add('expenses');

    await expect(countExpensesToReview(database(), TENANT)).rejects.toThrow(/^Nie można policzyć wydatków do opisania/);
  });
});

describe('getLastInboxFetchAt — „Ostatnie pobranie z KSeF”', () => {
  it('najnowszy zapis faktury kosztowej firmy; brak faktur → null', async () => {
    expect(await getLastInboxFetchAt(database(), TENANT)).toBeNull();

    tables.invoices = [
      incoming('inv-1', { created_at: '2026-10-01T08:00:00Z' }),
      incoming('inv-2', { created_at: '2026-10-19T14:05:00Z' }),
      incoming('inv-3', { created_at: '2026-10-20T09:00:00Z', tenant_id: 'firma-b' }),
      { ...incoming('out-1', { created_at: '2026-10-20T10:00:00Z' }), direction: 'outgoing' },
    ];

    expect(await getLastInboxFetchAt(database(), TENANT)).toBe('2026-10-19T14:05:00Z');
  });

  it('pomija faktury z historii KSeF (archiwum) — liczy się tylko pobranie Skrzynki (decyzja Bartosza 22.10.2026)', async () => {
    tables.invoices = [
      incoming('inv-1', { created_at: '2026-10-19T14:05:00Z', origin: 'ksef_inbox' }),
      incoming('hist-1', { created_at: '2026-10-21T09:00:00Z', origin: 'ksef_import' }),
    ];

    expect(await getLastInboxFetchAt(database(), TENANT)).toBe('2026-10-19T14:05:00Z');
  });
});
