import { kpirCostAmount, type KpirCostInput } from '@/lib/categorization/kpir-cost';
import { kpirRevenueNet } from '@/lib/categorization/kpir-revenue';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { roundToCents } from '@/lib/xml/invoice-calculator';

/**
 * Szacunek podatku dochodowego na panelu przepływów („ile odłożyć”).
 *
 * Do 01.10.2026 kafelek „Szac. podatek YTD” sumował zysk z OSTATNICH SZEŚCIU
 * MIESIĘCY, a nie od początku roku: w październiku gubił styczeń–kwiecień
 * (podatek zaniżony), w lutym doliczał wrzesień–grudzień poprzedniego roku.
 * PIT liczy się narastająco od 1 stycznia, więc liczymy tylko bieżący rok —
 * a gdy dane zaczynają się później niż w styczniu (strona ładuje sześć
 * miesięcy), etykieta mówi o tym wprost zamiast udawać pełny rok.
 */

const LINEAR_PIT_RATE = 0.19;

const MONTHS_GENITIVE = [
  'stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
  'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia',
];

export interface TaxEstimateInvoice {
  issue_date: string;
  net_total: number | string | null;
  invoice_kind: string | null;
  settled_advances_net?: number | null;
}

/**
 * Wydatek jako wiersz `expenses` (koszt liczy `kpirCostAmount`) albo jako
 * gotowy koszt z `getCosts` (`lib/dashboard/costs.ts`, pole `cost` — ta sama
 * reguła, policzona już przy odczycie).
 */
export type TaxEstimateExpense =
  | (KpirCostInput & { issue_date: string })
  | { issue_date: string; cost: number };

function expenseCost(expense: TaxEstimateExpense): number {
  return 'cost' in expense ? expense.cost : kpirCostAmount(expense);
}

export interface TaxEstimate {
  amount: number;
  label: string;
  subtitle: string;
  /** Czy dane obejmują cały bieżący rok od 1 stycznia. */
  fullYear: boolean;
}

/**
 * @param dataFrom pierwszy dzień załadowanych danych (`RRRR-MM-DD`).
 */
export function estimateIncomeTaxThisYear(
  invoices: readonly TaxEstimateInvoice[],
  expenses: readonly TaxEstimateExpense[],
  now: Date,
  dataFrom: string,
): TaxEstimate {
  // Rok w Polsce, nie w strefie procesu: komponent wywołujący renderuje się
  // też na serwerze (UTC), a w Nowy Rok tuż po północy to jeszcze stary rok.
  const year = Number(todayInWarsaw(now).slice(0, 4));
  const yearStart = `${year}-01-01`;
  const fullYear = dataFrom <= yearStart;
  const inRange = (date: string) => date >= dataFrom && date.startsWith(`${year}-`);

  const revenue = invoices
    .filter((i) => inRange(i.issue_date))
    .reduce(
      (s, i) => s + kpirRevenueNet({ kind: i.invoice_kind, net: i.net_total, settledAdvancesNet: i.settled_advances_net }),
      0,
    );
  const cost = expenses.filter((e) => inRange(e.issue_date)).reduce((s, e) => s + expenseCost(e), 0);
  const amount = Math.max(0, roundToCents((revenue - cost) * LINEAR_PIT_RATE));

  if (fullYear) {
    return { amount, label: 'Szac. podatek od 1 stycznia', subtitle: '19% liniowy', fullYear };
  }
  const month = MONTHS_GENITIVE[Number(dataFrom.slice(5, 7)) - 1] ?? '';
  return {
    amount,
    label: `Szac. podatek od 1 ${month}`,
    subtitle: '19% liniowy · bez wcześniejszych miesięcy roku',
    fullYear,
  };
}
