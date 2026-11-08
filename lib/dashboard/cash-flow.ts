import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { kpirRevenueNet } from '@/lib/categorization/kpir-revenue';
import { getCostsWithKsefPurchases, type CostEntry } from '@/lib/dashboard/costs';
import { assertAcceptedEnvironmentKnown } from '@/lib/dashboard/monthly-figures';
import { buildMonthReport, type MonthReport } from '@/lib/dashboard/pulpit-report';
import { estimateIncomeTaxThisYear, type TaxEstimate } from '@/lib/dashboard/tax-estimate';
import { assertOutgoingInvoicesInPln } from '@/lib/exports/currency-guard';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { fetchSettledAdvancesNet } from '@/lib/invoices/settled-advances';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import type { PageContext } from '@/lib/supabase/page-context';
import { roundToCents } from '@/lib/xml/invoice-calculator';
import type { Database } from '@/types/database';

/**
 * Odczyt liczb „jak w KPiR” dla `/przeplywy` (plan Finora E5) — przeniesiony
 * ze strony `app/(dashboard)/przeplywy/page.tsx` i `CashFlowDashboard` bez
 * zmiany reguł:
 *
 * - przychód = netto faktur sprzedaży PRZYJĘTYCH w aktywnym środowisku KSeF
 *   (§2.4 pkt 2), ROZ bez zaliczek już policzonych (`kpirRevenueNet`, §2.4
 *   pkt 4), korekta swoją różnicą w swoim miesiącu (pkt 5), tylko PLN (pkt 6),
 *   komplet stron (pkt 7);
 * - koszt = `getCostsWithKsefPurchases` (E10, decyzja D-K): wydatki jak
 *   w KPiR (`kpirCostAmount`) i faktury zakupu z KSeF bez wydatku netto —
 *   pełne koszty kart; sama KPiR (`/reports/kpir`) czyta tylko wydatki;
 * - szacunek podatku = `estimateIncomeTaxThisYear` od 1 stycznia (C-21).
 *
 * Nowe wobec starej strony: przyjęta faktura bez środowiska KSeF w oknie
 * zatrzymuje odczyt tym samym komunikatem co Pulpit (`assertAcceptedEnvironmentKnown`).
 *
 * Okno: sześć miesięcy kalendarzowych z bieżącym (wykres „Przychody
 * i koszty”) albo od 1 stycznia, jeśli to wcześniej (szacunek podatku), do
 * końca bieżącego roku. Miesiąc i rok w Europe/Warsaw (§2.4 pkt 10).
 *
 * Przychód czytamy dłużej — 12 miesięcy z bieżącym — bo „Średnio
 * miesięcznie” w karcie „Ten miesiąc” to średnia z 11 pełnych miesięcy, jak
 * na Pulpicie (plan Finora P1: te same komponenty i ta sama liczba). Strażniki
 * faktur sprzedaży (PLN, środowisko) obejmują przez to te same 12 miesięcy
 * co karta Pulpitu.
 */

export const CASH_FLOW_KPIR_MONTHS = 6;

/** Okno średniej miesięcznej: 11 pełnych miesięcy + bieżący (jak `SALES_MONTHS` Pulpitu). */
export const CASH_FLOW_AVERAGE_MONTHS = 12;

export type CashFlowInvoiceRow = Pick<
  Database['public']['Tables']['invoices']['Row'],
  'id' | 'issue_date' | 'net_total' | 'gross_total' | 'invoice_kind' | 'advance_invoice_ids' | 'currency'
> & {
  /** ROZ: suma netto zaliczek, które już są w przychodzie (`fetchSettledAdvancesNet`). */
  settled_advances_net: number | null;
};

export interface CashFlowMonth {
  /** RRRR-MM. */
  key: string;
  /** „Lis” — podpis osi. */
  label: string;
  /** „lis 2026” — podpis w dymku i w tabeli miesięcy. */
  longLabel: string;
}

