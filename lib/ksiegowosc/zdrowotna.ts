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
 * Skala i liniowy (K7): `zdrowotnaOdDochodu` niżej.
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

/**
 * Skala i liniowy (K7): składka za miesiąc od dochodu z POPRZEDNIEGO miesiąca
 * (za styczeń od grudnia), czyli przychód minus koszty z KPiR minus składki
 * społeczne zapłacone w tamtym miesiącu; 9 % przy skali, 4,9 % przy liniowym,
 * nie mniej niż minimalna (9 % płacy minimalnej z pierwszego dnia roku
 * składkowego). Strata to podstawa zero, więc składka minimalna. Podstawa
 * w wyniku nie jest niższa niż płaca minimalna (podstawa składki minimalnej).
 * Roczne rozliczenie składki (wyrównanie do dochodu z roku) to K9.
 */
export interface ZdrowotnaOdDochodu {
  /** Dochód poprzedniego miesiąca po odliczeniu społecznych (może być ujemny). */
  dochodGr: number;
  podstawaGr: number;
  skladkaGr: number;
  minimalna: boolean;
}

export type WynikZdrowotnejOdDochodu = { ok: true; zdrowotna: ZdrowotnaOdDochodu } | { ok: false; brak: string };

export function zdrowotnaOdDochodu(forma: 'skala' | 'liniowy', dochodGr: number, liczby: LiczbyZdrowotnej): WynikZdrowotnejOdDochodu {
  const stawkaSkali = liczby.stawka?.wartosc ?? null;
  const stawka = forma === 'skala' ? stawkaSkali : (liczby.stawkaLiniowy?.wartosc ?? null);
  const minimalna = liczby.minimalna?.wartosc ?? null;
  if (stawka === null || stawkaSkali === null || minimalna === null) {
    return {
      ok: false,
      brak: 'Stawka albo minimalna składka zdrowotna na ten rok składkowy nie są jeszcze ogłoszone (ZUS ogłasza je w styczniu), więc składki nie liczymy.',
    };
  }
  const odDochodu = Math.floor((Math.max(0, dochodGr) * stawka + 5_000) / 10_000);
  // Minimalna to 9 % płacy minimalnej, więc płaca minimalna = minimalna / 9 %.
  const placaMinimalnaGr = Math.round((minimalna * 10_000) / stawkaSkali);
  const jestMinimalna = odDochodu < minimalna;
  return {
    ok: true,
    zdrowotna: {
      dochodGr,
      podstawaGr: Math.max(Math.max(0, dochodGr), placaMinimalnaGr),
      skladkaGr: jestMinimalna ? minimalna : odDochodu,
      minimalna: jestMinimalna,
    },
  };
}
