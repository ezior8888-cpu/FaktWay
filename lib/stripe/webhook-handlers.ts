/**
 * Stripe webhook event handlers (Faza 25 Krok 3).
 *
 * 6 krytycznych events:
 *   - customer.subscription.created → INSERT subscriptions
 *   - customer.subscription.updated → UPDATE (status, plan, period, cancel flag)
 *   - customer.subscription.deleted → status='canceled' + canceled_at
 *   - invoice.payment_succeeded   → INSERT stripe_payments + Inngest event
 *                                   (Krok 4 self-invoicing trigger)
 *   - invoice.payment_failed      → INSERT stripe_payments + Inngest dunning
 *   - customer.subscription.trial_will_end → audit (trial emails run from a cron)
 *
 * Odbiór zdarzenia używa atomowego claimu, a mirror subskrypcji
 * synchronizuje aktualny obiekt Stripe pod dzierżawą z fencingiem.
 */

import { sendJobEvent } from '@/lib/jobs/enqueue';
import type Stripe from 'stripe';

import { ANALYTICS_EVENTS } from '@/lib/analytics/events';
import {
  recordPaymentSucceeded,
  recordSubscriptionEnded,
  recordTrialStarted,
} from '@/lib/analytics/funnel';
import { trackServer } from '@/lib/analytics/server';
import { logAuditSystem } from '@/lib/audit/log-system';
import {
  billingPaymentFailed,
  billingPaymentSucceeded,
} from '@/lib/jobs/events';
import { createAdminClient } from '@/lib/supabase/admin';

import {
  mapInvoiceToPaymentRow,
} from './event-mapping';
import { verifyPaidInvoicePaymentReferences } from './payment-reference-proof';
import { syncCurrentStripeSubscription } from './subscription-sync';
import { RetryablePreEffectWebhookError } from './webhook-errors';

/**
 * Late invoice payment events must not reopen an already refunded payment.
 * The database trigger in 00075 also covers a race after this read.
 */
async function readStripePaymentStatus(
  supabase: ReturnType<typeof createAdminClient>,
  stripeInvoiceId: string,
  preEffect = false,
): Promise<string | null> {
  let result: { data: { status: string } | null; error: { message: string } | null };
  try {
    result = await supabase
      .from('stripe_payments')
      .select('status')
      .eq('stripe_invoice_id', stripeInvoiceId)
      .maybeSingle();
  } catch {
    if (preEffect) {
      throw new RetryablePreEffectWebhookError(
        'financial_object_lookup_failed',
        'Stripe payment status read failed before local effects',
      );
    }
    throw new Error('Stripe payment status read failed after a possible write');
  }
  const { data, error } = result;
  if (error) {
    if (preEffect) {
      throw new RetryablePreEffectWebhookError(
        'financial_object_lookup_failed',
        'Stripe payment status read failed before local effects',
      );
    }
    throw new Error('stripe payment status read failed: ' + error.message);
  }
  return data?.status ?? null;
}

function isRefundedPaymentStatus(status: string | null): boolean {
  return status === 'refunded' || status === 'partially_refunded';
}
// ─── 1. subscription.created / updated ────────────────────────────────

export async function handleSubscriptionUpserted(
  eventSnapshot: Stripe.Subscription,
  isCreate: boolean,
): Promise<void> {
  const { subscription, tenantId, status } =
    await syncCurrentStripeSubscription(eventSnapshot.id);

  // A delayed "created" event may arrive after cancellation. Record the
  // current state, but never announce a new active plan from stale payload.
  await logAuditSystem({
    action: 'billing.subscription.synced',
    tenantId,
    userId: null,
    entityType: 'subscription',
    entityId: subscription.id,
    metadata: {
      sourceEvent: isCreate ? 'created' : 'updated',
      status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      priceId: subscription.items.data[0]?.price.id ?? null,
    },
  });

  if (isCreate && status !== 'canceled' && status !== 'incomplete_expired') {
    await trackServer({
      tenantId,
      event: ANALYTICS_EVENTS.subscriptionCreated,
      properties: { status },
      setPersonProperties: { plan: status === 'trialing' ? 'trial' : 'active' },
      dedupeKey: subscription.id,
      timestamp: subscription.created ? new Date(subscription.created * 1000) : undefined,
    });
  }

  // Próba naprawdę się zaczęła, nawet gdy to opóźnione „created” po rezygnacji:
  // zdarzenie niesie chwilę ze Stripe, więc nie ogłasza niczego nowego.
  if (isCreate && status !== 'incomplete_expired') {
    await recordTrialStarted(tenantId, subscription);
  }
}

