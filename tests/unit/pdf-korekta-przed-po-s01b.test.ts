import PDFDocument from 'pdfkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderInvoicePdf } from '@/lib/pdf/invoice-renderer';
import { finalizeInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';
import type { Invoice } from '@/types/invoice';

/**
 * S-01b: korekta „przed/po” ma w `invoice_line_items` pozycje w stanie PO,
 * a w nagłówku (`gross_total`, czyli `Invoice.grossTotal` z
 * `lib/pdf/invoice-data.ts`) różnicę (00200). „PODSUMOWANIE VAT” na PDF
 * liczyło stawki z pozycji, więc nabywca widział kwoty stanu po jako kwoty
 * korekty, obok „Do zapłaty” z różnicą. Ekran te wiersze ukrywa
 * (`vatSummaryAgreesWithGross`), PDF nie ukrywał.
 */

function dokument(type: InvoiceInput['type'], unitPriceNet: number): Invoice {
  return finalizeInvoice({
    internalNumber: type === 'VAT' ? 'FV 1/09/2026' : 'KOR 1/09/2026',
    type,
    issueDate: '2026-09-20',
    saleDate: '2026-09-20',
    seller: {
      nip: '1234567890',
      name: 'Moja Firma Sp. z o.o.',
      address: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' },
    },
    buyer: {
      nip: '5260001246',
      name: 'Klient Sp. z o.o.',
      address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' },
    },
    lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet, vatRate: '23' }],
    payment: { currency: 'PLN', dueDate: '2026-10-05', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  });
}

async function wydrukowane(invoice: Invoice): Promise<string[]> {
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  await renderInvoicePdf(invoice);
  return text.mock.calls.map((c) => String(c[0]));
}

const wierszeStawek = (napisy: string[]) => napisy.filter((t) => /netto .* VAT /.test(t));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PDF: podsumowanie VAT korekty „przed/po” (S-01b)', () => {
  it('korekta przed/po (pozycje = stan po 800 zł, nagłówek = różnica -246 zł): bez wierszy stawek stanu po', async () => {
    const korekta: Invoice = { ...dokument('KOR', 800), netTotal: -200, vatTotal: -46, grossTotal: -246 };
    const napisy = await wydrukowane(korekta);
    expect(wierszeStawek(napisy)).toEqual([]);
    expect(napisy.some((t) => t.startsWith('Do zapłaty:') && t.includes('246'))).toBe(true);
  });

  it('korekta z pozycjami jako różnicą (zmiana kwoty): wiersz stawki zostaje', async () => {
    expect(wierszeStawek(await wydrukowane(dokument('KOR', -200)))).toHaveLength(1);
  });

  it('zwykła faktura: wiersz stawki zostaje', async () => {
    expect(wierszeStawek(await wydrukowane(dokument('VAT', 1000)))).toHaveLength(1);
  });
});
