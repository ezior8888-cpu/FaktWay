import { RiBox3Line, RiMoreLine, RiUser3Line } from '@remixicon/react';

import { dailyTotals } from '@/lib/analytics-finance/breakdown';
import { clientMovers, clientShares } from '@/lib/analytics-finance/clients';
import { costOfMonth } from '@/lib/analytics-finance/costs';
import {
  currentMonthKey,
  HEATMAP_DAYS,
  monthKeysEnding,
  shiftMonthKey,
  TREND_MONTHS,
} from '@/lib/analytics-finance/months';
import { productBreakdown } from '@/lib/analytics-finance/products';
import { RECURRING_MONTHS, recurringClients } from '@/lib/analytics-finance/recurring';
import { salesMonthStats, salesOfMonth, salesTrend, type SaleInvoice } from '@/lib/analytics-finance/sales';
import { inflowTerms } from '@/lib/dashboard/inflow-terms';
import { PRODUCTS_NOTE } from '@/lib/dashboard/rankings';
import type { TrybDanych } from '@/lib/demo/tryb-danych';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { plural } from '@/lib/i18n/plural';

import {
  incomeExpenseNet,
  isAllZero,
  isOtherSlice,
  RECURRING_LIST_LIMIT,
  receivablesRows,
  receivablesRowsPrzyklad,
  recentSaleItems,
  salesAvgDaily,
  toCategorySlices,
  toRankedItems,
  toSubscriptionItems,
  toTrendData,
} from './adapters';
import { AnalizySiatka, loadAnalizyCard, type AnalizyCardProps, type AnalizyKarta } from './card-slot';
import CategoryBreakdownChart from './finora-1do1/category-breakdown-chart';
import CategoryRankedList from './finora-1do1/category-ranked-list';
import IncomeExpenseSummary from './finora-1do1/income-expense-summary';
import MonthlyStatsCards from './finora-1do1/monthly-stats-cards';
import RecentExpensesFeed from './finora-1do1/recent-expenses-feed';
import SpendHeatmap from './finora-1do1/spend-heatmap';
import SpendTrendChart from './finora-1do1/spend-trend-chart';
import SpendingStreaksCard from './finora-1do1/spending-streaks-card';
import SubscriptionsCard from './finora-1do1/subscriptions-card';
import AssetAllocationCard from './finora/chart-asset-allocation';
import { ANALIZY_EMPTY, type EmptyStateProps } from './finora/empty';
import MoverListCard from './finora/mover-list-card';
import { loadCostsWindow, loadProductLines, loadReceivables, loadSalesWindow, loadUpcomingInflows } from './loaders';
import { pobieramy } from './podpisy';

/**
 * Analiza sprzedaży `/analizy/sprzedaz` — poprawka Bartosza 21.10.2026:
 * Analizy 1:1 z Finory (Monthly Analytics drugi raz, ten sam układ co koszty).
 * Siatka `grid gap-6 md:grid-cols-4` z dziewięcioma kartami Finory w tej samej
 * kolejności i z tymi samymi rozpiętościami — bez dodatkowego rzędu pod
 * spodem. Karty to kopie z `finora-1do1/`, dane — prawdziwe, przez czyste
 * adaptery (`./adapters`). Faktury jednym odczytem `getSalesInvoices`
 * (§2.4 pkt 2, 4–7), produkty `fetchProductLines` (§2.4 pkt 13), należności
 * `getReceivables` (§2.4 pkt 11). Każda karta osobno
 * w `SectionErrorBoundary` z własną kartą błędu (§2.4 pkt 15); strona czeka
 * na wszystkie naraz (`AnalizySiatka`, bez szkieletów — poprawka 23.10.2026).
 */

type CardProps = AnalizyCardProps & { className?: string };

/**
 * Okno bez żadnej faktury: „wystaw pierwszą fakturę” (§7.3); w stanie B
 * (`synchronizacja`) historia sprzedaży się pobiera — „Pobieramy faktury z KSeF…”.
 */
function noInvoices(tryb: TrybDanych): EmptyStateProps {
  return tryb === 'synchronizacja' ? pobieramy() : ANALIZY_EMPTY.noInvoices;
}

/** Pusty miesiąc: bez żadnej faktury w oknie — stan firmy, z fakturami w innym miesiącu — „brak sprzedaży”. */
function salesEmpty(invoices: readonly SaleInvoice[], tryb: TrybDanych): EmptyStateProps {
  return invoices.length === 0 ? noInvoices(tryb) : ANALIZY_EMPTY.noSalesThisMonth;
}