// ─── 2. subscription.deleted ──────────────────────────────────────────

export async function handleSubscriptionDeleted(
  eventSnapshot: Stripe.Subscription,
): Promise<void> {
  const { subscription, tenantId, status } =
    await syncCurrentStripeSubscription(eventSnapshot.id);

  if (status !== 'canceled') {
    // The current Stripe object and the terminal event disagree. The mirror
    // was updated from Stripe, but acknowledging the event needs review.
    throw new Error('Deleted subscription event does not match current Stripe state');
  }

  await logAuditSystem({
    action: 'billing.subscription.canceled',
    tenantId,
    userId: null,
    entityType: 'subscription',
    entityId: subscription.id,
    metadata: {
      canceledAt: subscription.canceled_at
        ? new Date(subscription.canceled_at * 1000).toISOString()
        : null,
    },
  });

  await recordSubscriptionEnded(tenantId, subscription);
}
// ─── 3. invoice.payment_succeeded ─────────────────────────────────────

export async function handleInvoicePaymentSucceeded(
  invoice: Stripe.Invoice,
): Promise<void> {
  const mapping = await mapInvoiceToPaymentRow(invoice, 'succeeded');
  if (!mapping) return;

  const signedPaidAt = mapping.row.paid_at;
  if (typeof signedPaidAt !== 'string' ||
      !Number.isFinite(Date.parse(signedPaidAt))) {
    throw new Error('Stripe paid invoice has no valid authoritative paid_at');
  }

  const supabase = createAdminClient();
  if (isRefundedPaymentStatus(await readStripePaymentStatus(supabase, invoice.id, true))) return;
  const proof = await verifyPaidInvoicePaymentReferences(invoice, {
    paymentIntentId: typeof mapping.row.stripe_payment_intent_id === 'string'
      ? mapping.row.stripe_payment_intent_id : null,
    chargeId: typeof mapping.row.stripe_charge_id === 'string'
      ? mapping.row.stripe_charge_id : null,
  });
  const verifiedRow = {
    ...mapping.row,
    stripe_payment_intent_id: proof.paymentIntentId,
    stripe_charge_id: proof.chargeId,
    stripe_payment_refs_verified: true,
  };
  // Cast — `stripe_payments` poza typed gen.
  const { data, error } = await (supabase as unknown as {
    from: (n: string) => {
      upsert: (
        row: Record<string, unknown>,
        opts: { onConflict: string },
      ) => {
        select: (c: string) => Promise<{
          data: Array<{ id: string; status: string; paid_at: string | null }> | null;
          error: { message: string } | null;
        }>;
      };
    };
  })
    .from('stripe_payments')
    .upsert(verifiedRow, { onConflict: 'stripe_invoice_id' })
    .select('id, status, paid_at');

  if (error) {
    throw new Error(`stripe_payments upsert failed: ${error.message}`);
  }

  const persistedPayment = data?.[0];
  if (!persistedPayment) {
    // A refund guard can suppress the upsert. Any other zero-row result leaves
    // the payment event unpersisted and must be retried.
    const currentStatus = await readStripePaymentStatus(supabase, invoice.id);
    if (isRefundedPaymentStatus(currentStatus)) return;
    throw new Error(`stripe payment success upsert affected no row: ${invoice.id}`);
  }
  if (isRefundedPaymentStatus(persistedPayment.status)) return;
  if (persistedPayment.status !== 'succeeded') {
    throw new Error(`stripe payment success not persisted: ${invoice.id}`);
  }
  const persistedPaidAt = persistedPayment.paid_at;
  if (!persistedPaidAt || !Number.isFinite(Date.parse(persistedPaidAt)) ||
      Date.parse(persistedPaidAt) !== Date.parse(signedPaidAt)) {
    throw new Error(`stripe payment paid_at not confirmed: ${invoice.id}`);
  }
  const paymentId = persistedPayment.id;

  await logAuditSystem({
    action: 'billing.payment.succeeded',
    tenantId: mapping.tenantId,
    userId: null,
    entityType: 'stripe_payment',
    entityId: paymentId,
    metadata: {
      stripeInvoiceId: invoice.id,
      amountCents: invoice.amount_paid,
      taxCents: ((invoice as unknown as { total_taxes?: Array<{ amount?: number | null }> | null }).total_taxes ?? []).reduce((s, t) => s + (t.amount ?? 0), 0),
      currency: invoice.currency,
    },
  });

  // Inngest event — uruchamia self-invoicing przez KSeF (Krok 4).
  await sendJobEvent({
    // Grupa per tenant — jedna faktura własna naraz (parytet z Inngest).
    groupId: mapping.tenantId,
    ...billingPaymentSucceeded.create({
      tenantId: mapping.tenantId,
      paymentId,
      stripeInvoiceId: invoice.id ?? '',
      amountCents: invoice.amount_paid,
      taxCents: ((invoice as unknown as { total_taxes?: Array<{ amount?: number | null }> | null }).total_taxes ?? []).reduce((s, t) => s + (t.amount ?? 0), 0),
      currency: (invoice.currency ?? 'pln').toLowerCase(),
      paidAt: persistedPaidAt,
    }),
  });

  await recordPaymentSucceeded({
    tenantId: mapping.tenantId,
    stripeInvoiceId: invoice.id ?? paymentId,
    amountPaidCents: invoice.amount_paid,
    paidAt: persistedPaidAt,
  });
}

