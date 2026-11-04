import { describe, expect, it } from 'vitest';

import { changePct, topWithOther } from '@/lib/analytics-finance/breakdown';
import { heatmapIntensityClass, heatmapWeeks } from '@/lib/analytics-finance/heatmap';
import {
  analyticsDataRange,
  analyticsMonthOptions,
  countedDays,
  isoDatePl,
  monthKeysEnding,
  monthLongLabel,
  resolveAnalyticsMonth,
  weekdayFromMonday,
} from '@/lib/analytics-finance/months';

/**
 * Kalendarz analiz (plan Finora P10/P11, §2.4 pkt 10, §7.1): miesiąc
 * w strefie Europe/Warsaw, nazwy po polsku, tydzień od poniedziałku.
 */

describe('wybór miesiąca', () => {
  it('6 miesięcy od bieżącego, nazwy po polsku z wielkiej litery', () => {
    expect(analyticsMonthOptions(new Date('2026-10-17T10:00:00Z'))).toEqual([
      { value: '2026-10', label: 'Październik 2026' },
      { value: '2026-09', label: 'Wrzesień 2026' },
      { value: '2026-08', label: 'Sierpień 2026' },
      { value: '2026-07', label: 'Lipiec 2026' },
      { value: '2026-06', label: 'Czerwiec 2026' },
      { value: '2026-05', label: 'Maj 2026' },
    ]);
  });

  it('1. dnia miesiąca o 00:30 czasu polskiego to już nowy miesiąc (serwer w UTC)', () => {
    const now = new Date('2026-10-31T23:30:00Z'); // 01.11.2026 00:30 w Warszawie (CET, UTC+1)
    expect(analyticsMonthOptions(now)[0]?.value).toBe('2026-11');
    expect(analyticsDataRange(now)).toEqual({ from: '2026-05-01', toExclusive: '2026-12-01' });
  });

  it('miesiąc z adresu tylko z listy; inaczej bieżący', () => {
    const now = new Date('2026-10-17T10:00:00Z');
    expect(resolveAnalyticsMonth('2026-08', now)).toBe('2026-08');
    expect(resolveAnalyticsMonth(['2026-07', 'x'], now)).toBe('2026-07');
    expect(resolveAnalyticsMonth('2025-01', now)).toBe('2026-10');
    expect(resolveAnalyticsMonth('2026-13', now)).toBe('2026-10');
    expect(resolveAnalyticsMonth(undefined, now)).toBe('2026-10');
  });

  it('okno przez przełom roku', () => {
    expect(monthKeysEnding('2026-02', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthLongLabel('2026-01')).toBe('Styczeń 2026');
  });

  it('dni do średniej: bieżący do dziś, miniony cały (luty przestępny)', () => {
    expect(countedDays('2026-10', '2026-10-17')).toBe(17);
    expect(countedDays('2028-02', '2028-03-05')).toBe(29);
  });

  it('daty DD.MM.RRRR', () => {
    expect(isoDatePl('2026-10-07')).toBe('07.10.2026');
  });
});

describe('kalendarz dni', () => {
  it('tydzień od poniedziałku', () => {
    expect(weekdayFromMonday('2026-10-19')).toBe(0); // poniedziałek
    expect(weekdayFromMonday('2026-10-18')).toBe(6); // niedziela
  });

  it('dni na swoich miejscach w kolumnach tygodni', () => {
    const days = ['2026-10-17', '2026-10-18', '2026-10-19'].map((date) => ({ date, amount: 1 }));
    const weeks = heatmapWeeks(days);
    expect(weeks).toHaveLength(2);
    expect(weeks[0]?.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(weeks[0]?.[5]?.date).toBe('2026-10-17'); // sobota
    expect(weeks[0]?.[6]?.date).toBe('2026-10-18');
    expect(weeks[1]?.[0]?.date).toBe('2026-10-19');
    expect(heatmapWeeks([])).toEqual([]);
  });

  it('natężenie według kwantyla dni z kwotą > 0; zero i minus to tło', () => {
    const sorted = [10, 20, 30, 40];
    expect(heatmapIntensityClass(0, sorted)).toBe('bg-muted');
    expect(heatmapIntensityClass(-5, sorted)).toBe('bg-muted');
    expect(heatmapIntensityClass(10, sorted)).toBe('bg-chart-1/25');
    expect(heatmapIntensityClass(40, sorted)).toBe('bg-chart-1');
  });
});

describe('topWithOther i changePct', () => {
  it('bez reszty nie ma pozycji „Pozostałe”', () => {
    expect(topWithOther([{ key: 'a', label: 'A', amount: 1 }], 5, 'Pozostałe').map((s) => s.label)).toEqual(['A']);
  });

  it('zmiana procentowa tylko przy dodatniej podstawie', () => {
    expect(changePct(150, 100)).toBe(50);
    expect(changePct(150, 0)).toBeNull();
    expect(changePct(150, -10)).toBeNull();
  });
});
