import { describe, expect, it } from 'vitest';

import {
  isCashRegisterNumber,
  isReceiptInvoiceFa3,
  normalizeCashRegisterNumber,
  receiptFromJson,
  receiptInvoiceView,
  receiptRequestDeadline,
} from '@/lib/invoices/receipt-invoice';

/**
 * Reguły pomocnicze faktury do paragonu (krok 1.2): koniec terminu na żądanie
 * (art. 106b ust. 3: 3 miesiące od końca miesiąca sprzedaży), numer unikatowy
 * kasy (rozporządzenia MF o kasach: 3 litery i 10 cyfr, starsze 3 albo 2 litery
 * i 8 cyfr) i rozpoznanie FP w `fa3_data` (FaktWay i import KSeF).
 */

describe('termin na żądanie faktury do paragonu', () => {
  it.each([
    ['2026-08-15', '2026-11-30'],
    ['2026-08-31', '2026-11-30'],
    ['2026-10-01', '2027-01-31'],
    ['2026-11-30', '2027-02-28'],
    ['2026-12-31', '2027-03-31'],
    ['2027-11-05', '2028-02-29'], // rok przestępny
    ['2027-02-28', '2027-05-31'], // koniec trzeciego miesiąca, nie „28 maja”
  ])('paragon z %s: do %s', (paragon, koniec) => {
    expect(receiptRequestDeadline(paragon)).toBe(koniec);
  });
});

describe('numer unikatowy kasy', () => {
  it('zapis bez spacji i myślników, wielkimi literami', () => {
    expect(normalizeCashRegisterNumber(' abc 123-456 7890 ')).toBe('ABC1234567890');
  });

  it.each(['ABC1234567890', 'BEA12345678', 'AB12345678'])('%s: poprawny', (n) => {
    expect(isCashRegisterNumber(n)).toBe(true);
  });

  it.each(['ABC123456789', 'A12345678', '1234567890123', 'ABC 1234567890', 'abc1234567890'])('%s: niepoprawny', (n) => {
    expect(isCashRegisterNumber(n)).toBe(false);
  });
});

describe('FP w fa3_data', () => {
  const paragon = { receiptNumber: '000123', receiptDate: '2026-10-15', cashRegisterNumber: 'ABC1234567890' };

  it('FaktWay (receipt), import KSeF (ksefMarkers.fp) i zwykła faktura', () => {
    expect(isReceiptInvoiceFa3({ receipt: paragon })).toBe(true);
    expect(isReceiptInvoiceFa3({ ksefMarkers: { fp: true } })).toBe(true);
    expect(isReceiptInvoiceFa3({ ksefMarkers: { tp: true } })).toBe(false);
    expect(isReceiptInvoiceFa3({ lines: [] })).toBe(false);
    expect(isReceiptInvoiceFa3(null)).toBe(false);
  });

  it('niepełny zapis paragonu dalej znaczy FP (fail-closed), ale nie daje danych do druku', () => {
    expect(isReceiptInvoiceFa3({ receipt: { receiptNumber: '' } })).toBe(true);
    expect(receiptFromJson({ receiptNumber: '' })).toBeNull();
    expect(receiptFromJson({ ...paragon, receiptDate: '2026-02-31' })).toBeNull();
  });

  it('widok faktury: oznaczenie i dane paragonu z datą po polsku; FP z importu bez danych', () => {
    expect(receiptInvoiceView({ receipt: paragon })).toEqual({
      label: 'Faktura do paragonu',
      details: 'Paragon nr 000123 z dnia 15.10.2026, numer unikatowy kasy ABC1234567890',
    });
    expect(receiptInvoiceView({ ksefMarkers: { fp: true } })).toEqual({ label: 'Faktura do paragonu', details: null });
    expect(receiptInvoiceView({ lines: [] })).toBeNull();
  });
});