/**
 * Należności: faktury bez oznaczonej zapłaty, także po terminie (D-W odwołane
 * 02.11.2026). Krótki podpis, pełne zdanie w dymku.
 */
const RECEIVABLES_CAPTION = 'Faktury z FaktWay bez oznaczonej zapłaty';
const RECEIVABLES_CAPTION_TITLE =
  'Faktury z FaktWay bez oznaczonej zapłaty, bez importów i faktur skorygowanych. Gdy klient zapłaci, dotknij „Zapłacone” przy fakturze.';
/** Atrapa bazy nie ma wpłat: jej należności to same przyszłe terminy. */
const RECEIVABLES_CAPTION_DEMO = 'Faktury sprzedaży z terminem od dziś';

const inMonth = (invoices: readonly SaleInvoice[], month: string) =>
  invoices.filter((inv) => inv.issueDate.slice(0, 7) === month);

/** Produkty: miesiąc bez faktur to brak sprzedaży; faktury bez pozycji produktowych — osobny komunikat. */
function productsEmpty(invoices: readonly SaleInvoice[], month: string, tryb: TrybDanych): EmptyStateProps {
  return inMonth(invoices, month).length === 0 ? salesEmpty(invoices, tryb) : ANALIZY_EMPTY.noProducts;
}

export async function SalesStatsSlot({ supabase, tenantId, nowIso, month, className }: CardProps) {
  return loadAnalizyCard('Sprzedaż miesiąca', className, async () => {
    const invoices = await loadSalesWindow(supabase, tenantId, nowIso);
    const stats = salesMonthStats(invoices, month, shiftMonthKey(month, -1));
    return (
      <MonthlyStatsCards
        stats={{
          totalSpend: stats.total,
          // Finorowy kafel „Avg Daily” — ta sama reguła dni co w kosztach (D9).
          avgDailySpend: salesAvgDaily(stats.total, month, todayInWarsaw(new Date(nowIso))),
          vsLastMonthPercentage: stats.changePct,
          topCategory: stats.bestClient,
        }}
        labels={{
          totalSpend: 'Sprzedano (netto)',
          avgDailySpend: 'Średnio dziennie',
          vsLastMonth: 'vs poprzedni miesiąc',
          topCategory: 'Najlepszy klient',
          noPreviousMonth: 'Brak sprzedaży w poprzednim miesiącu',
        }}
        topCategoryIcon={RiUser3Line}
        className={className}
      />
    );
  });
}

export async function SalesTrendSlot({ supabase, tenantId, nowIso, tryb, className }: CardProps) {
  return loadAnalizyCard('Trend sprzedaży', className, async () => {
    const invoices = await loadSalesWindow(supabase, tenantId, nowIso);
    // Miesiąc z korektą in minus rysuje się jako słupek ujemny — tak, jak jest.
    const data = toTrendData(salesTrend(invoices, monthKeysEnding(currentMonthKey(new Date(nowIso)), TREND_MONTHS)));
    // Słupki Finory zawsze; pusto tylko, gdy wszystkie 6 miesięcy to zero (D8).
    const empty = isAllZero(data)
      ? invoices.length === 0
        ? noInvoices(tryb)
        : ANALIZY_EMPTY.noSalesInTrend
      : null;
    return (
      <SpendTrendChart
        title="Trend sprzedaży"
        description="Sprzedaż netto w ostatnich 6 miesiącach"
        seriesLabel="Sprzedaż"
        data={data}
        empty={empty}
        className={className}
      />
    );
  });
}

export async function ProductsChartSlot({ supabase, tenantId, nowIso, month, tryb, className }: CardProps) {
  return loadAnalizyCard('Sprzedaż według produktów', className, async () => {
    const [lines, invoices] = await Promise.all([
      loadProductLines(supabase, tenantId, month),
      loadSalesWindow(supabase, tenantId, nowIso),
    ]);
    return (
      <CategoryBreakdownChart
        title="Sprzedaż według produktów"
        description={`${PRODUCTS_NOTE} · wybrany miesiąc`}
        data={toCategorySlices(productBreakdown(lines))}
        empty={productsEmpty(invoices, month, tryb)}
        className={className}
      />
    );
  });
}

