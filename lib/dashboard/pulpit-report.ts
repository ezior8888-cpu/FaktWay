import { roundToCents } from '@/lib/xml/invoice-calculator';

/**
 * Karta „Ten miesiąc” na Pulpicie (plan Finora §5 P1, w szablonie „Report”).
 * Czysta funkcja na seriach z `getSalesSeries(…).netSeries` i
 * `sumCostsByMonth(getCosts(…))` — bez własnego odczytu bazy, więc liczby
 * są te same co na wykresie „Przychody i koszty” i na `/przeplywy`.
 */
export interface MonthReport {
  /** Przychód netto bieżącego miesiąca (ROZ bez rozliczonych zaliczek). */
  revenue: number;
  /** Koszty bieżącego miesiąca (`kpirCostAmount`). */
  costs: number;
  /** `revenue − costs` — „Dochód miesiąca” z `/przeplywy`. */
  profit: number;
  /** „Średnio miesięcznie” — netto pełnych miesięcy przed bieżącym; `null` bez danych. */
  monthlyAverageNet: number | null;
}

/**
 * Bieżący miesiąc to OSTATNI element obu serii (tej samej długości).
 *
 * `monthlyAverageNet` to średnia netto z pełnych miesięcy PRZED bieżącym
 * (przy 12-miesięcznym oknie: z 11), ale liczona dopiero od pierwszego
 * miesiąca okna, w którym netto ≠ 0. Świadome doprecyzowanie planu („średnia
 * z 11 pełnych miesięcy”): firma, która ruszyła 3 miesiące temu, nie dostaje
 * średniej rozcieńczonej ośmioma zerami sprzed startu. Zero PO pierwszym
 * miesiącu z danymi liczy się normalnie (miesiąc bez sprzedaży to fakt).
 * `null`, gdy przed bieżącym miesiącem nie ma żadnego miesiąca z netto ≠ 0.
 */
export function buildMonthReport(
  netSeries: readonly number[],
  costSeries: readonly number[],
): MonthReport {
  if (netSeries.length !== costSeries.length) {
    throw new Error('Serie przychodów i kosztów mają różną liczbę miesięcy');
  }
  if (netSeries.length === 0) {
    throw new Error('Serie przychodów i kosztów są puste');
  }

  const last = netSeries.length - 1;
  const revenue = roundToCents(netSeries[last]!);
  const costs = roundToCents(costSeries[last]!);

  const fullMonths = netSeries.slice(0, last);
  const firstWithData = fullMonths.findIndex((net) => net !== 0);
  const counted = firstWithData === -1 ? [] : fullMonths.slice(firstWithData);
  const monthlyAverageNet = counted.length === 0
    ? null
    : roundToCents(counted.reduce((sum, net) => sum + net, 0) / counted.length);

  return {
    revenue,
    costs,
    profit: roundToCents(revenue - costs),
    monthlyAverageNet,
  };
}
