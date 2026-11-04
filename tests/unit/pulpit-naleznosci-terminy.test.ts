import { describe, expect, it } from 'vitest';

import type { ReceivableInvoice, Receivables } from '@/lib/dashboard/receivables';
import { receivablesAging } from '@/lib/dashboard/receivables-aging';

/**
 * Karta „Należności według terminu” (PLAN-FINORA §5 P1): podział wyniku
 * `getReceivables` (§2.4 pkt 11) na trzy kubełki według `daysOverdue`.
 */

let seq = 0;
function receivable(outstanding: number, daysOverdue: number): ReceivableInvoice {
  seq += 1;
  return {
    id: `inv-${seq}`,
    internalNumber: `FV/${seq}`,
    buyerName: null,
    paymentDueDate: null,
    outstanding,
    daysOverdue,
  };
}

function receivables(byInvoice: ReceivableInvoice[]): Receivables {
  const total = byInvoice.reduce((s, i) => s + i.outstanding, 0);
  const overdueRows = byInvoice.filter((i) => i.daysOverdue > 0);
  const overdue = overdueRows.reduce((s, i) => s + i.outstanding, 0);
  return {
    total,
    overdue,
    notDue: total - overdue,
    count: byInvoice.length,
    overdueCount: overdueRows.length,
    oldestOverdueDays: overdueRows.length ? Math.max(...overdueRows.map((i) => i.daysOverdue)) : null,
    byInvoice,
    foreignCurrencyCount: 0,
  };
}

describe('receivablesAging', () => {
  it('granice: 0 dni przed terminem, 1 i 30 do 30 dni, 31 ponad 30 dni', () => {
    const aging = receivablesAging(receivables([
      receivable(100, 0),
      receivable(200, 1),
      receivable(300, 30),
      receivable(400, 31),
    ]));
    expect(aging.total).toBe(1000);
    expect(aging.count).toBe(4);
    expect(aging.buckets).toEqual([
      { key: 'notDue', label: 'Przed terminem', amount: 100, count: 1, pct: 10 },
      { key: 'upTo30', label: 'Do 30 dni po terminie', amount: 500, count: 2, pct: 50 },
      { key: 'over30', label: 'Ponad 30 dni po terminie', amount: 400, count: 1, pct: 40 },
    ]);
  });

  it('procenty to udział kwoty i sumują się do 100 przy kwotach 1/1/1', () => {
    const aging = receivablesAging(receivables([receivable(1, 0), receivable(1, 5), receivable(1, 45)]));
    expect(aging.buckets.map((b) => b.pct)).toEqual([34, 33, 33]);
    expect(aging.buckets.reduce((s, b) => s + b.pct, 0)).toBe(100);
  });

  it('procent liczy kwotę, nie liczbę faktur', () => {
    const aging = receivablesAging(receivables([
      receivable(10, 0), receivable(10, 0), receivable(10, 0), receivable(970, 40),
    ]));
    expect(aging.buckets.map((b) => [b.count, b.pct])).toEqual([[3, 3], [0, 0], [1, 97]]);
  });

  it('kwoty do grosza, total bez zmian z getReceivables', () => {
    const r = receivables([receivable(0.1, 0), receivable(0.2, 0), receivable(33.335, 2)]);
    const aging = receivablesAging({ ...r, total: 33.64 });
    expect(aging.total).toBe(33.64);
    expect(aging.buckets[0]!.amount).toBe(0.3);
    expect(aging.buckets.reduce((s, b) => s + b.pct, 0)).toBe(100);
  });

  it('zero należności: trzy kubełki po zero', () => {
    const aging = receivablesAging(receivables([]));
    expect(aging).toEqual({
      total: 0,
      count: 0,
      buckets: [
        { key: 'notDue', label: 'Przed terminem', amount: 0, count: 0, pct: 0 },
        { key: 'upTo30', label: 'Do 30 dni po terminie', amount: 0, count: 0, pct: 0 },
        { key: 'over30', label: 'Ponad 30 dni po terminie', amount: 0, count: 0, pct: 0 },
      ],
    });
  });
});
