/**
 * Normalizacja nazwy pozycji faktury do rankingu produktów („Najlepiej
 * sprzedające się” na Pulpicie, „Sprzedaż według produktów” i „Najlepsze
 * produkty i usługi” w Analizach — wszystkie przez `rankProducts`).
 *
 * Nazwy usług powtarzalnych niosą okres („Usługi programistyczne –
 * październik 2026”, „Abonament 11/2026”, „Obsługa za okres 01.12.2026 –
 * 31.12.2026”) albo numer umowy, więc grupowanie po dokładnej nazwie robiło
 * z każdego miesiąca osobny „produkt”. Tu z nazwy znikają:
 *
 * - numer umowy: „wg umowy nr …”, „według umowy nr …”, „wg nr …”;
 * - polskie nazwy miesięcy w każdej odmianie („październik”, „października”,
 *   „w październiku”) z rokiem albo z przyimkiem „za/w/na” i po myślniku,
 *   „MM/RRRR”, „MM.RRRR”, „MM-RRRR”, „RRRR-MM”, daty „dd.mm.rrrr”;
 * - zakresy „od … do …”, „… – …” oraz przyimki „za”, „za okres”, „za miesiąc”.
 *
 * Sam rok („Licencja 2026”) i liczby („Pakiet 10 godzin”) zostają. Czysta
 * funkcja, bez zależności.
 */

const NOT_WORD_BEFORE = String.raw`(?<![\p{L}\p{N}])`;
const NOT_WORD_AFTER = String.raw`(?![\p{L}\p{N}])`;
// Liczby nie mogą być środkiem większej daty („10.2026” w „01.10.2026”).
const NOT_DATE_BEFORE = String.raw`(?<![\p{L}\p{N}./-])`;
const NOT_DATE_AFTER = String.raw`(?![\p{L}\p{N}]|[./-]\p{N})`;

const MONTH_NAMES = [
  'stycz(?:eń|nia|niu|niem)',
  'lut(?:y|ego|ym)',
  'mar(?:zec|ca|cu|cem)',
  'kwie(?:cień|tnia|tniu|tniem)',
  'maj(?:a|u|em)?',
  'czerw(?:iec|ca|cu|cem)',
  'lip(?:iec|ca|cu|cem)',
  'sierp(?:ień|nia|niu|niem)',
  'wrze(?:sień|śnia|śniu|śniem)',
  'październik(?:a|u|iem)?',
  'listopad(?:a|zie|em)?',
  'grud(?:zień|nia|niu|niem)',
].join('|');

const MONTH = `${NOT_WORD_BEFORE}(?:${MONTH_NAMES})${NOT_WORD_AFTER}`;
const YEAR = String.raw`(?:19|20)\d{2}`;
const MONTH_NUM = String.raw`(?:0?[1-9]|1[0-2])`;
const DAY_NUM = String.raw`(?:0?[1-9]|[12]\d|3[01])`;

const DATE_DMY = `${NOT_DATE_BEFORE}${DAY_NUM}[./-]${MONTH_NUM}[./-](?:${YEAR}|\\d{2})${NOT_DATE_AFTER}`;
const NUM_MONTH_YEAR = `${NOT_DATE_BEFORE}${MONTH_NUM}[./-]${YEAR}${NOT_DATE_AFTER}`;
const YEAR_NUM_MONTH = `${NOT_DATE_BEFORE}${YEAR}[./-]${MONTH_NUM}${NOT_DATE_AFTER}`;
const MONTH_WITH_YEAR = `${MONTH}\\s+${YEAR}(?:\\s*r\\.?)?`;

/** Okres rozpoznawany bez przyimka: data, miesiąc liczbą, miesiąc słowem z rokiem. */
const STRICT_TOKEN = `(?:${DATE_DMY}|${NUM_MONTH_YEAR}|${YEAR_NUM_MONTH}|${MONTH_WITH_YEAR})`;
/** Po przyimku „za/w/na” wystarczy sama nazwa miesiąca („za styczeń”). */
const LOOSE_TOKEN = `(?:${STRICT_TOKEN}|${MONTH})`;

const RANGE_JOIN = String.raw`\s*(?:[-–—]|do)\s*`;
const range = (token: string) => `${token}(?:${RANGE_JOIN}${token})?`;

const PREPOSITION = String.raw`${NOT_WORD_BEFORE}(?:za|w|na|dla)\s+(?:(?:okres(?:ie)?|miesiąc|miesiącu)\s+)?(?:od\s+)?`;

const PERIOD = new RegExp(
  [
    `${PREPOSITION}${range(LOOSE_TOKEN)}`,
    `(?:od\\s+)?${range(STRICT_TOKEN)}`,
    // Goły miesiąc po myślniku: „Hosting – marzec”.
    String.raw`(?<=[-–—]\s{0,3})${MONTH}`,
  ].join('|'),
  'giu',
);

const CONTRACT = new RegExp(
  String.raw`${NOT_WORD_BEFORE}(?:wg\.?|według|zgodnie\s+z|na\s+podstawie)\s+(?:umow\p{L}*\s+)?(?:nr\.?|numer)\s*[\p{L}\p{N}][\p{L}\p{N}./_-]*`,
  'giu',
);

export interface NormalizedProductName {
  /** Klucz grupy: nazwa bez okresu i umowy, małymi literami, pojedyncze spacje. */
  key: string;
  /** Nazwa do wyświetlenia: jak wyżej, z zachowaniem wielkości liter oryginału. */
  display: string;
}

function tidy(text: string): string {
  return text
    .replace(/[(\[]\s*[)\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/([-–—])(?:\s+[-–—])+/g, '$1')
    .replace(/^[\s\-–—,;:/]+|[\s\-–—,;:/]+$/g, '');
}

export function normalizeProductName(name: string | null | undefined): NormalizedProductName {
  const original = tidy(name ?? '');
  const stripped = tidy(original.replace(CONTRACT, ' ').replace(PERIOD, ' '));
  // Nazwa złożona wyłącznie z okresu zostaje, żeby nie zlać różnych pozycji w jedną pustą grupę.
  const display = stripped || original;
  return { key: display.toLowerCase(), display };
}
