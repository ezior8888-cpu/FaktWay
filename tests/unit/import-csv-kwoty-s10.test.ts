import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseAmount, parseDate } from '@/lib/import/csv-parsers/csv-helpers';

/**
 * S-10 (sygnał z rozpoznania żelaznego filtra, plan B7.1): import CSV
 * z Fakturowni, wFirmy, inFaktu i iFirmy czytał kwotę ujemną w polskim
 * zapisie „-1.234,56” jako -1,234 zł, „1.234” (tysiąc dwieście trzydzieści
 * cztery złote) jako 1,234 zł, po cichu zamieniał kwotę w EUR na PLN,
 * a datę domyślną brał z UTC zamiast z dnia w Polsce.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('parseAmount: zapis polski i angielski, także ujemny', () => {
  it.each([
    ['-1.234,56', -1234.56],
    ['-1 234,56 zł', -1234.56],
    ['1.234', 1234],
    ['-1.234', -1234],
    ['12.345.678,90', 12345678.9],
    ['-1,234.56', -1234.56],
    ['1,234.56', 1234.56],
    ['1234,56', 1234.56],
    ['1234.56', 1234.56],
    ['0,99', 0.99],
    ['-0,50 PLN', -0.5],
    ['100', 100],
  ])('%s → %d', (wejscie, oczekiwane) => {
    expect(parseAmount(wejscie)).toBe(oczekiwane);
  });

  it('ilości i ceny z pozycji: kropka to część dziesiętna', () => {
    expect(parseAmount('1.500', { kropkaTysiecy: false })).toBe(1.5);
    expect(parseAmount('0.500')).toBe(0.5);
    expect(parseAmount('0.500', { kropkaTysiecy: false })).toBe(0.5);
  });

  it('kwota w obcej walucie zostaje odczytana, ale import ostrzega, że zapisze ją jako PLN', () => {
    const warnings: string[] = [];
    expect(parseAmount('100,00 EUR', { warnings, fieldLabel: 'Brutto' })).toBe(100);
    expect(warnings.join('\n')).toMatch(/Brutto: kwota w EUR/);
    const bez: string[] = [];
    parseAmount('100,00 zł', { warnings: bez });
    expect(bez).toEqual([]);
  });
});

describe('parseDate: data domyślna z dnia w Polsce', () => {
  it('31.12.2026 o 23:30 UTC to w Polsce już 1.01.2027', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-31T23:30:00Z'));
    const warnings: string[] = [];
    expect(parseDate('', { warnings })).toBe('2027-01-01');
    expect(parseDate('nie-data', { warnings })).toBe('2027-01-01');
  });

  it('data z godziną i strefą: dzień w Polsce', () => {
    expect(parseDate('2026-03-15T23:30:00Z')).toBe('2026-03-16');
  });
});
