/**
 * Self-invoicing job — odpowiada na `billing/payment.succeeded` (Faza 25 Krok 4).
 *
 * Pipeline:
 *   1. Load `stripe_payments` row — jeśli `vat_invoice_id` już ustawione,
 *      skip (idempotency po retry webhook'a).
 *   2. Zweryfikuj firmę i wyznacz plan z opłaconej faktury Stripe.
 *   3. `buildSelfInvoiceDraft(...)` — Invoice obiekt z poprawnym numerowaniem.
 *   4. `insertSelfInvoice(...)` — INSERT do `invoices` + `invoice_line_items`.
 *      Idempotent przez UNIQUE `(tenant_id, internal_number)`.
 *   5. UPDATE `stripe_payments.vat_invoice_id` + `vat_invoice_submitted_at`.
 *   6. Emit `invoice/submit.requested` do istniejącego pipeline'u Fazy 23
 *      (zwykły submit z retry-policy 5×, Offline24 fallback, audit per call).
 *
 * Concurrency: 1 per `tenantId` — żeby dwa payment'y w tym samym customer'cie
 * w krótkim czasie nie wystawiły 2 faktur na ten sam stripe_invoice_id
 * (idempotency-na-defense, faktyczna jest na poziomie unique constraint).
 *
 * Konfiguracja operatora: `FAKTFLOW_OPERATOR_TENANT_ID` env var. Bez niej
 * job loguje warning i kończy bez fakturowania (Stripe receipt = fallback).
 */

import { randomUUID } from 'node:crypto';
import { NonRetriableError } from '../errors';
import type { JobContext } from '@/lib/jobs/registry';

import { logAuditSystem } from '@/lib/audit/log-system';
import {
  buildSelfInvoiceDraft,
  insertSelfInvoice,
} from '@/lib/billing/self-invoice';
import { isSelfInvoicingConfigured } from '@/lib/billing/operator-config';
import { createAdminClient } from '@/lib/supabase/admin';
import { deriveBilledPlanFromPaidInvoice } from '@/lib/stripe/billed-plan';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { recordSendRefusal } from '@/lib/ksef/send-attempt-ledger';

import {
  billingPaymentSucceeded,
  invoiceSubmitRequested,
} from '../events';

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-d.ts
 */
