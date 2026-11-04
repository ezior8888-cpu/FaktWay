import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KpirFinanceCard } from '@/components/przeplywy/finora/chart-finance';
import { getCashFlowData } from '@/lib/dashboard/cash-flow';
import { getCosts, sumCostsByMonth } from '@/lib/dashboard/costs';
import { getSalesSeries } from '@/lib/dashboard/monthly-figures';
import { buildMonthReport } from '@/lib/dashboard/pulpit-report';
import { formatPlMoney } from '@/lib/format/pl';
import type { PageContext } from '@/lib/supabase/page-context';

/**
 * Karta „Ten miesiąc” (plan Finora §5 P1): zysk, przychody, koszty
 * i średnia miesięczna. „Zysk” musi być tą samą liczbą co „Dochód miesiąca”
 * na `/przeplywy` dla tych samych danych.
 */

describe('buildMonthReport', () => {
  it('bieżący miesiąc to ostatni element; średnia z pełnych miesięcy przed nim', () => {
    const report = buildMonthReport(
      [1000, 2000, 3000, 4000],
      [100, 200, 300, 1500.55],
    );

    expect(report).toEqual({
      revenue: 4000,
      costs: 1500.55,
      profit: 2499.45,
      monthlyAverageNet: 2000,
    });
  });

  it('strata: zysk ujemny', () => {
    expect(buildMonthReport([500, 100], [0, 350.1]).profit).toBe(-250.1);
  });

  it('firma nowa: bez sprzedaży przed bieżącym miesiącem średnia to null', () => {
    const report = buildMonthReport(
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1200],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 300],
    );

    expect(report.monthlyAverageNet).toBeNull();
    expect(report.revenue).toBe(1200);
    expect(report.profit).toBe(900);
  });

  it('jednomiesięczne okno: średniej nie ma', () => {
    expect(buildMonthReport([700], [0]).monthlyAverageNet).toBeNull();
  });

  it('średnia liczona od pierwszego miesiąca z danymi, nie rozcieńczona zerami sprzed startu', () => {
    // Start 3 miesiące przed bieżącym; zero w środku (miesiąc bez sprzedaży) się liczy.
    const net = [0, 0, 0, 0, 0, 0, 0, 0, 3000, 0, 6000, 9999];
    const report = buildMonthReport(net, new Array(12).fill(0));

    expect(report.monthlyAverageNet).toBe(3000);
  });

  it('średnia zaokrąglona do groszy', () => {
    expect(buildMonthReport([10, 10, 10.01, 0], [0, 0, 0, 0]).monthlyAverageNet).toBe(10);
    expect(buildMonthReport([0.01, 0.01, 0.02, 0], [0, 0, 0, 0]).monthlyAverageNet).toBe(0.01);
  });

  it('różne długości serii to błąd', () => {
    expect(() => buildMonthReport([1, 2, 3], [1, 2])).toThrow(Error);
  });
});

type Row = Record<string, unknown>;

let tables: Record<string, Row[]>;

