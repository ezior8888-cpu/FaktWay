'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isPublicApiEnabled } from '@/lib/api/v1/availability';
import { requireCodeForAccessGrant } from '@/lib/auth/access-grant-mfa';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';
import { resolveHost } from '@/lib/webhooks/network';
import { encryptWebhookSecret, generateWebhookSecret, webhookSecretsConfigured } from '@/lib/webhooks/secret-box';
import { canonicalEvents, MAX_WEBHOOKS, webhookCreateSchema } from '@/lib/webhooks/types';
import { checkWebhookUrl, resolvePublicTarget } from '@/lib/webhooks/url-guard';

/**
 * Webhooki firmy w Ustawieniach → API (krok 7.1 planu kompletnej aplikacji,
 * część 3, 00187). Właściciel albo administrator, jak klucze API.
 *
 * Dodanie wymaga kodu 2FA, gdy konto go ma: webhook wysyła dane firmy na
 * adres z zewnątrz, jak link dla księgowej albo klucz API. Adres sprawdzamy
 * przed zapisem (https, port 443, nazwa domeny, DNS bez adresów prywatnych
 * i zastrzeżonych); worker sprawdza go jeszcze raz przy każdej wysyłce.
 * Sekret podpisu wraca tylko w odpowiedzi tej akcji; do bazy trafia
 * szyfrogram (`lib/webhooks/secret-box.ts`). Zapis klientem z sesji: RLS
 * i granty z 00187 pilnują roli, firmy i kolumn, a wyzwalacz zapisuje zmianę
 * w `audit_logs` w tej samej transakcji.
 */

export type CreateWebhookResult =
  | { success: true; id: string; signingSecret: string }
  /** `mfaStepUp`: sesja po biometrii, konto ma 2FA. Formularz pokazuje przejście na ekran kodu. */
  | { success: false; error: string; mfaStepUp?: true };

export type WebhookActionResult = { success: true } | { success: false; error: string };

const NOT_AVAILABLE = 'Webhooki nie są jeszcze dostępne.';
const SAVE_FAILED = 'Nie udało się dodać webhooka. Spróbuj ponownie za chwilę.';
const NOT_FOUND = 'Nie znaleziono webhooka w tej firmie.';

async function managerContext() {
  try {
    return { ok: true as const, ctx: await requireOrgRole(['owner', 'admin']) };
  } catch (error) {
    if (error instanceof ActionAuthError) return { ok: false as const, error: error.message };
    throw error;
  }
}

/** Dane z przeglądarki są niezaufane: typ luźny, sprawdza je `webhookCreateSchema`. */
export async function createWebhookAction(input: { url: string; events: readonly string[] }): Promise<CreateWebhookResult> {
  const parsed = webhookCreateSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Niepoprawne dane webhooka.' };
  }
  if (!(await isPublicApiEnabled())) return { success: false, error: NOT_AVAILABLE };
  // Bez klucza szyfrowania sekretu nie zapiszemy (a jawnie nie zapisujemy nigdy).
  if (!webhookSecretsConfigured()) {
    console.error('[webhooks] brak WEBHOOK_SECRETS_ENCRYPTION_KEY: dodawanie webhooków odmawia');
    return { success: false, error: NOT_AVAILABLE };
  }

  const auth = await managerContext();
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase, tenantId, user } = auth.ctx;

  const stepUp = await requireCodeForAccessGrant(supabase, user.id, 'Dodanie webhooka');
  if (stepUp) return stepUp;

  const url = checkWebhookUrl(parsed.data.url);
  if (!url.ok) return { success: false, error: url.message };
  const target = await resolvePublicTarget(url.hostname, resolveHost);
  if (!target.ok) {
    return {
      success: false,
      error: target.reason === 'dns'
        ? `Nie znaleźliśmy adresu ${url.hostname} w DNS. Sprawdź nazwę domeny i spróbuj ponownie.`
        : `Nazwa ${url.hostname} wskazuje adres prywatny albo zastrzeżony. Webhook musi trafiać na serwer dostępny z internetu.`,
    };
  }

  const { count, error: countError } = await supabase
    .from('webhook_endpoints')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);
  if (countError) return { success: false, error: SAVE_FAILED };
  if ((count ?? 0) >= MAX_WEBHOOKS) {
    return {
      success: false,
      error: `Firma może mieć najwyżej ${MAX_WEBHOOKS} webhooków. Usuń webhook, którego już nie używasz.`,
    };
  }

  // Identyfikator z aplikacji: wiąże szyfrogram z wierszem (AAD) przed zapisem.
  const id = randomUUID();
  const signingSecret = generateWebhookSecret();
  let secretCiphertext: string;
  try {
    secretCiphertext = encryptWebhookSecret(signingSecret, { tenantId, webhookId: id });
  } catch {
    return { success: false, error: NOT_AVAILABLE };
  }

  const { data, error } = await supabase
    .from('webhook_endpoints')
    .insert({
      id,
      tenant_id: tenantId,
      url: url.href,
      events: canonicalEvents(parsed.data.events),
      secret_ciphertext: secretCiphertext,
    })
    .select('id')
    .single();
  if (error || !data) {
    if (error?.message?.includes('webhook_limit')) {
      return { success: false, error: `Firma może mieć najwyżej ${MAX_WEBHOOKS} webhooków. Usuń webhook, którego już nie używasz.` };
    }
    return { success: false, error: SAVE_FAILED };
  }

  revalidatePath('/settings/api');
  return { success: true, id, signingSecret };
}

export async function deleteWebhookAction(webhookId: string): Promise<WebhookActionResult> {
  if (!z.uuid().safeParse(webhookId).success) return { success: false, error: NOT_FOUND };
  const auth = await managerContext();
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase, tenantId } = auth.ctx;

  // Dziennik dostaw tego webhooka znika razem z nim (ON DELETE CASCADE); wpis
  // `webhook.deleted` w `audit_logs` dopisuje wyzwalacz.
  const { data, error } = await supabase
    .from('webhook_endpoints')
    .delete()
    .eq('id', webhookId)
    .eq('tenant_id', tenantId)
    .select('id');
  if (error) return { success: false, error: 'Nie udało się usunąć webhooka. Spróbuj ponownie za chwilę.' };
  if (!data || data.length === 0) return { success: false, error: NOT_FOUND };

  revalidatePath('/settings/api');
  return { success: true };
}

/**
 * Ponowne włączenie webhooka wyłączonego po 20 nieudanych dostawach z rzędu.
 * Bez kodu: adres zatwierdzono kodem przy dodaniu, a włączenie go nie zmienia.
 * Licznik porażek zeruje baza (wyzwalacz `guard_webhook_endpoint`).
 */
export async function enableWebhookAction(webhookId: string): Promise<WebhookActionResult> {
  if (!z.uuid().safeParse(webhookId).success) return { success: false, error: NOT_FOUND };
  if (!(await isPublicApiEnabled())) return { success: false, error: NOT_AVAILABLE };
  const auth = await managerContext();
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase, tenantId } = auth.ctx;

  const { data, error } = await supabase
    .from('webhook_endpoints')
    .update({ disabled_at: null })
    .eq('id', webhookId)
    .eq('tenant_id', tenantId)
    .not('disabled_at', 'is', null)
    .select('id');
  if (error) return { success: false, error: 'Nie udało się włączyć webhooka. Spróbuj ponownie za chwilę.' };
  if (!data || data.length === 0) return { success: false, error: 'Nie znaleziono wyłączonego webhooka w tej firmie.' };

  revalidatePath('/settings/api');
  return { success: true };
}
