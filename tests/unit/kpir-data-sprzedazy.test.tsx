import ExcelJS from 'exceljs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ db: vi.fn() }));
// Strona KPiR pyta o tryb danych (dane przykładowe przed weryfikacją KSeF) — tu firma zweryfikowana.
vi.mock('@/lib/demo/tryb-danych', () => ({ trybDanych: async () => ({ tryb: 'prawdziwe', stan: 'C', verifiedAt: null }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: async () => ({ supabase: mocks.db(), tenantId: 'firma-a' }),
}));

import KpirPage from '@/app/(dashboard)/reports/kpir/page';
import { KpirView, type KpirInvoiceRow } from '@/components/expenses/kpir-view';
import { earlierSaleRemark, kpirSaleEventDate } from '@/lib/categorization/kpir-revenue';
import type { JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { generateKpirXlsx } from '@/lib/exports/kpir-generator';
import { getKpirData } from '@/lib/reports/kpir-data';

/**
 * KPiR: kol. 2 to data zdarzenia gospodarczego — przy sprzedaży dzień
 * sprzedaży (P_6), nie wystawienia faktury. Przychód powstaje w dniu
 * sprzedaży, nie później niż przy wystawieniu (art. 14 ust. 1c PIT).
 * Faktura wystawiona 3.09 za usługę z 31.08 zostaje w KPiR września
 * (nic nie ginie, gdy sierpień już poszedł do księgowej), ale z datą
 * sprzedaży i uwagą — do 29.09 była tam z datą 03.09 bez śladu, że to sierpień.
 */

describe('reguła daty', () => {
  it.each([
    ['sprzedaż przed wystawieniem → sprzedaż', { saleDate: '2026-08-31', issueDate: '2026-09-03' }, '2026-08-31'],
    ['bez daty sprzedaży → wystawienie', { saleDate: null, issueDate: '2026-09-03' }, '2026-09-03'],
    ['data sprzedaży = wystawienie', { saleDate: '2026-09-03', issueDate: '2026-09-03' }, '2026-09-03'],
    ['sprzedaż PO wystawieniu (import) → wystawienie: „nie później niż”', { saleDate: '2026-09-20', issueDate: '2026-09-03' }, '2026-09-03'],
  ])('%s', (_opis, inv, oczekiwane) => {
    expect(kpirSaleEventDate(inv)).toBe(oczekiwane);
  });

  it('uwaga tylko, gdy sprzedaż wypada przed okresem', () => {
    expect(earlierSaleRemark({ saleDate: '2026-08-31', issueDate: '2026-09-03' }, '2026-09-01')).toBe(
      'sprzedaż z 31.08.2026, faktura z 03.09.2026 — przychód okresu sprzedaży (art. 14 ust. 1c PIT)',
    );
    expect(earlierSaleRemark({ saleDate: '2026-09-01', issueDate: '2026-09-03' }, '2026-09-01')).toBeNull();
    expect(earlierSaleRemark({ saleDate: null, issueDate: '2026-09-03' }, '2026-09-01')).toBeNull();
  });
});

function sprzedaz(o: Partial<JpkInvoice>): JpkInvoice {
  return {
    invoiceNumber: 'FV/1', currency: 'PLN', invoiceType: 'regular', issueDate: '2026-09-03', buyerName: 'Klient',
    netTotal: 1000, vatTotal: 230, grossTotal: 1230, lines: [], ...o,
  };
}

describe('eksport KPiR — kol. 2 i uwaga', () => {
  it('data sprzedaży w kol. 2, uwaga w kol. 17, kolejność po dacie zdarzenia', async () => {
    const buffer = await generateKpirXlsx({
      issuer: { nip: '1234567890', name: 'Firma' },
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      issuedInvoices: [
        sprzedaz({ invoiceNumber: 'FV/2', issueDate: '2026-09-10', saleDate: '2026-09-05' }),
        sprzedaz({ invoiceNumber: 'FV/1', issueDate: '2026-09-03', saleDate: '2026-08-31' }),
      ],
      expenses: [],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet('KPiR')!;
    const cell = (r: number, c: number) => sheet.getRow(r).getCell(c).value;

    expect(cell(2, 3)).toBe('FV/1');
    expect(cell(2, 2)).toBe('31.08.2026');
    expect(String(cell(2, 17))).toContain('sprzedaż z 31.08.2026, faktura z 03.09.2026');
    expect(cell(2, 7)).toBe(1000); // przychód dalej w pliku — nic nie ginie

    expect(cell(3, 3)).toBe('FV/2');
    expect(cell(3, 2)).toBe('05.09.2026');
    expect(String(cell(3, 17) ?? '')).not.toContain('sprzedaż z');
  });
});

describe('KPiR w aplikacji', () => {
  const wiersz = (o: Partial<KpirInvoiceRow>): KpirInvoiceRow => ({
    id: 'fv', internal_number: 'FV/1', issue_date: '2026-09-03', sale_date: '2026-08-31',
    gross_total: 1230, net_total: 1000, buyer_data: null, invoice_kind: 'regular', ...o,
  });

  it('data sprzedaży i uwaga przy sprzedaży z poprzedniego miesiąca', () => {
    const html = renderToStaticMarkup(<KpirView month={9} year={2026} expenses={[]} invoices={[wiersz({})]} />);
    expect(html).toContain('31.08.2026');
    expect(html).toContain('przychód okresu sprzedaży');
  });

  it('sprzedaż w okresie — bez uwagi', () => {
    const html = renderToStaticMarkup(
      <KpirView month={9} year={2026} expenses={[]} invoices={[wiersz({ sale_date: '2026-09-02' })]} />,
    );
    expect(html).toContain('2.09.2026');
    expect(html).not.toContain('przychód okresu sprzedaży');
  });
});

describe('strona KPiR — podpięcie', () => {
  // Atrapa zwraca TYLKO wybrane kolumny: bez `sale_date` w zapytaniu uwagi nie będzie.
  function database() {
    return {
      from(table: string) {
        let columns: string[] | null = null;
        let head = false;
        const query = {
          select(selection = '*', options?: { head?: boolean }) {
            const parts = selection.split(',').map((s) => s.trim()).filter(Boolean);
            columns = parts.includes('*') ? null : parts;
            head = Boolean(options?.head);
            return query;
          },
          eq() { return query; },
          or() { return query; },
          range() { return query; },
          in() { return query; },
          gte() { return query; },
          lte() { return query; },
          order() { return query; },
          then(resolve: (v: unknown) => unknown) {
            const rows =
              table === 'invoices'
                ? [{ id: 'fv', internal_number: 'FV/1', issue_date: '2026-09-03', sale_date: '2026-08-31', gross_total: 1230, net_total: 1000, currency: 'PLN', buyer_data: null, invoice_kind: 'regular', advance_invoice_ids: [] }]
                : [];
            const project = (r: Record<string, unknown>) => (columns ? Object.fromEntries(columns.map((c) => [c, r[c]])) : r);
            // Kontrola proweniencji (#63): 0 przyjętych faktur bez środowiska KSeF.
            if (head) return Promise.resolve({ data: null, count: 0, error: null }).then(resolve);
            return Promise.resolve({ data: rows.map(project), count: rows.length, error: null }).then(resolve);
          },
        };
        return query;
      },
    };
  }

  beforeEach(() => {
    mocks.db.mockReset().mockImplementation(database);
  });

  it('getKpirData pobiera datę sprzedaży (bez niej nie ma kol. 2 ani uwagi)', async () => {
    const data = await getKpirData(mocks.db(), 'firma-a', { month: '9', year: '2026' });
    expect(data.invoices[0]).toMatchObject({ internal_number: 'FV/1', sale_date: '2026-08-31', issue_date: '2026-09-03' });
  });

  it('strona pobiera datę sprzedaży i pokazuje uwagę', async () => {
    const page = await KpirPage({ searchParams: Promise.resolve({ month: '9', year: '2026' }) });
    const html = renderToStaticMarkup(page);
    expect(html).toContain('przychód okresu sprzedaży');
  });
});