export async function runSelfInvoicePayment(data: Parameters<typeof billingPaymentSucceeded.create>[0], { step, logger }: JobContext) {
    const { tenantId, paymentId, stripeInvoiceId } = data;

    if (!isSelfInvoicingConfigured()) {
      logger.warn(
        'FAKTFLOW_OPERATOR_TENANT_ID missing — self-invoicing skipped',
        { paymentId },
      );
      return { skipped: true as const, reason: 'operator-not-configured' as const };
    }

    // 1. Load payment + sprawdź idempotency.
    const paymentRow = await step.run('load-payment', async () => {
      const supabase = createAdminClient();
      const { data, error } = await (supabase as unknown as {
        from: (n: string) => {
          select: (c: string) => {
            eq: (k: string, v: string) => {
              maybeSingle: () => Promise<{
                data: {
                  id: string;
                  tenant_id: string;
                  amount_cents: number;
                  currency: string;
                  stripe_invoice_id: string;
                  last_webhook_payload: unknown;
                  status: string;
                  paid_at: string | null;
                  vat_invoice_id: string | null;
                  vat_invoice_submitted_at: string | null;
                  subscription_id: string | null;
                } | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      })
        .from('stripe_payments')
        .select(
          'id, tenant_id, amount_cents, currency, stripe_invoice_id, last_webhook_payload, status, paid_at, vat_invoice_id, vat_invoice_submitted_at, subscription_id',
        )
        .eq('id', paymentId)
        .maybeSingle();
      if (error) throw new Error(`load payment failed: ${error.message}`);
      if (!data) throw new NonRetriableError(`Payment ${paymentId} nie istnieje`);
      return data;
    });

    if (paymentRow.status !== 'succeeded') {
      logger.info('payment no longer succeeded — self-invoicing skipped', {
        paymentId,
        status: paymentRow.status,
      });
      return { skipped: true as const, reason: 'payment-not-succeeded' as const };
    }

    if (paymentRow.vat_invoice_id) {
      if (!paymentRow.vat_invoice_submitted_at) {
        throw new Error('VAT invoice linked without confirmed KSeF enqueue; manual reconciliation required');
      }
      logger.info('vat_invoice_id already set — skip', { paymentId });
      return {
        skipped: true as const,
        reason: 'already-invoiced' as const,
        existingInvoiceId: paymentRow.vat_invoice_id,
      };
    }

    const authoritativePaidAt = paymentRow.paid_at;
    if (!authoritativePaidAt || Number.isNaN(Date.parse(authoritativePaidAt))) {
      throw new Error('Payment paid_at missing or invalid; manual reconciliation required');
    }

    // 2. Bind the plan to the paid Stripe invoice snapshot saved with this
    // payment, not to the subscription's current plan. A later plan change
    // must not relabel an earlier VAT invoice.
    const plan = await step.run('load-billed-plan-v3', async () => {
      if (paymentRow.tenant_id !== tenantId ||
          paymentRow.stripe_invoice_id !== stripeInvoiceId) {
        throw new Error('Payment identity requires reconciliation');
      }
      if (!paymentRow.subscription_id) {
        throw new Error('Payment subscription reference missing; manual reconciliation required');
      }
      const supabase = createAdminClient();
      const { data: subscription, error } = await (supabase as unknown as {
        from: (n: string) => {
          select: (c: string) => {
            eq: (k: string, v: string) => {
              maybeSingle: () => Promise<{
                data: {
                  tenant_id: string;
                  stripe_subscription_id: string;
                  stripe_customer_id: string;
                } | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      })
        .from('subscriptions')
        .select('tenant_id, stripe_subscription_id, stripe_customer_id')
        .eq('id', paymentRow.subscription_id)
        .maybeSingle();
      if (error) throw new Error('Subscription binding lookup failed: ' + error.message);
      if (!subscription || subscription.tenant_id !== tenantId ||
          !subscription.stripe_subscription_id || !subscription.stripe_customer_id) {
        throw new Error('Payment subscription binding requires reconciliation');
      }
      return deriveBilledPlanFromPaidInvoice({
        snapshot: paymentRow.last_webhook_payload,
        stripeInvoiceId: paymentRow.stripe_invoice_id,
        stripeSubscriptionId: subscription.stripe_subscription_id,
        stripeCustomerId: subscription.stripe_customer_id,
        amountCents: paymentRow.amount_cents,
        currency: paymentRow.currency,
      });
    });
    // 3 + 4. Build draft + insert (idempotent po unique internal_number).
    const insertResult = await step.run('build-and-insert-atomic-v2', async () => {
      // Inngest może odtworzyć zapamiętany krok load-payment po zwrocie.
      // Odczyt w tym kroku sprawdza bieżący stan przed utworzeniem faktury.
      const supabase = createAdminClient();
      const { data: currentPayment, error: statusError } = await (supabase as unknown as {
        from: (n: string) => {
          select: (c: string) => {
            eq: (k: string, v: string) => {
              maybeSingle: () => Promise<{
                data: { status: string } | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      })
        .from('stripe_payments')
        .select('status')
        .eq('id', paymentId)
        .maybeSingle();
      if (statusError) throw new Error('payment status read failed: ' + statusError.message);
      if (!currentPayment) throw new NonRetriableError('Payment ' + paymentId + ' nie istnieje');
      if (currentPayment.status !== 'succeeded') {
        return { skipped: true as const, reason: 'payment-not-succeeded' as const };
      }

      const draft = await buildSelfInvoiceDraft(tenantId, {
        grossCents: paymentRow.amount_cents,
        paidAt: authoritativePaidAt,
        stripeInvoiceId,
        plan,
        paymentMethodType: data.paymentMethodType,
      });
      if (!draft) {
        throw new NonRetriableError(
          'Nie udało się zbudować draft faktury (operator config lub customer tenant missing)',
        );
      }

      const inserted = await insertSelfInvoice(
        draft.invoice, draft.operator.tenantId, stripeInvoiceId, paymentId, tenantId,
      );
      if (!inserted.created) {
        throw new Error('VAT invoice transaction already committed; reconcile KSeF enqueue before retry');
      }

      return {
        invoiceId: inserted.invoiceId,
        internalNumber: inserted.internalNumber,
        operatorTenantId: draft.operator.tenantId,
        operatorNip: draft.operator.nip,
        // Numer nadała baza (kolejny w miesiącu, AUD-69) — XML musi mieć ten sam.
        invoice: { ...draft.invoice, internalNumber: inserted.internalNumber },
      };
    });

    if ('skipped' in insertResult) {
      logger.info('payment no longer succeeded before invoice creation — skip', { paymentId });
      return insertResult;
    }

    // 6. Emit submit event do istniejącego KSeF pipeline'u (Faza 23).
    // A5: nieudane zlecenie zostawia wiersz w dzienniku prób (fail-open) — ponowienie
    // zatrzyma się na „VAT invoice linked without confirmed KSeF enqueue”, więc bez
    // tego wiersza faktura za abonament nie pojawia się na liście błędów wysyłki.
    try {
      await step.sendEvent('emit-ksef-submit', {
        name: 'invoice/submit.requested',
        data: invoiceSubmitRequested.create({
          tenantId: insertResult.operatorTenantId,
          invoiceId: insertResult.invoiceId,
          invoice: insertResult.invoice,
          nip: insertResult.operatorNip,
          environment: requireConfiguredKsefEnvironment(),
          // Właściciel przejęcia wysyłki (AUD-10, 00124).
          sendAttemptId: randomUUID(),
        }).data,
      });
    } catch (e) {
      await recordSendRefusal({
        tenantId: insertResult.operatorTenantId,
        invoiceId: insertResult.invoiceId,
        userId: null,
        code: 'ENQUEUE_ERROR',
        message: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      });
      throw e;
    }

    // Enqueue KSeF jest poza transakcją faktury. Brak znacznika po 15 min
    // zgłasza monitor i wymaga ręcznego ustalenia, czy event dotarł.
    await step.run('mark-ksef-event-emitted', async () => {
      const supabase = createAdminClient();
      const { data: marked, error } = await supabase
        .from('stripe_payments')
        .update({ vat_invoice_submitted_at: new Date().toISOString() })
        .eq('id', paymentId)
        .eq('vat_invoice_id', insertResult.invoiceId)
        .is('vat_invoice_submitted_at', null)
        .select('id')
        .maybeSingle();
      if (error || !marked) {
        throw error ?? new Error('KSeF enqueue marker requires reconciliation');
      }
    });
    // 7. Audit log z prefixem `billing.vat_invoice.queued`.
    await step.run('audit', async () => {
      await logAuditSystem({
        action: 'billing.vat_invoice.queued',
        tenantId: insertResult.operatorTenantId,
        userId: null,
        entityType: 'invoice',
        entityId: insertResult.invoiceId,
        metadata: {
          customerTenantId: tenantId,
          paymentId,
          stripeInvoiceId,
          internalNumber: insertResult.internalNumber,
          plan,
          amountCents: paymentRow.amount_cents,
        },
      });
    });

    return {
      success: true as const,
      invoiceId: insertResult.invoiceId,
      internalNumber: insertResult.internalNumber,
    };
}

