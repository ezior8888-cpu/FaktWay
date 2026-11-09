import { describe, expect, it } from 'vitest';

import {
  costDocumentType,
  documentAllowsVatDeduction,
  RECEIPT_WITH_NIP_NOT_INVOICE_FROM,
  vatDeductionForDocument,
} from '@/lib/expenses/vat-deduction-document';

/**
 * Reguła kroku 1.3: czy dokument kosztowy daje odliczenie VAT, zależnie od
 * rodzaju i daty wystawienia (nie daty wgrania). Paragon z NIP jest fakturą
 * uproszczoną do 31.12.2026 (art. 145n ust. 1 pkt 2 z art. 106e ust. 5 pkt 3
 * ustawy o VAT), od 1.01.2027 nie jest fakturą (art. 86 ust. 2 pkt 1 lit. a).
 */

const paragon = (issueDate: string | null) => ({ documentType: 'simplified_invoice', issueDate });

describe('paragon z NIP na granicy roku (Europe/Warsaw)', () => {
  it('pierwszy dzień bez faktury uproszczonej to 1.01.2027', () => {
    expect(RECEIPT_WITH_NIP_NOT_INVOICE_FROM).toBe('2027-01-01');
  });

  it.each([
    ['2026-12-31', true],
    ['2027-01-01', false],
    ['2026-02-15', true],
    ['2025-06-01', true],
    ['2027-06-30', false],
  ])('data wystawienia %s: odliczenie %s', (issueDate, deductible) => {
    expect(documentAllowsVatDeduction(paragon(issueDate))).toBe(deductible);
  });

  it.each([
    // 23:59:59 31.12.2026 w Warszawie (zima, UTC+1).
    ['2026-12-31T22:59:59Z', true],
    // Północ 1.01.2027 w Warszawie.
    ['2026-12-31T23:00:00Z', false],
    ['2026-12-31T23:30:00Z', false],
    ['2026-12-31T23:30:00+01:00', true],
    ['2027-01-01T00:30:00+01:00', false],
  ])('znacznik czasu %s liczony jako dzień w Warszawie: odliczenie %s', (issueDate, deductible) => {
    expect(documentAllowsVatDeduction(paragon(issueDate))).toBe(deductible);
  });

  it('od 2027 r.: powód i informacja z prośbą o fakturę do paragonu', () => {
    const wynik = vatDeductionForDocument(paragon('2027-01-01'));
    expect(wynik).toMatchObject({ deductible: false, reason: 'receipt_with_nip_from_2027' });
    expect(wynik.deductible === false && wynik.notice?.title).toBe('Od 1 stycznia 2027 r. paragon z NIP nie jest fakturą');
    expect(wynik.deductible === false && wynik.notice?.body).toContain('poproś sprzedawcę o fakturę do paragonu');
  });

  it.each([null, '', '   ', '2027-02-30', '31.12.2026', 'jutro'])(
    'brak albo zła data (%j): brak odliczenia z komunikatem',
    (issueDate) => {
      const wynik = vatDeductionForDocument(paragon(issueDate));
      expect(wynik).toMatchObject({ deductible: false, reason: 'missing_issue_date' });
      expect(wynik.deductible === false && wynik.notice?.title).toBe('Brak daty wystawienia paragonu');
    },
  );

  it('teksty bez długich myślników', () => {
    for (const issueDate of ['2027-01-01', null]) {
      const wynik = vatDeductionForDocument(paragon(issueDate));
      const tekst = wynik.deductible ? '' : `${wynik.notice?.title} ${wynik.notice?.body}`;
      expect(tekst).not.toMatch(/[—–]/);
    }
  });
});

describe('pozostałe rodzaje bez zmian', () => {
  it.each([
    ['invoice', '2027-03-01', true],
    ['invoice', null, true],
    [null, '2027-03-01', true],
    ['receipt', '2026-05-01', false],
    ['receipt', '2027-05-01', false],
    ['other', '2026-05-01', false],
  ])('%s z datą %s: odliczenie %s', (documentType, issueDate, deductible) => {
    expect(documentAllowsVatDeduction({ documentType, issueDate })).toBe(deductible);
  });

  it('paragon bez NIP i „inne”: bez komunikatu, jak dotąd', () => {
    expect(vatDeductionForDocument({ documentType: 'receipt', issueDate: '2027-05-01' }))
      .toEqual({ deductible: false, reason: 'document_type', notice: null });
  });
});

describe('rodzaj dokumentu kosztu z wiersza bazy', () => {
  const ocr = { document_type: 'simplified_invoice' };

  it('OCR zapisuje paragon z NIP jako `invoice`: rodzaj z odczytu zdjęcia', () => {
    expect(costDocumentType({ document_type: 'invoice', source: 'ocr_photo', ocr_extracted_data: ocr })).toBe('simplified_invoice');
    expect(costDocumentType({ document_type: 'invoice', source: 'import', ocr_extracted_data: ocr })).toBe('simplified_invoice');
  });

  it.each([
    ['skrzynka KSeF', { document_type: 'invoice', source: 'ksef_inbox', ocr_extracted_data: ocr }, 'invoice'],
    ['powiązany z fakturą KSeF', { document_type: 'invoice', source: 'ocr_photo', ksef_invoice_id: 'inv-1', ocr_extracted_data: ocr }, 'invoice'],
    ['faktura ze zdjęcia', { document_type: 'invoice', source: 'ocr_photo', ocr_extracted_data: { document_type: 'invoice' } }, 'invoice'],
    ['paragon ze zdjęcia', { document_type: 'receipt', source: 'ocr_photo', ocr_extracted_data: ocr }, 'receipt'],
    ['bez odczytu', { document_type: 'invoice', source: 'ocr_photo', ocr_extracted_data: null }, 'invoice'],
    ['odczyt nie jest obiektem', { document_type: 'invoice', source: 'ocr_photo', ocr_extracted_data: ['simplified_invoice'] }, 'invoice'],
    ['zapisany rodzaj', { document_type: 'simplified_invoice', source: 'manual', ocr_extracted_data: null }, 'simplified_invoice'],
    ['brak rodzaju', { document_type: null, source: 'manual', ocr_extracted_data: null }, 'invoice'],
  ])('%s', (_opis, row, rodzaj) => {
    expect(costDocumentType(row)).toBe(rodzaj);
  });
});
