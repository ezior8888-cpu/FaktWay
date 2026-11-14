import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';


/**
 * Wstrzymanie i wznowienie przypomnień faktury, wspólne dla akcji strony
 * (`toggleInvoiceRemindersAction`) i API telefonu (`POST
 * /api/mobile/v1/faktury/{id}/wstrzymanie`, M10a). Logika przeniesiona z akcji
 * bez zmian. RPC sprawdza aktywną firmę jeszcze raz i zmienia fakturę razem
 * z zaplanowanymi przypomnieniami w jednej transakcji; bezpośredni zapis
 * klienta usunęła 00074. Ponowienie ustawia ten sam stan (idempotentne).
 */

export const REMINDER_PAUSE_INVALID = 'Nieprawidłowe dane przypomnienia.';
export const REMINDER_PAUSE_FAILED = 'Nie udało się zmienić stanu przypomnień. Spróbuj ponownie.';

export function reminderPauseInputRefusal(invoiceId: string, paused: boolean, reason?: string): { success: false; error: string } | null {
  if (!z.string().uuid().safeParse(invoiceId).success ||
      typeof paused !== 'boolean' ||
      (reason !== undefined && (typeof reason !== 'string' || reason.length > 500))) {
    return { success: false, error: REMINDER_PAUSE_INVALID };
  }
  return null;
}

/**
 * `supabase`: klient sesji klienta w jego aktywnej firmie (RLS); z ciasteczek
 * (strona) albo z tokenu (telefon), stąd sam `rpc`.
 */
export async function setInvoiceRemindersPaused(
  supabase: Pick<SupabaseClient, 'rpc'>,
  invoiceId: string,
  paused: boolean,
  reason?: string,
): Promise<{ success: boolean; error?: string }> {
  const invalid = reminderPauseInputRefusal(invoiceId, paused, reason);
  if (invalid) return invalid;
  const { data, error } = await supabase.rpc('set_invoice_reminders_paused', {
    p_invoice_id: invoiceId,
    p_paused: paused,
    p_reason: paused ? (reason ?? null) : null,
  });
  if (error || data !== true) {
    return { success: false, error: REMINDER_PAUSE_FAILED };
  }

  revalidatePath('/invoices/' + invoiceId);
  revalidatePath('/payments/overdue');
  return { success: true };
}
