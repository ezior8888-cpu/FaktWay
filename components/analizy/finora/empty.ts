import { PULPIT_EMPTY } from '@/components/dashboard/pulpit/card-states';

/**
 * Puste stany kart analiz (plan Finora §7.3) — jedno źródło dla kart,
 * ładowarek i testów. Teksty wspólne z Pulpitem biorą `PULPIT_EMPTY`.
 * Poprawka Bartosza 21.10.2026 (Analizy 1:1 z Finory): bez „Wykres pojawi
 * się po drugim miesiącu” — trend rysuje słupki Finory zawsze (D8).
 */

export interface EmptyStateProps {
  message: string;
  action?: { label: string; href: string } | null;
}

/** Podpis pod „Udziałem klientów”, gdy jeden klient ma > 50% (P11). */
export const CONCENTRATION_WARNING = 'Uwaga: jeden klient to ponad połowa przychodu';

export const ANALIZY_EMPTY = {
  /** Brak faktur w całym oknie strony (§7.3: „Brak danych w ogóle”). */
  noInvoices: { message: PULPIT_EMPTY.noInvoices, action: PULPIT_EMPTY.issueInvoice },
  /** Są faktury, ale nie w wybranym miesiącu (Finora: „No expenses recorded for this month.”). */
  noSalesThisMonth: { message: 'Brak sprzedaży w tym miesiącu', action: PULPIT_EMPTY.issueInvoice },
  /** Firma bez KSeF i bez wydatków (§7.3: „Koszty bez KSeF”). */
  connectKsef: {
    message: PULPIT_EMPTY.connectKsef,
    action: { label: 'Podłącz KSeF', href: PULPIT_EMPTY.connectKsefHref },
  },
  noCostsThisMonth: { message: 'Brak wydatków w tym miesiącu', action: null },
  noCostsInWindow: { message: 'Brak wydatków w ostatnich 180 dniach', action: null },
  noCostsInTrend: { message: 'Brak wydatków w ostatnich 6 miesiącach', action: null },
  noSalesInTrend: { message: 'Brak sprzedaży w ostatnich 6 miesiącach', action: PULPIT_EMPTY.issueInvoice },
  noProducts: { message: PULPIT_EMPTY.noProductSales, action: null },
  noRecurringSuppliers: {
    message: 'Stałe koszty pokażemy, gdy ten sam dostawca wystąpi w 3 z 4 ostatnich miesięcy',
    action: null,
  },
  noRecurringClients: {
    message: 'Stałych klientów pokażemy, gdy ten sam nabywca dostanie fakturę w 3 z 4 ostatnich miesięcy',
    action: null,
  },
  noGainers: { message: 'Brak klientów ze wzrostem sprzedaży', action: null },
  noLosers: { message: 'Brak klientów ze spadkiem sprzedaży', action: null },
} as const satisfies Record<string, EmptyStateProps>;
