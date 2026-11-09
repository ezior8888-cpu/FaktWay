'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isPublicApiEnabled } from '@/lib/api/v1/availability';
import { generateApiKey } from '@/lib/api/v1/keys';
import { apiKeyCreateSchema, canonicalScopes, MAX_ACTIVE_API_KEYS } from '@/lib/api/v1/scopes';
import { requireCodeForAccessGrant } from '@/lib/auth/access-grant-mfa';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

/**
 * Klucze API firmy w Ustawieniach (krok 7.1 planu kompletnej aplikacji, 00181).
 *
 * Właściciel albo administrator. Utworzenie wymaga kodu 2FA, gdy konto go ma
 * (klucz daje programowi z zewnątrz dostęp do faktur, jak link dla księgowej).
 * Pełny klucz wraca tylko w odpowiedzi tej akcji; do bazy trafia skrót
 * i prefiks. Zapis klientem z sesji: RLS i granty z 00181 pilnują roli, firmy
 * i kolumn, a wyzwalacz zapisuje zmianę w `audit_logs` w tej samej transakcji.
 */

export type CreateApiKeyResult =
  | { success: true; id: string; key: string; prefix: string }
  /** `mfaStepUp`: sesja po biometrii, konto ma 2FA. Formularz pokazuje przejście na ekran kodu. */
  | { success: false; error: string; mfaStepUp?: true };

export type RevokeApiKeyResult = { success: true } | { success: false; error: string };

const NOT_AVAILABLE = 'Klucze API nie są jeszcze dostępne.';
const SAVE_FAILED = 'Nie udało się utworzyć klucza API. Spróbuj ponownie za chwilę.';
const REVOKE_FAILED = 'Nie udało się odwołać klucza API. Spróbuj ponownie za chwilę.';

async function managerContext() {
  try {
    return { ok: true as const, ctx: await requireOrgRole(['owner', 'admin']) };
  } catch (error) {
    if (error instanceof ActionAuthError) return { ok: false as const, error: error.message };
    throw error;
  }
}

/** Dane z przeglądarki są niezaufane: typ luźny, sprawdza je `apiKeyCreateSchema`. */
export async function createApiKeyAction(input: { name: string; scopes: readonly string[] }): Promise<CreateApiKeyResult> {
  const parsed = apiKeyCreateSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Niepoprawne dane klucza.' };
  }
  if (!(await isPublicApiEnabled())) return { success: false, error: NOT_AVAILABLE };

  const auth = await managerContext();
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase, tenantId, user } = auth.ctx;

  const stepUp = await requireCodeForAccessGrant(supabase, user.id, 'Utworzenie klucza API');
  if (stepUp) return stepUp;

  const { count, error: countError } = await supabase
    .from('api_keys')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .is('revoked_at', null);
  if (countError) return { success: false, error: SAVE_FAILED };
  if ((count ?? 0) >= MAX_ACTIVE_API_KEYS) {
    return {
      success: false,
      error: `Firma może mieć najwyżej ${MAX_ACTIVE_API_KEYS} aktywnych kluczy API. Odwołaj klucz, którego już nie używasz.`,
    };
  }

  const generated = generateApiKey();
  const { data, error } = await supabase
    .from('api_keys')
    .insert({
      tenant_id: tenantId,
      name: parsed.data.name,
      key_prefix: generated.prefix,
      key_hash: generated.hash,
      scopes: canonicalScopes(parsed.data.scopes),
    })
    .select('id')
    .single();
  if (error || !data) return { success: false, error: SAVE_FAILED };

  revalidatePath('/settings/api');
  return { success: true, id: String(data.id), key: generated.key, prefix: generated.prefix };
}

export async function revokeApiKeyAction(keyId: string): Promise<RevokeApiKeyResult> {
  if (!z.uuid().safeParse(keyId).success) return { success: false, error: 'Nie znaleziono klucza API.' };

  const auth = await managerContext();
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase, tenantId } = auth.ctx;

  // Czas odwołania i autora ustawia baza (wyzwalacz `guard_api_key`).
  const { data, error } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId)
    .eq('tenant_id', tenantId)
    .is('revoked_at', null)
    .select('id');
  if (error) return { success: false, error: REVOKE_FAILED };
  if (!data || data.length === 0) {
    return { success: false, error: 'Nie znaleziono aktywnego klucza API w tej firmie.' };
  }

  revalidatePath('/settings/api');
  return { success: true };
}
