import { describe, expect, it } from 'vitest';

import {
  CsvDocumentNotSupportedError,
  CsvForeignCurrencyNotSupportedError,
  generateInsertSubiektCsv,
  generateSymfoniaCsv,
  generateUniversalCsv,
  generateWaproCsv,
  type CsvExportInput,
} from '@/lib/exports/csv-generators';
import type { JpkInvoice } from '@/lib/exports/jpk-fa-generator';

/**
 * F12-E2, F12-E6: CSV nie wykazuje faktury do paragonu (FP) jako sprzedaży
 * (art. 109 ust. 3d ustawy o VAT: sprzedaż jest już w raporcie kasy), nie
 * zgaduje kwot faktury z importu bez sum, a komunikat o walucie podaje numer.
 */

function faktura(o: Partial<JpkInvoice> = {}): JpkInvoice {
  return {
    invoiceNumber: 'FV/1/2026',
    currency: 'PLN',
    invoiceType: 'standard',
    issueDate: '2026-09-20',
    buyerName: 'Nabywca',
    buyerNip: '1234567890',
    netTotal: 100,
    vatTotal: 23,
    grossTotal: 123,
    lines: [{ position: 1, name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: 100, netAmount: 100, vatRate: '23' }],
    ...o,
  } as JpkInvoice;
}

function dane(o: Partial<CsvExportInput>): CsvExportInput {
  return {
    issuer: { nip: '1234567890', name: 'Firma' },
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    issuedInvoices: [],
    receivedInvoices: [],
    ...o,
  };
}

const generatory: Array<[string, (d: CsvExportInput) => Buffer]> = [
  ['Subiekt', generateInsertSubiektCsv],
  ['Symfonia', generateSymfoniaCsv],
  ['Wapro', generateWaproCsv],
  ['uniwersalny', generateUniversalCsv],
];

describe.each(generatory)('CSV %s', (_n, generuj) => {
  it('faktura do paragonu (FP): odmowa z numerem i wyjaśnieniem o raporcie kasy', () => {
    const d = dane({
      issuedInvoices: [faktura({ invoiceNumber: 'FP/5/2026', importedFromKsef: true, ksefMarkers: { fp: true } })],
    });
    expect(() => generuj(d)).toThrow(CsvDocumentNotSupportedError);
    expect(() => generuj(d)).toThrow(/FP\/5\/2026/);
    expect(() => generuj(d)).toThrow(/raporcie kasy/);
  });

  it('nieznane kwoty z importu: odmowa z numerem i wskazaniem oryginału', () => {
    const d = dane({
      issuedInvoices: [
        faktura({
          invoiceNumber: 'FV/9/2026',
          importedFromKsef: true,
          importedTotalsUnknown: true,
          netTotal: 0,
          vatTotal: 0,
          grossTotal: 123,
        }),
      ],
    });
    expect(() => generuj(d)).toThrow(CsvDocumentNotSupportedError);
    expect(() => generuj(d)).toThrow(/FV\/9\/2026/);
    expect(() => generuj(d)).toThrow(/księgow/);
  });

  it('faktura w walucie obcej: komunikat z numerem faktury', () => {
    const d = dane({ receivedInvoices: [faktura({ invoiceNumber: 'FZ/7/2026', currency: 'EUR' })] });
    expect(() => generuj(d)).toThrow(CsvForeignCurrencyNotSupportedError);
    expect(() => generuj(d)).toThrow(/FZ\/7\/2026/);
  });

  it('zwykła faktura PLN przechodzi', () => {
    const d = dane({ issuedInvoices: [faktura()] });
    expect(generuj(d).length).toBeGreaterThan(0);
  });
});
