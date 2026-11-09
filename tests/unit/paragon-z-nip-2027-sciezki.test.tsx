import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { kpirCostAmount } from '@/lib/categorization/kpir-cost';
import { getCosts } from '@/lib/dashboard/costs';
import { fetchInvoicesForExport, type ExportExpense } from '@/lib/exports/data-fetcher';
import type { JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { generateJpkV7m, summarizeJpkV7m, vatPurchases } from '@/lib/exports/jpk-v7m-generator';
import { vatMiesiaca } from '@/lib/ksiegowosc/vat';
import type { PageContext } from '@/lib/supabase/page-context';
import type { Database } from '@/types/database';

import { memoryClient, type Row } from './helpers/baza-w-pamieci';

/**
 * Krok 1.3 planu kompletnej aplikacji: paragon z NIP nabywcy do 450 zł jest
 * fakturą uproszczoną tylko do 31.12.2026 (art. 145n ust. 1 pkt 2 ustawy
 * o VAT). Od 1.01.2027 nie jest fakturą, a podatek naliczony to podatek
 * z faktur (art. 86 ust. 2 pkt 1 lit. a), więc nie daje odliczenia.
 *
 * Prawdziwe ścieżki: generator JPK_V7M (wiersze K_42/K_43 i P_43), VAT
 * modułu księgowości (`fetchInvoicesForExport` i `vatMiesiaca`, jak
 * `czytajVat`), kafle „VAT do odliczenia” (`getCosts`) i przegląd kosztu.
 * Atrapa tylko bazy (w pamięci). OCR zapisuje paragon z NIP jako `invoice`
 * (`process-ocr.ts`), a rozpoznany rodzaj zostaje w `ocr_extracted_data`,
 * więc wiersze bazy są tu takie, jakie zapisuje OCR.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/app/actions/expenses', () => ({
  deleteExpenseAction: vi.fn(),
  reviewExpenseAction: vi.fn(),
}));

const { ExpenseEditForm } = await import('@/components/expenses/expense-edit-form');

const FIRMA = 'firma-a';
const ISSUER = { nip: '1234567890', name: 'Moja Firma', taxOfficeCode: '1433', email: 'biuro@example.test' };

function koszt(o: Partial<ExportExpense> = {}): ExportExpense {
  return {
    id: 'fv',
    issueDate: '2027-01-10',
    documentNumber: 'FV/1/01',
    documentType: 'invoice',
    sellerName: 'Dostawca Sp. z o.o.',
    sellerNip: '5260001246',
    sellerAddress: null,
    netAmount: 1000,
    vatAmount: 230,
    grossAmount: 1230,
    vatDeductibleAmount: 230,
    kpirColumn: 'col_13',
    categoryLabel: 'Usługi',
    ...o,
  };
}

/** Paragon z NIP nabywcy: 100 zł netto, 23 zł VAT. */
const paragonZNip = (issueDate: string): ExportExpense =>
  koszt({
    id: 'par-nip', issueDate, documentNumber: 'PAR 4711', documentType: 'simplified_invoice',
    sellerName: 'Sklep Przykład', netAmount: 100, vatAmount: 23, grossAmount: 123, vatDeductibleAmount: 23,
  });

function sprzedaz(issueDate: string): JpkInvoice {
  return {
    invoiceNumber: 'FS/1',
    currency: 'PLN',
    issueDate,
    buyerName: 'Klient',
    buyerNip: '5252241585',
    netTotal: 1000,
    vatTotal: 230,
    grossTotal: 1230,
    ksefNumber: '1234567890-20270105-ABC-01',
    lines: [{ name: 'Usługa', quantity: 1, unit: 'szt.', unitPriceNet: 1000, netAmount: 1000, vatRate: '23', vatAmount: 230 }],
  } as JpkInvoice;
}

function jpk(periodStart: string, periodEnd: string, expenses: ExportExpense[]) {
  return { issuer: ISSUER, periodStart, periodEnd, issuedInvoices: [sprzedaz(periodStart)], expenses };
}

describe('JPK_V7M: paragon z NIP a data wystawienia', () => {
  it('paragon z NIP z 1.01.2027: bez wiersza zakupu i bez K_43; faktura obok zostaje', () => {
    const data = jpk('2027-01-01', '2027-01-31', [koszt(), paragonZNip('2027-01-01')]);
    const xml = generateJpkV7m(data);

    expect(vatPurchases(data.expenses).map((e) => e.id)).toEqual(['fv']);
    expect(xml).not.toContain('PAR 4711');
    expect(xml).toContain('<LiczbaWierszyZakupow>1</LiczbaWierszyZakupow>');
    expect(xml).toContain('<PodatekNaliczony>230.00</PodatekNaliczony>');
    expect(xml).toContain('<P_42>1000</P_42>');
    expect(xml).toContain('<P_43>230</P_43>');
    expect(summarizeJpkV7m(data)).toMatchObject({ vatDeductible: 230, purchaseNet: 1000, purchaseCount: 1 });
  });

  it('paragon z NIP z 31.12.2026: wiersz zakupu z K_42 i K_43 jak dotąd', () => {
    const data = jpk('2026-12-01', '2026-12-31', [paragonZNip('2026-12-31')]);
    const xml = generateJpkV7m(data);

    expect(xml).toContain('<DowodZakupu>PAR 4711</DowodZakupu>');
    expect(xml).toContain('<K_42>100.00</K_42>');
    expect(xml).toContain('<K_43>23.00</K_43>');
    expect(xml).toContain('<P_43>23</P_43>');
    expect(summarizeJpkV7m(data)).toMatchObject({ vatDeductible: 23, purchaseCount: 1 });
  });
});

/** Wydatek tak, jak zapisuje go OCR zdjęcia paragonu z NIP (`process-ocr.ts`). */
function wydatekOcr(id: string, issueDate: string, fields: Row = {}): Row {
  return {
    id, tenant_id: FIRMA, is_deductible: true, is_reviewed: true, issue_date: issueDate,
    source: 'ocr_photo', ksef_invoice_id: null,
    document_number: 'PAR 4711', document_type: 'invoice',
    seller_name: 'Sklep Przykład', seller_nip: '5260001246', seller_address: null,
    net_amount: 100, vat_amount: 23, gross_amount: 123, vat_deductible_amount: 23,
    kpir_column: 'col_13', category_label: 'Materiały biurowe',
    ocr_extracted_data: { document_type: 'simplified_invoice', issue_date: issueDate, gross_amount: 123 },
    ...fields,
  };
}

function baza(expenses: Row[]) {
  return memoryClient({
    tenants: [{ id: FIRMA, nip: '1234567890', name: 'Firma A', address_json: null }],
    invoices: [],
    invoice_line_items: [],
    expenses,
  });
}

async function vatModulu(expenses: Row[], periodStart: string, periodEnd: string) {
  // Ten sam odczyt i silnik co `czytajVat` (strona VAT i „Ten miesiąc”).
  const dane = await fetchInvoicesForExport(
    { tenantId: FIRMA, periodStart, periodEnd, direction: 'issued', includeCorrections: true, includeExpenses: true },
    baza(expenses) as never,
  );
  return vatMiesiaca({ sprzedaz: dane.issuedInvoices, koszty: dane.expenses }, 0);
}

describe('VAT w module księgowości: paragon z NIP ze zdjęcia', () => {
  it('styczeń 2027: VAT z paragonu z NIP nie jest naliczonym do odliczenia', async () => {
    const wynik = await vatModulu([wydatekOcr('e-1', '2027-01-15')], '2027-01-01', '2027-01-31');
    expect(wynik).toMatchObject({ ok: true, naliczonyGr: 0, liczbaZakupow: 0 });
  });

  it('grudzień 2026: odliczenie jak dotąd (23 zł)', async () => {
    const wynik = await vatModulu([wydatekOcr('e-1', '2026-12-31')], '2026-12-01', '2026-12-31');
    expect(wynik).toMatchObject({ ok: true, naliczonyGr: 2300, liczbaZakupow: 1 });
  });

  it('zwykła faktura ze zdjęcia z 2027 r. dalej daje odliczenie', async () => {
    const faktura = wydatekOcr('e-2', '2027-01-15', {
      document_number: 'FV/7/2027', ocr_extracted_data: { document_type: 'invoice' },
    });
    const wynik = await vatModulu([faktura], '2027-01-01', '2027-01-31');
    expect(wynik).toMatchObject({ ok: true, naliczonyGr: 2300, liczbaZakupow: 1 });
  });
});

describe('kafle „VAT do odliczenia” (getCosts) i PIT', () => {
  const supabase = (expenses: Row[]) => baza(expenses) as unknown as PageContext['supabase'];

  it('paragon z NIP z 2027 r.: VAT do odliczenia 0; koszt w PIT zostaje jak dotąd (netto)', async () => {
    const [entry] = await getCosts(supabase([wydatekOcr('e-1', '2027-01-15')]), FIRMA, { from: '2027-01-01', toExclusive: '2027-02-01' });
    expect(entry?.vatDeductible).toBe(0);
    // Do odpowiedzi księgowej (karta PR, „Do rozstrzygnięcia”) PIT bez zmian.
    expect(entry?.cost).toBe(100);
  });

  it('paragon z NIP z 31.12.2026: VAT do odliczenia 23 zł jak dotąd', async () => {
    const [entry] = await getCosts(supabase([wydatekOcr('e-1', '2026-12-31')]), FIRMA, { from: '2026-12-01', toExclusive: '2027-01-01' });
    expect(entry?.vatDeductible).toBe(23);
    expect(entry?.cost).toBe(100);
  });

  it('KPiR: koszt paragonu z NIP z 2027 r. dalej netto (przypięcie dzisiejszego PIT)', () => {
    expect(kpirCostAmount({ net_amount: 100, vat_amount: 23, vat_deductible_amount: 23, document_type: 'simplified_invoice' })).toBe(100);
    expect(kpirCostAmount({ net_amount: 100, vat_amount: 23, vat_deductible_amount: 23, document_type: 'invoice' })).toBe(100);
  });
});

type ExpenseRow = Database['public']['Tables']['expenses']['Row'];

function wydatekNaEkranie(issueDate: string, fields: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    ...(wydatekOcr('e-1', issueDate) as unknown as ExpenseRow),
    categorization_confidence: null,
    categorization_method: null,
    created_at: '2027-01-15T10:00:00Z',
    created_by: null,
    notes: null,
    ocr_job_id: 'job-1',
    source_file_mime: null,
    source_file_path: null,
    updated_at: '2027-01-15T10:00:00Z',
    vat_rate: '23',
    ...fields,
  };
}