// ─── 4. invoice.payment_failed ────────────────────────────────────────

export async function handleInvoicePaymentFailed(
  invoice: Stripe.Invoice,
): Promise<void> {
  const mapping = await mapInvoiceToPaymentRow(invoice, 'failed');
  if (!mapping) return;

  const supabase = createAdminClient();
  const existingStatus = await readStripePaymentStatus(supabase, invoice.id, true);
  if (existingStatus === 'succeeded' || isRefundedPaymentStatus(existingStatus)) return;
  const { data, error } = await (supabase as unknown as {
    from: (n: string) => {
      upsert: (
        row: Record<string, unknown>,
        opts: { onConflict: string },
      ) => {
        select: (c: string) => Promise<{
          data: Array<{ id: string; status: string }> | null;
          error: { message: string } | null;
        }>;
      };
    };
  })
    .from('stripe_payments')
    .upsert(mapping.row, { onConflict: 'stripe_invoice_id' })
    .select('id, status');

  if (error) {
    throw new Error(`stripe_payments failed upsert: ${error.message}`);
  }

  const persistedPayment = data?.[0];
  if (!persistedPayment) {
    const currentStatus = await readStripePaymentStatus(supabase, invoice.id);
    if (currentStatus === 'succeeded' || isRefundedPaymentStatus(currentStatus)) return;
    throw new Error(`stripe payment failure upsert affected no row: ${invoice.id}`);
  }
  if (persistedPayment.status === 'succeeded' ||
      isRefundedPaymentStatus(persistedPayment.status)) return;
  if (persistedPayment.status !== 'failed') {
    throw new Error(`stripe payment failure not persisted: ${invoice.id}`);
  }
  const paymentId = persistedPayment.id;

  const failureReason =
    (mapping.row.failure_reason as string | null | undefined) ?? null;

  await logAuditSystem({
    action: 'billing.payment.failed',
    tenantId: mapping.tenantId,
    userId: null,
    entityType: 'stripe_payment',
    entityId: paymentId,
    metadata: {
      stripeInvoiceId: invoice.id,
      amountCents: invoice.amount_due,
      currency: invoice.currency,
      failureReason,
    },
  });

  await sendJobEvent({
    groupId: mapping.tenantId,
    ...billingPaymentFailed.create({
      tenantId: mapping.tenantId,
      paymentId,
      stripeInvoiceId: invoice.id ?? '',
      failureReason,
    }),
  });

  // Stripe ponawia obciążenie tej samej faktury, a każda próba to osobne zdarzenie.
  await trackServer({
    tenantId: mapping.tenantId,
    event: ANALYTICS_EVENTS.paymentFailed,
    dedupeKey: `${invoice.id}:${invoice.attempt_count ?? 0}`,
  });
}

// ─── 5. subscription.trial_will_end ───────────────────────────────────

export async function handleTrialWillEnd(
  eventSnapshot: Stripe.Subscription,
): Promise<void> {
  // Trial notices must use the same verified Customer -> tenant binding as
  // subscription writes. Metadata on an old event is not tenant authority.
  const { subscription, tenantId, status } =
    await syncCurrentStripeSubscription(eventSnapshot.id);
  if (status !== 'trialing') return;

  if (!subscription.trial_end) {
    throw new Error('Current Stripe trial has no end date');
  }
  const trialEndIso = new Date(subscription.trial_end * 1000).toISOString();

  await logAuditSystem({
    action: 'billing.trial.will_end',
    tenantId,
    userId: null,
    entityType: 'subscription',
    entityId: subscription.id,
    metadata: { trialEnd: trialEndIso },
  });
}