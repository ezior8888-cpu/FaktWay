import { beforeEach, describe, expect, it } from 'vitest';

import type { PageContext } from '@/lib/supabase/page-context';
import { getMonthlyFigures, getSalesSeries } from '@/lib/dashboard/monthly-figures';
import { OutgoingInvoiceCurrencyNotSupportedError } from '@/lib/exports/currency-guard';
import { roundToCents } from '@/lib/xml/invoice-calculator';

/**
 * Plan Finora E4 (§5 P1, karta „Przychody i koszty”): `getSalesSeries`
 * dostaje okno 12 miesięcy bez roku wcześniej oraz serie netto i VAT z tych
 * samych wierszy. Wywołanie bez opcji ma zwracać to samo co przed zmianą.
 */

type Row = Record<string, unknown>;
type Filter = [op: string, column: string, value: unknown];

let rows: Row[];
let queries: Array<{ table: string; filters: Filter[] }>;

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
          const source = table === 'invoices' ? rows : [];
          const matching = source.filter((r) => predicates.every((p) => p(r)));
          if (sortKey) {
            const k = sortKey;
            matching.sort((a, b) => String(a[k]).localeCompare(String(b[k])));
          }
          const page = window ? matching.slice(window[0], window[1] + 1) : matching;
          const data = page.map((r) => (columns ? Object.fromEntries(columns.map((c) => [c, r[c]])) : r));
          return Promise.resolve({ data: head ? null : data, count: matching.length, error: null }).then(resolve);
        },
      };
      return query;
    },
  } as unknown as PageContext['supabase'];
}

/** Dolne granice dat we wszystkich zapytaniach o faktury (strażnik i odczyt). */
function issueDateLowerBounds(): string[] {
  return queries
    .filter((q) => q.table === 'invoices')
    .flatMap((q) => q.filters.filter(([op, c]) => op === 'gte' && c === 'issue_date'))
    .map(([, , v]) => String(v));
}

const TENANT = 'firma-a';

function invoice(id: string, fields: Row): Row {
  return {
    id,
    tenant_id: TENANT,
    direction: 'outgoing',
    ksef_status: 'accepted',
    ksef_environment: 'test',
    invoice_kind: 'regular',
    advance_invoice_ids: null,
    currency: 'PLN',
    ...fields,
  };
}

beforeEach(() => {
  rows = [];
  queries = [];
});

describe('getSalesSeries — wywołanie bez opcji jak dotąd', () => {
  const NOW = new Date('2026-09-15T10:00:00Z');

  it('6 miesięcy brutto + to samo okno rok wcześniej, plus netto i VAT', async () => {
    rows = [
      invoice('a-2025-05', { issue_date: '2025-05-12', net_total: 400, vat_total: 92, gross_total: 492 }),
      invoice('b-2026-04', { issue_date: '2026-04-02', net_total: 1000, vat_total: 230, gross_total: 1230 }),
      invoice('c-2026-09', { issue_date: '2026-09-03', net_total: 2000, vat_total: 460, gross_total: 2460 }),
      // Poza oknem i poza rokiem wcześniej — nie liczy się nigdzie.
      invoice('d-2026-03', { issue_date: '2026-03-31', net_total: 9000, vat_total: 2070, gross_total: 11070 }),
    ];

    const series = await getSalesSeries(database(), TENANT, NOW);

    expect(series).toEqual({
      months: [
        { key: '2026-04', label: 'Kwi' },
        { key: '2026-05', label: 'Maj' },
        { key: '2026-06', label: 'Cze' },
        { key: '2026-07', label: 'Lip' },
        { key: '2026-08', label: 'Sie' },
        { key: '2026-09', label: 'Wrz' },
      ],
      currentSeries: [1230, 0, 0, 0, 0, 2460],
      prevSeries: [0, 492, 0, 0, 0, 0],
      // PLAN-PRAWDZIWE-DANE E5: netto roku wcześniej dla karty „Przychód netto” Pulpitu.
      prevNetSeries: [0, 400, 0, 0, 0, 0],
      currentMonthKey: '2026-09',
      netSeries: [1000, 0, 0, 0, 0, 2000],
      vatSeries: [230, 0, 0, 0, 0, 460],
    });
    // Okno bieżące i rok wcześniej — dwa strażniki i dwa odczyty.
    expect(issueDateLowerBounds().sort()).toEqual([
      '2025-04-01', '2025-04-01', '2026-04-01', '2026-04-01',
    ]);
  });

  it('pusty `options` to to samo co brak parametru', async () => {
    rows = [invoice('a', { issue_date: '2026-09-03', net_total: 1, vat_total: 0.23, gross_total: 1.23 })];

    const bare = await getSalesSeries(database(), TENANT, NOW);
    const empty = await getSalesSeries(database(), TENANT, NOW, {});

    expect(empty).toEqual(bare);
  });
});

