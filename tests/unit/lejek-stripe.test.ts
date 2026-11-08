import type Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';
import { fakePosthog, lejekClient } from '../helpers/lejek-atrapy';

/**
 * Zdarzenia lejka z webhooków Stripe: trial_started, payment_succeeded,
 * subscription_canceled, payment_churn, trial_ended. Prawdziwe handlery
 * i bramka zgody; mock tylko HTTP do Stripe i PostHoga, baza w pamięci.
 * Stripe ponawia webhook po każdym 500, więc każdy przypadek ponawia.
 */

const h = vi.hoisted(() => ({
  db: null as unknown,
  /** Podmiana klienta dla przypadku z awarią jednego odczytu. */
  wrapClient: null as ((client: unknown) => unknown) | null,
  posthog: null as unknown,
  sync: vi.fn(),
  map: vi.fn(),
  proof: vi.fn(),
  send: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    const client = lejekClient(h.db as MemoryDb);
    return h.wrapClient ? h.wrapClient(client) : client;
  },
}));
vi.mock('@/lib/analytics/posthog-node-client', () => ({ getPostHogNodeClient: () => h.posthog }));
vi.mock('@/lib/stripe/subscription-sync', () => ({ syncCurrentStripeSubscription: h.sync }));
vi.mock('@/lib/stripe/event-mapping', () => ({ mapInvoiceToPaymentRow: h.map }));
vi.mock('@/lib/stripe/payment-reference-proof', () => ({ verifyPaidInvoicePaymentReferences: h.proof }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: h.send }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: h.audit }));

import {
  handleInvoicePaymentSucceeded,
  handleSubscriptionDeleted,
  handleSubscriptionUpserted,
} from '@/lib/stripe/webhook-handlers';

const TENANT = '00000000-0000-4000-8000-000000000051';
const OWNER = '00000000-0000-4000-8000-000000000052';
const TRIAL_START = 1793000000;
const TRIAL_END = TRIAL_START + 30 * 86400;

let posthog: ReturnType<typeof fakePosthog>;
let db: MemoryDb;

function seed(owner: Row = {}, payments: Row[] = []) {
  db = memoryDb({
    users: [{ id: OWNER, analytics_consent: 'granted', signup_source: { channel: 'tiktok', at: '2026-10-30' }, ...owner }],
    memberships: [{ organization_id: TENANT, user_id: OWNER, role: 'owner', status: 'active', joined_at: '2026-10-30T00:00:00Z' }],
    stripe_payments: payments,
  });
  h.db = db;
}

function subscription(over: Record<string, unknown> = {}) {
  return {
    id: 'sub_lejek',
    status: 'trialing',
    trial_start: TRIAL_START,
    trial_end: TRIAL_END,
    canceled_at: null,
    ended_at: null,
    cancel_at_period_end: false,
    cancellation_details: null,
    items: { data: [{ price: { id: 'price_monthly' } }] },
    ...over,
  } as unknown as Stripe.Subscription;
}

function stripeSubscription(sub: Stripe.Subscription) {
  h.sync.mockResolvedValue({ subscription: sub, tenantId: TENANT, status: sub.status });
}

const invoice = (id: string, amount: number) =>
  ({ id, amount_paid: amount, amount_due: amount, total: amount, currency: 'pln' }) as unknown as Stripe.Invoice;

function mapPayment(id: string, amount: number, paidAt: string) {
  h.map.mockResolvedValue({
    tenantId: TENANT,
    row: {
      tenant_id: TENANT, stripe_invoice_id: id, status: 'succeeded', amount_cents: amount, paid_at: paidAt,
      stripe_payment_intent_id: 'pi_ValidIntent123', stripe_charge_id: 'ch_ValidCharge123',
    },
  });
}

let paymentNo = 0;
const paymentRow = (id: string, amount: number, paidAt: string, status = 'succeeded') => ({
  id: `00000000-0000-4000-8000-${String(100 + paymentNo++).padStart(12, '0')}`,
  tenant_id: TENANT, stripe_invoice_id: id, status, amount_cents: amount, paid_at: paidAt,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.wrapClient = null;
  posthog = fakePosthog();
  h.posthog = posthog;
  seed();
  h.proof.mockResolvedValue({ paymentIntentId: 'pi_ValidIntent123', chargeId: 'ch_ValidCharge123' });
  h.send.mockResolvedValue(undefined);
  h.audit.mockResolvedValue(undefined);
});

