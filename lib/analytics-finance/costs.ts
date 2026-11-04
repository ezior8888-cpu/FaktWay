import type { CostEntry } from '@/lib/dashboard/costs';
import { isKsefInvoiceCost } from '@/lib/dashboard/ksef-invoice-cost';
import { shortCompanyName } from '@/lib/format/company-name';
import { roundToCents } from '@/lib/xml/invoice-calculator';

import { changePct, sumBy, topWithOther, type BreakdownSlice } from './breakdown';
import { countedDays, monthShortLabel } from './months';

/**
 * Analiza kosztów `/analizy/koszty` (plan Finora P10 ← Monthly Analytics).
 * Czyste funkcje na wyniku `getCostsWithKsefPurchases` (E10, D-K — jedna
 * definicja kosztów kart, ta sama co Pulpit i `/przeplywy`: faktury zakupu
 * z KSeF + wydatki spoza KSeF; KPiR i eksport czytają same wydatki).
 *
 * Kwoty „wydatków” (Wydano, trend, kategorie, ostatnie, kalendarz, stałe
 * koszty) to WYPŁYW, czyli `gross_amount` (`outflow`) — tak jak „Wydano
 * w tym miesiącu” na `/przeplywy` i kafel „Wydatki w miesiącu” na
 * `/expenses`. Karta „Przychody a koszty” bierze koszt jak w KPiR (`cost`),
 * jak Pulpit (P1).
 */

export const UNCATEGORIZED_LABEL = 'Bez kategorii';
export const OTHER_CATEGORIES_LABEL = 'Pozostałe';

const inMonth = (entry: CostEntry, monthKey: string) => entry.issueDate.slice(0, 7) === monthKey;
const categoryOf = (entry: CostEntry) => entry.categoryLabel ?? UNCATEGORIZED_LABEL;

function sum(values: readonly number[]): number {
  return roundToCents(values.reduce((total, value) => total + value, 0)) || 0;
}

export interface CostMonthStats {
  /** Wypływ brutto miesiąca. */
  total: number;
  /** `total` / dni miesiąca (w bieżącym — dni do dziś). */
  avgDaily: number;
  /** Zmiana vs poprzedni miesiąc w %, `null` bez wydatków w poprzednim. */
  changePct: number | null;
  /** Kategoria z największym wypływem; `null` bez wydatków. */
  topCategory: string | null;
}

/** Finora `getMonthlyStats` na naszych wydatkach. */
export function costMonthStats(
  entries: readonly CostEntry[],
  monthKey: string,
  prevMonthKey: string,
  today: string,
): CostMonthStats {
  const current = entries.filter((e) => inMonth(e, monthKey));
  const total = sum(current.map((e) => e.outflow));
  const previous = sum(entries.filter((e) => inMonth(e, prevMonthKey)).map((e) => e.outflow));
  const top = costCategoryBreakdown(entries, monthKey, 1)[0];
  return {
    total,
    avgDaily: roundToCents(total / countedDays(monthKey, today)) || 0,
    changePct: changePct(total, previous),
    topCategory: top && !top.other ? top.label : null,
  };
}

export interface TrendPoint {
  key: string;
  label: string;
  amount: number;
}

/** Finora `getSpendTrend`: wypływ brutto per miesiąc z `monthKeys`. */
export function costTrend(entries: readonly CostEntry[], monthKeys: readonly string[]): TrendPoint[] {
  const byMonth = sumBy(entries, (e) => e.issueDate.slice(0, 7), (e) => e.outflow);
  return monthKeys.map((key) => ({ key, label: monthShortLabel(key), amount: byMonth.get(key) ?? 0 }));
}

/**
 * Finora `getCategoryBreakdown`: kategorie (`category_label`, brak →
 * „Bez kategorii”) wybranego miesiąca, top `limit` + „Pozostałe” (P10).
 */
export function costCategoryBreakdown(
  entries: readonly CostEntry[],
  monthKey: string,
  limit = 5,
): BreakdownSlice[] {
  const current = entries.filter((e) => inMonth(e, monthKey));
  // `category_label` to wolny tekst: „Paliwo” i „paliwo” to jedna kategoria
  // (jak klucz w `recurringSuppliers`). Podpis — pierwsza pisownia z wpisów.
  const normalized = (entry: CostEntry) => categoryOf(entry).trim().toLocaleLowerCase('pl');
  const labels = new Map<string, string>();
  for (const entry of current) if (!labels.has(normalized(entry))) labels.set(normalized(entry), categoryOf(entry).trim());
  const byCategory = sumBy(current, normalized, (e) => e.outflow);
  return topWithOther(
    [...byCategory].map(([key, amount]) => ({ key: `kat:${key}`, label: labels.get(key) ?? key, amount })),
    limit,
    OTHER_CATEGORIES_LABEL,
  );
}

export interface RecentCost {
  id: string;
  date: string;
  name: string;
  amount: number;
}

/** Finora `getRecentExpenses`: najnowsze wydatki miesiąca (data, potem id malejąco). */
export function recentCosts(entries: readonly CostEntry[], monthKey: string, limit = 5): RecentCost[] {
  return entries
    .filter((e) => inMonth(e, monthKey))
    .slice()
    .sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.id.localeCompare(a.id))
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      date: e.issueDate,
      // Jak „Stałe koszty” (`recurringSuppliers`): skrócona forma prawna (§7.2), bez nazwy — „NIP …”.
      name: shortCompanyName(e.sellerName ?? (e.sellerNip ? `NIP ${e.sellerNip}` : 'Wydatek')),
      amount: e.outflow,
    }));
}

export interface CostVatSummary {
  /** VAT naliczony z dokumentów miesiąca (`vat_amount`). */
  vat: number;
  /** VAT do odliczenia — reguła `VAT_DEDUCTIBLE_DOCUMENTS` (§2.4 pkt 12). */
  vatDeductible: number;
  /** Wydatki miesiąca do opisania (`is_reviewed = false`); faktura z KSeF bez wydatku się nie liczy. */
  toReview: number;
}

/** „VAT z wydatków” w miejscu Spending Streaks (P10). */
export function costVatSummary(entries: readonly CostEntry[], monthKey: string): CostVatSummary {
  const current = entries.filter((e) => inMonth(e, monthKey));
  return {
    vat: sum(current.map((e) => e.vat)),
    vatDeductible: sum(current.map((e) => e.vatDeductible)),
    // Faktury z KSeF bez wydatku nie ma w Wydatkach — nie ma czego opisać (link „Do opisania”).
    toReview: current.filter((e) => !e.isReviewed && !isKsefInvoiceCost(e)).length,
  };
}

/** Koszt miesiąca jak w KPiR (`kpirCostAmount`) — „Przychody a koszty”. */
export function costOfMonth(entries: readonly CostEntry[], monthKey: string): number {
  return sum(entries.filter((e) => inMonth(e, monthKey)).map((e) => e.cost));
}
