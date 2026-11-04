'use server';

import { revalidatePath } from 'next/cache';

import { logAudit } from '@/lib/audit/log';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { isMissingColumnError, normalizeBusinessStart, readTenantBusinessStart } from '@/lib/invoices/business-start';
import { createAdminClient } from '@/lib/supabase/admin';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

export type BusinessStartResult =
  | { success: true; startedOn: string | null }
  | { success: false; error: string };

/**
 * Ustawia (albo czyści — `null`/pusty tekst) datę rozpoczęcia działalności.
 * Tylko właściciel i administrator; zapis przez klienta serwisowego PO
 * sprawdzeniu roli (jak zwolnienie z VAT). Data zmienia limit zwolnienia
 * z VAT na Pulpicie, więc zmiana trafia do dziennika audytu.
 */
export async function updateBusinessStartAction(input: string | null): Promise<BusinessStartResult> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }

  let startedOn: string | null;
  try {
    startedOn = normalizeBusinessStart(input, todayInWarsaw());
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Nieprawidłowa data rozpoczęcia działalności.' };
  }

  const admin = createAdminClient();
  let before: string | null;
  try {
    before = await readTenantBusinessStart(admin, ctx.tenantId);
  } catch {
    // Wyjątek poza kontraktem { success:false } przewróciłby /settings w error.tsx.
    return { success: false, error: 'Nie udało się zapisać daty rozpoczęcia działalności. Spróbuj ponownie.' };
  }

  const { error } = await admin
    .from('tenants')
    .update({ business_started_on: startedOn })
    .eq('id', ctx.tenantId);

  if (error) {
    return {
      success: false,
      error:
        isMissingColumnError(error.code)
          ? 'Ta funkcja czeka jeszcze na aktualizację bazy danych. Spróbuj ponownie później.'
          : 'Nie udało się zapisać daty rozpoczęcia działalności.',
    };
  }

  await logAudit({
    action: 'tenant.updated',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'tenant',
    entityId: ctx.tenantId,
    metadata: { field: 'business_started_on', from: before, to: startedOn },
  });

  revalidatePath('/settings');
  revalidatePath('/dashboard');
  return { success: true, startedOn };
}
