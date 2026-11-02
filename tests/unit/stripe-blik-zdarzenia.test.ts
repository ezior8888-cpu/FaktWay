import { render } from '@react-email/render';
import type Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { Invoice } from '@/types/invoice';

/**
 * Przykłady zdarzeń BLIK na prawdziwej ścieżce: handler webhooka, dowód płatności,
 * job faktury albo przypomnienia, szablon maila. Podmienione są tylko baza i HTTP
 * do Stripe. Kształty zdarzeń jak w wersji 2024-11-20.acacia, którą ma webhook:
 * faktura niesie `payment_intent` i `charge` jako identyfikatory.
 *
 *   1. start próby przez SetupIntent (mandat na 0 zł, bez płatności),
 *   2. opłacona faktura po próbie: `charge.payment_method_details.type = 'blik'`,
 *   3. nieudane obciążenie `recurring_not_supported_by_bank`.
 */

const OPERATOR = '33333333-3333-4333-8333-333333333333';
const TENANT = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUBSCRIPTION_ROW = '44444444-4444-4444-8444-444444444444';
const PAYMENT_ROW = '22222222-2222-4222-8222-222222222222';
const CUSTOMER = 'cus_BlikKlient1';
const STRIPE_SUBSCRIPTION = 'sub_BlikSub00001';
const STRIPE_INVOICE = 'in_BlikFaktura01';
const PAYMENT_INTENT = 'pi_BlikIntent0001';
const CHARGE = 'ch_BlikCharge0001';
const PAID_AT_UNIX = 1_796_637_600; // 2026-12-02 12:00 czasu polskiego

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  rpc: vi.fn(),
  retrieveSession: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  retrieveCharge: vi.fn(),
  retrieveInvoice: vi.fn(),
  sendJob: vi.fn(),
  audit: vi.fn(),
  track: vi.fn(),
  captureException: vi.fn(),
  sendPaymentFailedEmail: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: mocks.rpc,
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'wlasciciel@example.test' } }, error: null }) } },
    from(table: string) {
      const predicates: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'insert' | 'update' | 'upsert' = 'select';
      let patch: Row = {};
      let conflict = '';
      let single = false;
      const rows = () => (mocks.tables[table] ??= []);
      const run = () => {
        if (op === 'insert') {
          rows().push({ ...patch });
          return { data: null, error: null };
        }
        if (op === 'upsert') {
          const hit = rows().find((r) => r[conflict] === patch[conflict]);
          if (hit) Object.assign(hit, patch);
          else rows().push({ id: PAYMENT_ROW, ...patch });
          return { data: [{ ...rows().find((r) => r[conflict] === patch[conflict]) }], error: null };
        }
        const hit = rows().filter((r) => predicates.every((p) => p(r)));
        if (op === 'update') hit.forEach((r) => Object.assign(r, patch));
        const data = hit.map((r) => ({ ...r }));
        return { data: single ? data[0] ?? null : data, error: null };
      };
      const q = {
        select: () => q,
        insert(r: Row) { op = 'insert'; patch = r; return q; },
        update(r: Row) { op = 'update'; patch = r; return q; },
        upsert(r: Row, opts: { onConflict: string }) { op = 'upsert'; patch = r; conflict = opts.onConflict; return q; },
        eq(k: string, v: unknown) { predicates.push((r) => r[k] === v); return q; },
        is(k: string, v: unknown) { predicates.push((r) => (r[k] ?? null) === v); return q; },
        order: () => q,
        limit: () => q,
        maybeSingle() { single = true; return Promise.resolve(run()); },
        then(ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) { return Promise.resolve(run()).then(ok, ko); },
      };
      return q;
    },
  }),
}));
vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({
    checkout: { sessions: { retrieve: mocks.retrieveSession } },
    paymentIntents: { retrieve: mocks.retrievePaymentIntent },
    charges: { retrieve: mocks.retrieveCharge },
    invoices: { retrieve: mocks.retrieveInvoice },
  }),
}));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: mocks.sendJob }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: mocks.audit }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: mocks.track }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.captureException, captureMessage: vi.fn() }));
vi.mock('@/lib/email/send', () => ({ sendPaymentFailedEmail: mocks.sendPaymentFailedEmail }));

