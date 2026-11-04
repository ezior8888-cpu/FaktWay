import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ksef/claim-environment', () => ({
  requireConfiguredKsefEnvironment: () => 'production',
}));

import { VatSummarySlotCard } from '@/components/przeplywy/przeplywy-grid';
import type { VatSummaryCardProps } from '@/components/przeplywy/finora/chart-net-worth';
import { getCashFlowData } from '@/lib/dashboard/cash-flow';
import type { PageContext } from '@/lib/supabase/page-context';

/**
 * Odczyt liczb `/przeplywy` (plan Finora E5: przeniesiony ze strony do
 * `getCashFlowData`). Asercje z czasów, gdy strona czytała dane sama
 * i podawała wiersze do `CashFlowDashboard` — teraz te same warunki na
 * wyniku funkcji.
 */

type Row = Record<string, unknown>;
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function expense(source: string, invoiceId: string | null, gross: number): Row {
  return { tenant_id: TENANT, source, ksef_invoice_id: invoiceId,
    issue_date: '2026-09-04', is_deductible: true, gross_amount: gross,
    net_amount: gross, vat_amount: 0, vat_deductible_amount: 0,
    document_type: 'invoice', kpir_column: 'col_13' };
}

const asClient = (fake: ReturnType<typeof client>) => fake as unknown as PageContext['supabase'];

/** Wynik albo wyjątek — do sprawdzenia `cause` z opakowania w `getCosts`. */
async function failure(promise: Promise<unknown>): Promise<Error & { cause?: unknown }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { cause?: unknown };
  }
  throw new Error('Oczekiwano wyjątku');
}

