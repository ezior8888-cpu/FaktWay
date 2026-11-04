import { describe, expect, it } from 'vitest';

import type { CostEntry } from '@/lib/dashboard/costs';
import {
  findRecurringCosts,
  recurringCostsMonthlyTotal,
  recurringMonthKeys,
} from '@/lib/dashboard/recurring-costs';

/**
 * Plan Finora §8 N3: dostawca (`seller_nip`) z kosztem w ≥ 3 z ostatnich
 * 4 miesięcy = stały koszt (średnia kwota, typowy dzień). Funkcja czysta na
 * kosztach z `getCosts` (§2.4 pkt 12).
 */

let seq = 0;
function cost(issueDate: string, outflow: number, fields: Partial<CostEntry> = {}): CostEntry {
  seq += 1;
  return {
    id: `c-${seq}`,
    issueDate,
    // Pola dodane przez E5/E7 do `CostEntry` (zbiorcze scalenie etapów).
    categoryLabel: null,
    vat: 0,
    documentNumber: null,
    isReviewed: true,
    source: 'ksef_inbox',
    sellerNip: '1234567890',
    sellerName: 'Telekom sp. z o.o.',
    cost: outflow,
    outflow,
    vatDeductible: 0,
    ...fields,
  };
}

const KEYS = recurringMonthKeys('2026-10');

describe('recurringMonthKeys', () => {
  it('cztery miesiące kończące się na wybranym, od najstarszego, przez przełom roku', () => {
    expect(KEYS).toEqual(['2026-07', '2026-08', '2026-09', '2026-10']);
    expect(recurringMonthKeys('2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});

describe('findRecurringCosts', () => {
  it('3 z 4 miesięcy = stały koszt: średnia z miesięcy z kosztem i typowy dzień', () => {
    const result = findRecurringCosts([
      cost('2026-07-05', 100),
      cost('2026-08-06', 120),
      cost('2026-10-05', 140),
    ], KEYS);

    expect(result).toEqual([{
      sellerNip: '1234567890',
      sellerName: 'Telekom sp. z o.o.',
      months: 3,
      averageAmount: 120,
      typicalDay: 5,
    }]);
  });

  it('2 z 4 miesięcy to jeszcze nie stały koszt', () => {
    expect(findRecurringCosts([cost('2026-07-05', 100), cost('2026-10-05', 100)], KEYS)).toEqual([]);
  });

  it('dwa koszty w jednym miesiącu to jeden miesiąc (suma miesiąca do średniej)', () => {
    const [recurring] = findRecurringCosts([
      cost('2026-08-01', 50),
      cost('2026-08-20', 50),
      cost('2026-09-01', 100),
      cost('2026-10-01', 100),
    ], KEYS);

    expect(recurring?.months).toBe(3);
    expect(recurring?.averageAmount).toBe(100);
    // Dni: 1, 1, 1, 20 → dolna mediana 1.
    expect(recurring?.typicalDay).toBe(1);
  });

  it('miesiąc spoza okna (5. wstecz i następny) się nie liczy', () => {
    expect(findRecurringCosts([
      cost('2026-06-05', 100),
      cost('2026-07-05', 100),
      cost('2026-08-05', 100),
      cost('2026-11-05', 100),
    ], KEYS)).toEqual([]);
  });

  it('korekta in minus nie robi miesiąca: sama korekta w miesiącu odpada', () => {
    expect(findRecurringCosts([
      cost('2026-07-05', 100),
      cost('2026-08-05', 100),
      cost('2026-09-05', -100),
    ], KEYS)).toEqual([]);

    // Faktura i jej korekta w tym samym miesiącu: miesiąc liczy się, gdy suma > 0.
    const [recurring] = findRecurringCosts([
      cost('2026-07-05', 100),
      cost('2026-08-05', 100),
      cost('2026-09-05', 100),
      cost('2026-09-15', -40),
    ], KEYS);
    expect(recurring?.months).toBe(3);
    expect(recurring?.averageAmount).toBe(86.67);
  });

  it('koszty bez NIP-u (paragony) pomijamy — bez klucza dostawcy', () => {
    expect(findRecurringCosts([
      cost('2026-07-05', 30, { sellerNip: null }),
      cost('2026-08-05', 30, { sellerNip: null }),
      cost('2026-09-05', 30, { sellerNip: '  ' }),
    ], KEYS)).toEqual([]);
  });

  it('różni dostawcy osobno, najdroższy pierwszy; nazwa z najnowszego kosztu', () => {
    const result = findRecurringCosts([
      cost('2026-07-10', 50, { sellerNip: '1111111111', sellerName: 'Hosting' }),
      cost('2026-08-10', 50, { sellerNip: '1111111111', sellerName: 'Hosting' }),
      cost('2026-09-10', 50, { sellerNip: '1111111111', sellerName: 'Hosting S.A.' }),
      cost('2026-07-01', 2000, { sellerNip: '2222222222', sellerName: 'Biuro' }),
      cost('2026-08-01', 2000, { sellerNip: '2222222222', sellerName: 'Biuro' }),
      cost('2026-09-01', 2000, { sellerNip: '2222222222', sellerName: 'Biuro' }),
      cost('2026-10-01', 2000, { sellerNip: '2222222222', sellerName: 'Biuro' }),
    ], KEYS);

    expect(result.map((r) => [r.sellerNip, r.sellerName, r.months, r.averageAmount])).toEqual([
      ['2222222222', 'Biuro', 4, 2000],
      ['1111111111', 'Hosting S.A.', 3, 50],
    ]);
    expect(recurringCostsMonthlyTotal(result)).toBe(2050);
  });

  it('kwoty z groszami: średnia i suma zaokrąglone do groszy', () => {
    const result = findRecurringCosts([
      cost('2026-07-05', 10.01),
      cost('2026-08-05', 10.02),
      cost('2026-09-05', 10.04),
    ], KEYS);

    expect(result[0]?.averageAmount).toBe(10.02);
    expect(recurringCostsMonthlyTotal([])).toBe(0);
  });
});
