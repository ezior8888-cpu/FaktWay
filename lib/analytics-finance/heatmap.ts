import { weekdayFromMonday } from './months';

/**
 * Kalendarz dni (Finora „Daily Spend”, plan P10/P11). Moduł bez ciężkich
 * importów — używa go komponent kliencki z podpowiedziami.
 */

export interface HeatmapDay {
  /** RRRR-MM-DD */
  date: string;
  amount: number;
}

/**
 * Kolumny tygodni kalendarza: każda ma 7 miejsc od poniedziałku do niedzieli
 * (polski tydzień; Finora zaczyna od niedzieli), `null` = dzień poza oknem.
 */
export function heatmapWeeks(days: readonly HeatmapDay[]): (HeatmapDay | null)[][] {
  if (days.length === 0) return [];
  const first = weekdayFromMonday(days[0]!.date);
  const weekCount = Math.ceil((first + days.length) / 7);
  const weeks: (HeatmapDay | null)[][] = Array.from({ length: weekCount }, () =>
    Array<HeatmapDay | null>(7).fill(null));
  days.forEach((day, index) => {
    const position = first + index;
    weeks[Math.floor(position / 7)]![position % 7] = day;
  });
  return weeks;
}

/**
 * Natężenie koloru komórki według kwantyla wśród dni z kwotą > 0 — 1:1
 * z Finorą (pojedynczy rekordowy dzień nie wygasza reszty). Dzień z kwotą
 * ≤ 0 (brak albo korekta in minus) to `bg-muted`.
 */
export function heatmapIntensityClass(amount: number, sortedPositiveAmounts: readonly number[]): string {
  if (amount <= 0 || sortedPositiveAmounts.length === 0) return 'bg-muted';
  const rank = sortedPositiveAmounts.findIndex((value) => value >= amount) / sortedPositiveAmounts.length;
  if (rank >= 0.75) return 'bg-chart-1';
  if (rank >= 0.5) return 'bg-chart-1/75';
  if (rank >= 0.25) return 'bg-chart-1/50';
  return 'bg-chart-1/25';
}
