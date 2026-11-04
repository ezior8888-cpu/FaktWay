import { costCategoryBreakdown, costMonthStats, costOfMonth, costTrend, costVatSummary } from '@/lib/analytics-finance/costs';
import { dailyTotals } from '@/lib/analytics-finance/breakdown';
import { HEATMAP_DAYS, monthKeysEnding, shiftMonthKey, TREND_MONTHS, currentMonthKey } from '@/lib/analytics-finance/months';
import { RECURRING_MONTHS, recurringSuppliers } from '@/lib/analytics-finance/recurring';
import { salesOfMonth } from '@/lib/analytics-finance/sales';
import type { CostEntry } from '@/lib/dashboard/costs';
import type { TrybDanych } from '@/lib/demo/tryb-danych';
import { todayInWarsaw } from '@/lib/format/warsaw-date';

import {
  costVatRows,
  incomeExpenseNet,
  isAllZero,
  RECURRING_LIST_LIMIT,
  recentCostItems,
  toCategorySlices,
  toRankedItems,
  toSubscriptionItems,
  toTrendData,
} from './adapters';
import { AnalizySiatka, loadAnalizyCard, type AnalizyCardProps, type AnalizyKarta } from './card-slot';
import CategoryBreakdownChart from './finora-1do1/category-breakdown-chart';
import CategoryRankedList from './finora-1do1/category-ranked-list';
import { costCategoryIcon } from './finora-1do1/expense-category-icons';
import IncomeExpenseSummary from './finora-1do1/income-expense-summary';
import MonthlyStatsCards from './finora-1do1/monthly-stats-cards';
import RecentExpensesFeed from './finora-1do1/recent-expenses-feed';
import SpendHeatmap from './finora-1do1/spend-heatmap';
import SpendTrendChart from './finora-1do1/spend-trend-chart';
import SpendingStreaksCard from './finora-1do1/spending-streaks-card';
import SubscriptionsCard from './finora-1do1/subscriptions-card';
import { ANALIZY_EMPTY, type EmptyStateProps } from './finora/empty';
import { loadCostsWindow, loadSalesWindow } from './loaders';
import { ksefOd, oknoKalendarzaOd, oknoKosztowOd, podpisKosztow, pobieramy } from './podpisy';

/**
 * Analiza kosztów `/analizy/koszty` — poprawka Bartosza 21.10.2026: Analizy
 * 1:1 z Finory (`money-management/monthly-analytics/index.tsx`). Siatka
 * `grid gap-6 md:grid-cols-4` z dziewięcioma kartami Monthly Analytics w tej
 * samej kolejności i z tymi samymi rozpiętościami; karty to kopie
 * z `finora-1do1/`, a dane — prawdziwe, przez czyste adaptery
 * (`./adapters`). Każda karta osobno w `SectionErrorBoundary` z własną kartą
 * błędu (§2.4 pkt 15), strona czeka na wszystkie naraz (`AnalizySiatka`, bez
 * szkieletów — poprawka 23.10.2026); koszty jedną drogą `getCostsWithKsefPurchases` (faktury
 * zakupu z KSeF + wydatki spoza KSeF, E10), czytane raz na żądanie
 * (`loadCostsWindow`).
 */

type CardProps = AnalizyCardProps & { className?: string };

/**
 * Pusty miesiąc bez żadnego kosztu w oknie, zależny od trybu danych
 * (`kontekstDanych`, jedno źródło decyzji): `przyklad` — „Podłącz KSeF” (§7.3),
 * `synchronizacja` — „Pobieramy faktury z KSeF…”, `prawdziwe` — zwykły pusty miesiąc.
 */
function costsEmpty(entries: readonly CostEntry[], tryb: TrybDanych): EmptyStateProps {
  if (entries.length > 0) return ANALIZY_EMPTY.noCostsThisMonth;
  if (tryb === 'synchronizacja') return pobieramy();
  return tryb === 'przyklad' ? ANALIZY_EMPTY.connectKsef : ANALIZY_EMPTY.noCostsThisMonth;
}

/**
 * Pusty stan kart całego okna (trend, kalendarz): tylko, gdy w oknie nie ma
 * ŻADNEGO wydatku — wtedy zera byłyby nieprawdą (świeża firma albo koszty
 * bez KSeF). Z choćby jednym wydatkiem wykres Finory rysuje się zawsze (`null`).
 */
