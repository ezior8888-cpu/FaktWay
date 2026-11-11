import PDFDocument from 'pdfkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }));

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: mocks.row, error: null }),
      });
      return q;
    },
  }),
}));

import { loadInvoiceForPdf } from '@/lib/pdf/invoice-data';
import { renderInvoicePdf } from '@/lib/pdf/invoice-renderer';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';
import type { Invoice, ReceiptInvoiceData } from '@/types/invoice';

/**
 * PDF faktury do paragonu (plan kompletnej aplikacji, krok 1.2): wyraźne
 * oznaczenie „Faktura do paragonu” i dane paragonu (numer, data, numer
 * unikatowy kasy; art. 106h ust. 1 ustawy o VAT). Nabywca spoza KSeF dostaje
 * tylko PDF. Sekcji płatności ten krok nie zmienia (krok 1.4 ma ją w osobnym PR).
 */

const PARAGON: ReceiptInvoiceData = {
  receiptNumber: '000123',
  receiptDate: '2026-10-15',
  cashRegisterNumber: 'ABC1234567890',
  buyerNipOnReceipt: true,
};

function faktura(receipt?: ReceiptInvoiceData): Invoice {
  const invoice = finalizeInvoice({
    internalNumber: 'FV 5/11/2026',
    type: 'VAT',
    issueDate: '2026-11-09',
    saleDate: '2026-10-15',
    seller: { nip: '5260001246', name: 'Sklep Testowy', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
    buyer: { nip: '5252241585', name: 'Klient Sp. z o.o.', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' } },
    lines: [{ ordinal: 1, name: 'Rower', unit: 'szt.', quantity: 1, unitPriceNet: 1000, vatRate: '23' }],
    payment: { currency: 'PLN', dueDate: '2026-11-09', method: 'cash' },
  });
  return receipt ? { ...invoice, receipt } : invoice;
}

async function wydrukowane(invoice: Invoice, opts: Parameters<typeof renderInvoicePdf>[1] = {}): Promise<string[]> {
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  await renderInvoicePdf(invoice, opts);
  return text.mock.calls.map((c) => String(c[0]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PDF faktury do paragonu', () => {
  it('oznaczenie „Faktura do paragonu” i dane paragonu', async () => {
    const teksty = await wydrukowane(faktura(PARAGON));
    expect(teksty).toContain('Faktura do paragonu');
    expect(teksty).toContain('Paragon nr 000123 z dnia 2026-10-15, numer unikatowy kasy ABC1234567890');
  });

  it('zwykła faktura bez oznaczenia', async () => {
    const teksty = await wydrukowane(faktura());
    expect(teksty.some((t) => t.includes('do paragonu'))).toBe(false);
  });

  it('FP z importu KSeF (samo oznaczenie w pliku, bez danych paragonu): samo oznaczenie', async () => {
    const teksty = await wydrukowane(faktura(), { receiptInvoiceMarker: true });
    expect(teksty).toContain('Faktura do paragonu');
    expect(teksty.some((t) => t.startsWith('Paragon nr'))).toBe(false);
  });

  it('loader PDF czyta paragon i oznaczenie FP z importu z fa3_data', async () => {
    const wiersz = {
      id: 'inv-1', tenant_id: 'ten-1', internal_number: 'FV 5/11/2026', invoice_type: 'VAT',
      issue_date: '2026-11-09', sale_date: '2026-10-15', ksef_number: null, net_total: 1000, vat_total: 230,
      gross_total: 1230, notes: null, updated_at: '2026-11-09T10:00:00Z', pdf_storage_path: null, pdf_generated_at: null,
      seller_data: {}, buyer_data: {}, payment_data: {}, annotations: null, invoice_line_items: [],
    };
    mocks.row = { ...wiersz, receipt: PARAGON, ksef_fp: null };
    const z = await loadInvoiceForPdf('inv-1', 'ten-1');
    expect(z?.invoice.receipt).toEqual(PARAGON);
    expect(z?.receiptInvoiceMarker).toBe(false);

    mocks.row = { ...wiersz, receipt: null, ksef_fp: 'true' };
    const zImportu = await loadInvoiceForPdf('inv-1', 'ten-1');
    expect(zImportu?.invoice.receipt).toBeUndefined();
    expect(zImportu?.receiptInvoiceMarker).toBe(true);

    mocks.row = { ...wiersz, receipt: { receiptNumber: '' }, ksef_fp: null };
    const uszkodzony = await loadInvoiceForPdf('inv-1', 'ten-1');
    // Niepełny paragon nie drukuje pustych danych, ale oznaczenie zostaje.
    expect(uszkodzony?.invoice.receipt).toBeUndefined();
    expect(uszkodzony?.receiptInvoiceMarker).toBe(true);
  });
});
