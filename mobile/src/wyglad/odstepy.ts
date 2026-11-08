/**
 * Skala odstępów (docs/mobile/ZASADY-DESIGNU.md, sekcja 3). Wartości spoza
 * skali nie wpisujemy w komponentach.
 */
export const ODSTEP = {
  /** Tylko między liniami tekstu w jednym wierszu listy. */
  linia: 2,
  xxs: 4,
  xs: 8,
  s: 12,
  m: 16,
  l: 20,
  xl: 24,
  xxl: 32,
} as const;

/** Margines boczny treści i wcięcie wierszy listy. */
export const MARGINES = ODSTEP.m;

/** Najmniejszy cel dotyku: 44 pt na iOS, 48 dp na Androidzie. */
export const CEL_DOTYKU = 44;

/** Zaokrąglenie sekcji listy w stylu „inset grouped” (iOS 26 i nowsze). */
export const PROMIEN_SEKCJI = 26;

/** Od tej skali tekstu z ustawień dostępności wiersze list układają wartość pod tytułem. */
export const SKALA_PIONOWA = 1.5;
