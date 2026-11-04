/**
 * Podpisy wpływów w module bez importów serwerowych: biorą je adaptery serwera
 * i karty klienckie Przepływów (wykres). Wpływ to prawdziwe pieniądze, które
 * klient oznacza jednym dotknięciem przy fakturze (FaktWay 1.0 §3 pkt 3; decyzję
 * D-W z 23.10.2026 odwołano 02.11.2026 na polecenie Bartosza), więc puste stany
 * prowadzą do oznaczenia.
 */

import { PAID_NOTE } from '@/lib/invoices/paid-labels';

/** Podpis każdej karty z wpływami. */
export const INFLOW_NOTE = PAID_NOTE;

/**
 * Pusty stan okresu bez żadnej wpłaty; nigdy „0 zł”. Mieści się w miejscu
 * „wobec poprzedniego miesiąca”.
 */
export const INFLOW_EMPTY = 'Oznacz wpłatę przy fakturze';

/** To samo w dymku, pełnym zdaniem. */
export const INFLOW_EMPTY_TITLE =
  'W tym okresie nie ma oznaczonych wpłat. Gdy klient zapłaci, dotknij „Zapłacone” przy fakturze: wpłata pojawi się tutaj.';

/** Okres bez wpłat w dymku wykresu („Wpływy: brak oznaczonych wpłat”). */
export const INFLOW_NONE = 'brak oznaczonych wpłat';

/** Pusta lista wpływów i kosztów na Przepływach: dokąd iść, żeby oznaczyć zapłatę. */
export const INFLOW_EMPTY_LIST = 'Brak wpłat i kosztów w 12 miesiącach. Oznacz zapłatę przy fakturze.';
export const INFLOW_EMPTY_LINK = { label: 'Przejdź do faktur', href: '/invoices' } as const;
