import { notFound } from 'next/navigation';

import { ExpenseEditForm } from '@/components/expenses/expense-edit-form';
import { loadReceiptMatchView } from '@/lib/expenses/receipt-invoice-match-view';
import { createClient } from '@/lib/supabase/server';
import { getExpensePhotoUrl } from '@/lib/storage/expenses';
import { isTenantStoragePath } from '@/lib/storage/tenant-path';

export const dynamic = 'force-dynamic';

export default async function ExpenseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: expense, error } = await supabase
    .from('expenses')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error || !expense) notFound();

  let ksefCurrency: string | null = null;
  if (expense.source === 'ksef_inbox' && expense.ksef_invoice_id) {
    const { data: invoice } = await supabase
      .from('invoices')
      .select('currency')
      .eq('id', expense.ksef_invoice_id)
      .eq('tenant_id', expense.tenant_id)
      .maybeSingle();
    ksefCurrency = invoice?.currency ?? null;
  }

  // Krok 1.3 (00175): faktura do paragonu i paragon z NIP (ostrzeżenie albo połączenie).
  const receiptMatch = await loadReceiptMatchView(supabase, expense.tenant_id, expense.id);

  let photoUrl: string | null = null;
  if (
    expense.source === 'ocr_photo' &&
    expense.source_file_path &&
    isTenantStoragePath(expense.source_file_path, expense.tenant_id)
  ) {
    photoUrl = await getExpensePhotoUrl(expense.source_file_path, expense.tenant_id);
  }

  return (
    <ExpenseEditForm expense={expense} photoUrl={photoUrl} ksefCurrency={ksefCurrency} receiptMatch={receiptMatch} />
  );
}
