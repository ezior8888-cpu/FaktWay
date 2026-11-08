import { describe, expect, it } from 'vitest';

/**
 * Poprawka Bartosza 21.10.2026: przed weryfikacją KSeF Analizy i KPiR pokazują
 * dane przykładowe (pełna okazałość aplikacji), po weryfikacji — prawdziwe.
 */

const { kpirPrzykladowe } = await import('@/lib/demo/kpir-przykladowe');

// Wybór „przykład czy prawda” (dawne `analizyKontekst` / `czyZweryfikowana`)
// testuje tabela stanów w `dane-tryb.test.ts` (`kontekstDanych`).

describe('kpirPrzykladowe', () => {
  it('wpisy w wybranym miesiącu, sprzedaż z końca poprzedniego (także na przełomie roku)', () => {
    const { expenses, invoices } = kpirPrzykladowe(1, 2027);
    expect(expenses.every((e) => e.issue_date.startsWith('2027-01-'))).toBe(true);
    expect(invoices.every((i) => i.issue_date!.startsWith('2027-01-'))).toBe(true);
    expect(invoices.find((i) => i.id === 's0')?.sale_date).toBe('2026-12-29');
    expect(invoices.find((i) => i.id === 's1')?.internal_number).toBe('FV/01/2027/011');
  });

  it('luty: dzień przycięty do długości miesiąca', () => {
    const { invoices } = kpirPrzykladowe(3, 2026);
    expect(invoices.find((i) => i.id === 's0')?.sale_date).toBe('2026-02-28');
  });
});
