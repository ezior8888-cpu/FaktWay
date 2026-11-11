import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '@/types/database';

import { memoryClient, type Row } from './helpers/baza-w-pamieci';

/**
 * Krok 1.3 (00175), ekran: ostrzeżenie o możliwym podwójnym koszcie na obu
 * dokumentach (faktura do paragonu i paragon z NIP), decyzja na stronie
 * faktury, dopisek w Skrzynce KSeF. Odczyt stanu z bazy w pamięci tą samą
 * funkcją co strona `/expenses/[id]` (`loadReceiptMatchView`).
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/app/actions/expenses', () => ({ deleteExpenseAction: vi.fn(), reviewExpenseAction: vi.fn() }));
vi.mock('@/app/actions/receipt-invoice-match', () => ({ decideReceiptMatchAction: vi.fn() }));

const { ExpenseEditForm } = await import('@/components/expenses/expense-edit-form');
const { loadReceiptMatchView } = await import('@/lib/expenses/receipt-invoice-match-view');
const { buildInboxRows, loadInboxReceiptMatches } = await import('@/app/(dashboard)/(koszty)/inbox/_components/inbox-rows');
const { InboxTable, RECEIPT_DOUBLE_COST_NOTE } = await import('@/app/(dashboard)/(koszty)/inbox/_components/inbox-table');

type ExpenseRow = Database['public']['Tables']['expenses']['Row'];
const TENANT = 'firma-a';

function wydatek(id: string, fields: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id, tenant_id: TENANT, created_by: null, source: 'ocr_photo', ksef_invoice_id: null,
    is_deductible: true, is_reviewed: true, issue_date: '2027-01-20',
    document_number: 'PAR 4711', document_type: 'invoice',
    seller_name: 'Sklep Przykład', seller_nip: '5260001246', seller_address: null,
    net_amount: 100, vat_amount: 23, gross_amount: 123, vat_deductible_amount: 23, vat_rate: '23',
    kpir_column: 'col_13', category_label: 'Materiały biurowe',
    ocr_extracted_data: { document_type: 'simplified_invoice' },
    categorization_confidence: null, categorization_method: null, notes: null, ocr_job_id: null,
    source_file_mime: null, source_file_path: null,
    created_at: '2027-02-05T10:00:00Z', updated_at: '2027-02-05T10:00:00Z',
    ...fields,
  } as ExpenseRow;
}

const FP = wydatek('fp-1', {
  source: 'ksef_inbox', ksef_invoice_id: 'inv-fp', document_number: 'FP/1/02/2027', issue_date: '2027-02-05',
  ocr_extracted_data: null, is_reviewed: false,
});

function baza(matches: Row[], expenses: ExpenseRow[] = [FP, wydatek('par-1'), wydatek('par-2', { document_number: 'PAR 4712', issue_date: '2027-02-01' })]) {
  return memoryClient({ expenses: expenses as unknown as Row[], expense_receipt_matches: matches }) as never;
}

const m = (receipt: string, status: string): Row => ({ tenant_id: TENANT, invoice_expense_id: 'fp-1', receipt_expense_id: receipt, status });

async function ekran(expense: ExpenseRow, matches: Row[]) {
  const receiptMatch = await loadReceiptMatchView(baza(matches), TENANT, expense.id);
  return renderToStaticMarkup(<ExpenseEditForm expense={expense} photoUrl={null} ksefCurrency="PLN" receiptMatch={receiptMatch} />);
}

describe('strona kosztu: faktura do paragonu i paragon z NIP', () => {
  it('kilku kandydatów: na fakturze ostrzeżenie, oba paragony i decyzja', async () => {
    const markup = await ekran(FP, [m('par-1', 'candidate'), m('par-2', 'candidate')]);
    expect(markup).toContain('Możliwy podwójny koszt');
    expect(markup).toContain('Paragon PAR 4711 z 20.01.2027, 123,00 zł');
    expect(markup).toContain('Paragon PAR 4712 z 01.02.2027, 123,00 zł');
    expect(markup.match(/To ten paragon/g)).toHaveLength(2);
    expect(markup).toContain('To osobne koszty');
  });

  it('kandydat: na paragonie to samo ostrzeżenie z odesłaniem do faktury, bez przycisków decyzji', async () => {
    const markup = await ekran(wydatek('par-1'), [m('par-1', 'candidate'), m('par-2', 'candidate')]);
    expect(markup).toContain('Możliwy podwójny koszt');
    expect(markup).toContain('Faktura do paragonu FP/1/02/2027 z 05.02.2027, 123,00 zł');
    expect(markup).toContain('href="/expenses/fp-1"');
    expect(markup).not.toContain('To ten paragon');
  });

  it('połączony paragon: informacja, bez prośby o fakturę do paragonu, KPiR wyłączone na stałe', async () => {
    const receipt = wydatek('par-1', { is_deductible: false });
    const markup = await ekran(receipt, [m('par-1', 'linked'), m('par-2', 'dismissed')]);
    expect(markup).toContain('Paragon zastąpiony fakturą do paragonu');
    expect(markup).not.toContain('paragon z NIP nie jest fakturą');
    // Pole „Uwzględnij w KPiR” wyłączone (etykieta jak przy innych blokadach przełącznika).
    expect(markup).toContain('cursor-not-allowed opacity-50');
    expect(await ekran(wydatek('par-1'), [])).not.toContain('cursor-not-allowed opacity-50');
  });

  it('połączona faktura: informacja i rozłączenie', async () => {
    const markup = await ekran(FP, [m('par-1', 'linked')]);
    expect(markup).toContain('Faktura do paragonu połączona z paragonem');
    expect(markup).toContain('Rozłącz dokumenty');
  });

  it('po decyzji „to osobne koszty” i bez dopasowania: bez ostrzeżenia', async () => {
    expect(await ekran(FP, [m('par-1', 'dismissed')])).not.toContain('Możliwy podwójny koszt');
    expect(await ekran(wydatek('par-9'), [])).not.toContain('Możliwy podwójny koszt');
  });
});

describe('Skrzynka KSeF: dopisek przy fakturze do decyzji', () => {
  const invoice = (id: string) => ({
    id, internal_number: 'FP/1/02/2027', ksef_number: `ksef-${id}`, issue_date: '2027-02-05', seller_nip: '5260001246',
    seller_data: { name: 'Sklep Przykład', nip: '5260001246' }, fa3_data: {}, gross_total: 123, currency: 'PLN',
    ksef_accepted_at: '2027-02-05T10:00:00Z', origin: 'ksef_inbox',
  });

  it('kandydaci: „Możliwy podwójny koszt” w tabeli i w karcie; połączona: bez dopisku', async () => {
    const matches = await loadInboxReceiptMatches(
      baza([m('par-1', 'candidate'), { ...m('par-2', 'linked'), invoice_expense_id: 'fp-2' }]) as never,
      TENANT,
      ['fp-1', 'fp-2'],
    );
    expect(matches).toEqual(new Map([['fp-1', 'candidates'], ['fp-2', 'linked']]));
    const rows = buildInboxRows(
      [invoice('inv-1'), invoice('inv-2')],
      [{ id: 'fp-1', ksef_invoice_id: 'inv-1', is_reviewed: false }, { id: 'fp-2', ksef_invoice_id: 'inv-2', is_reviewed: true }],
      matches,
    );
    expect(rows.map((r) => r.receiptMatch)).toEqual(['candidates', 'linked']);
    const markup = renderToStaticMarkup(<InboxTable rows={rows} />);
    expect(markup.split(RECEIPT_DOUBLE_COST_NOTE)).toHaveLength(3);
  });
});
