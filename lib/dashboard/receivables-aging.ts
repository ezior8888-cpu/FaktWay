import type { Receivables } from '@/lib/dashboard/receivables';
import { roundToCents } from '@/lib/xml/invoice-calculator';

/**
 * Karta „Należności według terminu” (PLAN-FINORA §5 P1). Czysty podział
 * wyniku `getReceivables` — należności nie liczymy tu drugi raz (§2.4
 * pkt 11). „Po terminie” pochodzi z `daysOverdue`, czyli z daty
 * w Europe/Warsaw, nie z `payment_status`.
 */

export type AgingBucketKey = 'notDue' | 'upTo30' | 'over30';

export interface AgingBucket {
  key: AgingBucketKey;
  label: string;
  /** PLN, do grosza. */
  amount: number;
  count: number;
  /** Udział KWOTY w procentach, całkowity; suma kubełków = 100 przy total > 0. */
  pct: number;
}

export interface ReceivablesAging {
  /** = `Receivables.total`. */
  total: number;
  count: number;
  /** Zawsze trzy, w kolejności notDue, upTo30, over30. */
  buckets: AgingBucket[];
}

const BUCKETS: ReadonlyArray<{ key: AgingBucketKey; label: string }> = [
  { key: 'notDue', label: 'Przed terminem' },
  { key: 'upTo30', label: 'Do 30 dni po terminie' },
  { key: 'over30', label: 'Ponad 30 dni po terminie' },
];

function bucketOf(daysOverdue: number): AgingBucketKey {
  if (daysOverdue <= 0) return 'notDue';
  if (daysOverdue <= 30) return 'upTo30';
  return 'over30';
}

/**
 * Procenty całkowite sumujące się do 100 (metoda największej reszty).
 * Remis reszt rozstrzyga kolejność kubełków. Wspólne ze spodziewanymi wpływami
 * według terminu (`inflow-terms.ts`).
 */
export function largestRemainderPercents(amounts: readonly number[]): number[] {
  const sum = amounts.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return amounts.map(() => 0);
  const exact = amounts.map((a) => (a / sum) * 100);
  const floors = exact.map(Math.floor);
  let missing = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of order) {
    if (missing <= 0) break;
    floors[index] = (floors[index] ?? 0) + 1;
    missing -= 1;
  }
  return floors;
}

export function receivablesAging(r: Receivables): ReceivablesAging {
  const sums = new Map<AgingBucketKey, { amount: number; count: number }>(
    BUCKETS.map(({ key }) => [key, { amount: 0, count: 0 }]),
  );
  for (const inv of r.byInvoice) {
    const bucket = sums.get(bucketOf(inv.daysOverdue))!;
    bucket.amount += inv.outstanding;
    bucket.count += 1;
  }
  const amounts = BUCKETS.map(({ key }) => roundToCents(sums.get(key)!.amount));
  const pcts = largestRemainderPercents(amounts);
  return {
    total: r.total,
    count: r.count,
    buckets: BUCKETS.map(({ key, label }, i) => ({
      key,
      label,
      amount: amounts[i] ?? 0,
      count: sums.get(key)!.count,
      pct: pcts[i] ?? 0,
    })),
  };
}