describe('trial_started', () => {
  it('start próby: zdarzenie z chwilą ze Stripe, a ponowiony webhook skleja się do jednego', async () => {
    const sub = subscription();
    stripeSubscription(sub);

    await handleSubscriptionUpserted(sub, true);
    await handleSubscriptionUpserted(sub, true);

    const events = posthog.sklejone('trial_started');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      distinctId: OWNER,
      groups: { tenant: TENANT },
      properties: { source: 'tiktok', trial_days: 30, tenant_id: TENANT },
    });
    expect(events[0]!.timestamp?.toISOString()).toBe(new Date(TRIAL_START * 1000).toISOString());
    expect(posthog.messages.filter((m) => m.event === 'trial_started').map((m) => m.uuid))
      .toEqual([events[0]!.uuid, events[0]!.uuid]);
  });

  it('subskrypcja bez próby: bez trial_started', async () => {
    const sub = subscription({ status: 'active', trial_start: null, trial_end: null });
    stripeSubscription(sub);
    await handleSubscriptionUpserted(sub, true);
    expect(posthog.nazwy()).toEqual(['subscription_created']);
  });

  it('zmiana subskrypcji (updated) nie startuje próby drugi raz', async () => {
    const sub = subscription();
    stripeSubscription(sub);
    await handleSubscriptionUpserted(sub, false);
    expect(posthog.messages).toEqual([]);
  });

  it('opóźnione „created” po rezygnacji: próba naprawdę się zaczęła, ale nowej subskrypcji nie ogłaszamy', async () => {
    const sub = subscription({ status: 'canceled' });
    stripeSubscription(sub);
    await handleSubscriptionUpserted(sub, true);
    expect(posthog.nazwy()).toEqual(['trial_started']);
  });

  it('właściciel bez zgody: bez zdarzenia (webhook nie ma ciasteczek, zgoda z bazy)', async () => {
    seed({ analytics_consent: 'denied' });
    const sub = subscription();
    stripeSubscription(sub);
    await handleSubscriptionUpserted(sub, true);
    expect(posthog.messages).toEqual([]);
  });

  it('awaria analityki nie zamienia webhooka w 500', async () => {
    db.failures['users:select'] = { code: '08006', message: 'zerwane' };
    const sub = subscription();
    stripeSubscription(sub);
    await expect(handleSubscriptionUpserted(sub, true)).resolves.toBeUndefined();
  });
});

describe('payment_succeeded', () => {
  const FIRST_PAID = '2026-12-01T10:00:00.000Z';
  const SECOND_PAID = '2027-01-01T10:00:00.000Z';

  it('pierwsza prawdziwa płatność: first_payment=true, chwila ze Stripe, ponowienie sklejone', async () => {
    mapPayment('in_1', 2999, FIRST_PAID);
    await handleInvoicePaymentSucceeded(invoice('in_1', 2999));
    await handleInvoicePaymentSucceeded(invoice('in_1', 2999));

    const events = posthog.sklejone('payment_succeeded');
    expect(events).toHaveLength(1);
    expect(events[0]!.properties).toMatchObject({ first_payment: true, source: 'tiktok' });
    expect(events[0]!.timestamp?.toISOString()).toBe(FIRST_PAID);
    expect(JSON.stringify(events[0])).not.toContain('in_1');
  });

  it('kolejna płatność: first_payment=false, osobne zdarzenie', async () => {
    seed({}, [paymentRow('in_1', 2999, FIRST_PAID)]);
    mapPayment('in_2', 2999, SECOND_PAID);
    await handleInvoicePaymentSucceeded(invoice('in_2', 2999));
    expect(posthog.messages[0]!.properties).toMatchObject({ first_payment: false });
  });

  it('ponowienie pierwszej płatności po przyjściu kolejnej: flaga dalej true', async () => {
    seed({}, [paymentRow('in_1', 2999, FIRST_PAID), paymentRow('in_2', 2999, SECOND_PAID)]);
    mapPayment('in_1', 2999, FIRST_PAID);
    await handleInvoicePaymentSucceeded(invoice('in_1', 2999));
    expect(posthog.messages[0]!.properties).toMatchObject({ first_payment: true });
  });

  it('wcześniejsza faktura 0 zł z próby nie zabiera flagi pierwszej płatności', async () => {
    seed({}, [paymentRow('in_0', 0, '2026-11-01T10:00:00.000Z')]);
    mapPayment('in_1', 2999, FIRST_PAID);
    await handleInvoicePaymentSucceeded(invoice('in_1', 2999));
    expect(posthog.messages[0]!.properties).toMatchObject({ first_payment: true });
  });

  it('zwrócona wcześniej płatność dalej była płatnością', async () => {
    seed({}, [paymentRow('in_1', 2999, FIRST_PAID, 'refunded')]);
    mapPayment('in_2', 2999, SECOND_PAID);
    await handleInvoicePaymentSucceeded(invoice('in_2', 2999));
    expect(posthog.messages[0]!.properties).toMatchObject({ first_payment: false });
  });

  it('faktura 0 zł z próby: bez zdarzenia', async () => {
    mapPayment('in_0', 0, FIRST_PAID);
    await handleInvoicePaymentSucceeded(invoice('in_0', 0));
    expect(posthog.sklejone('payment_succeeded')).toEqual([]);
  });

  it('nieudany odczyt historii: płatność i tak się liczy, tylko bez flagi', async () => {
    mapPayment('in_1', 2999, FIRST_PAID);
    h.wrapClient = (client) => {
      const real = client as ReturnType<typeof lejekClient>;
      return {
        ...real,
        from: (table: string) => {
          const q = real.from(table);
          if (table !== 'stripe_payments') return q;
          return Object.assign(q, { gt: () => { throw new Error('odczyt padł'); } });
        },
      };
    };
    await handleInvoicePaymentSucceeded(invoice('in_1', 2999));
    expect(posthog.messages[0]!.event).toBe('payment_succeeded');
    expect(posthog.messages[0]!.properties).not.toHaveProperty('first_payment');
  });

  it('bez zgody: płatność zapisana, zdarzenia brak', async () => {
    seed({ analytics_consent: null });
    mapPayment('in_1', 2999, FIRST_PAID);
    await handleInvoicePaymentSucceeded(invoice('in_1', 2999));
    expect(db.tables.stripe_payments).toHaveLength(1);
    expect(posthog.messages).toEqual([]);
  });
});

