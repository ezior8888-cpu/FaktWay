import { currentMonthKey, HEATMAP_DAYS, lastDaysIso, shiftMonthKey, TREND_MONTHS } from '@/lib/analytics-finance/months';
import { todayInWarsaw } from '@/lib/format/warsaw-date';

import { ksefOd, POBIERAMY } from '@/components/dashboard/finora/adaptery';

import type { EmptyStateProps } from './finora/empty';

/**
 * Podpisy i puste stany kart `/analizy/*` zależne od trybu danych
 * (PLAN-PRAWDZIWE-DANE §6.3, E4). Zasada Bartosza 23.10.2026: tylko napisy
 * w istniejących miejscach, o długości dawnych — żadnej nowej linii.
 * Czyste funkcje, więc testuje się je wprost.
 */

/** Początek okna trendu: najstarszy z ostatnich 6 miesięcy („RRRR-MM”). */
export function oknoKosztowOd(nowIso: string): string {
  return shiftMonthKey(currentMonthKey(new Date(nowIso)), -(TREND_MONTHS - 1));
}

/** Pierwszy dzień kalendarza (`HEATMAP_DAYS` dni, „RRRR-MM-DD”) — okno to dni, nie miesiące. */
export function oknoKalendarzaOd(nowIso: string): string {
  return lastDaysIso(todayInWarsaw(new Date(nowIso)), HEATMAP_DAYS)[0]!;
}

/**
 * Podpis karty kosztów (E10, D-K): koszty to faktury zakupu z KSeF i wydatki
 * spoza KSeF, nie wypłaty z konta. Dopóki historia zakupów z KSeF się pobiera
 * (`od` = „KSeF od DD.MM”), faktury z KSeF są pełne dopiero od tej daty.
 * Oba napisy krótsze od dawnych („Z dokumentów w FaktWay”, „Z dokumentów,
 * KSeF od DD.MM”) — ta sama liczba linii na 375 px.
 */
export function podpisKosztow(tail: string, od: string): string {
  return od ? `Z wydatków, ${od} · ${tail}` : `Z KSeF i wydatków · ${tail}`;
}

/** Pusty stan sprzedaży bez żadnej faktury: w stanie B historia się pobiera, więc nie wzywamy do wystawiania. */
export function pobieramy(): EmptyStateProps {
  return { message: POBIERAMY, action: null };
}

export { ksefOd, POBIERAMY };