describe('getSalesSeries({ months: 12, withPrevYear: false })', () => {
  const NOW = new Date('2027-02-15T10:00:00Z');
  const OPTIONS = { months: 12, withPrevYear: false } as const;

  it('okno przez przełom roku, bez roku wcześniej i bez zapytań o niego', async () => {
    rows = [
      invoice('a', { issue_date: '2026-03-01', net_total: 100, vat_total: 23, gross_total: 123 }),
      invoice('b', { issue_date: '2026-12-31', net_total: 200, vat_total: 46, gross_total: 246 }),
      invoice('c', { issue_date: '2027-02-14', net_total: 300, vat_total: 69, gross_total: 369 }),
      // Rok wcześniej — przy withPrevYear: true trafiłby do prevSeries.
      invoice('d', { issue_date: '2025-03-10', net_total: 999, vat_total: 0, gross_total: 999 }),
    ];

    const series = await getSalesSeries(database(), TENANT, NOW, OPTIONS);

    expect(series.months.map((m) => m.key)).toEqual([
      '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
      '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02',
    ]);
    expect(series.currentMonthKey).toBe('2027-02');
    expect(series.prevSeries).toEqual([]);
    expect(series.prevNetSeries).toEqual([]);
    expect(series.netSeries).toEqual([100, 0, 0, 0, 0, 0, 0, 0, 0, 200, 0, 300]);
    expect(series.vatSeries).toEqual([23, 0, 0, 0, 0, 0, 0, 0, 0, 46, 0, 69]);
    expect(series.currentSeries).toEqual([123, 0, 0, 0, 0, 0, 0, 0, 0, 246, 0, 369]);
    // Tylko okno bieżące: jeden strażnik i jeden odczyt, oba od 1 marca 2026.
    expect(issueDateLowerBounds()).toEqual(['2026-03-01', '2026-03-01']);
  });

  it('ROZ z zaliczką sprzed okna: netto miesiąca ROZ to reszta ponad zaliczkę', async () => {
    rows = [
      invoice('zal-1', {
        invoice_kind: 'advance', issue_date: '2025-12-10',
        net_total: 10000, vat_total: 2300, gross_total: 12300,
      }),
      invoice('roz-1', {
        invoice_kind: 'final', advance_invoice_ids: ['zal-1'], issue_date: '2026-04-20',
        net_total: 30000, vat_total: 6900, gross_total: 36900,
      }),
    ];

    const series = await getSalesSeries(database(), TENANT, NOW, OPTIONS);
    const april = series.months.findIndex((m) => m.key === '2026-04');

    expect(series.netSeries[april]).toBe(20000);
    expect(series.vatSeries[april]).toBe(4600);
    expect(series.currentSeries[april]).toBe(24600);
    // Zaliczka sprzed okna sama na wykres nie wchodzi.
    expect(series.netSeries.reduce((s, v) => s + v, 0)).toBe(20000);
  });

  it('VAT bieżącego miesiąca = totalVat z getMonthlyFigures (karta VAT na /przeplywy)', async () => {
    rows = [
      invoice('zal-1', {
        invoice_kind: 'advance', issue_date: '2027-01-10',
        net_total: 1000.1, vat_total: 230.02, gross_total: 1230.12,
      }),
      invoice('roz-1', {
        invoice_kind: 'final', advance_invoice_ids: ['zal-1'], issue_date: '2027-02-03',
        net_total: 4000.4, vat_total: 920.09, gross_total: 4920.49,
      }),
      invoice('vat-1', { issue_date: '2027-02-05', net_total: 333.33, vat_total: 76.67, gross_total: 410 }),
      invoice('vat-2', { issue_date: '2027-02-07', net_total: 0.1, vat_total: 0.02, gross_total: 0.12 }),
      invoice('kor-1', {
        invoice_kind: 'correction', issue_date: '2027-02-09',
        net_total: -100, vat_total: -23, gross_total: -123,
      }),
    ];

    const series = await getSalesSeries(database(), TENANT, NOW, OPTIONS);
    const figures = await getMonthlyFigures(database(), TENANT, NOW);

    // Serie są w groszach; `getMonthlyFigures` zwraca surową sumę.
    expect(series.vatSeries.at(-1)).toBe(roundToCents(figures.totalVat));
    expect(series.netSeries.at(-1)).toBe(roundToCents(figures.totalNet));
    expect(series.currentSeries.at(-1)).toBe(roundToCents(figures.totalGross));
  });

  it('korekta zerująca miesiąc daje dokładnie 0, nie resztę z liczb zmiennoprzecinkowych', async () => {
    // 10,10 + 20,20 − 30,30 w double to −3,55e-15: karta pokazałaby „-0 zł”
    // i policzyła miesiąc jako „z danymi”.
    rows = [
      invoice('vat-1', { issue_date: '2026-11-03', net_total: 10.1, vat_total: 2.32, gross_total: 12.3 }),
      invoice('vat-2', { issue_date: '2026-11-04', net_total: 20.2, vat_total: 4.65, gross_total: 24.6 }),
      invoice('kor-1', {
        invoice_kind: 'correction', issue_date: '2026-11-05',
        net_total: -30.3, vat_total: -6.97, gross_total: -36.9,
      }),
      invoice('vat-3', { issue_date: '2026-12-01', net_total: 0.1, vat_total: 0.2, gross_total: 0.3 }),
      invoice('vat-4', { issue_date: '2026-12-02', net_total: 0.2, vat_total: 0.1, gross_total: 0 }),
    ];

    const series = await getSalesSeries(database(), TENANT, NOW, OPTIONS);
    const november = series.months.findIndex((m) => m.key === '2026-11');
    const december = series.months.findIndex((m) => m.key === '2026-12');

    // `toBe` odróżnia też −0 od 0 (Object.is).
    expect(series.netSeries[november]).toBe(0);
    expect(series.vatSeries[november]).toBe(0);
    expect(series.currentSeries[november]).toBe(0);
    // 0,1 + 0,2 = 0,30000000000000004 → 0,3.
    expect(series.netSeries[december]).toBe(0.3);
    expect(series.vatSeries[december]).toBe(0.3);
  });

  it('rok wcześniej też w groszach', async () => {
    rows = [
      invoice('a', { issue_date: '2025-09-03', net_total: 1, vat_total: 0, gross_total: 0.1 }),
      invoice('b', { issue_date: '2025-09-04', net_total: 1, vat_total: 0, gross_total: 0.2 }),
      invoice('c', { issue_date: '2025-08-03', net_total: 1, vat_total: 0, gross_total: 12.3 }),
      invoice('d', { issue_date: '2025-08-04', net_total: 1, vat_total: 0, gross_total: 24.6 }),
      invoice('e', { issue_date: '2025-08-05', net_total: -2, vat_total: 0, gross_total: -36.9 }),
    ];

    const series = await getSalesSeries(database(), TENANT, new Date('2026-09-15T10:00:00Z'));

    expect(series.prevSeries).toEqual([0, 0, 0, 0, 0, 0.3]);
    expect(Object.is(series.prevSeries[4], 0)).toBe(true);
  });

  it('faktura w EUR zatrzymuje serię', async () => {
    rows = [invoice('eur', { issue_date: '2026-11-03', currency: 'EUR', net_total: 1, vat_total: 0, gross_total: 1 })];

    await expect(getSalesSeries(database(), TENANT, NOW, OPTIONS))
      .rejects.toBeInstanceOf(OutgoingInvoiceCurrencyNotSupportedError);
  });

  it('przyjęta faktura bez środowiska KSeF zatrzymuje serię', async () => {
    rows = [invoice('bez-env', { issue_date: '2026-05-03', ksef_environment: null, net_total: 1, vat_total: 0, gross_total: 1 })];

    await expect(getSalesSeries(database(), TENANT, NOW, OPTIONS))
      .rejects.toThrow('Przyjęte faktury wymagają uzgodnienia środowiska KSeF');
  });

  it('przyjęta faktura bez środowiska sprzed okna nie zatrzymuje, bo roku wcześniej nie czytamy', async () => {
    rows = [invoice('stara', { issue_date: '2025-05-03', ksef_environment: null, net_total: 1, vat_total: 0, gross_total: 1 })];

    await expect(getSalesSeries(database(), TENANT, NOW, OPTIONS)).resolves.toBeDefined();
    await expect(getSalesSeries(database(), TENANT, new Date('2026-05-15T10:00:00Z')))
      .rejects.toThrow('Przyjęte faktury wymagają uzgodnienia środowiska KSeF');
  });
});