import { clearOperatorCache } from '@/lib/billing/operator-config';
import { paymentFailureAdvice } from '@/lib/billing/payment-failure';
import PaymentFailed from '@/lib/email/templates/PaymentFailed';
import { runDunningPaymentFailed } from '@/lib/jobs/runners/dunning-payment-failed';
import { runSelfInvoicePayment } from '@/lib/jobs/runners/self-invoice-payment';
import { handleCheckoutSessionStateEvent } from '@/lib/stripe/checkout-reconcile';
import { mapSubscriptionToRow } from '@/lib/stripe/event-mapping';
import { handleInvoicePaymentFailed, handleInvoicePaymentSucceeded } from '@/lib/stripe/webhook-handlers';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { validateFA3 } from '@/lib/xml/validator';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const sendEvent = vi.fn();
const jobContext: JobContext = {
  attempt: 0,
  logger,
  step: {
    run: async (_name, fn) => fn(),
    sleep: vi.fn(),
    sendEvent,
    scheduleAfter: vi.fn(),
  },
};

/** Faktura po próbie, tak jak podpisane zdarzenie w acacia. */
function paidInvoice(overrides: Row = {}): Stripe.Invoice {
  return {
    id: STRIPE_INVOICE,
    object: 'invoice',
    livemode: false,
    status: 'paid',
    paid: true,
    paid_out_of_band: false,
    billing_reason: 'subscription_cycle',
    collection_method: 'charge_automatically',
    customer: CUSTOMER,
    subscription: STRIPE_SUBSCRIPTION,
    payment_intent: PAYMENT_INTENT,
    charge: CHARGE,
    currency: 'pln',
    total: 2999,
    amount_due: 2999,
    amount_paid: 2999,
    amount_remaining: 0,
    status_transitions: { paid_at: PAID_AT_UNIX },
    lines: {
      object: 'list',
      has_more: false,
      total_count: 1,
      data: [{
        object: 'line_item',
        type: 'subscription',
        proration: false,
        quantity: 1,
        currency: 'pln',
        subscription: STRIPE_SUBSCRIPTION,
        price: { id: 'price_monthly' },
      }],
    },
    ...overrides,
  } as unknown as Stripe.Invoice;
}

function failedInvoice(overrides: Row = {}): Stripe.Invoice {
  return paidInvoice({
    status: 'open',
    paid: false,
    amount_paid: 0,
    amount_remaining: 2999,
    attempt_count: 1,
    charge: null,
    last_finalization_error: null,
    status_transitions: { paid_at: null },
    ...overrides,
  });
}

const blikPaymentIntent = {
  id: PAYMENT_INTENT,
  object: 'payment_intent',
  status: 'succeeded',
  livemode: false,
  customer: CUSTOMER,
  currency: 'pln',
  amount_received: 2999,
  latest_charge: CHARGE,
  payment_method: 'pm_Blik00000001',
  payment_method_types: ['blik'],
};

const blikCharge = {
  id: CHARGE,
  object: 'charge',
  status: 'succeeded',
  paid: true,
  disputed: false,
  amount_refunded: 0,
  amount_captured: 2999,
  livemode: false,
  customer: CUSTOMER,
  currency: 'pln',
  payment_intent: PAYMENT_INTENT,
  payment_method_details: { type: 'blik', blik: { buyer_id: null } },
};

