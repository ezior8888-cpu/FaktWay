import { addDaysToIsoDate } from '@/lib/format/warsaw-date';
import type { InflowEntry } from '@/lib/dashboard/inflows';
import { largestRemainderPercents } from '@/lib/dashboard/receivables-aging';
import { roundToCents } from '@/lib/xml/invoice-calculator';

/**
 * Spodziewane wpływy według terminu: otwarte faktury sprzedaży z terminem od
 * dziś (`isExpectedInflow`). Kwota: reszta do zapłaty po wpłatach częściowych
 * (`InflowEntry.outstanding`). Czysty podział wyniku `getInflows`.
 *
 * Trzy kolumny `inflowTerms` zostały tylko na kartach Należności w danych
 * przykładowych (`lib/demo` bez wpłat). Prawdziwa firma widzi tam należności
 * z zaległościami (`getReceivables`, `receivablesAging`): decyzję D-W odwołano
 * 02.11.2026, więc miniony termin to należność po terminie, a nie wpływ.
 */

export type InflowTermKey = 'thisWeek' | 'upTo30' | 'later';

export interface InflowTermBucket {
  key: InflowTermKey;
  /** Pełny opis kolumny (dymek i czytnik ekranu). */
  label: string;
  /** PLN, do grosza. */
  amount: number;
  count: number;
  /** Udział KWOTY w procentach, całkowity; suma kolumn = 100 przy total > 0. */
  pct: number;
}

export interface InflowTerms {
  /** Suma kolumn, PLN. */
  total: number;
  count: number;
  /** Zawsze trzy, w kolejności thisWeek, upTo30, later. */
  buckets: InflowTermBucket[];
}

/** Ile dni naprzód sięga kolumna „Do 30 dni” (ta sama granica co Spodziewane wpływy). */
export const TERMS_DAYS = 30;

const BUCKETS: ReadonlyArray<{ key: InflowTermKey; label: string }> = [
  { key: 'thisWeek', label: 'Termin w tym tygodniu (do niedzieli)' },
  { key: 'upTo30', label: 'Termin po tym tygodniu, w ciągu 30 dni' },
  { key: 'later', label: 'Termin za ponad 30 dni' },
];

/** Niedziela tygodnia (pn–nd), w którym leży `iso`. */
function sundayOf(iso: string): string {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))));
  return addDaysToIsoDate(iso, (7 - d.getUTCDay()) % 7) ?? iso;
}

/** Spodziewany wpływ: otwarta faktura z terminem dziś lub później i z resztą do zapłaty. */
export function isExpectedInflow(entry: InflowEntry, today: string): boolean {
  return entry.basis === 'due' && entry.outstanding > 0 && entry.date >= today;
}

export function inflowTerms(entries: readonly InflowEntry[], today: string): InflowTerms {
  const weekEnd = sundayOf(today);
  const last = addDaysToIsoDate(today, TERMS_DAYS) ?? today;
  const sums = new Map<InflowTermKey, { amount: number; count: number }>(
    BUCKETS.map(({ key }) => [key, { amount: 0, count: 0 }]),
  );
  for (const entry of entries) {
    if (!isExpectedInflow(entry, today)) continue;
    const key: InflowTermKey = entry.date <= weekEnd ? 'thisWeek' : entry.date <= last ? 'upTo30' : 'later';
    const bucket = sums.get(key)!;
    bucket.amount += entry.outstanding;
    bucket.count += 1;
  }
  const amounts = BUCKETS.map(({ key }) => roundToCents(sums.get(key)!.amount) || 0);
  const pcts = largestRemainderPercents(amounts);
  const buckets = BUCKETS.map(({ key, label }, i) => ({
    key,
    label,
    amount: amounts[i] ?? 0,
    count: sums.get(key)!.count,
    pct: pcts[i] ?? 0,
  }));
  return {
    total: roundToCents(amounts.reduce((s, a) => s + a, 0)) || 0,
    count: buckets.reduce((s, b) => s + b.count, 0),
    buckets,
  };
}
