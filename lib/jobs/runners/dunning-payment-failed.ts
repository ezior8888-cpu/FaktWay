/**
 * Dunning email po `billing/payment.failed` (Faza 25 Krok 5).
 *
 * Stripe robi własne Smart Retries + Dunning (włączane w Stripe Dashboard
 * → Settings → Subscriptions and emails). My dorzucamy 1 email natychmiast
 * z linkiem do `/settings/billing` żeby user mógł zmienić metodę płatności.
 *
 * Bez follow-upów — Stripe pociągnie 2 dodatkowe próby przez 7 dni i pośle
 * własne smart-dunning emails. My nie chcemy duplikować.
 *
 * Idempotency: `billing_notifications` UNIQUE(entity_id, kind='payment_failed').
 * Jeden email per payment row, nawet jak Stripe retry'uje webhook.
 */

import { NonRetriableError } from '../errors';
import type { JobContext } from '@/lib/jobs/registry';

import { sendPaymentFailedEmail } from '@/lib/email/send';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe/client';

import { billingPaymentFailed } from '../events';
// `inngest` używany w `inngest.createFunction` poniżej.

function fmtPlnAmount(cents: number): string {
  const pln = cents / 100;
  return pln.toLocaleString('pl-PL', {
    style: 'currency',
    currency: 'PLN',
  });
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-b.ts
 */
export async function runDunningPaymentFailed(data: Parameters<typeof billingPaymentFailed.create>[0], { step, logger }: JobContext) {
    const { tenantId, paymentId, stripeInvoiceId } = data;
    const supabase = createAdminClient();

    // 1. Load payment row (cast — tabela poza typed gen).
    const payment = await step.run('load-payment', async () => {
      const { data, error } = await (supabase as unknown as {
        from: (n: string) => {
          select: (c: string) => {
            eq: (k: string, v: string) => {
              maybeSingle: () => Promise<{
                data: {
                  id: string;
                  tenant_id: string;
                  stripe_invoice_id: string | null;
                  status: string;
                  amount_cents: number;
                  failure_reason: string | null;
                } | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      })
        .from('stripe_payments')
        .select('id, tenant_id, stripe_invoice_id, status, amount_cents, failure_reason')
        .eq('id', paymentId)
        .maybeSingle();
      if (error) throw new Error(`payment lookup: ${error.message}`);
      if (!data) throw new NonRetriableError(`Payment ${paymentId} nie istnieje`);
      return data;
    });
    if (payment.id !== paymentId || payment.tenant_id !== tenantId ||
        payment.stripe_invoice_id !== stripeInvoiceId) {
      throw new NonRetriableError('Payment tenant or invoice binding mismatch');
    }
    if (payment.status !== 'failed') {
      return { skipped: true as const, reason: 'payment-no-longer-failed' as const };
    }

    // 2. Idempotency claim.
    const claimRes = await supabase.from('billing_notifications').insert({
      tenant_id: tenantId,
      entity_id: paymentId,
      kind: 'payment_failed',
      recipient_email: 'pending',
      status: 'sending',
    });
    if (claimRes.error) {
      if (claimRes.error.code === '23505') {
        logger.info('dunning already sent — skip', { paymentId });
        return { skipped: true as const, reason: 'duplicate' };
      }
      throw new Error(`notification claim: ${claimRes.error.message}`);
    }

    // 3. Resolve owner email.
    const { data: membership, error: membershipError } = await supabase
      .from('memberships')
      .select('user_id')
      .eq('organization_id', tenantId)
      .eq('role', 'owner')
      .eq('status', 'active')
      .order('joined_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    // An uncertain owner lookup must remain `sending` for the stale-claim alert.
    if (membershipError) throw new Error(`Owner membership lookup failed: ${membershipError.message}`);
    if (!membership) {
      await supabase
        .from('billing_notifications')
        .update({ status: 'failed', error_message: 'no owner found' })
        .eq('entity_id', paymentId)
        .eq('kind', 'payment_failed');
      throw new NonRetriableError('Brak ownera dla tenanta — nie ma do kogo wysłać');
    }

    const { data: userData, error: userError } = await supabase.auth.admin.getUserById(membership.user_id);
    if (userError) throw new Error(`Owner account lookup failed: ${userError.message}`);
    const email = userData.user?.email;
    if (!email) {
      await supabase
        .from('billing_notifications')
        .update({ status: 'failed', error_message: 'owner has no email' })
        .eq('entity_id', paymentId)
        .eq('kind', 'payment_failed');
      throw new NonRetriableError('Owner bez emaila');
    }

    // 4. Tenant name dla personalizacji.
    const { data: tenant } = await supabase
      .from('tenants')
      .select('name')
      .eq('id', tenantId)
      .maybeSingle();

    // 5. Check current DB state inside the same durable step as the external
    // send. Inngest may replay a cached load-payment step; pg-boss reruns the
    // whole runner. Both must read the persisted state immediately before mail.
    const result = await step.run('send-email', async () => {
      const current = await supabase
        .from('stripe_payments')
        .select('id, tenant_id, stripe_invoice_id, status')
        .eq('id', paymentId)
        .maybeSingle();
      if (current.error) throw new Error('Current payment status read failed');
      if (!current.data || current.data.id !== paymentId ||
          current.data.tenant_id !== tenantId ||
          current.data.stripe_invoice_id !== stripeInvoiceId) {
        throw new NonRetriableError('Payment tenant or invoice binding could not be verified');
      }
      if (current.data.status !== 'failed') {
        return { skipped: true as const, reason: 'payment-no-longer-failed' as const };
      }

      // Stripe can be ahead of a delayed local webhook. A paid/void invoice
      // must not trigger dunning even while the local mirror still says failed.
      let stripeInvoice;
      try {
        stripeInvoice = await getStripe().invoices.retrieve(stripeInvoiceId);
      } catch {
        throw new Error('Stripe invoice state could not be verified');
      }
      if (stripeInvoice.id !== stripeInvoiceId) {
        throw new NonRetriableError('Stripe invoice binding could not be verified');
      }
      if (stripeInvoice.status !== 'open') {
        return { skipped: true as const, reason: 'stripe-invoice-no-longer-open' as const };
      }
      return sendPaymentFailedEmail(email, {
        tenantName: tenant?.name ?? email,
        amountLabel: fmtPlnAmount(payment.amount_cents),
        failureReason: payment.failure_reason,
      });
    });

    if ('skipped' in result) {
      const { error } = await supabase
        .from('billing_notifications')
        .update({ status: 'skipped', error_message: result.reason })
        .eq('entity_id', paymentId)
        .eq('kind', 'payment_failed');
      if (error) throw new Error('Failed to record skipped dunning notification');
      logger.info('dunning skipped after payment status changed', { paymentId });
      return result;
    }

    // 6. Update status.
    await supabase
      .from('billing_notifications')
      .update({
        status: result.sent ? 'sent' : 'failed',
        recipient_email: email,
        resend_message_id: result.messageId ?? null,
        error_message: result.sent ? null : result.reason ?? null,
      })
      .eq('entity_id', paymentId)
      .eq('kind', 'payment_failed');

    return { sent: result.sent, email };
}

