import PDFDocument from 'pdfkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { REVERSE_CHARGE_LABEL } from '@/lib/invoices/annotations';
import { buildInvoicePdfKey } from '@/lib/pdf/pdf-storage';
import { renderInvoicePdf } from '@/lib/pdf/invoice-renderer';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';
import type { VatRate } from '@/types/invoice';

/**
 * Odwrotne obciążenie na PDF. Faktura, przy której podatek rozlicza nabywca,
 * musi zawierać wyrazy „odwrotne obciążenie” (art. 106e ust. 1 pkt 18).
 * XML do KSeF ma P_18=1 przy każdej pozycji „oo”, ale PDF do 01.10.2026
 * pokazywał tylko skrót „o.o.” w kolumnie stawki — a nabywca spoza KSeF
 * (np. zagraniczny) dostaje wyłącznie PDF.
 */

function faktura(...rates: VatRate[]) {
  const input: InvoiceInput = {
    internalNumber: 'FV 7/10/2026',
    type: 'VAT',
    issueDate: '2026-10-01',
    saleDate: '2026-10-01',
    seller: {
      nip: '5260001246',
      name: 'Moja Firma Sp. z o.o.',
      address: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' },
    },
    buyer: {
      nip: '5252241585',
      name: 'Klient Sp. z o.o.',
      address: { countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
    },
    lines: rates.map((vatRate, i) => ({ ordinal: i + 1, name: `Usługa ${i + 1}`, unit: 'usł.', quantity: 1, unitPriceNet: 1000, vatRate })),
    payment: { currency: 'PLN', dueDate: '2026-10-15', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  };
  return finalizeInvoice(input);
}

async function wydrukowane(rates: VatRate[]): Promise<string[]> {
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  await renderInvoicePdf(faktura(...rates));
  return text.mock.calls.map((c) => String(c[0]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PDF: „odwrotne obciążenie” tak jak P_18 w XML', () => {
  it('pozycja „oo” — wyrazy na PDF, a XML ma P_18=1', async () => {
    expect(await wydrukowane(['oo'])).toContain(REVERSE_CHARGE_LABEL);
    expect(generateFA3Xml(faktura('oo'))).toContain('<P_18>1</P_18>');
  });

  it('„oo” obok zwykłej stawki — też (wystarczy jedna pozycja)', async () => {
    expect(await wydrukowane(['23', 'oo'])).toContain(REVERSE_CHARGE_LABEL);
  });

  it('bez „oo” — bez dopisku, a XML ma P_18=2', async () => {
    expect(await wydrukowane(['23', 'np'])).not.toContain(REVERSE_CHARGE_LABEL);
    expect(generateFA3Xml(faktura('23'))).toContain('<P_18>2</P_18>');
  });

  it('zmiana wyglądu PDF unieważnia zapisane wcześniej pliki (nowa wersja w ścieżce)', () => {
    const draftKey = buildInvoicePdfKey('ten-1', 'inv-1', '2026-10-01');
    expect(draftKey).toMatch(/^ten-1\/2026\/10\/inv-1\.v6\.[0-9a-f]{32}\.pdf$/);
    expect(buildInvoicePdfKey('ten-1', 'inv-1', '2026-10-01', 'https://qr.ksef.mf.gov.pl/invoice/1234567890/hash', 'KSEF-1'))
      .not.toBe(draftKey);
  });
});
