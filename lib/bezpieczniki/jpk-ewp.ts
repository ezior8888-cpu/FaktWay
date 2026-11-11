/**
 * Strażnik JPK_EWP(4) (żelazny filtr F13 część 3, plan B4.10; D-F7: w module
 * księgowości blokada od razu). Ostatnia kontrola spójności gotowego pliku
 * ewidencji przychodów: `pobierzJpkEwpAction` w
 * `app/actions/ksiegowosc-ewidencja.ts` woła go po kontroli XSD, przed
 * wydaniem pliku klientowi. Plik z alarmem nie wychodzi: klient dostaje
 * `odmowaJpkEwp`, operator alarm (`alarm.ts`). `miesiac` (RRRR-MM) to miesiąc
 * końca okresu pliku; plik zawsze zaczyna się 1 stycznia.
 *
 * Funkcja czysta nad tekstem XML; odczyt i kwoty w groszach jak w `jpk-ctrl.ts`.
 * Wzory pochodzą z opisów pól oficjalnego schematu MF
 * (`lib/exports/schemas/jpk-ewp4/schemat.xsd`), nie z kodu generatora:
 *
 * - FILTR-RT-EWP-01: LiczbaWierszy to „liczba wierszy (zapisów) ewidencji
 *   przychodów, w okresie którego dotyczy JPK_EWP” (`schemat.xsd:336`), czyli
 *   liczba elementów EWPWiersz. Plik bez EWPCtrl też.
 * - FILTR-RT-EWP-02: SumaPrzychodow to „łączna wartość przychodów (K_8)
 *   w ewidencji przychodów w okresie” (`schemat.xsd:341`), czyli suma K_8
 *   z wierszy, z korektami in minus.
 *
 * Schemat nie podaje innych wzorów: K_1 to „Lp.”, a sum według stawek K_9
 * plik nie ma. Typy pól, stawki ze słownika i LiczbaWierszy większa od zera
 * to XSD przed strażnikiem.
 */

import type { AlarmFiltra } from '@/lib/bezpieczniki/alarm';
import { czytajJpk, sprawdzSumyKontrolne, type SumyKontrolne } from '@/lib/bezpieczniki/jpk-ctrl';

export const KODY_JPK_EWP = {
  wiersze: 'FILTR-RT-EWP-01',
  przychody: 'FILTR-RT-EWP-02',
} as const;

export type KodJpkEwp = (typeof KODY_JPK_EWP)[keyof typeof KODY_JPK_EWP];

export interface AlarmJpkEwp extends AlarmFiltra {
  kod: KodJpkEwp;
  rodzaj: 'ewidencja';
}

/** Sumy kontrolne EWPCtrl z opisów pól (cytaty w nagłówku pliku). */
export const SUMY_KONTROLNE_EWP: SumyKontrolne<KodJpkEwp> = {
  wiersz: 'EWPWiersz',
  ctrl: 'EWPCtrl',
  kodLiczby: KODY_JPK_EWP.wiersze,
  kodSum: KODY_JPK_EWP.przychody,
  sumy: [{ pole: 'SumaPrzychodow', kolumna: 'K_8', obowiazkowe: true }],
};

/** Dla klienta zamiast pliku, który nie przeszedł kontroli; kod pierwszego alarmu. */
export function odmowaJpkEwp(kod: KodJpkEwp): string {
  return (
    `Plik JPK_EWP wstrzymany: kontrola spójności wykryła błąd po naszej stronie (${kod}). Zgłosiliśmy go. ` +
    'Jeśli urząd wyznaczył termin, przygotuj plik z księgową.'
  );
}

/** Sprawdza gotowy plik; pusta lista to plik w porządku. Alarmy w kolejności kodów. */
export function sprawdzJpkEwp(xml: string, miesiac: string): AlarmJpkEwp[] {
  const alarmy: AlarmJpkEwp[] = [];
  sprawdzSumyKontrolne(czytajJpk(xml), SUMY_KONTROLNE_EWP, (kod, opis) => alarmy.push({ kod, rodzaj: 'ewidencja', miesiac, opis }));
  return alarmy;
}
