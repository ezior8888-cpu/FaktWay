import { monthLabel, monthRange, shiftMonth } from '@/lib/expenses/month';
import { formatIsoDatePl } from '@/lib/format/iso-date';

import { ENABLED_EXPORT_FORMATS, type EnabledExportFormat } from './export-formats';

/**
 * Okres eksportu (poprawka Bartosza 21.10.2026: przeprojektowanie
 * Księgowości): miesiąc, kwartał albo dowolne od–do. Moduł bez Reacta i bez
 * `new Date()` — „bieżący miesiąc” zawsze przychodzi z zewnątrz
 * (`parseExpenseMonth(undefined)`, czas polski), więc serwer i przeglądarka
 * liczą to samo.
 */

export type ExportPeriodMode = 'month' | 'quarter' | 'custom';

export type ExportPeriodInit =
  | { mode: 'month'; month: string }
  | { mode: 'quarter'; quarter: string }
  | { mode: 'custom'; from: string; to: string };

export interface QuarterOption {
  /** „2026-Q3”. */
  value: string;
  /** „III kw. 2026”, bieżący: „IV kw. 2026 (w trakcie)”. */
  label: string;
  from: string;
  to: string;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const QUARTER = /^(\d{4})-Q([1-4])$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ROMAN = ['I', 'II', 'III', 'IV'] as const;

/** Poprawna data kalendarzowa RRRR-MM-DD (bez 31.02). */
export function isIsoDate(value: string | null | undefined): value is string {
  const m = ISO_DATE.exec(value ?? '');
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Kwartał miesiąca: „2026-09” → „2026-Q3”. */
export function quarterOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/** Pierwszy i ostatni dzień kwartału „RRRR-Qn”. */
export function quarterRange(quarter: string): { from: string; to: string } {
  const m = QUARTER.exec(quarter);
  if (!m) throw new Error(`Niepoprawny kwartał: ${quarter}`);
  const year = m[1]!;
  const first = (Number(m[2]) - 1) * 3 + 1;
  const firstMonth = `${year}-${String(first).padStart(2, '0')}`;
  return { from: monthRange(firstMonth).from, to: monthRange(shiftMonth(firstMonth, 2)).to };
}

/** „2026-Q3” → „III kw. 2026”. */
export function quarterLabel(quarter: string): string {
  const m = QUARTER.exec(quarter);
  if (!m) return quarter;
  return `${ROMAN[Number(m[2]) - 1]} kw. ${m[1]}`;
}

/** Ostatni zamknięty kwartał — domyślny wybór, bo bieżący jeszcze trwa. */
export function lastClosedQuarter(currentMonth: string): string {
  return quarterOf(shiftMonth(quarterRange(quarterOf(currentMonth)).from.slice(0, 7), -3));
}

/**
 * Kwartały od bieżącego (oznaczonego „w trakcie”) wstecz. Wybrany spoza listy
 * (np. z linku) dochodzi na koniec, jak w `monthOptions`.
 */
export function quarterOptions(currentMonth: string, count = 8, selected?: string): QuarterOption[] {
  const current = quarterOf(currentMonth);
  const firstMonth = quarterRange(current).from.slice(0, 7);
  const values = Array.from({ length: count }, (_, index) => quarterOf(shiftMonth(firstMonth, -3 * index)));
  if (selected && QUARTER.test(selected) && !values.includes(selected)) values.push(selected);
  return values.map((value) => ({
    value,
    label: value === current ? `${quarterLabel(value)} (w trakcie)` : quarterLabel(value),
    ...quarterRange(value),
  }));
}

/** Zakres od–do dla wybranego okresu. */
export function periodRange(period: ExportPeriodInit): { from: string; to: string } {
  switch (period.mode) {
    case 'month':
      return monthRange(period.month);
    case 'quarter':
      return quarterRange(period.quarter);
    case 'custom':
      return { from: period.from, to: period.to };
  }
}

/** Czy od–do to pełny miesiąc, pełny kwartał, czy dowolny zakres. */
export function classifyPeriod(from: string, to: string): ExportPeriodInit {
  if (isIsoDate(from) && isIsoDate(to)) {
    const month = from.slice(0, 7);
    const asMonth = monthRange(month);
    if (asMonth.from === from && asMonth.to === to) return { mode: 'month', month };
    const quarter = quarterOf(month);
    const asQuarter = quarterRange(quarter);
    if (asQuarter.from === from && asQuarter.to === to) return { mode: 'quarter', quarter };
  }
  return { mode: 'custom', from, to };
}

/** „01.09.2026 – 30.09.2026”. */
export function formatExportRange(from: string, to: string): string {
  return `${formatIsoDatePl(from)} – ${formatIsoDatePl(to)}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase('pl-PL') + text.slice(1);
}

/** Okres po ludzku: „Wrzesień 2026”, „III kw. 2026” albo „01.09.2026 – 15.09.2026”. */
export function describeExportPeriod(from: string, to: string): string {
  const period = classifyPeriod(from, to);
  if (period.mode === 'month') return capitalize(monthLabel(period.month));
  if (period.mode === 'quarter') return quarterLabel(period.quarter);
  return formatExportRange(from, to);
}

export interface ExportPreset {
  format: EnabledExportFormat;
  period: ExportPeriodInit;
  from: string;
  to: string;
}

type SearchValue = string | string[] | undefined;

const single = (value: SearchValue): string | undefined => (typeof value === 'string' ? value : undefined);

function isEnabledFormat(value: string | undefined): value is EnabledExportFormat {
  return ENABLED_EXPORT_FORMATS.some((format) => format === value);
}

/**
 * Wybór z adresu: `?period=RRRR-MM&format=…` (przycisk „Eksport KPiR”) albo
 * `?od=RRRR-MM-DD&do=RRRR-MM-DD&format=…` (naprawy z historii). Wszystko
 * sprawdzone: format spoza włączonych → KPiR Excel; miesiąc z przyszłości →
 * bieżący (ta sama reguła co `parseExpenseMonth`, liczona od `currentMonth`);
 * od–do niepoprawne, odwrócone albo zaczynające się w przyszłości → pominięte.
 * Domyślnie KPiR Excel za poprzedni miesiąc — comiesięczny plik dla księgowej.
 */
export function parseExportPreset(
  searchParams: { period?: SearchValue; od?: SearchValue; do?: SearchValue; format?: SearchValue },
  currentMonth: string,
): ExportPreset {
  const rawFormat = single(searchParams.format);
  const format: EnabledExportFormat = isEnabledFormat(rawFormat) ? rawFormat : 'kpir_excel';

  const rawPeriod = single(searchParams.period);
  const od = single(searchParams.od);
  const doDate = single(searchParams.do);

  let period: ExportPeriodInit;
  if (rawPeriod && MONTH.test(rawPeriod)) {
    period = { mode: 'month', month: rawPeriod > currentMonth ? currentMonth : rawPeriod };
  } else if (isIsoDate(od) && isIsoDate(doDate) && od <= doDate && od.slice(0, 7) <= currentMonth) {
    period = classifyPeriod(od, doDate);
  } else {
    period = { mode: 'month', month: shiftMonth(currentMonth, -1) };
  }

  return { format, period, ...periodRange(period) };
}

/** Adres formularza z wybranym formatem i okresem (pełny miesiąc → `?period=`). */
export function presetHref(format: string, from: string, to: string): string {
  const period = classifyPeriod(from, to);
  const query =
    period.mode === 'month'
      ? `period=${period.month}`
      : `od=${encodeURIComponent(from)}&do=${encodeURIComponent(to)}`;
  return `/reports/exports?${query}&format=${encodeURIComponent(format)}`;
}