export async function ProductsListSlot({ supabase, tenantId, nowIso, month, tryb, className }: CardProps) {
  return loadAnalizyCard('Najlepsze produkty i usługi', className, async () => {
    const [lines, invoices] = await Promise.all([
      loadProductLines(supabase, tenantId, month),
      loadSalesWindow(supabase, tenantId, nowIso),
    ]);
    return (
      <CategoryRankedList
        title="Najlepsze produkty i usługi"
        description={`${PRODUCTS_NOTE} · netto`}
        data={toRankedItems(toCategorySlices(productBreakdown(lines)), (s) =>
          isOtherSlice(s) ? RiMoreLine : RiBox3Line)}
        empty={productsEmpty(invoices, month, tryb)}
        className={className}
      />
    );
  });
}

export async function RecentSalesSlot({ supabase, tenantId, nowIso, month, tryb, className }: CardProps) {
  return loadAnalizyCard('Ostatnie faktury', className, async () => {
    const invoices = await loadSalesWindow(supabase, tenantId, nowIso);
    return (
      <RecentExpensesFeed
        title="Ostatnie faktury"
        // Poprawka 21.10.2026: `getSalesInvoices` czyta tylko faktury przyjęte w KSeF —
        // opis musi to mówić (Pulpit pokazuje wszystkie statusy), a mieścić się w linii.
        description="Przyjęte w KSeF w wybranym miesiącu · brutto"
        data={recentSaleItems(invoices, month, tryb !== 'przyklad')}
        direction="in"
        empty={salesEmpty(invoices, tryb)}
        className={className}
      />
    );
  });
}

export async function ReceivablesSlot({ supabase, tenantId, nowIso, tryb, className }: CardProps) {
  return loadAnalizyCard('Należności', className, async () => {
    if (tryb === 'przyklad') {
      const terms = inflowTerms(await loadUpcomingInflows(supabase, tenantId, nowIso), todayInWarsaw(new Date(nowIso)));
      return (
        <SpendingStreaksCard
          title="Należności"
          description={RECEIVABLES_CAPTION_DEMO}
          rows={receivablesRowsPrzyklad(terms)}
          className={className}
        />
      );
    }
    const r = await loadReceivables(supabase, tenantId, nowIso);
    const skipped = r.foreignCurrencyCount > 0
      ? ` · pominięto ${r.foreignCurrencyCount} ${plural(r.foreignCurrencyCount, ['fakturę', 'faktury', 'faktur'])} w walucie obcej`
      : '';
    return (
      <SpendingStreaksCard
        title="Należności"
        description={`${RECEIVABLES_CAPTION}${skipped}`}
        descriptionTitle={RECEIVABLES_CAPTION_TITLE}
        rows={receivablesRows(r)}
        className={className}
      />
    );
  });
}

export async function SalesIncomeExpenseSlot({ supabase, tenantId, nowIso, month, className }: CardProps) {
  return loadAnalizyCard('Przychody a koszty', className, async () => {
    const [sales, costs] = await Promise.all([
      loadSalesWindow(supabase, tenantId, nowIso),
      loadCostsWindow(supabase, tenantId, nowIso),
    ]);
    return (
      <IncomeExpenseSummary data={incomeExpenseNet(salesOfMonth(sales, month), costOfMonth(costs, month))} className={className} />
    );
  });
}

export async function RecurringClientsSlot({ supabase, tenantId, nowIso, tryb, className }: CardProps) {
  return loadAnalizyCard('Stali klienci', className, async () => {
    const invoices = await loadSalesWindow(supabase, tenantId, nowIso);
    const months = monthKeysEnding(currentMonthKey(new Date(nowIso)), RECURRING_MONTHS);
    return (
      <SubscriptionsCard
        title="Stali klienci"
        description="Nabywcy z fakturą w 3 z 4 ostatnich miesięcy · netto"
        data={toSubscriptionItems(recurringClients(invoices, months, RECURRING_LIST_LIMIT), 'client', tryb !== 'przyklad')}
        empty={ANALIZY_EMPTY.noRecurringClients}
        className={className}
      />
    );
  });
}

