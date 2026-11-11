/**
 * Stronicowanie list `/api/v1` kursorem (keyset): kolejność `issue_date`
 * malejąco, potem `id` malejąco. Kursor to base64url z datą i identyfikatorem
 * ostatniego wiersza strony; przy odczycie sprawdzamy oba wzorcem, bo trafiają
 * do filtra PostgREST-a (`or`), a nie mogą wnieść do niego niczego innego.
 */

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PageCursor {
  issueDate: string;
  id: string;
}

/** Prawdziwa data kalendarzowa RRRR-MM-DD (bez 30 lutego). */
export function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // filtr-wyjatek: data-warszawa sprawdzenie dnia kalendarzowego na dacie w UTC, nie dzisiejsza data
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify({ d: cursor.issueDate, i: cursor.id })).toString('base64url');
}

export function decodeCursor(raw: string): PageCursor | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const { d, i } = parsed as { d?: unknown; i?: unknown };
    if (typeof d !== 'string' || typeof i !== 'string' || !isCalendarDate(d) || !isUuid(i)) return null;
    return { issueDate: d, id: i };
  } catch {
    return null;
  }
}

/** Warunek „po kursorze” dla `.or()`: wartości już sprawdzone wzorcem. */
export function afterCursorFilter(cursor: PageCursor): string {
  return `issue_date.lt.${cursor.issueDate},and(issue_date.eq.${cursor.issueDate},id.lt.${cursor.id})`;
}

export type ParsedQuery<T> = { ok: true; value: T } | { ok: false; param: string; message: string };

/**
 * Wspólne sprawdzenie parametrów: tylko znane nazwy, każdy najwyżej raz.
 * Literówka w nazwie filtra nie może po cichu zwrócić wszystkich danych.
 */
export function readKnownParams(
  params: URLSearchParams,
  known: readonly string[],
): { ok: true; values: Map<string, string> } | { ok: false; param: string; message: string } {
  const values = new Map<string, string>();
  for (const [name, value] of params) {
    if (!known.includes(name)) {
      return { ok: false, param: name, message: `Nieznany parametr „${name}”. Dozwolone: ${known.join(', ')}.` };
    }
    if (values.has(name)) {
      return { ok: false, param: name, message: `Parametr „${name}” może wystąpić tylko raz.` };
    }
    values.set(name, value);
  }
  return { ok: true, values };
}

export function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_PAGE_SIZE;
  if (!/^\d{1,3}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= MAX_PAGE_SIZE ? value : null;
}
