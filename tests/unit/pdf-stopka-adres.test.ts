import PDFDocument from 'pdfkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderInvoicePdf } from '@/lib/pdf/invoice-renderer';
import { buildInvoicePdfKey } from '@/lib/pdf/pdf-storage';
import { finalizeInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';

/**
 * Stopka faktury (FAKTWAY-1-0, sekcja 3, pkt 4): nabywca, który dostaje PDF,
 * ma widzieć adres strony, a tekst nie ma długiego myślnika. Adres jest stały,
 * nie z NEXT_PUBLIC_APP_URL: PDF wychodzi poza aplikację, więc wydruk z dev
 * albo testów nie może nieść adresu localhost.
 */

function faktura() {
  const input: InvoiceInput = {
    internalNumber: 'FV 1/11/2026',
    type: 'VAT',
    issueDate: '2026-11-02',
    saleDate: '2026-11-02',
    seller: {
      nip: '1234567890',
      name: 'Moja Firma',
      address: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' },
    },
    buyer: {
      nip: '1234567890',
      name: 'Klient',
      address: { countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
    },
    lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
    payment: { currency: 'PLN', dueDate: '2026-11-16', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  };
  return finalizeInvoice(input);
}

async function stopka(): Promise<{ text: string; options: Record<string, unknown> }> {
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  await renderInvoicePdf(faktura());
  const call = text.mock.calls.find((c) => String(c[0]).includes('FaktWay'));
  if (!call) throw new Error('Na PDF nie ma stopki FaktWay');
  return { text: String(call[0]), options: (call[3] ?? {}) as Record<string, unknown> };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('PDF: stopka z adresem strony', () => {
  it('podaje adres strony', async () => {
    expect((await stopka()).text).toContain('faktway.pl');
  });

  it('nie ma długiego myślnika', async () => {
    expect((await stopka()).text).not.toMatch(/[—–]/);
  });

  it('adres jest klikalny i prowadzi na stronę', async () => {
    expect((await stopka()).options.link).toBe('https://faktway.pl');
  });

  it('adres nie zależy od adresu środowiska', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
    const { text, options } = await stopka();
    expect(text).not.toContain('localhost');
    expect(options.link).toBe('https://faktway.pl');
  });

  it('nowa stopka unieważnia PDF-y w pamięci podręcznej', () => {
    const key = buildInvoicePdfKey('tenant', 'invoice', '2026-11-02', 'none');
    // Stopka weszła w v6; v7 (krok 1.4, tytuł przelewu z numerem KSeF) ją zawiera.
    expect(key).toContain('.v7.');
  });
});

describe('UPO PDF: stopka z adresem strony', () => {
  it('podaje adres FaktWay obok adresu KSeF', async () => {
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    const { generateUpoPdf } = await import('@/lib/ksef/upo-pdf-generator');
    await generateUpoPdf({
      ksefNumber: '1234567890-20261102-ABCDEF123456-AB',
      invoiceNumber: 'FV 1/11/2026',
      issueDate: '2026-11-02',
      sellerName: 'Moja Firma',
      sellerNip: '1234567890',
      buyerName: 'Klient',
      buyerNip: '1234567890',
      grossAmount: 123,
      acceptanceTimestamp: '2026-11-02T10:00:00.000Z',
      upoXmlHash: 'abc',
    });
    const footer = text.mock.calls.map((c) => String(c[0])).find((t) => t.startsWith('Wygenerowano:'));
    expect(footer).toContain('faktway.pl');
    expect(footer).not.toMatch(/[—–]/);
  });
});
