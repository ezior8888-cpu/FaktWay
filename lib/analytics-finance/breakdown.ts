import { roundToCents } from '@/lib/xml/invoice-calculator';

import type { HeatmapDay } from './heatmap';
import { lastDaysIso } from './months';

/**
 * Wspólne klocki kart analiz (plan Finora N2): podział „top N + Pozostałe”
 * (Spend by Category / Top Categories / Asset Allocation), sumy po dniach
 * (Daily Spend) i zmiana procentowa. Czyste funkcje.
 */

export interface BreakdownInput {
  key: string;
  label: string;
  amount: number;
}

export interface BreakdownSlice extends BreakdownInput {
  /** Udział w sumie wszystkich dodatnich pozycji, 0–100. */
  percentage: number;
  /** Pozycja zbiorcza „Pozostałe” (kolor `muted-foreground`, jak w Finorze). */
  other: boolean;
}

export const OTHER_KEY = 'pozostale';

/**
 * Top `limit` pozycji z kwotą > 0, malejąco po kwocie (remis: po kluczu), oraz
 * jedna pozycja zbiorcza z SUMĄ pozostałych dodatnich pozycji (P11: „suma
 * pozostałych pozycji, NIE sprzedaż ogółem minus top 5”). Pozycje z kwotą
 * ≤ 0 (np. kategoria wyzerowana korektą) nie wchodzą do wykresu kołowego.
 */
export function topWithOther(
  items: readonly BreakdownInput[],
  limit: number,
  otherLabel: string,
): BreakdownSlice[] {
  const positive = items
    .map((item) => ({ ...item, amount: roundToCents(item.amount) || 0 }))
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const total = positive.reduce((sum, item) => sum + item.amount, 0);
  const pct = (amount: number) => (total > 0 ? (amount / total) * 100 : 0);

  const top: BreakdownSlice[] = positive
    .slice(0, limit)
    .map((item) => ({ ...item, percentage: pct(item.amount), other: false }));
  const rest = roundToCents(positive.slice(limit).reduce((sum, item) => sum + item.amount, 0));
  if (rest > 0) {
    top.push({ key: OTHER_KEY, label: otherLabel, amount: rest, percentage: pct(rest), other: true });
  }
  return top;
}

/** Suma kwot według klucza, zaokrąglona do groszy. */
export function sumBy<T>(
  entries: readonly T[],
  keyOf: (entry: T) => string,
  amountOf: (entry: T) => number,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of entries) {
    const key = keyOf(entry);
    map.set(key, (map.get(key) ?? 0) + amountOf(entry));
  }
  for (const [key, value] of map) map.set(key, roundToCents(value) || 0);
  return map;
}

/** Suma kwot na każdy z `days` dni kończących się `today`, od najstarszego. */
export function dailyTotals<T>(
  entries: readonly T[],
  dateOf: (entry: T) => string,
  amountOf: (entry: T) => number,
  today: string,
  days: number,
): HeatmapDay[] {
  const byDate = sumBy(entries, dateOf, amountOf);
  return lastDaysIso(today, days).map((date) => ({ date, amount: byDate.get(date) ?? 0 }));
}

/** Zmiana procentowa; `null`, gdy podstawa ≤ 0 (procent nie istnieje). */
export function changePct(current: number, previous: number): number | null {
  return previous > 0 ? ((current - previous) / previous) * 100 : null;
}
