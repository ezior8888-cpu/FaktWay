import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TaxSavingsGoalCard } from '@/components/przeplywy/finora/statistics-savings-goal-card';
import { estimateIncomeTaxThisYear } from '@/lib/dashboard/tax-estimate';

/**
 * Kafelek podatku na przepływach: etykieta i kwota z `estimateIncomeTaxThisYear`.
 * Od E5 (plan Finora P2) kafelek to karta „Odłóż na podatek” w miejscu
 * „Savings goal” — te same przypadki, ten sam wynik na ekranie.
 */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const fv = (issue_date: string, net: number) => ({ issue_date, net_total: net, gross_total: net * 1.23, invoice_kind: 'regular' as const });

function card(invoices: ReturnType<typeof fv>[], dataFrom: string): string {
  const estimate = estimateIncomeTaxThisYear(invoices, [], new Date(), dataFrom);
  return renderToStaticMarkup(<TaxSavingsGoalCard estimate={estimate} />);
}

describe('kafelek szacowanego podatku', () => {
  it('luty: od 1 stycznia, bez zeszłorocznego zysku', () => {
    vi.setSystemTime(new Date('2027-02-20T12:00:00'));
    // Okno wykresu sześciu miesięcy zaczyna się we wrześniu 2026 — dane od tej daty.
    const html = card([fv('2026-11-10', 100_000), fv('2027-02-03', 10_000)], '2026-09-01');
    expect(html).toContain('Szac. podatek od 1 stycznia');
    expect(html).toContain('Odłóż na podatek');
    expect(html).not.toContain('YTD');
    expect(html).toMatch(/1[\s ]?900/); // 10 000 × 19%, nie 20 900
    expect(html).not.toMatch(/20[\s ]?900/);
  });

  it('październik: dane od maja — kafelek nie udaje pełnego roku', () => {
    vi.setSystemTime(new Date('2026-10-10T12:00:00'));
    const html = card([fv('2026-06-01', 1_000)], '2026-05-01');
    expect(html).toContain('Szac. podatek od 1 maja');
    expect(html).toContain('bez wcześniejszych miesięcy roku');
  });

  it('strona z danymi od 1 stycznia (C-21): pełny rok mimo sześciu miesięcy na wykresie', () => {
    vi.setSystemTime(new Date('2026-10-10T12:00:00'));
    const html = card([fv('2026-02-01', 10_000), fv('2026-06-01', 1_000)], '2026-01-01');
    expect(html).toContain('Szac. podatek od 1 stycznia');
    expect(html).toMatch(/2[\s ]?090/); // 11 000 × 19%
  });
});