function costsWindowEmpty(
  entries: readonly CostEntry[],
  inWindow: EmptyStateProps,
  tryb: TrybDanych,
): EmptyStateProps | null {
  if (entries.length > 0) return null;
  if (tryb === 'synchronizacja') return pobieramy();
  return tryb === 'przyklad' ? ANALIZY_EMPTY.connectKsef : inWindow;
}

export async function CostStatsSlot({ supabase, tenantId, nowIso, month, className }: CardProps) {
  return loadAnalizyCard('Wydatki miesiąca', className, async () => {
    const entries = await loadCostsWindow(supabase, tenantId, nowIso);
    const stats = costMonthStats(entries, month, shiftMonthKey(month, -1), todayInWarsaw(new Date(nowIso)));
    return (
      <MonthlyStatsCards
        stats={{
          totalSpend: stats.total,
          avgDailySpend: stats.avgDaily,
          vsLastMonthPercentage: stats.changePct,
          topCategory: stats.topCategory,
        }}
        labels={{
          totalSpend: 'Dokumenty (brutto)',
          avgDailySpend: 'Średnio dziennie',
          vsLastMonth: 'vs poprzedni miesiąc',
          topCategory: 'Największa kategoria',
          noPreviousMonth: 'Brak wydatków w poprzednim miesiącu',
        }}
        className={className}
      />
    );
  });
}

export async function CostTrendSlot({ supabase, tenantId, nowIso, tryb, kosztyKsefOd, className }: CardProps) {
  return loadAnalizyCard('Trend wydatków', className, async () => {
    const entries = await loadCostsWindow(supabase, tenantId, nowIso);
    const data = toTrendData(costTrend(entries, monthKeysEnding(currentMonthKey(new Date(nowIso)), TREND_MONTHS)));
    // Słupki Finory zawsze, także z jednym miesiącem; pusto tylko, gdy wszystkie 6 to zero (D8).
    const empty = isAllZero(data)
      ? (costsWindowEmpty(entries, ANALIZY_EMPTY.noCostsInTrend, tryb) ?? ANALIZY_EMPTY.noCostsInTrend)
      : null;
    return (
      <SpendTrendChart
        title="Trend wydatków"
        description={podpisKosztow('brutto, 6 mies.', ksefOd(tryb, kosztyKsefOd, oknoKosztowOd(nowIso)))}
        seriesLabel="Wydatki"
        data={data}
        empty={empty}
        className={className}
      />
    );
  });
}

export async function CostCategoriesChartSlot({ supabase, tenantId, nowIso, month, tryb, kosztyKsefOd, className }: CardProps) {
  return loadAnalizyCard('Wydatki według kategorii', className, async () => {
    const entries = await loadCostsWindow(supabase, tenantId, nowIso);
    return (
      <CategoryBreakdownChart
        title="Wydatki według kategorii"
        description={podpisKosztow('wybrany miesiąc', ksefOd(tryb, kosztyKsefOd, month))}
        data={toCategorySlices(costCategoryBreakdown(entries, month))}
        empty={costsEmpty(entries, tryb)}
        className={className}
      />
    );
  });
}

export async function CostCategoriesListSlot({ supabase, tenantId, nowIso, month, tryb, className }: CardProps) {
  return loadAnalizyCard('Największe kategorie', className, async () => {
    const entries = await loadCostsWindow(supabase, tenantId, nowIso);
    return (
      <CategoryRankedList
        title="Największe kategorie"
        description="Według kwoty wydanej w wybranym miesiącu"
        data={toRankedItems(toCategorySlices(costCategoryBreakdown(entries, month)), (s) => costCategoryIcon(s.label))}
        empty={costsEmpty(entries, tryb)}
        className={className}
      />
    );
  });
}

export async function RecentCostsSlot({ supabase, tenantId, nowIso, month, tryb, className }: CardProps) {
  return loadAnalizyCard('Ostatnie wydatki', className, async () => {
    const entries = await loadCostsWindow(supabase, tenantId, nowIso);
    return (
      <RecentExpensesFeed
        title="Ostatnie wydatki"
        description="Najnowsze wydatki z wybranego miesiąca"
        data={recentCostItems(entries, month, tryb !== 'przyklad')}
        direction="out"
        empty={costsEmpty(entries, tryb)}
        className={className}
      />
    );
  });
}

