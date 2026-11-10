/**
 * Skala odstępów i kształtów (docs/mobile/ZASADY-DESIGNU.md, sekcja 3).
 * Wartości spoza skali nie wpisujemy w komponentach.
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

/** Margines boczny treści i wcięcie wierszy w karcie. */
export const MARGINES = ODSTEP.m;

/** Najmniejszy cel dotyku: 44 pt na iOS, 48 dp na Androidzie. */
export const CEL_DOTYKU = 44;

/**
 * Zaokrąglenie kart, przycisków, pól i plakietek. Na stronie karty i przyciski
 * mają ostre rogi (styl `base-lyra` szablonu Finora, `rounded-none`); na
 * telefonie 2 pt, żeby krawędź nie migotała przy przewijaniu, a wrażenie
 * zostało to samo. Zmiana na 0 to jedna linia.
 */
export const PROMIEN = 2;

/** Obwódka kart i pól (`ring-1` i `border` na stronie). */
export const OBWODKA = 1;

/** Średnica okrągłej ikony w wierszu i kaflu (`Avatar` z ikoną na stronie, `size-9`). */
export const KOLO_IKONY = 34;

/** Od tej skali tekstu z ustawień dostępności wiersze list układają wartość pod tytułem. */
export const SKALA_PIONOWA = 1.5;
