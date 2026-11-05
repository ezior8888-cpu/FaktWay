/**
 * Parametry modułu księgowości: jedyne miejsce, z którego silniki biorą
 * stawki, progi, limity i terminy (plan, D7 i sekcja 4 pkt 7).
 *
 * FAIL-CLOSED: silnik przed liczeniem pyta `brakujace(rok, sekcje)`. Brak
 * roku, liczba bez wartości albo sekcja niesprawdzona przez księgową
 * oznaczają brak kwoty i komunikat z nazwą braku. Ścieżka operatora: PR
 * z plikiem roku albo z potwierdzeniem księgowej w polu `sprawdzila`.
 *
 * Wyjątek świadomy: karta „Limit zwolnienia z VAT” na Pulpicie działa od
 * 2026 r. i czyta limit przez `limitZwolnieniaVat` bez warunku `sprawdzila`,
 * tak jak przed przeniesieniem z `lib/flo/tax-params.ts`. To licznik ustawowego
 * progu, a nie kwota do zapłaty.
 */

import { PARAMETRY_2026 } from './2026';
import { PARAMETRY_2027 } from './2027';
import { TERMINY } from './terminy';
import type { Liczba, NazwaSekcji, ParametryRoku, Sekcja, Terminy } from './typy';

export type * from './typy';

export const PARAMETRY: Readonly<Record<number, ParametryRoku>> = {
  2026: PARAMETRY_2026,
  2027: PARAMETRY_2027,
};

export const SEKCJE: readonly NazwaSekcji[] = [
  'vat',
  'ryczalt',
  'limity',
  'skala',
  'liniowy',
  'zdrowotna',
  'zus',
];

/** Nazwy do komunikatów dla klienta. */
export const NAZWY_SEKCJI: Readonly<Record<NazwaSekcji, string>> = {
  vat: 'VAT',
  ryczalt: 'ryczałt',
  limity: 'limity przychodu',
  skala: 'skala podatkowa',
  liniowy: 'podatek liniowy',
  zdrowotna: 'składka zdrowotna',
  zus: 'składki ZUS',
};

const DZIEN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIESIAC = /^(\d{4})-(\d{2})$/;

function rokZDnia(dzien: string): number {
  const m = DZIEN.exec(dzien);
  if (!m) throw new Error(`Oczekiwano daty RRRR-MM-DD, otrzymano „${dzien}”`);
  return Number(m[1]);
}

export function parametryRoku(rok: number): ParametryRoku | null {
  return PARAMETRY[rok] ?? null;
}

/** Parametry roku kalendarzowego dnia (RRRR-MM-DD w Europe/Warsaw). */
export function parametryNa(dzien: string): ParametryRoku | null {
  return parametryRoku(rokZDnia(dzien));
}

/**
 * Rok składkowy zdrowotnej dla miesiąca RRRR-MM: od lutego do stycznia,
 * więc styczeń należy do roku poprzedniego.
 */
export function rokSkladkowyZdrowotnej(miesiac: string): number {
  const m = MIESIAC.exec(miesiac);
  if (!m) throw new Error(`Oczekiwano miesiąca RRRR-MM, otrzymano „${miesiac}”`);
  const rok = Number(m[1]);
  return Number(m[2]) === 1 ? rok - 1 : rok;
}

/** Sekcja zdrowotnej właściwa dla miesiąca składki (RRRR-MM). */
export function zdrowotnaNa(miesiac: string): ParametryRoku['zdrowotna'] | null {
  return parametryRoku(rokSkladkowyZdrowotnej(miesiac))?.zdrowotna ?? null;
}

/** Dni miesiąca terminów obowiązujące w danym dniu; przed pierwszym wierszem `null`. */
export function terminyNa(dzien: string): Terminy | null {
  rokZDnia(dzien);
  let znalezione: Terminy | null = null;
  for (const wiersz of TERMINY) {
    if (wiersz.od <= dzien) znalezione = wiersz;
  }
  return znalezione;
}

/**
 * Limit zwolnienia podmiotowego z VAT w groszach dla roku dnia; `null`, gdy
 * roku nie ma albo limitu jeszcze nie ogłoszono. Bez warunku `sprawdzila`
 * (nagłówek modułu).
 */
