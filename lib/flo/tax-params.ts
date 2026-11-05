/**
 * Parametry roczne FLO i kalendarz terminów (krok 35 planu).
 *
 * ⚠️ WARTOŚCI WYMAGAJĄ POTWIERDZENIA PRZEZ CZŁOWIEKA — dokładnie tak samo
 * jak stawki odsetek w `lib/flo/interest.ts`.
 *
 * Limity, progi i terminy to DANE PRAWNE. Zmieniają się ustawą, a nie
 * decyzją programisty, i nie wolno brać ich z pamięci modelu językowego —
 * model potrafi podać liczbę, która była prawdziwa dwa lata temu, i zrobi
 * to z pełnym przekonaniem. Dlatego każdy wiersz ma pole `source`, a flaga
 * `PARAMS_VERIFIED` stoi na `false`, dopóki ktoś nie sprawdzi tabeli
 * w źródle urzędowym i nie przestawi jej świadomie, w commicie.
 *
 * OD KROKU K1 PLANU KSIĘGOWOŚCI (docs/koordynacja/PLAN-KSIEGOWOSC-JDG.md):
 * - kalendarz i terminy żyją w `lib/ksiegowosc/kalendarz.ts`, a ten plik
 *   tylko je udostępnia pod dawnymi nazwami;
 * - atrapy składek ZUS (400/700/1600 zł) usunięte (D7): `tax-relief`
 *   dostaje kwoty od wywołującego;
 * - limit zwolnienia z VAT dla Pulpitu czyta `lib/ksiegowosc/parametry`.
 * Tabela niżej zostaje wyłącznie dla nieaktywnych funkcji FLO.
 *
 * BEZPIECZNIK WIEKU: `paramsStale()` psuje zestaw testów, gdy tabela nie
 * była przeglądana od roku. To celowe. Parametry podatkowe, o których
 * wszyscy zapomnieli, są gorsze od ich braku: brak widać od razu, a stara
 * liczba wygląda dokładnie tak samo jak świeża.
 */

import {
  czyDzienRoboczy,
  czySwieto,
  dniWolne,
  najblizszyDzienRoboczy,
  ostatniMiesiacKwartalu,
  terminDla,
  wielkanoc,
  type RodzajTerminu,
} from '@/lib/ksiegowosc/kalendarz';

// ═══════════════════════════════════════════════════════════════
// Bezpieczniki
// ═══════════════════════════════════════════════════════════════

/**
 * PRZESTAW NA `true` DOPIERO PO SPRAWDZENIU CAŁEJ TABELI W ŹRÓDLE URZĘDOWYM
 * i uzupełnieniu pól `source`. Dopóki jest `false`, grupa podatkowa milczy
 * niezależnie od tego, co ustawiono w `lib/flo/flags.ts`.
 */
export const PARAMS_VERIFIED = false;

/** Kiedy człowiek ostatni raz przejrzał tabelę poniżej (YYYY-MM-DD). */
export const PARAMS_REVIEWED_ON = '2026-08-29';

/** Po tylu dniach bez przeglądu tabela uchodzi za przeterminowaną. */
export const PARAMS_MAX_AGE_DAYS = 365;

const DAY_MS = 86_400_000;

export function paramsAgeDays(today: Date = new Date()): number {
  const reviewed = Date.parse(`${PARAMS_REVIEWED_ON}T00:00:00.000Z`);
  return Math.floor((today.getTime() - reviewed) / DAY_MS);
}

/** Pilnowane testem. Zielone dopóki ktoś przegląda tabelę raz do roku. */
export function paramsStale(today: Date = new Date()): boolean {
  return paramsAgeDays(today) > PARAMS_MAX_AGE_DAYS;
}

// ═══════════════════════════════════════════════════════════════
// Tabela parametrów
// ═══════════════════════════════════════════════════════════════