const ekran = (expense: ExpenseRow) =>
  renderToStaticMarkup(<ExpenseEditForm expense={expense} photoUrl={null} ksefCurrency={null} />);

describe('przegląd kosztu: informacja o paragonie z NIP od 2027 r.', () => {
  it('paragon z NIP z 2027 r.: informacja i prośba o fakturę do paragonu', () => {
    const markup = ekran(wydatekNaEkranie('2027-01-15'));
    expect(markup).toContain('Od 1 stycznia 2027 r. paragon z NIP nie jest fakturą');
    expect(markup).toContain('VAT odliczysz tylko z faktury w KSeF, więc poproś sprzedawcę o fakturę do paragonu.');
    expect(markup).toContain('W kosztach podatku dochodowego paragon zostaje na razie tak jak dotąd');
  });

  it('bez informacji: paragon z NIP z 2026 r., paragon bez NIP, firma bez odliczenia VAT', () => {
    expect(ekran(wydatekNaEkranie('2026-12-31'))).not.toContain('paragon z NIP nie jest fakturą');
    expect(ekran(wydatekNaEkranie('2027-01-15', { document_type: 'receipt', ocr_extracted_data: { document_type: 'receipt' } })))
      .not.toContain('paragon z NIP nie jest fakturą');
    // Firma zwolniona z VAT (art. 113): OCR zapisuje 0 zł do odliczenia, więc nie ma czego tracić.
    expect(ekran(wydatekNaEkranie('2027-01-15', { vat_deductible_amount: 0 }))).not.toContain('paragon z NIP nie jest fakturą');
  });
});
