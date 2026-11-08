'use server';

import { listRecurringTemplateCandidates, type RecurringTemplateCandidate } from '@/lib/invoices/recurring/queries';
import { ActionAuthError, requireUserAndActiveOrg } from '@/lib/supabase/auth-context';

/**
 * Wyszukiwarka faktury-wzoru w arkuszu „+ Nowa faktura cykliczna” (plan
 * Finora N1, P6). Lista startowa (50 najnowszych) idzie propsem ze strony;
 * ta akcja szuka starszych po fragmencie numeru. Klient z sesji (RLS) +
 * `tenant_id` aktywnej firmy; warunki wzoru te same co przy zapisie.
 * Nic nie zapisuje.
 */

export type SearchRecurringTemplatesResult =
  | { success: true; candidates: RecurringTemplateCandidate[] }
  | { success: false; error: string };

/** Fragment numeru: dłuższy nie ma sensu, a adres zapytania PostgREST ma limit. */
const MAX_QUERY_LENGTH = 40;

export async function searchRecurringTemplatesAction(query: string): Promise<SearchRecurringTemplatesResult> {
  let ctx;
  try {
    ctx = await requireUserAndActiveOrg();
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const numberQuery = typeof query === 'string' ? query.trim().slice(0, MAX_QUERY_LENGTH) : '';
  try {
    const candidates = await listRecurringTemplateCandidates(ctx.supabase, ctx.tenantId, {
      limit: 50,
      numberQuery,
    });
    return { success: true, candidates };
  } catch {
    return { success: false, error: 'Nie udało się wyszukać faktur. Spróbuj ponownie za chwilę.' };
  }
}