export interface CashFlowData {
  /** Pierwszy dzień odczytu (RRRR-MM-DD). */
  dataFrom: string;
  months: CashFlowMonth[];
  /** Przychód netto jak w KPiR per miesiąc, PLN (do groszy). */
  revenue: number[];
  /** Koszt per miesiąc (wydatki jak w KPiR + faktury zakupu z KSeF bez wydatku), PLN (do groszy). */
  costs: number[];
  /** `revenue − costs` per miesiąc. */
  profit: number[];
  /** „Ten miesiąc” — ta sama funkcja co na Pulpicie (`buildMonthReport`). */
  report: MonthReport;
  /** Zmiana przychodu vs poprzedni miesiąc w procentach; `null`, gdy poprzedni ≤ 0. */
  revenueChangePct: number | null;
  taxEstimate: TaxEstimate;
  /** Wiersze faktur, z których liczony jest przychód (posortowane: data, id). */
  invoices: CashFlowInvoiceRow[];
  /** Koszty z `getCostsWithKsefPurchases` z tego samego okna. */
  costEntries: CostEntry[];
}

const INVOICE_COLUMNS = 'id, issue_date, net_total, gross_total, invoice_kind, advance_invoice_ids, currency';

function monthKey(year: number, monthIndex: number): string {
  const d = new Date(Date.UTC(year, monthIndex, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabels(key: string): { label: string; longLabel: string } {
  const d = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1));
  const short = d
    .toLocaleDateString('pl-PL', { month: 'short', timeZone: 'UTC' })
    .replace(/\./g, '')
    .trim();
  return {
    label: short.charAt(0).toUpperCase() + short.slice(1),
    longLabel: `${short} ${d.getUTCFullYear()}`,
  };
}

export async function getCashFlowData(
  supabase: PageContext['supabase'],
  tenantId: string,
  now: Date = new Date(),
): Promise<CashFlowData> {
  const environment = requireConfiguredKsefEnvironment();

  // Miesiąc i rok w czasie polskim, bez `toISOString()` z lokalnej północy
  // (w strefie polskiej cofało początek o dzień: 1 maja → 30 kwietnia),
  // a serwer chodzi w UTC.
  const [year, month] = todayInWarsaw(now).split('-').map(Number) as [number, number];
  const months: CashFlowMonth[] = Array.from({ length: CASH_FLOW_KPIR_MONTHS }, (_, i) => {
    const key = monthKey(year, month - 1 - (CASH_FLOW_KPIR_MONTHS - 1) + i);
    return { key, ...monthLabels(key) };
  });
  const averageKeys = Array.from({ length: CASH_FLOW_AVERAGE_MONTHS }, (_, i) =>
    monthKey(year, month - 1 - (CASH_FLOW_AVERAGE_MONTHS - 1) + i));
  // 11 miesięcy wstecz to zawsze najpóźniej styczeń — wcześniej niż `dataFrom`.
  const revenueFrom = `${averageKeys[0]!}-01`;
  const chartStart = `${months[0]!.key}-01`;
  // C-21: szacunek podatku liczy się od 1 stycznia, a wykres pokazuje sześć
  // miesięcy — dane od wcześniejszej z tych dat.
  const yearStart = `${year}-01-01`;
  const dataFrom = yearStart < chartStart ? yearStart : chartStart;
  const endExclusive = `${year + 1}-01-01`;

  const [invoices, costEntries] = await Promise.all([
    readCompletePages('Nie można odczytać przychodów', (from, to) =>
      supabase
        .from('invoices')
        .select(INVOICE_COLUMNS, { count: 'exact' })
        .eq('tenant_id', tenantId)
        .eq('direction', 'outgoing')
        .eq('ksef_status', 'accepted')
        .eq('ksef_environment', environment)
        .gte('issue_date', revenueFrom)
        .lt('issue_date', endExclusive)
        .order('id', { ascending: true })
        .range(from, to)),
    getCostsWithKsefPurchases(supabase, tenantId, { from: dataFrom, toExclusive: endExclusive }),
  ]);
  // Przyjęta faktura bez środowiska mogłaby być z TEST albo z produkcji —
  // zero zamiast niej ukryłoby niejasność (jak na Pulpicie).
  await assertAcceptedEnvironmentKnown(supabase, tenantId, revenueFrom, endExclusive);
  invoices.sort((a, b) => a.issue_date.localeCompare(b.issue_date) || a.id.localeCompare(b.id));
  // C-11: sumy w złotych — faktura sprzedaży w walucie obcej zatrzymuje odczyt.
  assertOutgoingInvoicesInPln(invoices);

  // Przychód jak w KPiR: ROZ bez zaliczek, które już są w przychodzie.
  // Błąd odczytu rzuca — zerowa suma zaliczek zawyżyłaby dochód i podatek.
  const settled = await fetchSettledAdvancesNet(supabase, tenantId, invoices);
  const allInvoiceRows: CashFlowInvoiceRow[] = invoices.map((inv) => ({
    ...inv,
    settled_advances_net: settled.get(inv.id) ?? null,
  }));
  // Wykres i szacunek podatku — jak dotąd od `dataFrom`; starsze faktury
  // służą tylko średniej miesięcznej.
  const invoiceRows = allInvoiceRows.filter((inv) => inv.issue_date >= dataFrom);

  const revenueByMonth = new Map<string, number>();
  for (const inv of allInvoiceRows) {
    const key = inv.issue_date.slice(0, 7);
    revenueByMonth.set(
      key,
      (revenueByMonth.get(key) ?? 0) +
        kpirRevenueNet({ kind: inv.invoice_kind, net: inv.net_total, settledAdvancesNet: inv.settled_advances_net }),
    );
  }
  const costByMonth = new Map<string, number>();
  for (const cost of costEntries) {
    const key = cost.issueDate.slice(0, 7);
    costByMonth.set(key, (costByMonth.get(key) ?? 0) + cost.cost);
  }
  const revenue = months.map((m) => roundToCents(revenueByMonth.get(m.key) ?? 0) || 0);
  const costs = months.map((m) => roundToCents(costByMonth.get(m.key) ?? 0) || 0);
  const profit = months.map((_, i) => roundToCents(revenue[i]! - costs[i]!) || 0);

  // `buildMonthReport` bierze z kosztów tylko bieżący miesiąc (jest w oknie
  // kosztów), a średnią liczy z przychodu — koszty sprzed `dataFrom` to zera.
  const averageRevenue = averageKeys.map((key) => roundToCents(revenueByMonth.get(key) ?? 0) || 0);
  const averageCosts = averageKeys.map((key) => roundToCents(costByMonth.get(key) ?? 0) || 0);

  const current = revenue[revenue.length - 1]!;
  const previous = revenue[revenue.length - 2]!;

  return {
    dataFrom,
    months,
    revenue,
    costs,
    profit,
    report: buildMonthReport(averageRevenue, averageCosts),
    revenueChangePct: previous > 0 ? ((current - previous) / previous) * 100 : null,
    // PIT liczy się od 1 stycznia, nie z okna sześciu miesięcy wykresu.
    taxEstimate: estimateIncomeTaxThisYear(
      invoiceRows,
      costEntries.map((c) => ({ issue_date: c.issueDate, cost: c.cost })),
      now,
      dataFrom,
    ),
    invoices: invoiceRows,
    costEntries,
  };
}

/**
 * Wydatki czekające na akceptację (baner nad siatką). Błąd odczytu = brak
 * banera, jak na starej stronie: baner to skrót, nie liczba rozliczeniowa.
 */
export async function countPendingReview(
  supabase: PageContext['supabase'],
  tenantId: string,
): Promise<number> {
  try {
    const { count, error } = await supabase
      .from('expenses')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('is_reviewed', false);
    if (error || typeof count !== 'number' || count < 0) return 0;
    return count;
  } catch {
    return 0;
  }
}