function database(): PageContext['supabase'] {
  return {
    from(table: string) {
      const predicates: Array<(row: Row) => boolean> = [];
      let columns: string[] | null = null;
      let head = false;
      let sortKey: string | null = null;
      let window: [number, number] | null = null;
      const query = {
        select(selection = '*', options?: { head?: boolean }) {
          const parts = selection.split(',').map((s) => s.trim()).filter(Boolean);
          columns = parts.includes('*') ? null : parts;
          head = Boolean(options?.head);
          return query;
        },
        eq(c: string, v: unknown) { predicates.push((r) => r[c] === v); return query; },
        is(c: string, v: unknown) {
          predicates.push((r) => (v === null ? r[c] == null : r[c] === v));
          return query;
        },
        in(c: string, v: unknown[]) { predicates.push((r) => v.includes(r[c])); return query; },
        gte(c: string, v: string) { predicates.push((r) => String(r[c]) >= v); return query; },
        lt(c: string, v: string) { predicates.push((r) => String(r[c]) < v); return query; },
        order(key: string) { sortKey = key; return query; },
        range(from: number, to: number) { window = [from, to]; return query; },
        then(resolve: (v: unknown) => unknown) {
          const matching = (tables[table] ?? []).filter((r) => predicates.every((p) => p(r)));
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

const TENANT = 'firma-a';
const NOW = new Date('2027-02-15T10:00:00Z');

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

function expense(id: string, fields: Row): Row {
  return {
    id,
    tenant_id: TENANT,
    source: 'manual',
    ksef_invoice_id: null,
    seller_nip: '1234567890',
    seller_name: 'Dostawca',
    is_deductible: true,
    is_reviewed: true,
    kpir_column: 'col_13',
    ocr_extracted_data: null,
    ...fields,
  };
}

/** Kwota „Zysk” karty „Ten miesiąc” z wyrenderowanych `/przeplywy` (dawniej kafelek „Dochód miesiąca”). */
function cashFlowProfitLabel(html: string): string {
  const match = /data-figure="profit"[^>]*>([^<]+)</.exec(html);
  if (!match) throw new Error('Brak kwoty „Zysk” w znaczniku karty Przepływów');
  return match[1]!;
}

describe('„Zysk” na Pulpicie = „Zysk” miesiąca na /przeplywy (dawny „Dochód miesiąca”)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    tables = {
      invoices: [
        invoice('zal-1', {
          invoice_kind: 'advance', issue_date: '2027-01-12',
          net_total: 10000, vat_total: 2300, gross_total: 12300,
        }),
        invoice('roz-1', {
          invoice_kind: 'final', advance_invoice_ids: ['zal-1'], issue_date: '2027-02-04',
          net_total: 30000, vat_total: 6900, gross_total: 36900,
        }),
        invoice('vat-1', { issue_date: '2027-02-10', net_total: 1234.56, vat_total: 283.95, gross_total: 1518.51 }),
        // Szkic nie jest sprzedażą ani na Pulpicie, ani na /przeplywy.
        invoice('szkic', {
          issue_date: '2027-02-11', ksef_status: 'draft', ksef_environment: null,
          net_total: 50000, vat_total: 11500, gross_total: 61500,
        }),
      ],
      expenses: [
        expense('exp-paragon', {
          issue_date: '2027-02-05', document_type: 'receipt',
          net_amount: 100, vat_amount: 23, gross_amount: 123, vat_deductible_amount: 0,
        }),
        expense('exp-faktura', {
          issue_date: '2027-02-08', document_type: 'invoice',
          net_amount: 500.1, vat_amount: 115.02, gross_amount: 615.12, vat_deductible_amount: 115.02,
        }),
        expense('exp-styczen', {
          issue_date: '2027-01-20', document_type: 'invoice',
          net_amount: 800, vat_amount: 184, gross_amount: 984, vat_deductible_amount: 184,
        }),
        // Nie koszt — odpada w obu miejscach.
        expense('exp-prywatny', {
          issue_date: '2027-02-09', document_type: 'invoice', is_deductible: false,
          net_amount: 9000, vat_amount: 2070, gross_amount: 11070, vat_deductible_amount: 2070,
        }),
      ],
    };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('te same dane dają tę samą kwotę zysku miesiąca', async () => {
    const supabase = database();

    // Pulpit: seria 12 miesięcy netto + koszty z jednej drogi odczytu.
    const series = await getSalesSeries(supabase, TENANT, NOW, { months: 12, withPrevYear: false });
    const costs = await getCosts(supabase, TENANT, {
      from: `${series.months[0]!.key}-01`,
      toExclusive: '2027-03-01',
    });
    const report = buildMonthReport(
      series.netSeries,
      sumCostsByMonth(costs, series.months.map((m) => m.key)),
    );

    // /przeplywy: odczyt strony (od E5 w `getCashFlowData`) i jej karta „Ten miesiąc”.
    const cashFlow = await getCashFlowData(supabase, TENANT, NOW);
    const html = renderToStaticMarkup(
      <KpirFinanceCard
        months={cashFlow.months}
        revenue={cashFlow.revenue}
        costs={cashFlow.costs}
        profit={cashFlow.profit}
        report={cashFlow.report}
        revenueChangePct={cashFlow.revenueChangePct}
        costsHint="none"
      />,
    );

    // 20 000 (ROZ bez zaliczki) + 1 234,56 − (123 paragon + 500,10 faktura).
    expect(report.revenue).toBe(21234.56);
    expect(report.costs).toBe(623.1);
    expect(report.profit).toBe(20611.46);
    // Średnia też ta sama: /przeplywy liczy ją z 11 pełnych miesięcy jak Pulpit.
    expect(cashFlow.report).toEqual(report);
    expect(cashFlowProfitLabel(html)).toBe(`${formatPlMoney(report.profit)} zł`);
  });
});
