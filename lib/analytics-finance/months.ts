import { addDaysToIsoDate, todayInWarsaw } from '@/lib/format/warsaw-date';

/**
 * Kalendarz stron „Analiza kosztów” i „Analiza sprzedaży” (plan Finora
 * P10/P11, N2). Czyste funkcje bez importów serwerowych — działają i na
 * serwerze, i w komponencie klienckim.
 *
 * Miesiąc to klucz `RRRR-MM`. „Dziś” zawsze z `todayInWarsaw` (§2.4 pkt 10),
 * arytmetyka miesięcy w UTC na polach kalendarza, więc wynik nie zależy od
 * strefy procesu.
 */

/** Parametr adresu z wybranym miesiącem (Finora: `month`, u nas po polsku). */
export const ANALYTICS_MONTH_PARAM = 'miesiac';

/** Tyle miesięcy (z bieżącym) proponuje wybór miesiąca — jak w Finorze. */
export const ANALYTICS_MONTH_OPTIONS = 6;

/** Kalendarz wydatków / sprzedaży: ostatnie 180 dni, jak „Daily Spend”. */
export const HEATMAP_DAYS = 180;

/** Trend: 6 ostatnich miesięcy, jak „Spend Trend”. */
export const TREND_MONTHS = 6;

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isMonthKey(value: unknown): value is string {
  return typeof value === 'string' && MONTH_KEY.test(value);
}

/** Klucz miesiąca przesunięty o `delta` miesięcy. */
export function shiftMonthKey(key: string, delta: number): string {
  const d = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Bieżący miesiąc w Polsce. */
export function currentMonthKey(now: Date): string {
  return todayInWarsaw(now).slice(0, 7);
}

/** `count` kluczy miesięcy kończących się `endKey`, od najstarszego. */
export function monthKeysEnding(endKey: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => shiftMonthKey(endKey, i - (count - 1)));
}

/** Zakres dat `[from, toExclusive)` jednego miesiąca. */
export function monthRange(key: string): { from: string; toExclusive: string } {
  return { from: `${key}-01`, toExclusive: `${shiftMonthKey(key, 1)}-01` };
}

/** Liczba dni miesiąca. */
export function daysInMonth(key: string): number {
  return new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).getUTCDate();
}

/**
 * Dni, przez które dzielimy „Średnio dziennie”: miesiąc miniony — wszystkie
 * dni, bieżący — dni do dziś włącznie. Finora dzieli zawsze przez wszystkie
 * dni miesiąca, co w bieżącym miesiącu zaniża średnią (świadome odstępstwo).
 */
export function countedDays(key: string, today: string): number {
  if (today.slice(0, 7) === key) return Number(today.slice(8, 10));
  return daysInMonth(key);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function monthDate(key: string): Date {
  return new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1));
}

/** „Październik 2026”. */
export function monthLongLabel(key: string): string {
  return capitalize(monthDate(key).toLocaleDateString('pl-PL', { month: 'long', year: 'numeric', timeZone: 'UTC' }));
}

/** „Paź” — podpis osi jak w `getSalesSeries`. */
export function monthShortLabel(key: string): string {
  const raw = monthDate(key)
    .toLocaleDateString('pl-PL', { month: 'short', timeZone: 'UTC' })
    .replace(/\./g, '')
    .trim();
  return capitalize(raw);
}

export interface MonthOption {
  value: string;
  label: string;
}

/** Wybór miesiąca: bieżący i 5 wcześniejszych, od najnowszego (jak w Finorze). */
export function analyticsMonthOptions(now: Date): MonthOption[] {
  const current = currentMonthKey(now);
  return Array.from({ length: ANALYTICS_MONTH_OPTIONS }, (_, i) => {
    const value = shiftMonthKey(current, -i);
    return { value, label: monthLongLabel(value) };
  });
}

/**
 * Miesiąc z adresu, gdy jest wśród proponowanych; inaczej bieżący. Ręcznie
 * wpisany starszy miesiąc nie otwiera okna odczytu szerszego niż strona
 * przewiduje.
 */
export function resolveAnalyticsMonth(param: string | string[] | undefined, now: Date): string {
  const value = Array.isArray(param) ? param[0] : param;
  const options = analyticsMonthOptions(now);
  return options.some((o) => o.value === value) ? (value as string) : options[0]!.value;
}

/** RRRR-MM-DD → DD.MM.RRRR (§7.1). */
export function isoDatePl(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

/** `count` dni kończących się dziś (Polska), od najstarszego. */
export function lastDaysIso(today: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDaysToIsoDate(today, i - (count - 1)) ?? today);
}

/**
 * Jedno okno odczytu dla całej strony: od początku miesiąca sprzed
 * najstarszego miesiąca wyboru (porównanie „vs poprzedni miesiąc”) albo od
 * początku kalendarza 180 dni — co wcześniejsze — do końca bieżącego
 * miesiąca. Każda karta liczy swoje z tego samego zbioru.
 */
export function analyticsDataRange(now: Date): { from: string; toExclusive: string } {
  const today = todayInWarsaw(now);
  const current = today.slice(0, 7);
  const monthsFrom = `${shiftMonthKey(current, -ANALYTICS_MONTH_OPTIONS)}-01`;
  const daysFrom = lastDaysIso(today, HEATMAP_DAYS)[0]!;
  return {
    from: monthsFrom < daysFrom ? monthsFrom : daysFrom,
    toExclusive: `${shiftMonthKey(current, 1)}-01`,
  };
}

/** Dzień tygodnia od poniedziałku: 0 = poniedziałek … 6 = niedziela. */
export function weekdayFromMonday(iso: string): number {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))));
  return (d.getUTCDay() + 6) % 7;
}