export interface TaxParams {
  /** Data, od której zestaw obowiązuje (YYYY-MM-DD). */
  validFrom: string;
  /** Skala: stawka pierwszego progu (ułamek). */
  pitScaleLowRate: number;
  /** Skala: stawka powyżej progu (ułamek). */
  pitScaleHighRate: number;
  /** Skala: próg dochodu, PLN. */
  pitScaleThreshold: number;
  /** Skala: kwota wolna od podatku, PLN. */
  pitTaxFreeAmount: number;
  /** Podatek liniowy: stawka (ułamek). */
  pitFlatRate: number;
  /** Ulga na start: ile miesięcy bez składek społecznych. */
  reliefStartMonths: number;
  /** Preferencyjny ZUS: ile miesięcy po uldze na start. */
  reliefPreferentialMonths: number;
  /** Skąd wzięte wartości — PUSTE POLE OZNACZA WIERSZ NIESPRAWDZONY. */
  source: string;
}

/**
 * Zestawy posortowane rosnąco po dacie obowiązywania.
 *
 * Wartości poniżej są PLACEHOLDERAMI o prawdopodobnym rzędzie wielkości.
 * Służą do testowania algorytmów — kalendarza, proporcji, progów — a nie
 * do liczenia czegokolwiek klientowi. Patrz `PARAMS_VERIFIED`.
 */
export const TAX_PARAMS: readonly TaxParams[] = [
  {
    validFrom: '2026-01-01',
    pitScaleLowRate: 0.12,
    pitScaleHighRate: 0.32,
    pitScaleThreshold: 120_000,
    pitTaxFreeAmount: 30_000,
    pitFlatRate: 0.19,
    reliefStartMonths: 6,
    reliefPreferentialMonths: 24,
    source: '',
  },
];

/**
 * Zestaw obowiązujący w danym dniu.
 *
 * Zwraca `null` dla dat sprzed pierwszego wiersza. Milczenie jest wtedy
 * jedyną uczciwą odpowiedzią: nie wiemy, jakie były wtedy limity, a
 * podstawienie najstarszego znanego zestawu byłoby zgadywaniem.
 */
export function paramsFor(date: Date): TaxParams | null {
  const stamp = date.getTime();
  let found: TaxParams | null = null;

  for (const row of TAX_PARAMS) {
    const from = Date.parse(`${row.validFrom}T00:00:00.000Z`);
    if (from <= stamp) found = row;
  }

  return found;
}

// ═══════════════════════════════════════════════════════════════
// Kalendarz dni wolnych (z `lib/ksiegowosc/kalendarz.ts`)
// ═══════════════════════════════════════════════════════════════

export const easterSunday = wielkanoc;
export const holidaysOf = dniWolne;
export const isPublicHoliday = czySwieto;
export const isBusinessDay = czyDzienRoboczy;
export const shiftToBusinessDay = najblizszyDzienRoboczy;
export const quarterEndMonth = ostatniMiesiacKwartalu;

// ═══════════════════════════════════════════════════════════════
// Terminy
// ═══════════════════════════════════════════════════════════════

export type TaxDeadlineKind = 'vat' | 'pit' | 'zus';

export interface TaxDeadline {
  kind: TaxDeadlineKind;
  /** Termin ustawowy przed przesunięciem, YYYY-MM-DD. */
  nominal: string;
  /** Termin faktyczny, po przesunięciu na dzień roboczy. */
  due: string;
  /** Czy przesunięcie w ogóle nastąpiło — do treści komunikatu. */
  shifted: boolean;
}

export interface DeadlineInput {
  kind: TaxDeadlineKind;
  /** Rok okresu rozliczeniowego. */
  year: number;
  /** Ostatni miesiąc okresu rozliczeniowego, 1–12. */
  month: number;
}

const DEADLINE_KIND: Record<TaxDeadlineKind, RodzajTerminu> = {
  vat: 'vatJpk',
  pit: 'zaliczkaPit',
  zus: 'zus',
};

/**
 * Termin dla okresu rozliczeniowego — zawsze w miesiącu NASTĘPUJĄCYM po nim.
 * Liczy `terminDla` z modułu księgowości; `null`, gdy dla tej daty nie
 * znamy terminów. Podanie terminu „na oko" byłoby najgorszym możliwym
 * błędem tej funkcji: klient zapłaciłby za późno.
 */
export function taxDeadline(input: DeadlineInput): TaxDeadline | null {
  const termin = terminDla({ rodzaj: DEADLINE_KIND[input.kind], rok: input.year, miesiac: input.month });
  if (!termin) return null;

  return {
    kind: input.kind,
    nominal: termin.nominalny,
    due: termin.faktyczny,
    shifted: termin.przesuniety,
  };
}
