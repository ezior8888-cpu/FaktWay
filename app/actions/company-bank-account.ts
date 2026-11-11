'use server';

import { revalidatePath } from 'next/cache';

import { logAudit } from '@/lib/audit/log';
import { normalizujRachunekFirmy } from '@/lib/expenses/rachunek-firmy';
import { isMissingColumnError } from '@/lib/invoices/business-start';
import { createAdminClient } from '@/lib/supabase/admin';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

export type CompanyBankAccountResult = { success: true; rachunek: string | null } | { success: false; error: string };

/**
 * Ustawia (albo czyści: pusty tekst) rachunek firmy, z którego plik
 * przelewów zleca przelewy (krok 3.4, część 2; `tenants.bank_account`, 00183).
 * Tylko właściciel i administrator, jak dane firmy; zapis kluczem serwisowym
 * PO sprawdzeniu roli (wzór: `updateBusinessStartAction`), zmiana w audycie.
 */
export async function updateCompanyBankAccountAction(input: string | null): Promise<CompanyBankAccountResult> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return {
        success: false,
        error: e.message === 'Niewystarczające uprawnienia' ? 'Rachunek firmy zmienia właściciel albo administrator firmy.' : e.message,
      };
    }
    throw e;
  }

  let rachunek: string | null;
  try {
    rachunek = normalizujRachunekFirmy(input);
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Nieprawidłowy numer rachunku.' };
  }

  const admin = createAdminClient();
  const { data: before, error: readError } = await admin
    .from('tenants')
    .select('bank_account')
    .eq('id', ctx.tenantId)
    .maybeSingle();
  if (readError && !isMissingColumnError(readError.code)) {
    return { success: false, error: 'Nie udało się zapisać rachunku firmy. Spróbuj ponownie.' };
  }

  const { error } = await admin.from('tenants').update({ bank_account: rachunek }).eq('id', ctx.tenantId);
  if (error) {
    return {
      success: false,
      error: isMissingColumnError(error.code)
        ? 'Ta funkcja czeka jeszcze na aktualizację bazy danych. Spróbuj ponownie później.'
        : 'Nie udało się zapisać rachunku firmy.',
    };
  }

  const from = (before as { bank_account?: unknown } | null)?.bank_account;
  await logAudit({
    action: 'tenant.updated',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'tenant',
    entityId: ctx.tenantId,
    metadata: { field: 'bank_account', from: typeof from === 'string' ? from : null, to: rachunek },
  });

  revalidatePath('/settings');
  revalidatePath('/expenses');
  return { success: true, rachunek };
}
