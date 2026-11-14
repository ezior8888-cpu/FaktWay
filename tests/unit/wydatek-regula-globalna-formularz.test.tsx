import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Ustalenie 738u1 (obchód M9, 14.11.2026), drugie wystąpienie: formularz
 * kosztu pokazywał ramkę „Auto-kategoryzacja” (wykryta kategoria, pewność,
 * „sprawdź kategorię”) tylko dla czterech metod klasyfikatora. Koszt
 * dopasowany regułą globalną (Stacja, Orlen, Hotel... albo NIP z listy) do
 * 00205 nie mógł powstać, a po 00205 dostałby kategorię bez słowa, że
 * ustawiła ją reguła.
 *
 * Prawdziwy: `ExpenseEditForm`. Zastąpione: akcje serwera, router i toast.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/app/actions/expenses', () => ({
  deleteExpenseAction: vi.fn(),
  reviewExpenseAction: vi.fn(),
  uploadExpensePhotoAction: vi.fn(),
  getOcrJobStatusAction: vi.fn(),
}));

import { ExpenseEditForm } from '@/components/expenses/expense-edit-form';
import type { ExpenseRow } from '@/components/expenses/expenses-list';

type Method = ExpenseRow['categorization_method'];

function expense(method: Method): ExpenseRow {
  return {
    id: 'e-1',
    tenant_id: 'firma-a',
    paid_at: null,
    payment_account: null,
    payment_due_date: null,
    payment_split: null,
    payment_terms: null,
    categorization_confidence: 0.88,
    categorization_method: method,
    category_label: 'Paliwo',
    created_at: '2026-11-10T10:00:00Z',
    created_by: null,
    document_number: 'P/2026/11',
    document_type: 'receipt',
    gross_amount: 200,
    is_deductible: true,
    is_reviewed: false,
    issue_date: '2026-11-10',
    kpir_column: 'col_13',
    ksef_invoice_id: null,
    net_amount: 162.6,
    notes: null,
    ocr_extracted_data: null,
    ocr_job_id: 'job-1',
    seller_address: null,
    seller_name: 'Stacja Paliw Testowa',
    seller_nip: null,
    source: 'ocr_photo',
    source_file_mime: null,
    source_file_path: null,
    updated_at: '2026-11-10T10:00:00Z',
    vat_amount: 37.4,
    vat_deductible_amount: 37.4,
    vat_rate: '23',
  } as ExpenseRow;
}

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe('formularz kosztu: kategoria z reguły globalnej', () => {
  it.each(['rule_global_keyword', 'rule_global_nip'] as const)('metoda %s pokazuje ramkę „Auto-kategoryzacja”', (method) => {
    const markup = html(<ExpenseEditForm expense={expense(method)} photoUrl={null} ksefCurrency={null} />);

    expect(markup).toContain('Auto-kategoryzacja');
    expect(markup).toContain('Paliwo');
    expect(markup).toContain('Pewność: 88%');
  });

  it('kategoria wpisana ręcznie nie udaje automatu', () => {
    const markup = html(<ExpenseEditForm expense={expense('manual')} photoUrl={null} ksefCurrency={null} />);

    expect(markup).not.toContain('Auto-kategoryzacja');
  });
});
