/**
 * Stan połączenia faktury do paragonu z paragonem z NIP dla strony kosztu
 * (`/expenses/[id]`, krok 1.3 planu kompletnej aplikacji, migracja 00175).
 * Odczyt klientem z sesji (RLS: tylko aktywna firma). Błąd odczytu to brak
 * informacji, a nie błąd strony: koszt dalej da się przejrzeć.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database';

export interface ReceiptMatchDoc {
  expenseId: string;
  number: string | null;
  issueDate: string;
  gross: number;
}

export interface ReceiptMatchView {
  /** Ten koszt to faktura do paragonu (`invoice`) albo paragon z NIP (`receipt`). */
  role: 'invoice' | 'receipt';
  /** `linked`: koszt liczy się z faktury; `candidates`: możliwy podwójny koszt do decyzji. */
  state: 'linked' | 'candidates';
  /** Koszt faktury, przy którym zapada decyzja (przy paragonie `null`: decyzja na stronie faktury). */
  invoiceExpenseId: string | null;
  /** Dokumenty z drugiej strony połączenia. */
  docs: ReceiptMatchDoc[];
}

type MatchRow = { invoice_expense_id: string; receipt_expense_id: string; status: string };

const OPEN = ['linked', 'candidate'];

export async function loadReceiptMatchView(
  supabase: SupabaseClient<Database>,
  tenantId: string,
  expenseId: string,
): Promise<ReceiptMatchView | null> {
  const [asInvoice, asReceipt] = await Promise.all([
    supabase.from('expense_receipt_matches').select('invoice_expense_id, receipt_expense_id, status')
      .eq('tenant_id', tenantId).eq('invoice_expense_id', expenseId).in('status', OPEN),
    supabase.from('expense_receipt_matches').select('invoice_expense_id, receipt_expense_id, status')
      .eq('tenant_id', tenantId).eq('receipt_expense_id', expenseId).in('status', OPEN),
  ]);
  if (asInvoice.error || asReceipt.error) {
    console.error('[expenses] odczyt połączenia faktury do paragonu', asInvoice.error ?? asReceipt.error);
    return null;
  }

  const invoiceRows = (asInvoice.data ?? []) as MatchRow[];
  const receiptRows = (asReceipt.data ?? []) as MatchRow[];
  const role: ReceiptMatchView['role'] | null = invoiceRows.length ? 'invoice' : receiptRows.length ? 'receipt' : null;
  if (!role) return null;
  const rows = role === 'invoice' ? invoiceRows : receiptRows;
  const linked = rows.find((r) => r.status === 'linked');
  const other = (r: MatchRow) => (role === 'invoice' ? r.receipt_expense_id : r.invoice_expense_id);
  const ids = linked ? [other(linked)] : rows.map(other);

  const { data, error } = await supabase
    .from('expenses')
    .select('id, document_number, issue_date, gross_amount')
    .eq('tenant_id', tenantId)
    .in('id', ids);
  if (error) {
    console.error('[expenses] odczyt dokumentów połączenia faktury do paragonu', error);
    return null;
  }
  const docs = (data ?? [])
    .map((d) => ({
      expenseId: d.id,
      number: d.document_number?.trim() || null,
      issueDate: d.issue_date,
      gross: Number(d.gross_amount ?? 0),
    }))
    .sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.expenseId.localeCompare(b.expenseId));
  return {
    role,
    state: linked ? 'linked' : 'candidates',
    invoiceExpenseId: role === 'invoice' ? expenseId : null,
    docs,
  };
}
