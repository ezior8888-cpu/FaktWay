import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_REFUSAL_PREFIX,
  exportFixFor,
  friendlyStartError,
  refusedInvoiceNumber,
  type ExportFix,
} from '@/components/exports/export-fixes';
import type { ManualExportJobWithFiles } from '@/components/exports/export-formats';
import { KsefExpenseCurrencyNotSupportedError } from '@/lib/expenses/ksef-currency-review';
import { OptimaForeignCurrencyNotSupportedError } from '@/lib/exports/comarch-optima-generator';
import { CsvForeignCurrencyNotSupportedError } from '@/lib/exports/csv-generators';
import { OutgoingInvoiceCurrencyNotSupportedError } from '@/lib/exports/currency-guard';
import { MissingIssuerAddressError } from '@/lib/exports/issuer-address';
import {
  JPK_DOCUMENT_REFUSAL_PREFIX,
  JpkDocumentNotSupportedError,
  JpkFaCorrectionNotSupportedError,
  JpkFaForeignCurrencyNotSupportedError,
} from '@/lib/exports/jpk-fa-generator';
import { JPK_SCHEMA_ERROR_MESSAGES } from '@/lib/exports/jpk-schema-check';
import { MissingTaxpayerEmailError } from '@/lib/exports/jpk-v7m-generator';
import { MissingTaxOfficeError } from '@/lib/exports/tax-office';
import { SUSPENDED_EXPORT_FORMATS } from '@/lib/exports/suspended-formats';

/**
 * Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): nieudany
 * eksport w historii ma przycisk wyjścia. Moduł napraw rozpoznaje powody po
 * fragmentach treści (działa w przeglądarce, nie importuje generatorów),
 * więc ten test buduje PRAWDZIWE klasy błędów z `lib/` — zmiana komunikatu
 * tam bez zmiany w `export-fixes.ts` zapali go.
 */

type Job = Pick<ManualExportJobWithFiles, 'status' | 'format' | 'error_message' | 'period_start' | 'period_end'>;

const failed = (error: Error | string, format: Job['format'] = 'jpk_fa'): Job => ({
  status: 'failed',
  format,
  error_message: typeof error === 'string' ? error : error.message,
  period_start: '2026-09-01',
  period_end: '2026-09-30',
});

const link = (label: string, href: string): ExportFix => ({ kind: 'link', label, href });

