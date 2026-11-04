/**
 * Read-side query helpers dla subskrypcji (Faza 25).
 *
 * Source-of-truth dla statusu = nasza tabela `subscriptions` (lokalne mirror
 * Stripe webhook'ami). Zaleta: read latency < 50ms (vs hit do Stripe API),
 * RLS chroni przed cross-tenant leakami.
 *
 * Webhook handler (Krok 3) odpowiada za świeżość — `last_webhook_at` mówi
 * "data ostatniej synchronizacji".
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { createAdminClient } from '@/lib/supabase/admin';
import type { Database } from '@/types/database';

/**
 * Lokalny typ — `subscriptions` tabela powstaje w migracji 00045 i nie jest
 * jeszcze w `types/database.ts` (pre-regeneracja). Po `supabase gen types`
 * można zastąpić tym z `Database['public']['Tables']['subscriptions']['Row']`.
 */
export interface ActiveSubscription {
  id: string;
  tenant_id: string;
  stripe_subscription_id: string;
  stripe_customer_id: string;
  stripe_price_id: string;
  status:
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'incomplete'
    | 'incomplete_expired'
    | 'unpaid'
    | 'paused';
  plan: 'monthly' | 'annual';
  current_period_start: string | null;
  current_period_end: string | null;
  trial_start: string | null;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  last_webhook_at: string | null;
}

/**
 * Zwraca subscription dla tenanta, jeśli istnieje. Filtruje pominięte
 * `canceled`/`incomplete_expired` — partial UNIQUE index w DB to wymusza,
 * ale dla pewności jest dodatkowy filter.
 *
 * `supabase` opcjonalne — domyślnie admin client (do użycia w server actions
 * gdzie i tak mamy zwalidowany tenantId). Dla SC z user-context daj swojego
 * RLS-aware klienta.
 */
export async function getActiveSubscription(
  tenantId: string,
  supabase?: SupabaseClient<Database>,
): Promise<ActiveSubscription | null> {
  const client = supabase ?? createAdminClient();

  // Cast — tabela `subscriptions` powstaje w 00045, typed gen jeszcze nie
  // regenerowany. Bezpieczne: query jest ściśle typowany przez wynik (`select`
  // string match'uje runtime, columns istnieją w schema).
  const result = (await (
    client as unknown as {
      from: (name: string) => {
        select: (cols: string) => {
          eq: (col: string, val: string) => {
            not: (col: string, op: string, val: string) => {
              order: (col: string, opts: { ascending: boolean }) => {
                limit: (n: number) => {
                  maybeSingle: () => Promise<{
                    data: ActiveSubscription | null;
                    error: { message: string } | null;
                  }>;
                };
              };
            };
          };
        };
      };
    }
  )
    .from('subscriptions')
    .select(
      'id, tenant_id, stripe_subscription_id, stripe_customer_id, stripe_price_id, status, plan, current_period_start, current_period_end, trial_start, trial_end, cancel_at_period_end, canceled_at, last_webhook_at',
    )
    .eq('tenant_id', tenantId)
    .not('status', 'in', '(canceled,incomplete_expired)')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle());

  if (result.error) {
    throw new Error(`subscription lookup failed: ${result.error.message}`);
  }

  return result.data ?? null;
}

/**
 * Przyczyna ostatniej nieudanej płatności firmy (`stripe_payments.failure_reason`):
 * kod odmowy Stripe, który `paymentFailureAdvice` zamienia na tekst dla klienta.
 */
export async function getLatestPaymentFailureReason(
  tenantId: string,
): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from('stripe_payments')
    .select('failure_reason')
    .eq('tenant_id', tenantId)
    .eq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`payment failure lookup failed: ${error.message}`);
  return data?.failure_reason ?? null;
}

/** Czy subskrypcja jest w trakcie 30-dniowego trialu. */
export function isInTrial(sub: ActiveSubscription | null): boolean {
  if (!sub) return false;
  if (sub.status !== 'trialing') return false;
  if (!sub.trial_end) return false;
  return new Date(sub.trial_end).getTime() > Date.now();
}

/** Days remaining w trialu (zaokrąglone w dół). Null gdy nie w trialu. */
export function trialDaysRemaining(
  sub: ActiveSubscription | null,
): number | null {
  if (!isInTrial(sub) || !sub?.trial_end) return null;
  const ms = new Date(sub.trial_end).getTime() - Date.now();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}