export async function CostVatSlot({ supabase, tenantId, nowIso, month, tryb, className }: CardProps) {
  return loadAnalizyCard('VAT z wydatków', className, async () => {
    const vat = costVatSummary(await loadCostsWindow(supabase, tenantId, nowIso), month);
    return (
      <SpendingStreaksCard
        title="VAT z wydatków"
        // Poprawka 21.10.2026: opis w jednej linii jak w Finorze (dłuższy zawijał
        // się przy 375 px i podnosił kartę o 19,5 px).
        description="Wybrany miesiąc · VAT do odliczenia według dokumentu"
        rows={costVatRows(vat, tryb === 'przyklad' ? null : `/expenses?filter=unreviewed&miesiac=${month}`)}
        className={className}
      />
    );
  });
}

export async function CostIncomeExpenseSlot({ supabase, tenantId, nowIso, month, className }: CardProps) {
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

export async function RecurringCostsSlot({ supabase, tenantId, nowIso, className }: CardProps) {
  return loadAnalizyCard('Stałe koszty', className, async () => {
    const entries = await loadCostsWindow(supabase, tenantId, nowIso);
    const months = monthKeysEnding(currentMonthKey(new Date(nowIso)), RECURRING_MONTHS);
    return (
      <SubscriptionsCard
        title="Stałe koszty"
        description="Dostawcy z wydatkami w 3 z 4 ostatnich miesięcy"
        data={toSubscriptionItems(recurringSuppliers(entries, months, RECURRING_LIST_LIMIT), 'supplier')}
        empty={ANALIZY_EMPTY.noRecurringSuppliers}
        className={className}
      />
    );
  });
}

export async function CostHeatmapSlot({ supabase, tenantId, nowIso, tryb, kosztyKsefOd, className }: CardProps) {
  return loadAnalizyCard('Kalendarz wydatków', className, async () => {
    const entries = await loadCostsWindow(supabase, tenantId, nowIso);
    const days = dailyTotals(entries, (e) => e.issueDate, (e) => e.outflow, todayInWarsaw(new Date(nowIso)), HEATMAP_DAYS);
    return (
      <SpendHeatmap
        title="Kalendarz wydatków"
        // Podpis mówi o źródle liczb i oknie (E4); wcześniejszy dopisek „mocniejszy kolor to więcej” odpadł dla zachowania jednej linii.
        description={podpisKosztow(`ostatnie ${HEATMAP_DAYS} dni`, ksefOd(tryb, kosztyKsefOd, oknoKalendarzaOd(nowIso)))}
        data={days}
        empty={costsWindowEmpty(entries, ANALIZY_EMPTY.noCostsInWindow, tryb)}
        className={className}
      />
    );
  });
}

/**
 * Siatka `/analizy/koszty`. Dziewięć kart Monthly Analytics Finory w jej kolejności
 * i rozpiętościach: tytuł karty błędu, klasa siatki, karta.
 */
export const SIATKA_KOSZTOW: readonly AnalizyKarta[] = [
  ['Wydatki miesiąca', 'md:col-span-4', CostStatsSlot],
  ['Trend wydatków', 'md:col-span-2 2xl:col-span-3', CostTrendSlot],
  ['Wydatki według kategorii', 'md:max-2xl:col-span-2', CostCategoriesChartSlot],
  ['Największe kategorie', 'md:col-span-2', CostCategoriesListSlot],
  ['Ostatnie wydatki', 'md:col-span-2', RecentCostsSlot],
  ['VAT z wydatków', 'md:col-span-2', CostVatSlot],
  ['Przychody a koszty', 'md:col-span-2', CostIncomeExpenseSlot],
  ['Stałe koszty', 'md:col-span-2', RecurringCostsSlot],
  ['Kalendarz wydatków', 'md:col-span-2', CostHeatmapSlot],
];

/** Wszystkie karty naraz, bez szkieletów (`AnalizySiatka`, poprawka Bartosza 23.10.2026). */
export function KosztyGrid(props: AnalizyCardProps) {
  return <AnalizySiatka {...props} karty={SIATKA_KOSZTOW} />;
}
