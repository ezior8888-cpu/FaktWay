import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobContext } from '@/lib/jobs/registry';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  build: vi.fn(),
  insert: vi.fn(),
  audit: vi.fn(),
  capture: vi.fn(),
  derivePlan: vi.fn(),
  refusal: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mocks.from }) }));
vi.mock('@/lib/billing/operator-config', () => ({ isSelfInvoicingConfigured: () => true }));
vi.mock('@/lib/billing/self-invoice', () => ({
  buildSelfInvoiceDraft: mocks.build,
  insertSelfInvoice: mocks.insert,
}));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: mocks.audit }));
vi.mock('@/lib/stripe/billed-plan', () => ({ deriveBilledPlanFromPaidInvoice: mocks.derivePlan }));
vi.mock('@/lib/ksef/send-attempt-ledger', () => ({ recordSendRefusal: mocks.refusal }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.capture }));
vi.mock('@/lib/jobs/inngest-adapter', () => ({ toJobContext: vi.fn() }));
vi.mock('@/lib/jobs/events', () => ({
  billingPaymentSucceeded: { create: (data: unknown) => ({ data }) },
  invoiceSubmitRequested: { create: (data: unknown) => ({ data }) },
  inngest: { createFunction: () => ({}) },
}));

import { runSelfInvoicePayment } from '@/lib/jobs/runners/self-invoice-payment';

const event = {
  tenantId: 'customer-tenant',
  paymentId: 'payment-1',
  stripeInvoiceId: 'in_1',
  amountCents: 12000,
  taxCents: 2244,
  currency: 'pln',
  paidAt: '2026-09-24T10:00:00.000Z',
};

let paymentStatus: string;
let statusReadError: boolean;
let subscriptionPlan: string | null;
let subscriptionTenantId: string;
let paymentStripeInvoiceId: string;
let subscriptionStripeId: string;
let subscriptionCustomerId: string;
const sentEvent = vi.fn();
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const context: JobContext = {
  attempt: 0,
  logger,
  step: {
    run: async (_name, fn) => fn(),
    sleep: vi.fn(),
    sendEvent: sentEvent,
    scheduleAfter: vi.fn(),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  paymentStatus = 'succeeded';
  statusReadError = false;
  subscriptionPlan = 'annual';
  subscriptionTenantId = event.tenantId;
  paymentStripeInvoiceId = event.stripeInvoiceId;
  subscriptionStripeId = 'sub_stripe_1';
  subscriptionCustomerId = 'cus_stripe_1';
  mocks.derivePlan.mockResolvedValue('monthly');
  mocks.from.mockImplementation((table: string) => {
    if (table === 'subscriptions') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: subscriptionPlan === null ? null : {
                plan: subscriptionPlan,
                tenant_id: subscriptionTenantId,
                stripe_subscription_id: subscriptionStripeId,
                stripe_customer_id: subscriptionCustomerId,
              },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table !== 'stripe_payments') throw new Error('Unexpected table: ' + table);
    return {
      select: (columns: string) => ({
        eq: () => ({ maybeSingle: async () => {
          if (columns === 'status' && statusReadError) {
            return { data: null, error: { message: 'temporary read failure' } };
          }
          return {
            data: columns === 'status' ? { status: paymentStatus } : {
              id: event.paymentId,
              tenant_id: event.tenantId,
              amount_cents: event.amountCents,
              status: paymentStatus,
              paid_at: event.paidAt,
              vat_invoice_id: null,
              subscription_id: 'subscription-1',
              stripe_invoice_id: paymentStripeInvoiceId,
              currency: event.currency,
              last_webhook_payload: {
                id: paymentStripeInvoiceId,
                currency: event.currency,
                amount_paid: event.amountCents,
              },
            },
            error: null,
          };
        } }),
      }),
      update: (values: Record<string, unknown>) => {
        if ('vat_invoice_id' in values) {
          throw new Error('Payment-to-invoice link must be committed by the billing RPC');
        }
        expect(values).toHaveProperty('vat_invoice_submitted_at');
        expect(sentEvent).toHaveBeenCalledOnce();
        return {
          eq: () => ({
            eq: () => ({
              is: () => ({
                select: () => ({
                  maybeSingle: async () => ({ data: { id: event.paymentId }, error: null }),
                }),
              }),
            }),
          }),
        };
      },
    };
  });
  mocks.build.mockResolvedValue({
    operator: { tenantId: 'operator-tenant', nip: '1234567890' },
    invoice: { id: 'draft-invoice' },
  });
  mocks.insert.mockResolvedValue({ invoiceId: 'vat-invoice', internalNumber: 'VAT-1', created: true });
  mocks.audit.mockResolvedValue(undefined);
});