const declinedPaymentIntent = {
  id: PAYMENT_INTENT,
  object: 'payment_intent',
  status: 'requires_payment_method',
  livemode: false,
  customer: CUSTOMER,
  currency: 'pln',
  amount_received: 0,
  payment_method_types: ['blik'],
  last_payment_error: {
    type: 'card_error',
    code: 'payment_method_provider_decline',
    decline_code: 'recurring_not_supported_by_bank',
    message: 'The customer’s bank does not support recurring payments.',
    payment_method: { id: 'pm_Blik00000001', object: 'payment_method', type: 'blik' },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  clearOperatorCache();
  vi.stubEnv('FAKTFLOW_OPERATOR_TENANT_ID', OPERATOR);
  vi.stubEnv('STRIPE_PRICE_MONTHLY', 'price_monthly');
  vi.stubEnv('STRIPE_PRICE_ANNUAL', 'price_annual');
  mocks.tables.stripe_payments = [];
  mocks.tables.subscriptions = [{
    id: SUBSCRIPTION_ROW,
    tenant_id: TENANT,
    stripe_subscription_id: STRIPE_SUBSCRIPTION,
    stripe_customer_id: CUSTOMER,
  }];
  mocks.tables.tenants = [
    {
      id: OPERATOR,
      nip: '1234567890',
      name: 'Operator Testowy',
      address_json: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
    },
    {
      id: TENANT,
      nip: '1234567890',
      name: 'Firma Testowa',
      address_json: { countryCode: 'PL', addressLine1: 'ul. Klienta 2', addressLine2: '00-002 Warszawa' },
    },
  ];
  mocks.tables.billing_notifications = [];
  mocks.tables.memberships = [{ user_id: 'user-1', organization_id: TENANT, role: 'owner', status: 'active' }];
  mocks.tables.stripe_checkout_attempts = [];
  mocks.retrievePaymentIntent.mockResolvedValue(blikPaymentIntent);
  mocks.retrieveCharge.mockResolvedValue(blikCharge);
  mocks.retrieveInvoice.mockResolvedValue({ id: STRIPE_INVOICE, status: 'open' });
  mocks.sendJob.mockResolvedValue(undefined);
  mocks.audit.mockResolvedValue(undefined);
  mocks.track.mockResolvedValue(undefined);
  mocks.sendPaymentFailedEmail.mockResolvedValue({ sent: true, messageId: 'email-1' });
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'settle_stripe_checkout_session') return { data: true, error: null };
    if (name === 'create_billing_vat_invoice') {
      const payment = mocks.tables.stripe_payments[0];
      if (payment) payment.vat_invoice_id = 'vat-invoice';
      return { data: [{ invoice_id: 'vat-invoice', internal_number: 'FF/2026/12/0001', created: true }], error: null };
    }
    throw new Error('Nieoczekiwane RPC: ' + name);
  });
});

afterEach(() => vi.unstubAllEnvs());

describe('1. start próby przez SetupIntent (mandat BLIK na 0 zł)', () => {
  const completedSession = {
    id: 'cs_test_BlikStart',
    object: 'checkout.session',
    mode: 'subscription',
    status: 'complete',
    payment_status: 'no_payment_required',
    customer: CUSTOMER,
    client_reference_id: ATTEMPT,
    metadata: { attemptId: ATTEMPT, tenantId: TENANT, plan: 'monthly' },
    setup_intent: 'seti_BlikMandat01',
    subscription: STRIPE_SUBSCRIPTION,
    payment_method_types: ['card', 'blik'],
    amount_total: 0,
    currency: 'pln',
    expires_at: 2_000_000_000,
  };

  it('checkout.session.completed zamyka próbę, choć Session nie ma żadnej płatności', async () => {
    mocks.tables.stripe_checkout_attempts = [{
      id: ATTEMPT,
      tenant_id: TENANT,
      stripe_customer_id: CUSTOMER,
      plan: 'monthly',
      status: 'open',
      stripe_session_id: completedSession.id,
    }];
    mocks.retrieveSession.mockResolvedValue(completedSession);

    await handleCheckoutSessionStateEvent(completedSession as unknown as Stripe.Checkout.Session);

    expect(mocks.rpc).toHaveBeenCalledWith('settle_stripe_checkout_session', {
      p_attempt_id: ATTEMPT,
      p_session_id: completedSession.id,
      p_new_status: 'completed',
    });
  });

  it('subskrypcja w próbie z domyślną metodą BLIK trafia do lustra bez żadnego pola karty', () => {
    const row = mapSubscriptionToRow({
      id: STRIPE_SUBSCRIPTION,
      object: 'subscription',
      status: 'trialing',
      customer: CUSTOMER,
      default_payment_method: 'pm_Blik00000001',
      trial_start: 1_793_959_200,
      trial_end: 1_796_551_200,
      cancel_at_period_end: false,
      canceled_at: null,
      items: {
        has_more: false,
        data: [{
          quantity: 1,
          current_period_start: 1_793_959_200,
          current_period_end: 1_796_551_200,
          price: { id: 'price_monthly' },
        }],
      },
    } as unknown as Stripe.Subscription, TENANT);

    expect(row).toMatchObject({ status: 'trialing', plan: 'monthly', tenant_id: TENANT });
    expect(row.trial_end).toBe(new Date(1_796_551_200 * 1000).toISOString());
  });

  it('faktura zerowa z próby nie tworzy płatności, faktury VAT ani maila', async () => {
    await handleInvoicePaymentSucceeded(paidInvoice({
      billing_reason: 'subscription_create',
      total: 0,
      amount_due: 0,
      amount_paid: 0,
      payment_intent: null,
      charge: null,
    }));

    expect(mocks.tables.stripe_payments).toEqual([]);
    expect(mocks.sendJob).not.toHaveBeenCalled();
    expect(mocks.retrievePaymentIntent).not.toHaveBeenCalled();
  });
});

