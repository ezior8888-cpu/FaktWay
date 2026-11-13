'use server';

import { requestInboxCheck, type InboxCheckResult } from '@/lib/ksef/inbox-check';
import { ActionAuthError, requireUserAndActiveOrg } from '@/lib/supabase/auth-context';

/**
 * Przycisk „Sprawdź teraz” w Skrzynce KSeF: przyspiesza termin firmy, najwyżej
 * raz na 5 minut. Faktury pobiera worker, więc odpowiedź mówi tylko, że sprawdzamy.
 * Członkostwo sprawdza `requireUserAndActiveOrg`, RPC jest tylko dla serwera.
 * Termin i zdania: `lib/ksef/inbox-check.ts` (te same dla telefonu).
 */
export async function requestInboxCheckAction(): Promise<InboxCheckResult> {
  let tenantId: string;
  try {
    ({ tenantId } = await requireUserAndActiveOrg());
  } catch (error) {
    if (error instanceof ActionAuthError) return { status: 'error', message: error.message };
    throw error;
  }
  return requestInboxCheck(tenantId);
}
