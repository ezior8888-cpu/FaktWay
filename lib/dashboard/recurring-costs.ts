import type { CostEntry } from '@/lib/dashboard/costs';
import { roundToCents } from '@/lib/xml/invoice-calculator';

/**
 * Stałe koszty (plan Finora §8 N3, kafel P8 „Stałe koszty”, karta P10
 * „Stałe koszty”). Funkcja CZYSTA na kosztach z `getCosts` (§2.4 pkt 12) —
 * nie czyta bazy, więc nie ma własnej drogi odczytu kosztów.
 *
 * Reguła: dostawca (`seller_nip`) z kosztem w co najmniej `minMonths`
 * (domyślnie 3) z ostatnich `monthKeys.length` (4) miesięcy to stały koszt.
 * Miesiąc liczy się, gdy suma wypływów dostawcy w tym miesiącu jest dodatnia
 * (sama korekta in minus nie robi z dostawcy stałego kosztu).
 *
 * - `averageAmount` — średni miesięczny wypływ (`outflow`, brutto) z miesięcy,
 *   w których dostawca się pojawił, zaokrąglony do groszy;
 * - `typicalDay` — mediana dnia miesiąca z dat wystawienia (dolna mediana przy
 *   parzystej liczbie dat), czyli „zwykle około X dnia miesiąca”.
 *
 * Koszty bez NIP-u (paragony) pomijamy: bez klucza dostawcy nie da się
 * powiedzieć, że to ten sam dostawca.
 */

export interface RecurringCost {
  sellerNip: string;
  /** Nazwa z najnowszego kosztu dostawcy (albo NIP, gdy nazwy brak). */
  sellerName: string;
  /** W ilu miesiącach z okna dostawca miał koszt. */
  months: number;
  averageAmount: number;
  typicalDay: number;
}

export const RECURRING_WINDOW_MONTHS = 4;
export const RECURRING_MIN_MONTHS = 3;

/** Klucze RRRR-MM: `count` miesięcy kończących się na `month` (włącznie), od najstarszego. */
export function recurringMonthKeys(month: string, count = RECURRING_WINDOW_MONTHS): string[] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (count - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

export function findRecurringCosts(
  entries: readonly CostEntry[],
  monthKeys: readonly string[],
  minMonths = RECURRING_MIN_MONTHS,
): RecurringCost[] {
  const window = new Set(monthKeys);
  const bySeller = new Map<string, { name: string | null; latest: string; byMonth: Map<string, number>; days: number[] }>();

  for (const entry of entries) {
    const nip = entry.sellerNip?.trim();
    if (!nip) continue;
    const monthKey = entry.issueDate.slice(0, 7);
    if (!window.has(monthKey)) continue;
    let seller = bySeller.get(nip);
    if (!seller) {
      seller = { name: null, latest: '', byMonth: new Map(), days: [] };
      bySeller.set(nip, seller);
    }
    seller.byMonth.set(monthKey, (seller.byMonth.get(monthKey) ?? 0) + entry.outflow);
    seller.days.push(Number(entry.issueDate.slice(8, 10)));
    if (entry.issueDate >= seller.latest) {
      seller.latest = entry.issueDate;
      if (entry.sellerName?.trim()) seller.name = entry.sellerName.trim();
    }
  }

  const result: RecurringCost[] = [];
  for (const [nip, seller] of bySeller) {
    const positive = [...seller.byMonth.values()].filter((total) => roundToCents(total) > 0);
    if (positive.length < minMonths) continue;
    const days = [...seller.days].sort((a, b) => a - b);
    result.push({
      sellerNip: nip,
      sellerName: seller.name ?? nip,
      months: positive.length,
      averageAmount: roundToCents(positive.reduce((sum, total) => sum + total, 0) / positive.length),
      typicalDay: days[Math.floor((days.length - 1) / 2)]!,
    });
  }

  return result.sort((a, b) => b.averageAmount - a.averageAmount || a.sellerNip.localeCompare(b.sellerNip));
}

/** Suma średnich miesięcznych kwot — „ile co miesiąc idzie na stałe koszty”. */
export function recurringCostsMonthlyTotal(costs: readonly RecurringCost[]): number {
  return roundToCents(costs.reduce((sum, cost) => sum + cost.averageAmount, 0));
}
