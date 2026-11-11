import PDFDocument from 'pdfkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ row: null as Record<string, unknown> | null, select: vi.fn() }));

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: (cols: string) => {
        mocks.select(cols);
        const query = {
          eq: () => query,
          maybeSingle: async () => ({ data: mocks.row, error: null }),
        };
        return query;
      },
    }),
  }),
}));

import { loadInvoiceForPdf } from '@/lib/pdf/invoice-data';
import { renderInvoicePdf } from '@/lib/pdf/invoice-renderer';

/**
 * F12-E4: faktura z importu KSeF z cenami brutto (P_9B, bez P_9A) ma w bazie
 * `unit_price_net = NULL`; PDF drukował „0,00” jako cenę netto, której nie ma na fakturze.
 * F12-E5: adnotacje z pliku (P_17, P_18, P_PMarzy_*) są obowiązkowymi wyrazami
 * na fakturze (art. 106e ust. 1 pkt 17, 18, 21, 24), a PDF je gubił.
 * P_23 (procedura uproszczona): brzmienie z art. 136 nie wynika ze schematu, więc PDF go nie dopisuje.
 */

const wiersz = (o: Record<string, unknown> = {}) => ({
  ordinal: 1, name: 'Usługa', unit: 'szt', quantity: 2, unit_price_net: 50,
  net_amount: 100, vat_rate: '23', vat_amount: 23, gross_amount: 123, ...o,
});

function wierszImportu(annotations: unknown, lines: unknown[] = [wiersz()], extra: Record<string, unknown> = {}) {
  return {
    id: 'inv-1', tenant_id: 'ten-1', internal_number: 'FV/1/2026', invoice_type: 'VAT',
    issue_date: '2026-10-01', sale_date: null, ksef_number: null, net_total: 100, vat_total: 23, gross_total: 123,
    notes: null, updated_at: null, pdf_storage_path: null, pdf_generated_at: null,
    seller_data: { nip: '1234567890', name: 'Sprzedawca', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
    buyer_data: { nip: '1234567890', name: 'Nabywca', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' } },
    payment_data: { currency: 'PLN', method: 'transfer' },
    annotations,
    invoice_line_items: lines,
    ...extra,
  };
}

async function tekstPdf(row: Record<string, unknown>): Promise<string[]> {
  mocks.row = row;
  const data = await loadInvoiceForPdf('inv-1', 'ten-1');
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  await renderInvoicePdf(data!.invoice);
  return text.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('F12-E4: cena z faktury w cenach brutto', () => {
  const brutto = (extra: Record<string, unknown> = {}) =>
    wierszImportu(undefined, [wiersz({ unit_price_net: null, ...extra })], {
      ksef_line_fields: [{ ordinal: 1, P_9B: 61.5, P_11A: 123 }],
    });

  it('nie drukuje ceny netto 0,00, tylko cenę brutto z P_9B z oznaczeniem', async () => {
    const t = await tekstPdf(brutto());
    expect(t).toContain('61,50 brutto');
    expect(t).not.toContain('0,00');
  });

  it('bez ceny brutto w pliku komórka ceny jest pusta, nie 0,00', async () => {
    const t = await tekstPdf(wierszImportu(undefined, [wiersz({ unit_price_net: null })]));
    expect(t).not.toContain('0,00');
  });

  it('pobiera ceny brutto z fa3_data->ksefLineFields', async () => {
    await tekstPdf(brutto());
    expect(mocks.select.mock.calls[0]![0]).toContain('fa3_data->ksefLineFields');
  });

  it('strażnik: zwykła faktura z ceną netto dalej drukuje cenę netto', async () => {
    const t = await tekstPdf(wierszImportu(undefined));
    expect(t).toContain('50,00');
    expect(t.some((s) => s.includes('brutto') && s !== 'Brutto' && s !== 'Brutto:')).toBe(false);
  });
});

describe('F12-E5: adnotacje z importu na PDF', () => {
  it.each([
    ['P_17', { selfInvoicing: 1 }, 'samofakturowanie'],
    ['P_18 jawnie', { reverseCharge: 1 }, 'odwrotne obciążenie'],
    ['P_PMarzy_2', { marginScheme: 'P_PMarzy_2' }, 'procedura marży dla biur podróży'],
    ['P_PMarzy_3_1', { marginScheme: 'P_PMarzy_3_1' }, 'procedura marży - towary używane'],
    ['P_PMarzy_3_2', { marginScheme: 'P_PMarzy_3_2' }, 'procedura marży - dzieła sztuki'],
    ['P_PMarzy_3_3', { marginScheme: 'P_PMarzy_3_3' }, 'procedura marży - przedmioty kolekcjonerskie i antyki'],
  ])('%s drukuje wyrazy ustawowe', async (_n, annotations, wyrazy) => {
    expect(await tekstPdf(wierszImportu(annotations))).toContain(wyrazy);
  });

  it('jawne „2” i nieznana procedura marży nic nie drukują', async () => {
    const t = await tekstPdf(wierszImportu({ selfInvoicing: 2, reverseCharge: 2, marginScheme: 'cokolwiek' }));
    expect(t).not.toContain('samofakturowanie');
    expect(t).not.toContain('odwrotne obciążenie');
    expect(t.some((s) => s.includes('procedura marży'))).toBe(false);
  });

  it('odwrotne obciążenie z pozycji „oo” i z adnotacji daje jeden wiersz', async () => {
    const t = await tekstPdf(wierszImportu({ reverseCharge: 1 }, [wiersz({ vat_rate: 'oo' })]));
    expect(t.filter((s) => s === 'odwrotne obciążenie')).toHaveLength(1);
  });

  it('strażnik: faktura z FaktWay bez tych adnotacji nie dostaje żadnych dopisków', async () => {
    const t = await tekstPdf(wierszImportu({ splitPayment: 1 }));
    expect(t).toContain('mechanizm podzielonej płatności');
    for (const s of ['samofakturowanie', 'odwrotne obciążenie']) expect(t).not.toContain(s);
    expect(t.some((x) => x.includes('procedura marży'))).toBe(false);
  });
});
