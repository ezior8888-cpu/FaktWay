import { describe, expect, it } from 'vitest';

import { monthLabel, monthRange, parseExpenseMonth, shiftMonth } from '@/lib/expenses/month';

/**
 * F-087 (audyt bloku 1, część: wydatki): lista wydatków pokazywała tylko
 * bieżący miesiąc (liczony w strefie serwera), bez przejścia do innych.
 */

const NOW = new Date('2026-10-02T10:00:00Z');

describe('miesiąc listy wydatków', () => {
  it('domyślnie bieżący miesiąc w Polsce — także tuż po północy 1. dnia', () => {
    expect(parseExpenseMonth(undefined, NOW)).toBe('2026-10');
    expect(parseExpenseMonth(undefined, new Date('2026-09-30T22:30:00Z'))).toBe('2026-10');
  });

  it('miesiąc z adresu; zła wartość albo przyszłość → bieżący', () => {
    expect(parseExpenseMonth('2026-07', NOW)).toBe('2026-07');
    expect(parseExpenseMonth('2026-13', NOW)).toBe('2026-10');
    expect(parseExpenseMonth('lipiec', NOW)).toBe('2026-10');
    expect(parseExpenseMonth('2027-01', NOW)).toBe('2026-10');
  });

  it('zakres dni miesiąca (luty przestępny, grudzień)', () => {
    expect(monthRange('2026-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('przesunięcie przez przełom roku', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });

  it('nazwa miesiąca po polsku', () => {
    expect(monthLabel('2026-09')).toBe('wrzesień 2026');
  });
});

describe('strona /expenses — zakres miesiąca w zapytaniu', () => {
  it('wybrany miesiąc: od pierwszego do ostatniego dnia', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const { vi } = await import('vitest');
    vi.doMock('@/lib/supabase/page-context', () => ({
      getPageContext: async () => {
        const chain: Record<string, unknown> = {};
        for (const m of ['from', 'select', 'eq', 'order', 'gte', 'lte']) {
          chain[m] = (...args: unknown[]) => { calls.push([m, args]); return chain; };
        }
        chain.limit = async (...args: unknown[]) => { calls.push(['limit', args]); return { data: [], error: null }; };
        return { supabase: chain, tenantId: 'ten-1' };
      },
    }));
    const { default: ExpensesPage } = await import('@/app/(dashboard)/(koszty)/expenses/page');
    await ExpensesPage({ searchParams: Promise.resolve({ miesiac: '2026-02' }) });
    expect(calls.filter(([m]) => m === 'gte')).toEqual([['gte', ['issue_date', '2026-02-01']]]);
    expect(calls.filter(([m]) => m === 'lte')).toEqual([['lte', ['issue_date', '2026-02-28']]]);
  });
});
