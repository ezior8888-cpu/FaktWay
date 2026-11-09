'use server';

import { revalidatePath } from 'next/cache';

import { isUuid } from '@/lib/supabase/active-org';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireUserAndActiveOrg } from '@/lib/supabase/auth-context';

/**
 * Decyzja klienta o fakturze do paragonu i paragonie z NIP (krok 1.3, 00175):
 * `receiptExpenseId` to wybrany paragon („To ten paragon”), `null` to „To
 * osobne koszty” (odrzucenie kandydatów albo rozłączenie; paragon wraca do
 * KPiR z wartością sprzed połączenia). Jedyna droga zapisu: RPC tylko dla
 * service_role, które w bazie sprawdza członkostwo i firmę, a audyt zapisuje
 * w tej samej transakcji (wzór `review_ksef_expense`, 00127).
 */
export async function decideReceiptMatchAction(invoiceExpenseId: string, receiptExpenseId: string | null) {
  if (!isUuid(invoiceExpenseId) || (receiptExpenseId !== null && !isUuid(receiptExpenseId))) {
    return { success: false as const, error: 'Nieprawidłowe dane dokumentów' };
  }
  let auth;
  try {
    auth = await requireUserAndActiveOrg();
  } catch {
    return { success: false as const, error: 'Brak autoryzacji' };
  }
  const { user, tenantId } = auth;

  const { data, error } = await createAdminClient().rpc('decide_receipt_invoice_match', {
    p_tenant_id: tenantId,
    p_invoice_expense_id: invoiceExpenseId,
    p_actor_user_id: user.id,
    p_receipt_expense_id: receiptExpenseId,
  });
  if (error) {
    return { success: false as const, error: 'Nie udało się zapisać decyzji. Spróbuj ponownie za chwilę.' };
  }
  if (data !== 'linked' && data !== 'separated') {
    return { success: false as const, error: 'Dokumenty zmieniły się w międzyczasie. Odśwież stronę.' };
  }

  revalidatePath('/expenses');
  revalidatePath(`/expenses/${invoiceExpenseId}`);
  if (receiptExpenseId) revalidatePath(`/expenses/${receiptExpenseId}`);
  revalidatePath('/inbox');
  revalidatePath('/reports/kpir');
  return { success: true as const, result: data };
}
