/**
 * Typy parametrów modułu księgowości (plan `docs/koordynacja/PLAN-KSIEGOWOSC-JDG.md`,
 * krok K1, decyzje D7 i D12).
 *
 * Każda LICZBA ma źródło i datę odczytu. Każda SEKCJA ma pole `sprawdzila`:
 * dopóki księgowa jej nie potwierdzi, silniki nie liczą z niej kwot dla
 * klienta (`brakujace()` w `index.ts`). Liczba jeszcze nieogłoszona ma
 * `wartosc: null` i powód w `uwagi` — nigdy wartość „na oko”.
 *
 * Jednostki są całkowite, żeby silniki liczyły bez ułamków binarnych:
 * kwoty w groszach, stopy w punktach bazowych (1 pb = 0,01 %, więc 19,52 %
 * to 1952), okresy w miesiącach, terminy jako dzień miesiąca.
 */

export type Jednostka = 'gr' | 'pb' | 'mies' | 'dzien';

/** Pewność wpisu według planu (sekcja 5) i odczytu źródła. */
export type Pewnosc = 'wysoka' | 'srednia' | 'niska';

export interface Liczba {
  /** `null` = jeszcze nieogłoszona albo niepotwierdzona; liczyć z niej nie wolno. */
  wartosc: number | null;
  jednostka: Jednostka;
  /** Akt prawny albo komunikat i adres strony. Pusty tylko przy `wartosc: null`. */
  zrodlo: string;
  /** Kiedy źródło przeczytano, RRRR-MM-DD. */
  odczyt: string;
  pewnosc: Pewnosc;
  /** Obowiązkowe przy `wartosc: null`: czego brakuje i kiedy się pojawi. */
  uwagi?: string;
}

export interface Sprawdzenie {
  /** Imię i nazwisko księgowej. */
  kto: string;
  /** RRRR-MM-DD */
  data: string;
}

export interface Sekcja<K extends string> {
  liczby: { readonly [P in K]: Liczba };
  /** `null` = księgowa nie potwierdziła sekcji; silniki jej nie używają. */
  sprawdzila: Sprawdzenie | null;
}

export type KluczRyczaltu =
  | 'stawka17'
  | 'stawka15'
  | 'stawka14'
  | 'stawka12'
  | 'stawka10'
  | 'stawka8_5'
  | 'stawka5_5'
  | 'stawka3'
  | 'progStawki8_5'
  | 'stawkaPonadProg8_5'
  | 'odliczenieZdrowotnej';

export type KluczZdrowotnej =
  | 'stawka'
  | 'stawkaLiniowy'
  | 'przecietneWynagrodzenieIvKw'
  | 'ryczaltDo60Tys'
  | 'ryczaltDo300Tys'
  | 'ryczaltPonad300Tys'
  | 'progRyczaltu60Tys'
  | 'progRyczaltu300Tys'
  | 'minimalna';

export type KluczZus =
  | 'placaMinimalna'
  | 'prognozowanePrzecietneWynagrodzenie'
  | 'podstawaPelnaProc'
  | 'podstawaPreferencyjnaProc'
  | 'stopaEmerytalna'
  | 'stopaRentowa'
  | 'stopaChorobowa'
  | 'stopaWypadkowaDoMarca'
  | 'stopaWypadkowaOdKwietnia'
  | 'stopaFunduszPracy'
  | 'ulgaNaStartMiesiecy'
  | 'preferencyjnyMiesiecy';

export interface ParametryRoku {
  rok: number;
  vat: Sekcja<'limitZwolnienia'>;
  ryczalt: Sekcja<KluczRyczaltu>;
  /** Limity uprawniające do formy i okresu rozliczeń; miesięczne silniki ich nie potrzebują. */
  limity: Sekcja<'ryczaltLimitPrzychodu' | 'ryczaltLimitKwartalny'>;
  skala: Sekcja<'stawkaDoProgu' | 'stawkaPonadProg' | 'prog' | 'kwotaZmniejszajaca'>;
  liniowy: Sekcja<'stawka' | 'limitOdliczeniaZdrowotnej'>;
  /**
   * ROK SKŁADKOWY zdrowotnej: od 1 lutego `rok` do 31 stycznia `rok + 1`.
   * Za styczeń obowiązuje sekcja z roku poprzedniego (`zdrowotnaNa`).
   */
  zdrowotna: Sekcja<KluczZdrowotnej>;
  zus: Sekcja<KluczZus>;
}

export type NazwaSekcji = Exclude<keyof ParametryRoku, 'rok'>;

/**
 * Dni miesiąca terminów. Ustawowe i stałe od lat, więc tabela idzie po dacie
 * obowiązywania, a nie rok po roku: termin za grudzień przypada w styczniu
 * następnego roku, dla którego może jeszcze nie być pliku parametrów.
 */
export interface Terminy {
  /** Od kiedy obowiązuje, RRRR-MM-DD. */
  od: string;
  liczby: { readonly [P in 'ryczalt' | 'zaliczkaPit' | 'zus' | 'vatJpk']: Liczba };
  sprawdzila: Sprawdzenie | null;
}
