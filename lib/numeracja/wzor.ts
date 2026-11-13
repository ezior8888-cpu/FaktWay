/**
 * Wzór numeru faktury w serii (plan kompletnej aplikacji, krok 2.5).
 *
 * Elementy: {RRRR} rok, {MM} miesiąc z zerem, {M} miesiąc, {N} do {NNNNNN}
 * licznik (liczba N to najmniejsza liczba cyfr, licznik dłuższy nie jest
 * obcinany). Poza nimi przedrostek i separatory: litery bez polskich znaków,
 * cyfry, spacja i / . _ -.
 *
 * Art. 106e ust. 1 pkt 2 ustawy o VAT: kolejny numer w ramach serii, który
 * jednoznacznie identyfikuje fakturę. Dlatego wzór musi mieć licznik, wzór
 * z miesiącem także rok, a licznik obok {M} (oba o zmiennej liczbie cyfr)
 * znak, który nie jest cyfrą. Licznik liczy się od 1 co miesiąc (wzór
 * z miesiącem), co rok (z rokiem) albo bez zerowania.
 *
 * Te same reguły ma baza (00199: `invoice_number_pattern_problem`,
 * `invoice_number_period`, `invoice_number_render`,
 * `invoice_number_pattern_skeleton`); zgodność sprawdza
 * tests/rls-numeracja.test.ts. Moduł bez zależności: używa go formularz
 * w przeglądarce i akcje na serwerze.
 */

