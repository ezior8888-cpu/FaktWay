/**
 * Trial countdown cron (Faza 25 Krok 5).
 *
 * Codziennie o 09:00 Europe/Warsaw skanuje `subscriptions` w statusie
 * `trialing` i wysyła emaile gdy `trial_end - now()` mieści się w oknie:
 *   - 14 dni  → `trial_14d` notification
 *   - 7 dni   → `trial_7d`
 *   - 3 dni   → `trial_3d`
 *   - 1 dzień → `trial_1d`
 *
 * Idempotency: `billing_notifications` z UNIQUE(entity_id, kind). INSERT
 * przed wysyłką = duplikat się nie wpisze, więc kolejne dni nie wyślą
 * tego samego stage. Wpis „sent” zamyka stage; „failed”/„sending” (błąd
 * Resend, przerwany przebieg) wolno przejąć ponownie — do 02.10 zostawał
 * na zawsze i mail nie wychodził nigdy (AUD-87). Przed dublem przy
 * przejęciu chroni klucz idempotencji Resend (`trial/<sub>/<stage>`).
 *
 * Email recipient: właściciel pierwszej organizacji (owner role) — bierzemy
 * z `memberships` najwcześniejszego `joined_at` z `role='owner'`.
 */

import * as Sentry from '@sentry/nextjs';

import { PRICE_PER_MONTH_WITH_NET } from '@/lib/billing/pricing';
import { sendTrialEndingEmail } from '@/lib/email/send';
import { createAdminClient } from '@/lib/supabase/admin';

import type { JobContext } from '@/lib/jobs/registry';

interface TrialingSubscription {
  id: string;
  tenant_id: string;
  plan: 'monthly' | 'annual';
  trial_end: string | null;
  /** Anulowana w trialu — nie zostanie obciążona, mail by kłamał (AUD-75). */
  cancel_at_period_end?: boolean | null;
}

const PLAN_LABELS: Record<TrialingSubscription['plan'], { plan: string; price: string }> = {
  monthly: { plan: 'Miesięczny', price: PRICE_PER_MONTH_WITH_NET },
  // Plan roczny wycofany 1 października 2026 — etykieta dla starszych subskrypcji.
  annual: { plan: 'Roczny', price: 'według planu rocznego z Twojej subskrypcji' },
};

type Stage = { days: 14 | 7 | 3 | 1; kind: string; min: number; max: number };

// Stage'e w godzinach — gdy `trial_end - now()` mieści się w danym oknie,
// odpalamy odpowiedni stage. Okna 24-godzinne pozwalają wykryć stage
// niezależnie od godziny w której cron się uruchomił (zwykle 09:00 PL).
const STAGES: Stage[] = [
  { days: 14, kind: 'trial_14d', min: 13 * 24, max: 14 * 24 },
  { days: 7, kind: 'trial_7d', min: 6 * 24, max: 7 * 24 },
  { days: 3, kind: 'trial_3d', min: 2 * 24, max: 3 * 24 },
  { days: 1, kind: 'trial_1d', min: 0, max: 1 * 24 },
];