export function limitZwolnieniaVat(dzien: string): number | null {
  return parametryNa(dzien)?.vat.liczby.limitZwolnienia.wartosc ?? null;
}

export interface WpisLiczby {
  sekcja: NazwaSekcji;
  klucz: string;
  liczba: Liczba;
}

/** Wszystkie liczby roku, w kolejności sekcji (testy i panel operatora). */
export function wszystkieLiczby(parametry: ParametryRoku): WpisLiczby[] {
  return SEKCJE.flatMap((sekcja) => {
    const { liczby } = parametry[sekcja] as Sekcja<string>;
    return Object.entries(liczby).map(([klucz, liczba]) => ({ sekcja, klucz, liczba }));
  });
}

export type PowodBraku = 'brak_roku' | 'brak_liczby' | 'niesprawdzone';

export interface Brak {
  sekcja: NazwaSekcji;
  powod: PowodBraku;
  /** Klucze liczb bez wartości (tylko `brak_liczby`). */
  liczby?: string[];
  /** Dla klienta: nazwa braku i co z nim będzie. Bez trybu rozkazującego (D8). */
  komunikat: string;
  /** Dla operatora: gdzie to uzupełnić. */
  operator: string;
}

function brak(rok: number, sekcja: NazwaSekcji, powod: PowodBraku, liczby?: string[]): Brak {
  const nazwa = NAZWY_SEKCJI[sekcja];
  const plik = `lib/ksiegowosc/parametry/${rok}.ts`;
  if (powod === 'brak_roku') {
    return {
      sekcja,
      powod,
      komunikat: `Nie mamy jeszcze stawek na ${rok} r. (${nazwa}), więc tej kwoty nie liczymy.`,
      operator: `Brak pliku ${plik}: dodać go ze źródłami i potwierdzeniem księgowej.`,
    };
  }
  if (powod === 'brak_liczby') {
    return {
      sekcja,
      powod,
      liczby,
      komunikat: `Część stawek na ${rok} r. (${nazwa}) nie jest jeszcze ogłoszona, więc tej kwoty nie liczymy.`,
      operator: `Uzupełnić w ${plik}, sekcja ${sekcja}: ${(liczby ?? []).join(', ')}.`,
    };
  }
  return {
    sekcja,
    powod,
    komunikat: `Stawki na ${rok} r. (${nazwa}) czekają na sprawdzenie przez księgową, więc tej kwoty jeszcze nie pokazujemy.`,
    operator: `Sekcja ${sekcja} w ${plik} ma sprawdzila: null; wpis po potwierdzeniu przez księgową (warunek B4).`,
  };
}

/**
 * Czego brakuje, żeby liczyć z podanych sekcji roku. Pusta lista = wolno
 * liczyć. Zdrowotną sprawdza się dla roku SKŁADKOWEGO (`rokSkladkowyZdrowotnej`).
 */
export function brakujace(rok: number, sekcje: readonly NazwaSekcji[]): Brak[] {
  const parametry = parametryRoku(rok);
  if (!parametry) return sekcje.map((sekcja) => brak(rok, sekcja, 'brak_roku'));

  return sekcje.flatMap((sekcja) => {
    const { liczby, sprawdzila } = parametry[sekcja] as Sekcja<string>;
    const puste = Object.entries(liczby)
      .filter(([, liczba]) => liczba.wartosc === null)
      .map(([klucz]) => klucz);
    const braki: Brak[] = [];
    if (puste.length > 0) braki.push(brak(rok, sekcja, 'brak_liczby', puste));
    if (sprawdzila === null) braki.push(brak(rok, sekcja, 'niesprawdzone'));
    return braki;
  });
}

/**
 * Bezpiecznik roku: od 1 grudnia musi istnieć plik parametrów na następny
 * rok. Zwraca brakujący rok albo `null`. Test na nim psuje CI w grudniu,
 * zanim 1 stycznia karta limitu VAT i silniki zostaną bez parametrów.
 */
export function brakNastepnegoRoku(dzis: string): number | null {
  const rok = rokZDnia(dzis);
  if (dzis < `${rok}-12-01`) return null;
  return parametryRoku(rok + 1) ? null : rok + 1;
}
