import { notFound } from 'next/navigation';

import { ZaplataKosztuKarta } from '@/components/expenses/do-zaplaty/zaplata-kosztu-karta';
import { ExpenseEditForm } from '@/components/expenses/expense-edit-form';
import { listaDoZaplaty, type WierszKosztuDoZaplaty } from '@/lib/expenses/do-zaplaty';
import { canChangeExpensePayment } from '@/lib/expenses/zaplata-kosztu';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { getPageContext } from '@/lib/supabase/page-context';
import { loadReceiptMatchView } from '@/lib/expenses/receipt-invoice-match-view';
import { createClient } from '@/lib/supabase/server';
import { getExpensePhotoUrl } from '@/lib/storage/expenses';
import { isTenantStoragePath } from '@/lib/storage/tenant-path';

import { ExpenseThread } from './_components/expense-thread';

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
  let ksefInvoice: { ksef_number: string | null; internal_number: string | null; currency: string | null } | null = null;
  if (expense.source === 'ksef_inbox' && expense.ksef_invoice_id) {
    const { data: invoice } = await supabase
      .from('invoices')
      .select('currency, ksef_number, internal_number')
      .eq('id', expense.ksef_invoice_id)
      .eq('tenant_id', expense.tenant_id)
      .maybeSingle();
    ksefCurrency = invoice?.currency ?? null;
    ksefInvoice = invoice ?? null;
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
    <>
      <ExpenseEditForm
        expense={expense}
        photoUrl={photoUrl}
        ksefCurrency={ksefCurrency}
        receiptMatch={receiptMatch}
        paymentSection={await paymentSection(expense, ksefInvoice)}
      />
      <ExpenseThread expenseId={expense.id} />
    </>
  );
}

/**
 * Krok 3.4: karta „Płatność”, gdy koszt ma termin, odczytane warunki z pliku
 * KSeF albo dzień zapłaty. Kolumny z 00177 dojdą do `types/database.ts` po
 * wgraniu migracji (typy z produkcji), stąd własny kształt wiersza.
 */
async function paymentSection(
  expense: object,
  faktura: WierszKosztuDoZaplaty['faktura'],
) {
  const row = { ...(expense as Omit<WierszKosztuDoZaplaty, 'faktura'>), faktura };
  if (!row.paid_at && !row.payment_due_date && !row.payment_terms) return null;
  const { role } = await getPageContext();
  const dzis = todayInWarsaw();
  const [koszt] = listaDoZaplaty([row], dzis).pozycje;
  return (
    <ZaplataKosztuKarta
      expenseId={row.id}
      zaplaconoDnia={row.paid_at ?? null}
      koszt={koszt ?? null}
      termin={row.payment_due_date ?? null}
      dzis={dzis}
      mozeOznaczac={canChangeExpensePayment(role)}
    />
  );
}
