import { describe, expect, it } from 'vitest';

import {
  ENABLED_EXPORT_FORMATS,
  FORMAT_LABELS,
  formatFileSize,
  formatLabel,
  includesFor,
  includesForJob,
  SUSPENDED_FORMATS,
  suspendedFormatsInOrder,
  suspendedFormatsSummary,
} from '@/components/exports/export-formats';
import {
  classifyPeriod,
  describeExportPeriod,
  lastClosedQuarter,
  parseExportPreset,
  presetHref,
  quarterOptions,
  quarterRange,
} from '@/components/exports/export-period';
import { isExportFormatSuspended, SUSPENDED_EXPORT_FORMATS } from '@/lib/exports/suspended-formats';
import { Constants } from '@/types/database';

/**
 * Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): formaty
 * i okres ekranu Eksport.
 *
 * Błąd z podwójnym kluczem: dawna lista doklejała `jpk_v7m` do enuma, który
 * już go miał — JPK_V7M i jego powód były na ekranie dwa razy, a React
 * zgłaszał dwa elementy z tym samym kluczem.
 */

const CSV_ALL = { csv: { issued: true, received: true, corrections: true }, jpkCorrections: true };

describe('formaty eksportu', () => {
  it('bez duplikatów: każdy wyłączony format raz, klucze unikalne', () => {
    expect(new Set(SUSPENDED_FORMATS).size).toBe(SUSPENDED_FORMATS.length);
    expect(SUSPENDED_FORMATS.filter((f) => f === 'jpk_v7m')).toHaveLength(1);
    expect(new Set(ENABLED_EXPORT_FORMATS).size).toBe(ENABLED_EXPORT_FORMATS.length);
    // Klucze listy powodów (`key={format}`) i same powody — bez powtórzeń.
    const reasons = suspendedFormatsInOrder().map((f) => SUSPENDED_EXPORT_FORMATS[f]);
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(new Set(suspendedFormatsInOrder()).size).toBe(SUSPENDED_FORMATS.length);
  });

  it('wyłączone = wszystkie formaty enuma z powodem; włączone = KPiR, CSV, JPK_FA', () => {
    expect([...SUSPENDED_FORMATS].sort()).toEqual(
      Constants.public.Enums.export_format_enum.filter(isExportFormatSuspended).sort(),
    );
    expect(ENABLED_EXPORT_FORMATS).toEqual(['kpir_excel', 'csv_universal', 'jpk_fa']);
    expect(suspendedFormatsSummary()).toBe('JPK_V7M, Optima, Subiekt, Symfonia, Wapro');
  });

  it('każdy format enuma ma nazwę; nieznany nie wychodzi surowo', () => {
    for (const format of Constants.public.Enums.export_format_enum) {
      expect(FORMAT_LABELS[format]).toBeTruthy();
    }
    expect(formatLabel('jpk_v7m')).toBe('JPK_V7M');
    expect(formatLabel('wapro')).toBe('Wapro');
    expect(formatLabel('xyz')).toBe('Inny format');
  });

  it('includesFor: KPiR zawsze z kosztami (F-058), JPK_FA bez zakupów, CSV według pól', () => {
    const none = { csv: { issued: false, received: false, corrections: false }, jpkCorrections: false };
    expect(includesFor('kpir_excel', none)).toEqual({ includeIssued: true, includeReceived: true, includeCorrections: true });
    expect(includesFor('jpk_fa', CSV_ALL)).toEqual({ includeIssued: true, includeReceived: false, includeCorrections: true });
    expect(includesFor('jpk_fa', none)).toEqual({ includeIssued: true, includeReceived: false, includeCorrections: false });
    expect(includesFor('csv_universal', { ...none, csv: { issued: false, received: true, corrections: false } })).toEqual({
      includeIssued: false,
      includeReceived: true,
      includeCorrections: false,
    });
  });

  it('ponowienie z historii: zakres joba, ale KPiR zawsze z kosztami', () => {
    const job = { include_issued: true, include_received: false, include_corrections: false };
    expect(includesForJob({ ...job, format: 'kpir_excel' }).includeReceived).toBe(true);
    expect(includesForJob({ ...job, format: 'csv_universal' })).toEqual({
      includeIssued: true,
      includeReceived: false,
      includeCorrections: false,
    });
  });

  it('rozmiar pliku po polsku', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(12_390)).toBe('12,1 KB');
    expect(formatFileSize(1_258_291)).toBe('1,2 MB');
    expect(formatFileSize(null)).toBeNull();
  });
});