describe('exportFixFor — prawdziwe błędy z lib/', () => {
  it.each<[string, Job, ExportFix]>([
    ['brak urzędu', failed(new MissingTaxOfficeError()), link('Ustaw urząd', '/settings/accountant')],
    ['brak adresu z GUS', failed(new MissingIssuerAddressError()), link('Dane firmy', '/settings')],
    ['brak e-maila podatnika', failed(new MissingTaxpayerEmailError()), link('Dane firmy', '/settings')],
    [
      'korekta w JPK_FA',
      failed(new JpkFaCorrectionNotSupportedError()),
      link('Wybierz CSV', '/reports/exports?period=2026-09&format=csv_universal'),
    ],
    [
      'odmowa dokumentu',
      failed(new JpkDocumentNotSupportedError('FV/1', undefined, 'ma stawkę „0 WDT”.')),
      link('Otwórz fakturę', '/invoices?q=FV%2F1'),
    ],
    [
      'odmowa dokumentu z numerem KSeF',
      failed(new JpkDocumentNotSupportedError('FV/WDT/1', '1234567890-20260901-ABC', 'ma stawkę VAT „0 WDT”.')),
      link('Otwórz fakturę', '/invoices?q=FV%2FWDT%2F1'),
    ],
    [
      // Też zawiera „faktura korygująca” — ale to odmowa konkretnego dokumentu.
      'zaimportowana korekta',
      failed(new JpkDocumentNotSupportedError('KOR/7', undefined, 'to zaimportowana z KSeF faktura korygująca — FaktWay nie zna jej powiązań.')),
      link('Otwórz fakturę', '/invoices?q=KOR%2F7'),
    ],
    ['koszt KSeF bez kursu', failed(new KsefExpenseCurrencyNotSupportedError(), 'kpir_excel'), link('Skrzynka KSeF', '/inbox')],
    ['sprzedaż bez PLN', failed(new OutgoingInvoiceCurrencyNotSupportedError(), 'kpir_excel'), link('Faktury', '/invoices')],
    ['JPK_FA walutowa', failed(new JpkFaForeignCurrencyNotSupportedError()), link('Faktury', '/invoices')],
    ['CSV walutowa', failed(new CsvForeignCurrencyNotSupportedError(), 'csv_universal'), link('Faktury', '/invoices')],
    ['Optima walutowa', failed(new OptimaForeignCurrencyNotSupportedError(), 'csv_universal'), link('Faktury', '/invoices')],
  ])('%s', (_name, job, expected) => {
    expect(exportFixFor(job)).toEqual(expected);
  });

  it('prefiks odmowy dokumentu = stała z lib/', () => {
    expect(DOCUMENT_REFUSAL_PREFIX).toBe(JPK_DOCUMENT_REFUSAL_PREFIX);
  });

  it('numer faktury ze spacją i bez powodu po nim', () => {
    expect(refusedInvoiceNumber(new JpkDocumentNotSupportedError('FV 1/2026', undefined, 'ma stawkę „22”.').message)).toBe(
      'FV 1/2026',
    );
    expect(refusedInvoiceNumber('Inny błąd')).toBeNull();
  });

  it.each(Object.entries(SUSPENDED_EXPORT_FORMATS))('wyłączony %s → „Wybierz” zamiennik', (format, reason) => {
    const fix = exportFixFor(failed(reason, format as Job['format']));
    const expected =
      format === 'symfonia' || format === 'wapro'
        ? link('Wybierz JPK_FA(4)', '/reports/exports?period=2026-09&format=jpk_fa')
        : link('Wybierz CSV uniwersalny', '/reports/exports?period=2026-09&format=csv_universal');
    expect(fix).toEqual(expected);
  });

  it('wyłączony i wygasły → też zamiennik, bo ponowienie i tak by odmówiło', () => {
    expect(exportFixFor({ ...failed('', 'symfonia'), status: 'expired' })).toMatchObject({ label: 'Wybierz JPK_FA(4)' });
  });

  it('wygasły → „Wygeneruj ponownie”; ogólny błąd, schemat i brak powodu → „Ponów”', () => {
    expect(exportFixFor({ ...failed(''), status: 'expired', error_message: null })).toEqual({
      kind: 'rerun',
      label: 'Wygeneruj ponownie',
    });
    const retry = { kind: 'rerun', label: 'Ponów' };
    expect(exportFixFor(failed('Nie udało się wygenerować pliku. Spróbuj ponownie albo napisz do nas.'))).toEqual(retry);
    for (const message of JPK_SCHEMA_ERROR_MESSAGES) expect(exportFixFor(failed(message))).toEqual(retry);
    expect(exportFixFor({ ...failed(''), error_message: null })).toEqual(retry);
  });

  it('gotowy, w toku → bez przycisku naprawy', () => {
    for (const status of ['completed', 'pending', 'generating'] as const) {
      expect(exportFixFor({ ...failed(new MissingTaxOfficeError()), status })).toBeNull();
    }
  });

  it('nigdy „Bez korekt” (niepełny JPK dla urzędu)', () => {
    const messages = [
      new MissingTaxOfficeError().message,
      new MissingIssuerAddressError().message,
      new MissingTaxpayerEmailError().message,
      new JpkFaCorrectionNotSupportedError().message,
      new JpkDocumentNotSupportedError('FV/1', undefined, 'ma stawkę „0 WDT”.').message,
      new KsefExpenseCurrencyNotSupportedError().message,
      new OutgoingInvoiceCurrencyNotSupportedError().message,
      new JpkFaForeignCurrencyNotSupportedError().message,
      new CsvForeignCurrencyNotSupportedError().message,
      ...Object.values(SUSPENDED_EXPORT_FORMATS),
      ...JPK_SCHEMA_ERROR_MESSAGES,
      'cokolwiek',
    ];
    for (const format of ['jpk_fa', 'csv_universal', 'kpir_excel', 'jpk_v7m'] as const) {
      for (const status of ['failed', 'expired'] as const) {
        for (const message of messages) {
          const fix = exportFixFor({ ...failed(message, format), status });
          expect(fix?.label ?? '').not.toMatch(/bez korekt/i);
        }
      }
    }
  });
});

describe('friendlyStartError', () => {
  it('daty → „Popraw daty okresu.”; powód wyłączenia bez zmian; reszta ogólnie', () => {
    expect(friendlyStartError('Niepoprawny format dat (YYYY-MM-DD)')).toBe('Popraw daty okresu.');
    expect(friendlyStartError('Data końcowa < początkowa')).toBe('Popraw daty okresu.');
    expect(friendlyStartError(SUSPENDED_EXPORT_FORMATS.jpk_v7m!)).toBe(SUSPENDED_EXPORT_FORMATS.jpk_v7m);
    expect(friendlyStartError('Błąd tworzenia jobu')).toBe('Nie udało się zlecić eksportu. Spróbuj ponownie.');
    expect(friendlyStartError('duplicate key value violates unique constraint')).toBe(
      'Nie udało się zlecić eksportu. Spróbuj ponownie.',
    );
  });
});