describe('odejście: powód z chwili końca subskrypcji', () => {
  const PAID = paymentRow('in_1', 2999, '2026-12-01T10:00:00.000Z');
  const ENDED = TRIAL_END + 60 * 86400;

  it('rezygnacja po płatnościach: subscription_canceled z powodem, ponowienie sklejone', async () => {
    seed({}, [PAID]);
    const sub = subscription({
      status: 'canceled', canceled_at: ENDED - 3600, ended_at: ENDED,
      cancellation_details: { reason: 'cancellation_requested' },
    });
    stripeSubscription(sub);

    await handleSubscriptionDeleted(sub);
    await handleSubscriptionDeleted(sub);

    const events = posthog.sklejone();
    expect(events.map((m) => m.event)).toEqual(['subscription_canceled']);
    expect(events[0]!.properties).toMatchObject({ reason: 'canceled', source: 'tiktok', $set: { plan: 'canceled' } });
    expect(events[0]!.timestamp?.toISOString()).toBe(new Date(ENDED * 1000).toISOString());
  });

  it('nieudane płatności po okresie płatnym: payment_churn', async () => {
    seed({}, [PAID]);
    const sub = subscription({
      status: 'canceled', canceled_at: ENDED, ended_at: ENDED,
      cancellation_details: { reason: 'payment_failed' },
    });
    stripeSubscription(sub);
    await handleSubscriptionDeleted(sub);
    expect(posthog.nazwy()).toEqual(['payment_churn']);
    expect(posthog.messages[0]!.properties).toMatchObject({ reason: 'payment_failed' });
  });

  it.each([
    ['rezygnacja w trakcie próby', 'cancellation_requested'],
    ['nieudane pierwsze obciążenie po próbie', 'payment_failed'],
  ])('%s, bez żadnej płatności: trial_ended, nie rezygnacja', async (_name, reason) => {
    const sub = subscription({
      status: 'canceled', canceled_at: TRIAL_END, ended_at: TRIAL_END,
      cancellation_details: { reason },
    });
    stripeSubscription(sub);
    await handleSubscriptionDeleted(sub);
    expect(posthog.nazwy()).toEqual(['trial_ended']);
    expect(posthog.messages[0]!.properties).toMatchObject({ reason: 'trial_no_payment', converted: false });
  });

  it('płatność 0 zł z próby nie robi z firmy płacącej', async () => {
    seed({}, [paymentRow('in_0', 0, '2026-11-01T10:00:00.000Z')]);
    const sub = subscription({ status: 'canceled', canceled_at: TRIAL_END, ended_at: TRIAL_END });
    stripeSubscription(sub);
    await handleSubscriptionDeleted(sub);
    expect(posthog.nazwy()).toEqual(['trial_ended']);
  });

  it('subskrypcja bez próby i bez płatności: rezygnacja', async () => {
    const sub = subscription({ status: 'canceled', trial_start: null, trial_end: null, canceled_at: ENDED, ended_at: ENDED });
    stripeSubscription(sub);
    await handleSubscriptionDeleted(sub);
    expect(posthog.nazwy()).toEqual(['subscription_canceled']);
  });

  it('właściciel bez zgody: subskrypcja zamknięta, zdarzenia brak', async () => {
    seed({ analytics_consent: 'denied' }, [PAID]);
    const sub = subscription({ status: 'canceled', canceled_at: ENDED, ended_at: ENDED });
    stripeSubscription(sub);
    await handleSubscriptionDeleted(sub);
    expect(posthog.messages).toEqual([]);
  });
});