describe('2. opłacona faktura po próbie: płatność BLIK', () => {
  it('dowód płatności przechodzi bez pól karty, a job faktury dostaje rodzaj metody', async () => {
    await handleInvoicePaymentSucceeded(paidInvoice());

    expect(mocks.tables.stripe_payments[0]).toMatchObject({
      status: 'succeeded',
      amount_cents: 2999,
      stripe_payment_intent_id: PAYMENT_INTENT,
      stripe_charge_id: CHARGE,
      stripe_payment_refs_verified: true,
    });
    expect(mocks.sendJob).toHaveBeenCalledOnce();
    expect(mocks.sendJob.mock.calls[0][0]).toMatchObject({
      name: 'billing/payment.succeeded',
      groupId: TENANT,
      data: { tenantId: TENANT, stripeInvoiceId: STRIPE_INVOICE, paymentMethodType: 'blik' },
    });
  });

  it('faktura VAT za abonament ma formę płatności „mobilna” (FA(3): 7), nie „karta”', async () => {
    await handleInvoicePaymentSucceeded(paidInvoice());
    const event = mocks.sendJob.mock.calls[0][0].data;

    await runSelfInvoicePayment(event, jobContext);

    const rpcCall = mocks.rpc.mock.calls.find(([name]) => name === 'create_billing_vat_invoice');
    expect(rpcCall).toBeDefined();
    const draft = rpcCall![1].p_invoice as Invoice;
    expect(draft.payment.method).toBe('mobile');

    expect(sendEvent).toHaveBeenCalledOnce();
    const submitted = sendEvent.mock.calls[0][1].data.invoice as Invoice;
    expect(submitted.payment.method).toBe('mobile');
    expect(submitted.internalNumber).toBe('FF/2026/12/0001');
    const xml = generateFA3Xml(submitted, { validate: false });
    expect(xml).toMatch(/<FormaPlatnosci>7<\/FormaPlatnosci>/);
    expect(xml).not.toMatch(/<FormaPlatnosci>2<\/FormaPlatnosci>/);
    const schema = await validateFA3(xml);
    expect(schema.errors).toEqual([]);
    expect(schema.valid).toBe(true);
  });

  it('płatność kartą ma dalej formę „karta”', async () => {
    mocks.retrieveCharge.mockResolvedValue({
      ...blikCharge,
      payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } },
    });
    await handleInvoicePaymentSucceeded(paidInvoice());
    const event = mocks.sendJob.mock.calls[0][0].data;

    await runSelfInvoicePayment(event, jobContext);

    const rpcCall = mocks.rpc.mock.calls.find(([name]) => name === 'create_billing_vat_invoice');
    expect((rpcCall![1].p_invoice as Invoice).payment.method).toBe('card');
  });

  it('job sprzed wdrożenia (bez rodzaju metody) wystawia fakturę jak dotąd: karta', async () => {
    await handleInvoicePaymentSucceeded(paidInvoice());
    const oldEvent = { ...mocks.sendJob.mock.calls[0][0].data };
    delete oldEvent.paymentMethodType;

    await runSelfInvoicePayment(oldEvent, jobContext);

    const rpcCall = mocks.rpc.mock.calls.find(([name]) => name === 'create_billing_vat_invoice');
    expect((rpcCall![1].p_invoice as Invoice).payment.method).toBe('card');
  });
});

