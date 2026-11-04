import { beforeEach, describe, expect, it } from 'vitest';

import type { PageContext } from '@/lib/supabase/page-context';
import { getCosts, sumCostsByMonth, type CostEntry } from '@/lib/dashboard/costs';
import { KsefExpenseCurrencyNotSupportedError } from '@/lib/expenses/ksef-currency-review';

/**
 * Plan Finora §2.4 pkt 12: koszty Pulpitu czytane jedną drogą, jak
 * `/przeplywy` i eksport — `is_deductible` w zapytaniu, komplet stron,
 * środowisko KSeF i waluta kosztów ze skrzynki.
 */

type Row = Record<string, unknown>;
type Filter = [op: string, column: string, value: unknown];

/** PostgREST ucina odpowiedź na 1000 wierszach — atrapa też. */
const SERVER_CAP = 1000;

let tables: Record<string, Row[]>;
let queries: Array<{ table: string; filters: Filter[] }>;
/** Tabele, których odczyt kończy się błędem PostgREST-a. */
let failingTables: Set<string>;

function database(): PageContext['supabase'] {
  return {
    from(table: string) {
      const filters: Filter[] = [];
      queries.push({ table, filters });
      const predicates: Array<(row: Row) => boolean> = [];
      let columns: string[] | null = null;
      let head = false;
      let sortKey: string | null = null;
      let window: [number, number] | null = null;
      const add = (op: string, column: string, value: unknown, test: (row: Row) => boolean) => {
        filters.push([op, column, value]);
        predicates.push(test);
        return query;
      };
      const query = {
        select(selection = '*', options?: { head?: boolean }) {
          const parts = selection.split(',').map((s) => s.trim()).filter(Boolean);
          columns = parts.includes('*') ? null : parts;
          head = Boolean(options?.head);
          return query;
        },
        eq: (c: string, v: unknown) => add('eq', c, v, (r) => r[c] === v),
        is: (c: string, v: unknown) => add('is', c, v, (r) => (v === null ? r[c] == null : r[c] === v)),
        in: (c: string, v: unknown[]) => add('in', c, v, (r) => v.includes(r[c])),
        gte: (c: string, v: string) => add('gte', c, v, (r) => String(r[c]) >= v),
        lt: (c: string, v: string) => add('lt', c, v, (r) => String(r[c]) < v),
        order(key: string) { sortKey = key; return query; },
        range(from: number, to: number) { window = [from, to]; return query; },
        then(resolve: (v: unknown) => unknown) {
          if (failingTables.has(table)) {
            return Promise.resolve({ data: null, count: null, error: { message: 'connection reset' } }).then(resolve);
          }
          const matching = (tables[table] ?? []).filter((r) => predicates.every((p) => p(r)));
          if (sortKey) {
            const k = sortKey;
            matching.sort((a, b) => String(a[k]).localeCompare(String(b[k])));
          }
          const [from, to] = window ?? [0, matching.length - 1];
          const page = matching.slice(from, Math.min(to + 1, from + SERVER_CAP));
          const data = page.map((r) => (columns ? Object.fromEntries(columns.map((c) => [c, r[c]])) : r));
          return Promise.resolve({ data: head ? null : data, count: matching.length, error: null }).then(resolve);
        },
      };
      return query;
    },
  } as unknown as PageContext['supabase'];
}

const TENANT = 'firma-a';
const RANGE = { from: '2026-09-01', toExclusive: '2026-10-01' };

function expense(id: string, fields: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT,
    source: 'manual',
    ksef_invoice_id: null,
    issue_date: '2026-09-10',
    seller_nip: '1234567890',
    seller_name: 'Dostawca Sp. z o.o.',
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
    ksef_status: 'accepted',
    ksef_environment: 'test',
    currency: 'PLN',
    ...fields,
  };
}

beforeEach(() => {
  tables = { expenses: [], invoices: [] };
  queries = [];
  failingTables = new Set();
});

