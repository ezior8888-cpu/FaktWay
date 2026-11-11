/**
 * Sumy kontrolne plików JPK w podatkach dochodowych (żelazny filtr F13
 * część 3, plan B4.10): wspólna część strażników JPK_EWP(4) (`jpk-ewp.ts`)
 * i JPK_PKPIR(3) (`jpk-pkpir.ts`). Oba schematy MF mają tę samą budowę:
 * wiersze (`EWPWiersz`, `PKPIRWiersz`) i element sum kontrolnych (`EWPCtrl`,
 * `PKPIRCtrl`) z liczbą wierszy i łączną wartością kolumn.
 *
 * Zasady odczytu jak w strażniku JPK_V7M (`jpk-v7m.ts`, który ma własny
 * odczyt): parser `fast-xml-parser` bez przestrzeni nazw, wartości jako
 * tekst; kwoty TKwotowy (xsd:decimal, najwyżej dwa miejsca po przecinku)
 * w groszach jako bezpieczne liczby całkowite; pola kwoty nie ma, to 0. Pole
 * powtórzone, puste, z przecinkiem, z więcej niż dwoma miejscami po przecinku
 * albo poza zakresem liczb całkowitych to błąd kontroli, która go potrzebuje.
 * Typy, kolejność i obecność pól obowiązkowych sprawdza XSD przed strażnikiem.
 */

import { XMLParser } from 'fast-xml-parser';

export type Wezel = Record<string, unknown>;

export type Zglos<K extends string> = (kod: K, opis: string) => void;

/** Suma kontrolna z opisu pola: `pole` elementu sum kontrolnych to łączna wartość kolumny `kolumna` z wierszy. */
export interface SumaKolumny {
  pole: string;
  kolumna: string;
  /** Pole obowiązkowe w schemacie: bez niego alarm. Pole nieobowiązkowe bez wartości to 0. */
  obowiazkowe: boolean;
}

export interface SumyKontrolne<K extends string> {
  /** Element wiersza, np. `EWPWiersz`. */
  wiersz: string;
  /** Element sum kontrolnych, np. `EWPCtrl`. */
  ctrl: string;
  /** Kod alarmu dla `LiczbaWierszy`. */
  kodLiczby: K;
  /** Kod alarmu dla sum kolumn. */
  kodSum: K;
  sumy: readonly SumaKolumny[];
}

/** Elementy powtarzalne obu schematów: zawsze tablica, także przy jednym wierszu. */
const POWTARZALNE = new Set(['EWPWiersz', 'PKPIRSpis', 'PKPIRWiersz']);

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  // Wartości jako tekst: kwoty czyta `grosze`, nie parser (jak w `lib/import/fa3-parser.ts`).
  parseTagValue: false,
  trimValues: true,
  isArray: (nazwa) => POWTARZALNE.has(nazwa),
});

/** Element `JPK` gotowego pliku; null, gdy tekst nie jest XML albo nie ma w nim `JPK`. */
export function czytajJpk(xml: string): Wezel | null {
  try {
    return wezel(wezel(parser.parse(xml, true))?.JPK);
  } catch {
    return null;
  }
}

/**
 * `LiczbaWierszy` to liczba wierszy, a każde pole z `sumy` to łączna wartość
 * swojej kolumny z wierszy (opisy pól sum kontrolnych). Plik bez elementu sum
 * kontrolnych daje alarm obu kodów. Zwraca wiersze pliku do dalszych kontroli.
 */
export function sprawdzSumyKontrolne<K extends string>(jpk: Wezel | null, s: SumyKontrolne<K>, zglos: Zglos<K>): Wezel[] {
  const wierszePliku = wiersze(jpk?.[s.wiersz]);
  const ctrl = wezel(jpk?.[s.ctrl]);

  if (!ctrl) {
    zglos(s.kodLiczby, `plik nie ma sum kontrolnych ${s.ctrl}`);
  } else {
    const liczba = liczbaNaturalna(ctrl.LiczbaWierszy);
    if (liczba === null) zglos(s.kodLiczby, `LiczbaWierszy w ${s.ctrl} brak albo nie jest liczbą wierszy`);
    else if (liczba !== wierszePliku.length) zglos(s.kodLiczby, `LiczbaWierszy różni się od liczby wierszy ${s.wiersz}`);
  }

  for (const { pole, kolumna, obowiazkowe } of s.sumy) {
    const wartosc = ctrl !== null && Object.prototype.hasOwnProperty.call(ctrl, pole) ? kwota(ctrl, pole) : obowiazkowe ? null : 0;
    const zWierszy = suma(wierszePliku.map((w) => kwota(w, kolumna)));
    if (wartosc === null) zglos(s.kodSum, `${pole} brak albo nie jest kwotą`);
    else if (zWierszy === null) zglos(s.kodSum, `${kolumna} w wierszach ${s.wiersz} nie jest kwotą albo suma wychodzi poza zakres`);
    else if (wartosc !== zWierszy) zglos(s.kodSum, `${pole} różni się od sumy ${kolumna} z wierszy ${s.wiersz}`);
  }
  return wierszePliku;
}

/** Kwota pola w groszach; 0, gdy pola nie ma; null, gdy pole jest, ale nie jest jedną kwotą. */
export function kwota(w: Wezel, pole: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(w, pole)) return 0;
  const v = w[pole];
  return typeof v === 'string' ? grosze(v) : null;
}

/** Suma z kontrolą zakresu po każdym kroku; null, gdy któryś składnik nie jest kwotą albo suma wyjdzie poza bezpieczne liczby całkowite. */
export function suma(skladniki: ReadonlyArray<number | null>): number | null {
  let s = 0;
  for (const x of skladniki) {
    if (x === null) return null;
    s += x;
    if (!Number.isSafeInteger(s)) return null;
  }
  return s;
}

function wezel(v: unknown): Wezel | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Wezel) : null;
}

/** Wiersze pliku; wiersz bez pól (pusty element) liczy się do liczby wierszy, kwot nie ma. */
function wiersze(v: unknown): Wezel[] {
  return Array.isArray(v) ? v.map((w) => wezel(w) ?? {}) : [];
}

/** TNaturalnyJPK (liczba całkowita bez znaku minus); null, gdy pola nie ma albo to nie liczba. */
function liczbaNaturalna(v: unknown): number | null {
  if (typeof v !== 'string' || !/^\+?\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

const KWOTA = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/** Tekst xsd:decimal (TKwotowy) w groszach; null, gdy to nie kwota z najwyżej dwoma miejscami po przecinku. */
function grosze(tekst: string): number | null {
  const m = KWOTA.exec(tekst);
  if (!m) return null;
  const [, znak, calosc, ulamek = ''] = m;
  if (calosc === '' && ulamek === '') return null;
  if (/[1-9]/.test(ulamek.slice(2))) return null;
  const gr = Number(calosc || '0') * 100 + Number(ulamek.slice(0, 2).padEnd(2, '0'));
  if (!Number.isSafeInteger(gr)) return null;
  return znak === '-' ? 0 - gr : gr;
}