describe('3. nieudane obciążenie recurring_not_supported_by_bank', () => {
  it('webhook zapisuje kod odmowy z PaymentIntent, a nie pustą przyczynę', async () => {
    mocks.retrievePaymentIntent.mockResolvedValue(declinedPaymentIntent);

    await handleInvoicePaymentFailed(failedInvoice());

    // Wersja przed endive dałaby `generic_decline`: tests/unit/stripe-payment-decline.test.ts.
    expect(mocks.retrievePaymentIntent).toHaveBeenCalledWith(
      PAYMENT_INTENT,
      {},
      expect.objectContaining({ apiVersion: '2026-09-30.endive' }),
    );
    expect(mocks.tables.stripe_payments[0]).toMatchObject({
      status: 'failed',
      failure_reason: 'recurring_not_supported_by_bank',
    });
    expect(mocks.sendJob.mock.calls[0][0]).toMatchObject({
      name: 'billing/payment.failed',
      data: { failureReason: 'recurring_not_supported_by_bank' },
    });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'billing.payment.failed',
      metadata: expect.objectContaining({ failureReason: 'recurring_not_supported_by_bank' }),
    }));
  });

  it('awaria odczytu PaymentIntent nie zatrzymuje stanu ani przypomnienia, trafia do Sentry', async () => {
    mocks.retrievePaymentIntent.mockRejectedValue(new Error('Stripe timeout'));

    await handleInvoicePaymentFailed(failedInvoice());

    expect(mocks.tables.stripe_payments[0]).toMatchObject({ status: 'failed', failure_reason: null });
    expect(mocks.sendJob).toHaveBeenCalledOnce();
    expect(mocks.captureException).toHaveBeenCalledOnce();
  });

  it('faktura bez PaymentIntent: bez odczytu, przyczyna jak dotąd', async () => {
    await handleInvoicePaymentFailed(failedInvoice({
      payment_intent: null,
      last_finalization_error: { message: 'Finalizacja nieudana' },
    }));

    expect(mocks.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(mocks.tables.stripe_payments[0]).toMatchObject({ failure_reason: 'Finalizacja nieudana' });
  });

  it('mail od razu mówi, co zrobić: zmień metodę płatności', async () => {
    mocks.retrievePaymentIntent.mockResolvedValue(declinedPaymentIntent);
    await handleInvoicePaymentFailed(failedInvoice());

    await runDunningPaymentFailed(mocks.sendJob.mock.calls[0][0].data, jobContext);

    expect(mocks.sendPaymentFailedEmail).toHaveBeenCalledOnce();
    const [, payload] = mocks.sendPaymentFailedEmail.mock.calls[0];
    expect(payload.failureReason).toBe('recurring_not_supported_by_bank');

    const html = await render(PaymentFailed({ ...payload, appUrl: 'https://app.example.test' }));
    expect(html).toContain('Twój bank nie obsługuje');
    expect(html).toContain('Zmień metodę płatności');
    expect(html).toContain('https://app.example.test/settings/billing');
    // Bez obietnicy kolejnych prób: ta metoda się nie uda, a kod techniczny nie jest dla klienta.
    expect(html).not.toContain('recurring_not_supported_by_bank');
    expect(html).not.toMatch(/Spróbujemy/);
  });
});

describe('paymentFailureAdvice: kody odmowy z dokumentacji BLIK', () => {
  it.each([
    ['recurring_not_supported_by_bank', /nie obsługuje/, /Zmień metodę płatności/, false],
    ['insufficient_funds', /środków/, /metodę płatności/, true],
    ['customer_declined', /zatwierdz/, /metodę płatności/, true],
    ['payment_limit_exceeded', /limit/, /metodę płatności/, true],
    ['partner_generic_decline', /bank/i, /metodę płatności/, true],
  ] as const)('%s', (code, reason, action, willRetry) => {
    const advice = paymentFailureAdvice(code);
    expect(advice.reason).toMatch(reason);
    expect(advice.action).toMatch(action);
    expect(advice.willRetry).toBe(willRetry);
  });

  it('kod nieznany, kod karty i brak kodu: tekst ogólny, bez kodu technicznego i bez słowa „karta”', () => {
    for (const code of [null, 'generic_decline', 'card_declined', 'lost_or_stolen_card', 'Finalizacja nieudana']) {
      const advice = paymentFailureAdvice(code);
      expect(advice.reason, String(code)).toBeNull();
      expect(advice.willRetry, String(code)).toBe(true);
      expect(advice.action, String(code)).toMatch(/metodę płatności/);
      expect(advice.action, String(code)).not.toMatch(/kart/i);
    }
  });

  it('teksty bez długich myślników', () => {
    for (const code of [null, 'recurring_not_supported_by_bank', 'insufficient_funds', 'customer_declined', 'payment_limit_exceeded', 'partner_generic_decline']) {
      const { reason, action } = paymentFailureAdvice(code);
      expect(`${reason ?? ''} ${action}`).not.toMatch(/[–—]/);
    }
  });
});