describe('getCosts — jedna droga kosztów Pulpitu', () => {
  it('paragon: koszt = netto + VAT, bez VAT do odliczenia', async () => {
    tables.expenses = [expense('e-1', {
      document_type: 'receipt', net_amount: 100, vat_amount: 23, gross_amount: 123,
      vat_deductible_amount: 23,
    })];

    const [entry] = await getCosts(database(), TENANT, RANGE);

    expect(entry).toEqual<CostEntry>({
      id: 'e-1',
      issueDate: '2026-09-10',
      source: 'manual',
      sellerNip: '1234567890',
      sellerName: 'Dostawca Sp. z o.o.',
      cost: 123,
      outflow: 123,
      vatDeductible: 0,
      // Plan Finora P10 (E7) i P2 (E5): pola z tego samego wiersza.
      categoryLabel: null,
      vat: 23,
      documentNumber: null,
      isReviewed: true,
    });
  });

  it('analiza kosztów (P10): kategoria, VAT naliczony i opis z tego samego wiersza', async () => {
    tables.expenses = [
      expense('e-1', { category_label: '  Paliwo ', vat_amount: 46, vat_deductible_amount: 23, is_reviewed: false }),
      expense('e-2', { category_label: '   ' }),
    ];

    const entries = await getCosts(database(), TENANT, RANGE);

    expect(entries.map((e) => [e.id, e.categoryLabel, e.vat, e.vatDeductible, e.isReviewed])).toEqual([
      ['e-1', 'Paliwo', 46, 23, false],
      ['e-2', null, 23, 23, true],
    ]);
  });

  it('faktura czynnego podatnika: koszt = netto, VAT do odliczenia z wiersza', async () => {
    tables.expenses = [expense('e-1', {
      net_amount: 1000, vat_amount: 230, gross_amount: 1230, vat_deductible_amount: 230,
    })];

    const [entry] = await getCosts(database(), TENANT, RANGE);

    expect(entry?.cost).toBe(1000);
    expect(entry?.outflow).toBe(1230);
    expect(entry?.vatDeductible).toBe(230);
  });

  it('is_deductible = false odpada już w zapytaniu', async () => {
    tables.expenses = [
      expense('e-1'),
      expense('e-2', { is_deductible: false, net_amount: 5000 }),
    ];

    const entries = await getCosts(database(), TENANT, RANGE);

    expect(entries.map((e) => e.id)).toEqual(['e-1']);
    const expenseQueries = queries.filter((q) => q.table === 'expenses');
    expect(expenseQueries.length).toBeGreaterThan(0);
    for (const q of expenseQueries) {
      expect(q.filters).toContainEqual(['eq', 'is_deductible', true]);
      expect(q.filters).toContainEqual(['eq', 'tenant_id', TENANT]);
      expect(q.filters).toContainEqual(['gte', 'issue_date', RANGE.from]);
      expect(q.filters).toContainEqual(['lt', 'issue_date', RANGE.toExclusive]);
    }
  });

  it('koszt ze skrzynki KSeF z innego środowiska jest pominięty', async () => {
    tables.invoices = [
      incoming('inv-test'),
      incoming('inv-prod', { ksef_environment: 'production' }),
    ];
    tables.expenses = [
      expense('e-1', { source: 'ksef_inbox', ksef_invoice_id: 'inv-test', net_amount: 200 }),
      expense('e-2', { source: 'ksef_inbox', ksef_invoice_id: 'inv-prod', net_amount: 900 }),
    ];

    const entries = await getCosts(database(), TENANT, RANGE);

    expect(entries.map((e) => [e.id, e.cost])).toEqual([['e-1', 200]]);
  });

  it('koszt KSeF bez uzgodnionego środowiska: polski komunikat, oryginał w cause', async () => {
    tables.invoices = [incoming('inv-x', { ksef_environment: null })];
    tables.expenses = [expense('e-1', { source: 'ksef_inbox', ksef_invoice_id: 'inv-x' })];

    const error = await getCosts(database(), TENANT, RANGE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message)
      .toBe('Koszty ze skrzynki KSeF wymagają uzgodnienia środowiska KSeF');
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it('błąd odczytu faktur KSeF to nie brak uzgodnienia: osobny komunikat, oryginał w cause', async () => {
    tables.invoices = [incoming('inv-test')];
    tables.expenses = [expense('e-1', { source: 'ksef_inbox', ksef_invoice_id: 'inv-test' })];
    failingTables.add('invoices');

    const error = await getCosts(database(), TENANT, RANGE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Nie można sprawdzić środowiska kosztów KSeF');
    expect(((error as Error).cause as Error).message)
      .toBe('KSeF expense invoice provenance check is unavailable');
  });

  it('koszt KSeF w EUR bez przeglądu i kursu zatrzymuje odczyt', async () => {
    tables.invoices = [incoming('inv-eur', { currency: 'EUR' })];
    tables.expenses = [expense('e-1', {
      source: 'ksef_inbox', ksef_invoice_id: 'inv-eur', is_reviewed: false,
    })];

    await expect(getCosts(database(), TENANT, RANGE))
      .rejects.toBeInstanceOf(KsefExpenseCurrencyNotSupportedError);
  });

  it('ponad 1000 kosztów: suma pełna mimo ucinania stron po stronie serwera', async () => {
    tables.expenses = Array.from({ length: 1203 }, (_, i) =>
      expense(`e-${String(i).padStart(5, '0')}`, {
        document_type: 'invoice', net_amount: 10, vat_amount: 2.3, gross_amount: 12.3,
        vat_deductible_amount: 2.3,
      }));

    const entries = await getCosts(database(), TENANT, RANGE);

    expect(entries).toHaveLength(1203);
    expect(sumCostsByMonth(entries, ['2026-09'])).toEqual([12030]);
  });

  it('korekta zakupu in minus obniża koszt', async () => {
    tables.expenses = [
      expense('e-1', { net_amount: 1000, vat_amount: 230, gross_amount: 1230, vat_deductible_amount: 230 }),
      expense('e-2', { net_amount: -200, vat_amount: -46, gross_amount: -246, vat_deductible_amount: -46 }),
    ];

    const entries = await getCosts(database(), TENANT, RANGE);

    expect(entries.map((e) => e.cost)).toEqual([1000, -200]);
    expect(entries[1]?.vatDeductible).toBe(-46);
    expect(sumCostsByMonth(entries, ['2026-09'])).toEqual([800]);
  });

  it('wynik posortowany po dacie, potem po id', async () => {
    tables.expenses = [
      expense('e-b', { issue_date: '2026-09-20' }),
      expense('e-c', { issue_date: '2026-09-05' }),
      expense('e-a', { issue_date: '2026-09-20' }),
    ];

    const entries = await getCosts(database(), TENANT, RANGE);

    expect(entries.map((e) => e.id)).toEqual(['e-c', 'e-a', 'e-b']);
  });
});

describe('sumCostsByMonth', () => {
  const entry = (issueDate: string, cost: number): CostEntry => ({
    id: issueDate, issueDate, source: 'manual', sellerNip: null, sellerName: null, cost, outflow: cost, vatDeductible: 0,
    categoryLabel: null, vat: 0, documentNumber: null, isReviewed: true,
  });

  it('sumuje per klucz RRRR-MM w kolejności kluczy, z zerem dla pustego miesiąca', () => {
    const entries = [
      entry('2026-07-03', 100.1),
      entry('2026-07-30', 200.2),
      entry('2026-09-01', 50),
      entry('2026-10-01', 999), // poza kluczami
    ];

    expect(sumCostsByMonth(entries, ['2026-07', '2026-08', '2026-09']))
      .toEqual([300.3, 0, 50]);
  });
});
