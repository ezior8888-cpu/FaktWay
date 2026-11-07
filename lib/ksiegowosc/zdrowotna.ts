/**
 * Składka zdrowotna przy ryczałcie (plan księgowości JDG, K4; sekcja 5).
 * Funkcja czysta: parametry roku składkowego (luty-styczeń, `zdrowotnaNa`)
 * podaje wołający.
 *
 * Kwota zależy od progu przychodu od początku roku podatkowego: do 60 tys. zł,
 * do 300 tys. zł albo więcej. Przychód do progu wołający pomniejsza
 * o zapłacone składki społeczne bez FP (biznes.gov.pl, ZUS; pewność średnia,
 * sekcja 5). Wyższa składka obowiązuje od miesiąca przekroczenia progu, bez
 * korekty miesięcy wcześniejszych: różnicę wyrównuje rozliczenie roczne.
 * Skala i liniowy: K7.
 */

import type { KluczZdrowotnej, Liczba } from '@/lib/ksiegowosc/parametry';

export type ProgZdrowotnej = 'do 60 tys.' | 'do 300 tys.' | 'ponad 300 tys.';

export interface ZdrowotnaRyczaltu {
  /** Przychód od początku roku, według którego ustalono próg (już pomniejszony przez wołającego). */
  przychodNarastajacoGr: number;
  prog: ProgZdrowotnej;
  skladkaGr: number;
}

export type WynikZdrowotnej = { ok: true; zdrowotna: ZdrowotnaRyczaltu } | { ok: false; brak: string };

export type LiczbyZdrowotnej = { readonly [P in KluczZdrowotnej]: Liczba };

export function zdrowotnaRyczaltu(przychodNarastajacoGr: number, liczby: LiczbyZdrowotnej): WynikZdrowotnej {
  const prog60 = liczby.progRyczaltu60Tys?.wartosc ?? null;
  const prog300 = liczby.progRyczaltu300Tys?.wartosc ?? null;
  const prog: ProgZdrowotnej =
    prog60 !== null && przychodNarastajacoGr <= prog60
      ? 'do 60 tys.'
      : prog300 !== null && przychodNarastajacoGr <= prog300
        ? 'do 300 tys.'
        : 'ponad 300 tys.';
  const klucz: KluczZdrowotnej =
    prog === 'do 60 tys.' ? 'ryczaltDo60Tys' : prog === 'do 300 tys.' ? 'ryczaltDo300Tys' : 'ryczaltPonad300Tys';
  const skladkaGr = liczby[klucz]?.wartosc ?? null;
  if (prog60 === null || prog300 === null || skladkaGr === null) {
    return {
      ok: false,
      brak: 'Kwoty składki zdrowotnej na ten rok składkowy nie są jeszcze ogłoszone (GUS i ZUS ogłaszają je w styczniu), więc składki nie liczymy.',
    };
  }
  return { ok: true, zdrowotna: { przychodNarastajacoGr, prog, skladkaGr } };
}