function client(options: {
  expenses?: Row[];
  incomingInvoices?: Row[];
  outgoingInvoices?: Row[];
  serverCap?: number;
  withholdExactCount?: boolean;
} = {}) {
  const invoices: Row[] = [
    { tenant_id: TENANT, direction: 'outgoing', currency: 'PLN', ksef_status: 'accepted',
      ksef_environment: 'test', issue_date: '2026-09-02', net_total: 1_000, gross_total: 1_230 },
    { tenant_id: TENANT, direction: 'outgoing', currency: 'PLN', ksef_status: 'accepted',
      ksef_environment: 'production', issue_date: '2026-09-03', net_total: 100, gross_total: 123 },
    ...(options.incomingInvoices ?? []),
    ...(options.outgoingInvoices ?? []),
  ];
  invoices.forEach((row, index) => {
    row.id ??= `invoice-${String(index).padStart(4, '0')}`;
  });
  const invoiceFilters: Array<[string, unknown]> = [];
  const ranges: Array<{ table: string; from: number; to: number }> = [];
  return {
    invoiceFilters,
    ranges,
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      const ordering: string[] = [];
      let countRequested = false;
      let head = false;
      let range: [number, number] | null = null;
      const builder = {
        select: (_columns: string, options?: { count?: string; head?: boolean }) => {
          countRequested = options?.count === 'exact';
          head = options?.head === true;
          return builder;
        },
        eq: (column: string, value: unknown) => {
          if (table === 'invoices') invoiceFilters.push([column, value]);
          filters.push((row) => row[column] === value);
          return builder;
        },
        gte: (column: string, value: string) => {
          filters.push((row) => String(row[column]) >= value);
          return builder;
        },
        lt: (column: string, value: string) => {
          filters.push((row) => String(row[column]) < value);
          return builder;
        },
        is: (column: string, value: unknown) => {
          filters.push((row) => (row[column] ?? null) === value);
          return builder;
        },
        in: (column: string, values: string[]) => {
          filters.push((row) => values.includes(String(row[column])));
          return builder;
        },
        order: (column: string) => {
          ordering.push(column);
          return builder;
        },
        range: (from: number, to: number) => {
          range = [from, to];
          ranges.push({ table, from, to });
          return builder;
        },
        then: <T = { data: Row[]; count: number | null; error: null }, E = never>(
          resolve?: ((value: { data: Row[]; count: number | null; error: null }) => T | PromiseLike<T>) | null,
          reject?: ((reason: unknown) => E | PromiseLike<E>) | null,
        ) => {
          const source = table === 'invoices' ? invoices : (options.expenses ?? []).map((row, index) => ({
            ...row, id: row.id ?? `expense-${String(index).padStart(4, '0')}`,
          }));
          const matching = source.filter((row) =>
            filters.every((filter) => filter(row)));
          matching.sort((a, b) => {
            for (const column of ordering) {
              const comparison = String(a[column] ?? '').localeCompare(String(b[column] ?? ''));
              if (comparison !== 0) return comparison;
            }
            return 0;
          });
          const start = range?.[0] ?? 0;
          const requested = range ? range[1] - range[0] + 1 : Infinity;
          const data = matching.slice(start, start + Math.min(requested, options.serverCap ?? Infinity));
          return Promise.resolve({
            data: head ? [] : data,
            count: countRequested && !options.withholdExactCount ? matching.length : null,
            error: null,
          }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('cash flow after switching from TEST to PROD', () => {
  it('passes only accepted production invoices to the revenue calculation', async () => {
    const supabase = client();

    const data = await getCashFlowData(asClient(supabase), TENANT, new Date());

    expect(supabase.invoiceFilters).toContainEqual(['ksef_environment', 'production']);
    expect(data.invoices).toEqual([expect.objectContaining({ gross_total: 123 })]);
    // Ten sam warunek na liczbie, którą widzi klient: przychód września 100, nie 1 100.
    expect(data.revenue.at(-1)).toBe(100);
  });

  it('keeps manual and OCR costs, but excludes TEST and DEMO KSeF-linked costs', async () => {
    const supabase = client({
      expenses: [
        expense('manual', null, 10),
        expense('ocr_photo', null, 20),
        expense('ksef_inbox', 'test-in', 1_000),
        expense('ksef_inbox', 'demo-in', 2_000),
        expense('ksef_inbox', 'prod-in', 30),
      ],
      incomingInvoices: [
        { id: 'test-in', tenant_id: TENANT, direction: 'incoming', currency: 'PLN',
          ksef_status: 'accepted', ksef_environment: 'test' },
        { id: 'demo-in', tenant_id: TENANT, direction: 'incoming', currency: 'PLN',
          ksef_status: 'accepted', ksef_environment: 'demo' },
        { id: 'prod-in', tenant_id: TENANT, direction: 'incoming', currency: 'PLN',
          ksef_status: 'accepted', ksef_environment: 'production' },
      ],
    });

    const data = await getCashFlowData(asClient(supabase), TENANT, new Date());

    expect(data.costEntries.map((row) => row.outflow)).toEqual([10, 20, 30]);
    expect(data.costs.at(-1)).toBe(60);
    expect(supabase.invoiceFilters).toContainEqual(['tenant_id', TENANT]);
  });

  it('stops the cash-flow read when a KSeF cost has no verifiable linked invoice', async () => {
    const supabase = client({ expenses: [expense('ksef_inbox', 'missing-in', 500)] });

    const error = await failure(getCashFlowData(asClient(supabase), TENANT, new Date()));

    // `getCosts` opakowuje wyjątek polskim tekstem dla karty; przyczyna bez zmian.
    expect(error.message).toBe('Koszty ze skrzynki KSeF wymagają uzgodnienia środowiska KSeF');
    expect((error.cause as Error).message).toContain('KSeF expense invoice is missing from this organization');
  });

  it('stops the cash-flow read when a linked invoice has no environment provenance', async () => {
    const supabase = client({
      expenses: [expense('ksef_inbox', 'unknown-env', 500)],
      incomingInvoices: [{ id: 'unknown-env', tenant_id: TENANT, direction: 'incoming', currency: 'PLN',
        ksef_status: 'accepted', ksef_environment: null }],
    });

    const error = await failure(getCashFlowData(asClient(supabase), TENANT, new Date()));

    expect(error.message).toBe('Koszty ze skrzynki KSeF wymagają uzgodnienia środowiska KSeF');
    expect((error.cause as Error).message).toContain('KSeF expense invoice requires environment reconciliation');
  });

  it('stops the cash-flow read when an accepted sales invoice has no environment (jak Pulpit)', async () => {
    const supabase = client({
      outgoingInvoices: [{ tenant_id: TENANT, direction: 'outgoing', currency: 'PLN', ksef_status: 'accepted',
        ksef_environment: null, issue_date: '2026-09-04', net_total: 500, gross_total: 615 }],
    });

    await expect(getCashFlowData(asClient(supabase), TENANT, new Date())).rejects.toThrow(
      'Przyjęte faktury wymagają uzgodnienia środowiska KSeF',
    );
  });

  it('includes all accepted invoices and deductible expenses beyond the PostgREST cap', async () => {
    const supabase = client({
      outgoingInvoices: Array.from({ length: 1200 }, (_, index) => ({
        id: `prod-${String(index).padStart(4, '0')}`,
        tenant_id: TENANT,
        direction: 'outgoing', currency: 'PLN',
        ksef_status: 'accepted',
        ksef_environment: 'production',
        issue_date: '2026-09-05',
        net_total: 1,
        gross_total: 1.23,
      })),
      expenses: Array.from({ length: 1200 }, (_, index) => ({
        ...expense('manual', null, 1),
        id: `expense-${String(index).padStart(4, '0')}`,
      })),
      serverCap: 1000,
    });

    const data = await getCashFlowData(asClient(supabase), TENANT, new Date());

    expect(data.invoices).toHaveLength(1201);
    expect(data.costEntries).toHaveLength(1200);
    expect(data.revenue.at(-1)).toBe(1300);
    expect(supabase.ranges).toContainEqual({ table: 'invoices', from: 500, to: 999 });
    expect(supabase.ranges).toContainEqual({ table: 'expenses', from: 500, to: 999 });
    expect(supabase.ranges).toContainEqual({ table: 'invoices', from: 1000, to: 1499 });
    expect(supabase.ranges).toContainEqual({ table: 'expenses', from: 1000, to: 1499 });
  });

  it('rejects an incomplete page instead of showing partial cash-flow totals', async () => {
    const supabase = client({
      expenses: Array.from({ length: 500 }, (_, index) => ({
        ...expense('manual', null, 1),
        id: `expense-${index}`,
      })),
      serverCap: 400,
    });

    await expect(getCashFlowData(asClient(supabase), TENANT, new Date())).rejects.toThrow('niepełna strona danych');
  });

  it('rejects a response without an exact count', async () => {
    const supabase = client({ withholdExactCount: true });

    await expect(getCashFlowData(asClient(supabase), TENANT, new Date())).rejects.toThrow(
      'nie można potwierdzić liczby rekordów',
    );
  });
});

/**
 * C-21: szacunek podatku na przepływach liczy od 1 stycznia, a strona ładowała
 * tylko sześć miesięcy wykresu — od lipca kafelek obejmował niepełny rok.
 */
describe('przepływy: dane od 1 stycznia dla szacunku podatku', () => {
  const sprzedaz = (id: string, issue_date: string): Row => ({
    id, tenant_id: TENANT, direction: 'outgoing', currency: 'PLN', ksef_status: 'accepted',
    ksef_environment: 'production', issue_date, net_total: 1_000, gross_total: 1_230,
  });

  async function cashFlowData(now: string, outgoingInvoices: Row[]) {
    vi.setSystemTime(new Date(now));
    return getCashFlowData(asClient(client({ outgoingInvoices })), TENANT, new Date());
  }

  it('październik: luty w danych, kafelek dostaje początek roku', async () => {
    const data = await cashFlowData('2026-10-10T12:00:00Z', [sprzedaz('luty', '2026-02-10'), sprzedaz('grudzien-2025', '2025-12-20')]);
    expect(data.dataFrom).toBe('2026-01-01');
    expect(data.invoices.map((i) => i.id)).toContain('luty');
    expect(data.invoices.map((i) => i.id)).not.toContain('grudzien-2025');
    expect(data.taxEstimate.fullYear).toBe(true);
  });

  it('czerwiec: początek wykresu i roku to ten sam styczeń', async () => {
    expect((await cashFlowData('2026-06-15T12:00:00Z', [])).dataFrom).toBe('2026-01-01');
  });

  it('luty: wykres sięga września zeszłego roku — dane od początku wykresu', async () => {
    const data = await cashFlowData('2027-02-20T12:00:00Z', [sprzedaz('sierpien', '2026-08-31'), sprzedaz('wrzesien', '2026-09-01')]);
    expect(data.dataFrom).toBe('2026-09-01');
    expect(data.invoices.map((i) => i.id)).toContain('wrzesien');
    expect(data.invoices.map((i) => i.id)).not.toContain('sierpien');
  });

  it('noc sylwestrowa: w Polsce już 1 stycznia, choć w UTC jeszcze grudzień — liczy nowy rok', async () => {
    // 23:30 UTC 31.12 = 00:30 1.01 w Warszawie; serwer chodzi w UTC.
    const data = await cashFlowData('2026-12-31T23:30:00Z', []);
    expect(data.dataFrom).toBe('2026-08-01');
  });

  it('noc sylwestrowa: legenda wykresu sprzedaży mówi o nowym roku, jak jego serie (§2.4 pkt 10)', async () => {
    const originalTz = process.env.TZ;
    // Node przelicza strefę przy przypisaniu; produkcja chodzi w UTC.
    process.env.TZ = 'UTC';
    try {
      vi.setSystemTime(new Date('2026-12-31T23:30:00Z'));
      const card = (await VatSummarySlotCard({
        supabase: asClient(client()),
        tenantId: TENANT,
        nowIso: new Date().toISOString(),
      })) as { props: VatSummaryCardProps };
      expect(card.props.sales.year).toBe(2027);
      expect(card.props.sales.currentMonthKey).toBe('2027-01');
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});

/**
 * „Średnio miesięcznie” w karcie „Ten miesiąc” (plan Finora P1/P2): średnia
 * netto z 11 pełnych miesięcy bez bieżącego — ta sama co na Pulpicie, choć
 * wykres `/przeplywy` pokazuje tylko 6 miesięcy.
 */
describe('przepływy: średnia miesięczna z 11 pełnych miesięcy', () => {
  const sprzedaz = (id: string, issue_date: string, net: number): Row => ({
    id, tenant_id: TENANT, direction: 'outgoing', currency: 'PLN', ksef_status: 'accepted',
    ksef_environment: 'production', issue_date, net_total: net, gross_total: net,
  });

  it('październik: listopad–kwiecień po 10 000, maj–wrzesień po 2 000 (+100 we wrześniu) → 6 372,73', async () => {
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    const months = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
    const outgoingInvoices = months.map((m, i) => sprzedaz(`s-${m}`, `${m}-10`, i < 6 ? 10_000 : 2_000));

    const data = await getCashFlowData(asClient(client({ outgoingInvoices })), TENANT, new Date());

    // Wykres nadal 6 miesięcy; wrzesień ma też fakturę bazową klienta (100 netto).
    expect(data.revenue).toEqual([2_000, 2_000, 2_000, 2_000, 2_100, 0]);
    // (6 × 10 000 + 4 × 2 000 + 2 100) / 11; z 5 miesięcy wyszłoby 2 020.
    expect(data.report.monthlyAverageNet).toBe(6_372.73);
    expect(data.report.revenue).toBe(0);
  });
});