describe('VAT self-invoice for a delayed payment job', () => {
  it.each(['refunded', 'partially_refunded', 'failed', 'pending'])(
    'skips payment in %s status before creating or submitting an invoice',
    async (status) => {
      paymentStatus = status;

      await expect(runSelfInvoicePayment(event, context)).resolves.toEqual({
        skipped: true,
        reason: 'payment-not-succeeded',
      });

      expect(mocks.build).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
      expect(sentEvent).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    },
  );

  it('rechecks status before invoice creation when Inngest replays a cached paid row after refund', async () => {
    paymentStatus = 'refunded';
    const cachedPaidRow = {
      id: event.paymentId,
      tenant_id: event.tenantId,
      amount_cents: event.amountCents,
      status: 'succeeded',
      paid_at: event.paidAt,
      vat_invoice_id: null,
      subscription_id: 'subscription-1',
      stripe_invoice_id: event.stripeInvoiceId,
      currency: event.currency,
      last_webhook_payload: {
        id: event.stripeInvoiceId,
        currency: event.currency,
        amount_paid: event.amountCents,
      },
    };
    const resumedContext: JobContext = {
      ...context,
      step: {
        ...context.step,
        run: async <T>(name: string, fn: () => Promise<T> | T): Promise<T> =>
          name === 'load-payment' ? cachedPaidRow as T : fn(),
      },
    };

    await expect(runSelfInvoicePayment(event, resumedContext)).resolves.toEqual({
      skipped: true,
      reason: 'payment-not-succeeded',
    });
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(sentEvent).not.toHaveBeenCalled();
  });

  it('retries on a failed current-status read before creating an invoice', async () => {
    statusReadError = true;

    await expect(runSelfInvoicePayment(event, context)).rejects.toThrow(
      'payment status read failed',
    );
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(sentEvent).not.toHaveBeenCalled();
  });

  it('stops before drafting a VAT invoice when payment lacks a subscription', async () => {
    const missingSubscriptionContext: JobContext = {
      ...context,
      step: {
        ...context.step,
        run: async <T>(name: string, fn: () => Promise<T> | T): Promise<T> =>
          name === 'load-payment'
            ? {
                id: event.paymentId,
                tenant_id: event.tenantId,
                amount_cents: event.amountCents,
                status: 'succeeded',
                paid_at: event.paidAt,
                vat_invoice_id: null,
                subscription_id: null,
                stripe_invoice_id: event.stripeInvoiceId,
                currency: event.currency,
                last_webhook_payload: {
                  id: event.stripeInvoiceId,
                  currency: event.currency,
                  amount_paid: event.amountCents,
                },
              } as T
            : fn(),
      },
    };

    await expect(runSelfInvoicePayment(event, missingSubscriptionContext)).rejects.toThrow(
      'Payment subscription reference missing',
    );
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(sentEvent).not.toHaveBeenCalled();
  });

  it('stops before drafting a VAT invoice when the subscription row is missing', async () => {
    subscriptionPlan = null;
    await expect(runSelfInvoicePayment(event, context)).rejects.toThrow(
      'Payment subscription binding requires reconciliation',
    );
    expect(mocks.derivePlan).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(sentEvent).not.toHaveBeenCalled();
  });

  it('rejects a subscription bound to a different tenant', async () => {
    subscriptionTenantId = 'other-tenant';
    await expect(runSelfInvoicePayment(event, context)).rejects.toThrow(
      'Payment subscription binding requires reconciliation',
    );
    expect(mocks.derivePlan).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it.each(['subscription', 'customer'])(
    'rejects a missing Stripe %s identifier before invoice drafting',
    async (identifier) => {
      if (identifier === 'subscription') subscriptionStripeId = '';
      else subscriptionCustomerId = '';
      await expect(runSelfInvoicePayment(event, context)).rejects.toThrow(
        'Payment subscription binding requires reconciliation',
      );
      expect(mocks.derivePlan).not.toHaveBeenCalled();
      expect(mocks.build).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
    },
  );

  it('rejects a payment invoice ID that differs from the queued event', async () => {
    paymentStripeInvoiceId = 'in_other';
    await expect(runSelfInvoicePayment(event, context)).rejects.toThrow(
      'Payment identity requires reconciliation',
    );
    expect(mocks.derivePlan).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('uses the paid invoice plan even when the current subscription is annual', async () => {
    subscriptionPlan = 'annual';
    mocks.derivePlan.mockResolvedValue('monthly');

    await expect(runSelfInvoicePayment(event, context)).resolves.toMatchObject({
      success: true,
    });

    expect(mocks.derivePlan).toHaveBeenCalledWith({
      snapshot: {
        id: event.stripeInvoiceId,
        currency: event.currency,
        amount_paid: event.amountCents,
      },
      stripeInvoiceId: event.stripeInvoiceId,
      stripeSubscriptionId: subscriptionStripeId,
      stripeCustomerId: subscriptionCustomerId,
      amountCents: event.amountCents,
      currency: event.currency,
    });
    expect(mocks.build).toHaveBeenCalledWith(
      event.tenantId,
      expect.objectContaining({ plan: 'monthly' }),
    );
  });

  it('stops before drafting when the invoice snapshot cannot establish a plan', async () => {
    mocks.derivePlan.mockImplementation(() => {
      throw new Error('Paid Stripe invoice requires manual reconciliation');
    });
    await expect(runSelfInvoicePayment(event, context)).rejects.toThrow(
      'Paid Stripe invoice requires manual reconciliation',
    );
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('does not enqueue KSeF when the atomic invoice claim loses to a refund', async () => {
    mocks.insert.mockRejectedValue(new Error('VAT invoice blocked by refund operation'));

    await expect(runSelfInvoicePayment(event, context)).rejects.toThrow(
      'VAT invoice blocked by refund operation',
    );

    expect(mocks.insert).toHaveBeenCalledWith(
      expect.anything(),
      'operator-tenant',
      event.stripeInvoiceId,
      event.paymentId,
      event.tenantId,
    );
    expect(sentEvent).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('still creates and queues a VAT invoice for a succeeded payment', async () => {
    await expect(runSelfInvoicePayment(event, context)).resolves.toMatchObject({
      success: true,
      invoiceId: 'vat-invoice',
    });

    expect(mocks.build).toHaveBeenCalledOnce();
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.anything(),
      'operator-tenant',
      event.stripeInvoiceId,
      event.paymentId,
      event.tenantId,
    );
    expect(sentEvent).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledOnce();
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('A5: nieudane zlecenie wysyłki faktury za abonament zostawia ślad w dzienniku prób', () => {
  it('błąd kolejki przy emit-ksef-submit: wiersz ENQUEUE_ERROR dla faktury operatora, ten sam błąd idzie dalej', async () => {
    const boom = new Error('pg-boss: connection terminated');
    sentEvent.mockRejectedValueOnce(boom);

    await expect(runSelfInvoicePayment(event, context)).rejects.toBe(boom);
    expect(mocks.refusal).toHaveBeenCalledOnce();
    expect(mocks.refusal).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'operator-tenant',
      invoiceId: 'vat-invoice',
      userId: null,
      code: 'ENQUEUE_ERROR',
    }));
  });

  it('udane zlecenie — bez wiersza w dzienniku', async () => {
    await runSelfInvoicePayment(event, context);
    expect(mocks.refusal).not.toHaveBeenCalled();
  });
});