describe('okres eksportu', () => {
  it('describeExportPeriod: miesiąc, kwartał, dowolny zakres', () => {
    expect(describeExportPeriod('2026-09-01', '2026-09-30')).toBe('Wrzesień 2026');
    expect(describeExportPeriod('2026-02-01', '2026-02-28')).toBe('Luty 2026');
    expect(describeExportPeriod('2026-07-01', '2026-09-30')).toBe('III kw. 2026');
    expect(describeExportPeriod('2026-09-01', '2026-09-15')).toBe('01.09.2026 – 15.09.2026');
    expect(describeExportPeriod('2026-09-02', '2026-09-30')).toBe('02.09.2026 – 30.09.2026');
  });

  it('kwartały: zakres, ostatni zamknięty i lista z bieżącym „w trakcie”', () => {
    expect(quarterRange('2026-Q4')).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(quarterRange('2024-Q1')).toEqual({ from: '2024-01-01', to: '2024-03-31' });
    expect(lastClosedQuarter('2026-10')).toBe('2026-Q3');
    expect(lastClosedQuarter('2026-02')).toBe('2025-Q4');
    const options = quarterOptions('2026-10', 8);
    expect(options).toHaveLength(8);
    expect(options[0]).toMatchObject({ value: '2026-Q4', label: 'IV kw. 2026 (w trakcie)' });
    expect(options[1]).toMatchObject({ value: '2026-Q3', label: 'III kw. 2026', from: '2026-07-01', to: '2026-09-30' });
    expect(options[7]!.value).toBe('2025-Q1');
    // Wybrany spoza listy dochodzi na koniec.
    expect(quarterOptions('2026-10', 8, '2023-Q2').at(-1)).toMatchObject({ value: '2023-Q2', label: 'II kw. 2023' });
  });

  it('classifyPeriod rozpoznaje pełny miesiąc i kwartał', () => {
    expect(classifyPeriod('2026-09-01', '2026-09-30')).toEqual({ mode: 'month', month: '2026-09' });
    expect(classifyPeriod('2026-04-01', '2026-06-30')).toEqual({ mode: 'quarter', quarter: '2026-Q2' });
    expect(classifyPeriod('2026-04-01', '2026-06-29')).toEqual({ mode: 'custom', from: '2026-04-01', to: '2026-06-29' });
  });
});

describe('parseExportPreset — link z KPiR i napraw', () => {
  const NOW = '2026-10';

  it('domyślnie KPiR Excel za poprzedni miesiąc', () => {
    expect(parseExportPreset({}, NOW)).toEqual({
      format: 'kpir_excel',
      period: { mode: 'month', month: '2026-09' },
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });

  it('przycisk „Eksport KPiR”: ?period=2026-09&format=kpir_excel', () => {
    expect(parseExportPreset({ period: '2026-09', format: 'kpir_excel' }, NOW)).toMatchObject({
      format: 'kpir_excel',
      period: { mode: 'month', month: '2026-09' },
    });
    expect(parseExportPreset({ period: '2025-12', format: 'csv_universal' }, NOW)).toMatchObject({
      format: 'csv_universal',
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });

  it('od–do: kwartał i dowolny zakres', () => {
    expect(parseExportPreset({ od: '2026-07-01', do: '2026-09-30', format: 'jpk_fa' }, NOW)).toMatchObject({
      format: 'jpk_fa',
      period: { mode: 'quarter', quarter: '2026-Q3' },
    });
    expect(parseExportPreset({ od: '2026-09-03', do: '2026-09-20' }, NOW).period).toEqual({
      mode: 'custom',
      from: '2026-09-03',
      to: '2026-09-20',
    });
  });

  it('przyszły miesiąc → bieżący (jak parseExpenseMonth)', () => {
    expect(parseExportPreset({ period: '2027-03' }, NOW).period).toEqual({ mode: 'month', month: '2026-10' });
  });

  it('śmieci, format wyłączony i odwrócone daty → wartości domyślne', () => {
    const fallback = { mode: 'month', month: '2026-09' };
    expect(parseExportPreset({ period: '2026-13', format: 'jpk_v7m' }, NOW)).toMatchObject({
      format: 'kpir_excel',
      period: fallback,
    });
    expect(parseExportPreset({ period: '<script>', format: 'symfonia' }, NOW).format).toBe('kpir_excel');
    expect(parseExportPreset({ od: '2026-09-30', do: '2026-09-01' }, NOW).period).toEqual(fallback);
    expect(parseExportPreset({ od: '2026-02-30', do: '2026-03-10' }, NOW).period).toEqual(fallback);
    expect(parseExportPreset({ od: '2027-01-01', do: '2027-01-31' }, NOW).period).toEqual(fallback);
    // Powtórzony parametr (tablica) nie wywraca strony.
    expect(parseExportPreset({ period: ['2026-08', '2026-07'], format: ['csv_universal'] }, NOW)).toMatchObject({
      format: 'kpir_excel',
      period: fallback,
    });
  });

  it('presetHref: pełny miesiąc → ?period=, reszta → ?od=&do=, i wraca tym samym okresem', () => {
    expect(presetHref('csv_universal', '2026-09-01', '2026-09-30')).toBe(
      '/reports/exports?period=2026-09&format=csv_universal',
    );
    const quarter = presetHref('jpk_fa', '2026-07-01', '2026-09-30');
    expect(quarter).toBe('/reports/exports?od=2026-07-01&do=2026-09-30&format=jpk_fa');
    const params = Object.fromEntries(new URL(quarter, 'https://x').searchParams);
    expect(parseExportPreset(params, NOW)).toMatchObject({ format: 'jpk_fa', from: '2026-07-01', to: '2026-09-30' });
  });
});