export async function SalesHeatmapSlot({ supabase, tenantId, nowIso, tryb, className }: CardProps) {
  return loadAnalizyCard('Kalendarz sprzedaży', className, async () => {
    const invoices = await loadSalesWindow(supabase, tenantId, nowIso);
    const days = dailyTotals(invoices, (inv) => inv.issueDate, (inv) => inv.net, todayInWarsaw(new Date(nowIso)), HEATMAP_DAYS);
    return (
      <SpendHeatmap
        title="Kalendarz sprzedaży"
        // Poprawka 21.10.2026: „mocniejszy kolor” zamiast „ciemniejsze pole” (w ciemnym
        // motywie więcej sprzedaży = jaśniej), jedna linia jak w Finorze, „netto” zostaje.
        description={`Ostatnie ${HEATMAP_DAYS} dni · netto — mocniejszy kolor to więcej`}
        data={days}
        // Siatka Finory zawsze, gdy w oknie jest choć jedna faktura; pusto tylko bez żadnej (D10).
        empty={invoices.length === 0 ? noInvoices(tryb) : null}
        className={className}
      />
    );
  });
}

// Poza siatką 1:1 z Finory (decyzja Bartosza 21.10.2026: „na razie wszystko 1:1”) — wrócimy do tego.
export async function ClientSharesSlot({ supabase, tenantId, nowIso, month, tryb, className }: CardProps) {
  return loadAnalizyCard('Udział klientów w przychodach', className, async () => {
    const invoices = await loadSalesWindow(supabase, tenantId, nowIso);
    const shares = clientShares(inMonth(invoices, month));
    return (
      <AssetAllocationCard data={shares.slices} concentrated={shares.concentrated} empty={salesEmpty(invoices, tryb)} className={className} />
    );
  });
}

/** Okno „rośnie / spada”: 3 miesiące z bieżącym wobec 3 poprzednich. */
function moversWindow(nowIso: string) {
  const current = currentMonthKey(new Date(nowIso));
  return {
    prevFrom: `${shiftMonthKey(current, -5)}-01`,
    currentFrom: `${shiftMonthKey(current, -2)}-01`,
    toExclusive: `${shiftMonthKey(current, 1)}-01`,
  };
}

// Poza siatką 1:1 z Finory (decyzja Bartosza 21.10.2026: „na razie wszystko 1:1”) — wrócimy do tego.
export async function ClientMoversSlot({
  supabase,
  tenantId,
  nowIso,
  mode,
  tryb,
  className,
}: CardProps & { mode: 'gainers' | 'losers' }) {
  return loadAnalizyCard(mode === 'gainers' ? 'Klienci: rośnie' : 'Klienci: spada', className, async () => {
    const invoices = await loadSalesWindow(supabase, tenantId, nowIso);
    const movers = clientMovers(invoices, moversWindow(nowIso));
    return (
      <MoverListCard
        mode={mode}
        items={mode === 'gainers' ? movers.gainers : movers.losers}
        empty={invoices.length === 0 ? noInvoices(tryb) : mode === 'gainers' ? ANALIZY_EMPTY.noGainers : ANALIZY_EMPTY.noLosers}
        className={className}
      />
    );
  });
}

/**
 * Siatka `/analizy/sprzedaz`. Dziewięć kart Monthly Analytics Finory w jej kolejności
 * i rozpiętościach: tytuł karty błędu, klasa siatki, karta.
 */
export const SIATKA_SPRZEDAZY: readonly AnalizyKarta[] = [
  ['Sprzedaż miesiąca', 'md:col-span-4', SalesStatsSlot],
  ['Trend sprzedaży', 'md:col-span-2 2xl:col-span-3', SalesTrendSlot],
  ['Sprzedaż według produktów', 'md:max-2xl:col-span-2', ProductsChartSlot],
  ['Najlepsze produkty i usługi', 'md:col-span-2', ProductsListSlot],
  ['Ostatnie faktury', 'md:col-span-2', RecentSalesSlot],
  ['Należności', 'md:col-span-2', ReceivablesSlot],
  ['Przychody a koszty', 'md:col-span-2', SalesIncomeExpenseSlot],
  ['Stali klienci', 'md:col-span-2', RecurringClientsSlot],
  ['Kalendarz sprzedaży', 'md:col-span-2', SalesHeatmapSlot],
];

/** Wszystkie karty naraz, bez szkieletów (`AnalizySiatka`, poprawka Bartosza 23.10.2026). */
export function SprzedazGrid(props: AnalizyCardProps) {
  return <AnalizySiatka {...props} karty={SIATKA_SPRZEDAZY} />;
}
