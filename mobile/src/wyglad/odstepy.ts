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
 * Zaokrąglenia jak w Copilocie (plan aplikacji, D15; ZASADY-DESIGNU.md,
 * sekcje 2 i 5): karta 18 pt, przycisk 16 pt, pole 12 pt, plakietka i pigułka
 * w pełni zaokrąglone, słupek wykresu 4 pt.
 */
export const PROMIEN_KARTY = 18;
export const PROMIEN_PRZYCISKU = 16;
export const PROMIEN_POLA = 12;
export const PROMIEN_PIGULKI = 999;
export const PROMIEN_SLUPKA = 4;

/**
 * Cień karty w jasnym motywie: dwie warstwy, ledwo widoczna krawędź i miękka
 * poświata (D15). W ciemnym karty nie mają cienia, odróżnia je jaśniejsze tło.
 */
export const CIEN_KARTY = '0px 1px 2px rgba(16, 24, 40, 0.04), 0px 8px 24px rgba(16, 24, 40, 0.06)';

/** Obwódka pól formularza (`border` na stronie). Karty od D15 są bez obwódki. */
export const OBWODKA = 1;

/** Średnica okrągłej ikony w wierszu i kaflu (`Avatar` z ikoną na stronie, `size-9`). */
export const KOLO_IKONY = 34;

/** Od tej skali tekstu z ustawień dostępności wiersze list układają wartość pod tytułem. */
export const SKALA_PIONOWA = 1.5;

/**
 * Gradient pod nagłówkiem (D15), w pt od górnej krawędzi przewijanej treści.
 * `nadTrescia`: mniej więcej pasek stanu, pasek nawigacji i duży tytuł.
 * `podTrescia`: tu gradient znika w tle, pod pierwszą kartą ekranu, więc
 * nagłówki sekcji niżej stoją już na zwykłym tle i trzymają kontrast.
 */
export const GRADIENT = { nadTrescia: 150, podTrescia: 120 } as const;
