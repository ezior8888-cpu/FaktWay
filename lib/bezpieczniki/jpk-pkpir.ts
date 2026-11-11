/**
 * Strażnik JPK_PKPIR(3) (żelazny filtr F13 część 3, plan B4.10; D-F7: w module
 * księgowości blokada od razu). Ostatnia kontrola spójności gotowego pliku
 * KPiR: `pobierzJpkPkpirAction` w `app/actions/ksiegowosc-ewidencja.ts` woła
 * go po kontroli XSD, przed wydaniem pliku klientowi. Plik z alarmem nie
 * wychodzi: klient dostaje `odmowaJpkPkpir`, operator alarm (`alarm.ts`).
 * `miesiac` (RRRR-MM) to miesiąc końca okresu pliku; plik zawsze zaczyna się
 * 1 stycznia.
 *
 * Funkcja czysta nad tekstem XML; odczyt i kwoty w groszach jak w `jpk-ctrl.ts`.
 * Wzory pochodzą z opisów pól oficjalnego schematu MF
 * (`lib/exports/schemas/jpk-pkpir3/schemat.xsd`), nie z kodu generatora:
 *
 * - FILTR-RT-PKPIR-01: LiczbaWierszy to „liczba wierszy (zapisów) PKPIR,
 *   w okresie którego dotyczy JPK_PKPIR” (`schemat.xsd:404`), czyli liczba
 *   elementów PKPIRWiersz. Plik bez PKPIRCtrl też.
 * - FILTR-RT-PKPIR-02: SumaPrzychodow to „łączna wartość przychodów razem
 *   (kol. K_9)” (`:409`), czyli suma K_9 z wierszy; SumaPrzychodow2 to ta sama
 *   suma dla K_9A (`:414`). SumaPrzychodow2 jest nieobowiązkowa, więc bez niej
 *   to 0, jak każde pole kwoty: wiersz z K_9A bez SumaPrzychodow2 to alarm.
 * - FILTR-RT-PKPIR-03: K_9 to „razem przychód w PLN (K_7 + K_8)” (`:333`)
 *   w każdym wierszu.
 * - FILTR-RT-PKPIR-04: K_14 to „razem wydatki (12+13)” (`:363`), czyli K_12
 *   plus K_13, w każdym wierszu.
 *
 * Poza strażnikiem, bo opis nie podaje wzoru: P_3 i P_4 w PKPIRInfo („wg
 * objaśnień do podatkowej księgi przychodów i rozchodów”, `:243`, `:248`;
 * program liczy je według RP-SPIS-01, z pewnością średnią i pytaniem do
 * księgowej, a w pliku za część roku „rok podatkowy” nie jest jednoznaczny),
 * P_1, P_2 i P_5B (wartości spisu z natury), K_10, K_11, K_15, K_16B, K_9A
 * i K_14A w wierszu. Typy pól i LiczbaWierszy większa od zera to XSD przed
 * strażnikiem.
 */

import type { AlarmFiltra } from '@/lib/bezpieczniki/alarm';
import { czytajJpk, kwota, sprawdzSumyKontrolne, suma, type SumyKontrolne } from '@/lib/bezpieczniki/jpk-ctrl';

export const KODY_JPK_PKPIR = {
  wiersze: 'FILTR-RT-PKPIR-01',
  przychody: 'FILTR-RT-PKPIR-02',
  razemPrzychod: 'FILTR-RT-PKPIR-03',
  razemWydatki: 'FILTR-RT-PKPIR-04',
} as const;

export type KodJpkPkpir = (typeof KODY_JPK_PKPIR)[keyof typeof KODY_JPK_PKPIR];

export interface AlarmJpkPkpir extends AlarmFiltra {
  kod: KodJpkPkpir;
  rodzaj: 'kpir';
}

/** Sumy kontrolne PKPIRCtrl z opisów pól (cytaty w nagłówku pliku). */
export const SUMY_KONTROLNE_PKPIR: SumyKontrolne<KodJpkPkpir> = {
  wiersz: 'PKPIRWiersz',
  ctrl: 'PKPIRCtrl',
  kodLiczby: KODY_JPK_PKPIR.wiersze,
  kodSum: KODY_JPK_PKPIR.przychody,
  sumy: [
    { pole: 'SumaPrzychodow', kolumna: 'K_9', obowiazkowe: true },
    { pole: 'SumaPrzychodow2', kolumna: 'K_9A', obowiazkowe: false },
  ],
};

/** Kolumny „razem” z opisów pól: w każdym wierszu `pole` to suma `skladniki`. */
export const SUMY_WIERSZA_PKPIR = [
  { kod: KODY_JPK_PKPIR.razemPrzychod, pole: 'K_9', skladniki: ['K_7', 'K_8'] },
  { kod: KODY_JPK_PKPIR.razemWydatki, pole: 'K_14', skladniki: ['K_12', 'K_13'] },
] as const satisfies ReadonlyArray<{ kod: KodJpkPkpir; pole: string; skladniki: readonly string[] }>;

/** Dla klienta zamiast pliku, który nie przeszedł kontroli; kod pierwszego alarmu. */
export function odmowaJpkPkpir(kod: KodJpkPkpir): string {
  return (
    `Plik JPK_PKPIR wstrzymany: kontrola spójności wykryła błąd po naszej stronie (${kod}). Zgłosiliśmy go. ` +
    'Jeśli urząd wyznaczył termin, przygotuj plik z księgową.'
  );
}

/**
 * Sprawdza gotowy plik; pusta lista to plik w porządku. Alarmy w kolejności
 * kodów; kolumna „razem” daje najwyżej jeden alarm na rodzaj błędu, nie jeden
 * na wiersz (plik ma tysiące wierszy, a przypadek odtwarza się z firmy i okresu).
 */
export function sprawdzJpkPkpir(xml: string, miesiac: string): AlarmJpkPkpir[] {
  const alarmy: AlarmJpkPkpir[] = [];
  const zglos = (kod: KodJpkPkpir, opis: string) => alarmy.push({ kod, rodzaj: 'kpir', miesiac, opis });

  const wierszePliku = sprawdzSumyKontrolne(czytajJpk(xml), SUMY_KONTROLNE_PKPIR, zglos);
  for (const { kod, pole, skladniki } of SUMY_WIERSZA_PKPIR) {
    let nieKwota = false;
    let rozne = false;
    for (const w of wierszePliku) {
      const razem = kwota(w, pole);
      const zeSkladnikow = suma(skladniki.map((p) => kwota(w, p)));
      if (razem === null || zeSkladnikow === null) nieKwota = true;
      else if (razem !== zeSkladnikow) rozne = true;
    }
    if (nieKwota) zglos(kod, `${pole}, ${skladniki.join(' albo ')} w co najmniej jednym wierszu PKPIRWiersz nie jest kwotą albo suma wychodzi poza zakres`);
    if (rozne) zglos(kod, `${pole} różni się od ${skladniki.join(' plus ')} w co najmniej jednym wierszu PKPIRWiersz`);
  }
  return alarmy;
}