function pickStage(trialEnd: Date): Stage | null {
  const hoursLeft = (trialEnd.getTime() - Date.now()) / (60 * 60 * 1000);
  return STAGES.find((s) => hoursLeft >= s.min && hoursLeft < s.max) ?? null;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pl-PL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-b.ts
 */
export async function runTrialCountdownEmails({ step, logger }: JobContext) {
    const supabase = createAdminClient();

    // 1. Znajdź wszystkie trialing subscriptions z trial_end w ciągu 15 dni.
    const cutoffIso = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();

    const subscriptions = await step.run('find-trialing', async () => {
      const result = (await (supabase as unknown as {
        from: (n: string) => {
          select: (c: string) => {
            eq: (k: string, v: string) => {
              not: (k: string, op: string, v: string) => {
                lte: (k: string, v: string) => Promise<{
                  data: TrialingSubscription[] | null;
                  error: { message: string } | null;
                }>;
              };
            };
          };
        };
      })
        .from('subscriptions')
        .select('id, tenant_id, plan, trial_end, cancel_at_period_end')
        .eq('status', 'trialing')
        .not('trial_end', 'is', 'null')
        .lte('trial_end', cutoffIso));

      if (result.error) {
        throw new Error(`trialing lookup failed: ${result.error.message}`);
      }
      return result.data ?? [];
    });

    logger.info('trial-countdown scan', { count: subscriptions.length });

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    // Błędy wysyłki (nie odmowy z preferencji) — zadanie kończy się błędem,
    // żeby kolejka je ponowiła; wysłane wcześniej stage'e są już „sent”.
    let toRetry = 0;

    for (const sub of subscriptions) {
      if (!sub.trial_end) continue;
      // Mail mówi „pobierzemy płatność” — przy anulowanym trialu to nieprawda.
      if (sub.cancel_at_period_end) {
        skipped++;
        continue;
      }
      const stage = pickStage(new Date(sub.trial_end));
      if (!stage) {
        skipped++;
        continue;
      }

      // Per-subscription step — Inngest zapisuje state, więc retry tylko
      // tej iteracji bez powtarzania całego scanu.
      try {
        const dispatched = await step.run(`send-${sub.id}-${stage.kind}`, () =>
          dispatchTrialEmail(sub, stage),
        );
        if (dispatched === 'sent') sent++;
        else if (dispatched === 'duplicate') skipped++;
        else failed++;
      } catch (e) {
        failed++;
        toRetry++;
        Sentry.captureException(e, {
          tags: { area: 'billing.trial-countdown' },
          extra: { subscriptionId: sub.id, stage: stage.kind },
        });
      }
    }

    if (toRetry > 0) {
      throw new Error(`trial-countdown: ${toRetry} wysyłek do ponowienia`);
    }

    return { processed: subscriptions.length, sent, skipped, failed };
}

async function dispatchTrialEmail(
  sub: TrialingSubscription,
  stage: Stage,
): Promise<'sent' | 'duplicate' | 'failed'> {
  const supabase = createAdminClient();

  // 1. Resolve owner email z memberships.
  const { data: membership } = await supabase
    .from('memberships')
    .select('user_id')
    .eq('organization_id', sub.tenant_id)
    .eq('role', 'owner')
    .eq('status', 'active')
    .order('joined_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!membership) return 'failed';

  const { data: userData } = await supabase.auth.admin.getUserById(membership.user_id);
  const email = userData.user?.email;
  if (!email) return 'failed';

  // 2. Resolve tenant name.
  const { data: tenant } = await supabase
    .from('tenants')
    .select('name')
    .eq('id', sub.tenant_id)
    .maybeSingle();

  // 3. Idempotency claim: INSERT przed wysyłką. UNIQUE(entity_id, kind)
  //    zwróci 23505 przy duplikacie = dziś już wysłaliśmy ten stage.
  const claimRes = await supabase.from('billing_notifications').insert({
    tenant_id: sub.tenant_id,
    entity_id: sub.id,
    kind: stage.kind as 'trial_14d' | 'trial_7d' | 'trial_3d' | 'trial_1d',
    recipient_email: email,
    status: 'sending',
  });

  if (claimRes.error) {
    if (claimRes.error.code !== '23505') {
      throw new Error(`notification claim failed: ${claimRes.error.message}`);
    }
    // Wpis już jest. „sent” = stage zamknięty; nieudana albo przerwana
    // wysyłka — przejmujemy ją warunkowo (tylko z tych stanów).
    const { data: retaken, error: retakeError } = await supabase
      .from('billing_notifications')
      .update({ status: 'sending', recipient_email: email, error_message: null })
      .eq('entity_id', sub.id)
      .eq('kind', stage.kind)
      .in('status', ['failed', 'sending'])
      .select('id');
    if (retakeError) throw new Error(`notification retake failed: ${retakeError.message}`);
    if (!retaken || retaken.length === 0) return 'duplicate';
  }

  // 4. Wysyłka. Klucz zależy od stage'u, nie od próby — przejęcie wpisu
  //    „sending” po wysyłce, której odpowiedź zginęła, nie zdubluje maila.
  const labels = PLAN_LABELS[sub.plan];
  let result: Awaited<ReturnType<typeof sendTrialEndingEmail>>;
  try {
    result = await sendTrialEndingEmail(
      email,
      {
        tenantName: tenant?.name ?? email,
        daysRemaining: stage.days,
        trialEndDate: fmtDate(sub.trial_end!),
        planLabel: labels.plan,
        monthlyPriceLabel: labels.price,
      },
      { idempotencyKey: `trial/${sub.id}/${stage.kind}` },
    );
  } catch (e) {
    // Zdjęcie blokady: następna próba może przejąć wpis i wysłać.
    await supabase
      .from('billing_notifications')
      .update({ status: 'failed', error_message: 'send-error' })
      .eq('entity_id', sub.id)
      .eq('kind', stage.kind);
    throw e;
  }

  // 5. Update status.
  await supabase
    .from('billing_notifications')
    .update({
      status: result.sent ? 'sent' : 'failed',
      resend_message_id: result.messageId ?? null,
      error_message: result.sent ? null : result.reason ?? null,
    })
    .eq('entity_id', sub.id)
    .eq('kind', stage.kind);

  return result.sent ? 'sent' : 'failed';
}