export const INVOICE_KINDS = ['regular', 'advance', 'final', 'correction'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export const INVOICE_KIND_LABELS: Record<InvoiceKind, string> = {
  regular: 'Faktura',
  advance: 'Faktura zaliczkowa',
  final: 'Faktura końcowa',
  correction: 'Korekta',
};

export function isInvoiceKind(value: unknown): value is InvoiceKind {
  return typeof value === 'string' && (INVOICE_KINDS as readonly string[]).includes(value);
}

export const MAX_PATTERN_LENGTH = 30;
export const MAX_FIRST_NUMBER = 9_999_999;
export const MAX_SERIES_NAME_LENGTH = 60;

export type PatternProblem =
  | 'empty'
  | 'too_long'
  | 'bad_char'
  | 'unknown_token'
  | 'no_counter'
  | 'duplicate_token'
  | 'month_without_year'
  | 'ambiguous';

const TOKENS = /\{(RRRR|MM|M|N{1,6})\}/g;
const COUNTER = /\{N{1,6}\}/;
const LITERAL_CHARS = /^[A-Za-z0-9 /._-]*$/;
const PERIOD = /^(\d{4}(-(0[1-9]|1[0-2]))?)?$/;

/** Jak `btrim` w Postgresie: tylko spacje, nie tabulatory i nowe linie. */
function trimSpaces(text: string): string {
  return text.replace(/^ +| +$/g, '');
}

function count(text: string, re: RegExp): number {
  return text.match(new RegExp(re.source, 'g'))?.length ?? 0;
}

/** Problem wzoru albo `null`, gdy wzór jest poprawny (kolejność sprawdzeń jak w bazie). */
export function patternProblem(pattern: string): PatternProblem | null {
  if (trimSpaces(pattern) === '') return 'empty';
  if ([...pattern].length > MAX_PATTERN_LENGTH) return 'too_long';
  const literal = pattern.replace(TOKENS, '');
  if (/[{}]/.test(literal)) return 'unknown_token';
  if (!LITERAL_CHARS.test(literal) || pattern !== trimSpaces(pattern)) return 'bad_char';
  const years = count(pattern, /\{RRRR\}/);
  const months = count(pattern, /\{MM?\}/);
  const counters = count(pattern, COUNTER);
  if (counters === 0) return 'no_counter';
  if (years > 1 || months > 1 || counters > 1) return 'duplicate_token';
  if (months === 1 && years === 0) return 'month_without_year';
  const monthAt = pattern.indexOf('{M}');
  if (monthAt >= 0) {
    const token = COUNTER.exec(pattern)![0];
    const counterAt = pattern.indexOf(token);
    const between = monthAt < counterAt
      ? pattern.slice(monthAt + 3, counterAt)
      : pattern.slice(counterAt + token.length, monthAt);
    if (!/[^0-9]/.test(between.replace(/\{RRRR\}/g, ''))) return 'ambiguous';
  }
  return null;
}

const PROBLEM_MESSAGES: Record<PatternProblem, string> = {
  empty: 'Wpisz wzór numeru, np. FV/{NNN}/{MM}/{RRRR}.',
  too_long: `Wzór numeru może mieć najwyżej ${MAX_PATTERN_LENGTH} znaków.`,
  bad_char:
    'We wzorze mogą być litery bez polskich znaków, cyfry, spacja, znaki / . _ - oraz elementy {RRRR}, {MM}, {M} i {N}. Bez spacji na początku i na końcu.',
  unknown_token:
    'Nieznany element w nawiasach klamrowych. Dostępne są {RRRR} (rok), {MM} (miesiąc z zerem), {M} (miesiąc) oraz {N} albo {NNN} (licznik, liczba N to najmniejsza liczba cyfr).',
  no_counter: 'Wzór musi zawierać licznik, np. {N} albo {NNN}. Bez licznika dwie faktury dostałyby ten sam numer.',
  duplicate_token: 'Każdy element (rok, miesiąc, licznik) może wystąpić we wzorze tylko raz.',
  month_without_year: 'Wzór z miesiącem musi zawierać też rok {RRRR}, inaczej numery powtórzą się co rok.',
  ambiguous:
    'Oddziel licznik od miesiąca znakiem innym niż cyfra, np. „/”. Bez tego dwa różne numery mogłyby wyglądać tak samo.',
};

export function patternProblemMessage(problem: PatternProblem): string {
  return PROBLEM_MESSAGES[problem];
}

export function isPatternProblem(value: unknown): value is PatternProblem {
  return typeof value === 'string' && value in PROBLEM_MESSAGES;
}

export type PatternReset = 'monthly' | 'yearly' | 'never';

export function patternReset(pattern: string): PatternReset {
  if (/\{MM?\}/.test(pattern)) return 'monthly';
  if (pattern.includes('{RRRR}')) return 'yearly';
  return 'never';
}

export const RESET_LABELS: Record<PatternReset, string> = {
  monthly: 'licznik od 1 co miesiąc',
  yearly: 'licznik od 1 co rok',
  never: 'licznik bez zerowania',
};

/** Okres licznika z daty wystawienia (RRRR-MM-DD): RRRR-MM, RRRR albo pusty. */
export function patternPeriod(pattern: string, issueDate: string): string {
  const year = issueDate.slice(0, 4);
  const month = issueDate.slice(5, 7);
  const reset = patternReset(pattern);
  if (reset === 'monthly') return `${year}-${month}`;
  if (reset === 'yearly') return year;
  return '';
}

function replaceAllText(text: string, search: string, value: string): string {
  return text.split(search).join(value);
}

/** Numer z wzoru, okresu i licznika; `null`, gdy okres nie pasuje do wzoru. */
export function renderInvoiceNumber(pattern: string, period: string, counter: number): string | null {
  if (!Number.isInteger(counter) || counter < 1 || !PERIOD.test(period)) return null;
  let out = pattern;
  if (out.includes('{RRRR}')) {
    if (period.length < 4) return null;
    out = replaceAllText(out, '{RRRR}', period.slice(0, 4));
  }
  if (out.includes('{MM}') || out.includes('{M}')) {
    if (period.length !== 7) return null;
    const mm = period.slice(5, 7);
    out = replaceAllText(replaceAllText(out, '{MM}', mm), '{M}', String(Number(mm)));
  }
  const token = COUNTER.exec(out)?.[0];
  if (!token) return null;
  const width = token.length - 2;
  const digits = String(counter);
  return replaceAllText(out, token, digits.length < width ? digits.padStart(width, '0') : digits);
}

/** Układ numeru: znaki poza elementami i cyframi, wielkimi literami (unikalny w firmie). */
export function patternSkeleton(pattern: string): string {
  return pattern.replace(TOKENS, '').replace(/[0-9]/g, '').toUpperCase();
}
