/**
 * Stripe Checkout Session (Faza 25 Krok 2).
 *
 * The per-tenant database attempt is claimed before sessions.create. An open
 * Session can outlive an hourly idempotency key; an ambiguous provider response
 * must never be retried with a new key or released by a clock.
 *
 * BLIK obok karty (`STRIPE_BLIK_RECURRING=on`, docs/runbooks/stripe-blik.md):
 * wyłączony przełącznik wysyła dokładnie żądanie sprzed BLIK-a. Włączony dokłada
 * listę metod i wersję API na to jedno żądanie. Odmowa pewna (Stripe odrzucił
 * żądanie, Session nie powstała) nie zatrzymuje próby: jedno ponowienie tylko
 * z kartą w tym samym claimie. Wynik niepewny nadal kończy się stanem „uncertain”.
 */

import * as Sentry from '@sentry/nextjs';
import { TRIAL_DAYS } from '@/lib/billing/pricing';
import { isBlikAvailable } from '@/lib/billing/trial-payment';
import type Stripe from 'stripe';

import { logAuditSystem } from '@/lib/audit/log-system';
import { BLIK_API_VERSION } from './blik-api-version';
import { getActiveSubscription } from './subscription';
import { getStripe } from './client';
import { ensureStripeCustomer } from './customer';
import { getConfiguredStripePriceIds } from './event-mapping';
import {
  abandonCheckoutAttempt,
  claimCheckoutAttempt,
  holdCheckoutAttempt,
  recordCheckoutSession,
  retireCompletedCheckoutAttempt,
  settleCheckoutSession,
  type ExistingCheckoutClaim,
} from './checkout-store';

export type CheckoutPlan = 'monthly' | 'annual';

export interface CreateCheckoutInput {
  tenantId: string;
  /** Owner email — primary contact (Stripe wymaga). */
  email: string;
  tenantName?: string;
  nip?: string;
  plan: CheckoutPlan;
  /** Base URL do redirectu — np. https://faktway.pl. */
  baseUrl: string;
  /**
   * Klient widział ujawnienia BLIK-a przed przekierowaniem. Bez tego (albo przy
   * wyłączonym `STRIPE_BLIK_RECURRING`) Checkout idzie żądaniem jak przed BLIK-iem.
   */
  offerBlik?: boolean;
}

function resolvePriceId(plan: CheckoutPlan): string {
  if (plan !== 'monthly' && plan !== 'annual') {
    throw new Error('Invalid Stripe checkout plan');
  }
  return getConfiguredStripePriceIds()[plan];
}

function stripeCustomerId(
  value: Stripe.Checkout.Session['customer'],
): string | null {
  if (typeof value === 'string') return value;
  return value?.id ?? null;
}

function hasCheckoutUrl(url: string | null): url is string {
  if (!url) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

async function preflightClaimedAttempt(
  stripe: Stripe,
  customerId: string,
  attemptId: string,
): Promise<void> {
  // This is after the DB claim, so another new-code request for this tenant
  // cannot pass the same preflight and create a second Session.
  let subscriptions: Stripe.ApiList<Stripe.Subscription>;
  try {
    subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 100,
    });
  } catch (error) {
    await abandonCheckoutAttempt(attemptId);
    throw error;
  }
  if (subscriptions.has_more || subscriptions.data.some(
    (subscription) =>
      subscription.status !== 'canceled' &&
      subscription.status !== 'incomplete_expired',
  )) {
    await abandonCheckoutAttempt(attemptId);
    throw new Error('Stripe customer already has a nonterminal subscription');
  }

  // Sessions created by the old code have no database claim. Until those are
  // reconciled, no new Session may be created for this Customer.
  let sessions: Stripe.ApiList<Stripe.Checkout.Session>;
  try {
    sessions = await stripe.checkout.sessions.list({
      customer: customerId,
      status: 'open',
      limit: 100,
    });
  } catch (error) {
    await abandonCheckoutAttempt(attemptId);
    throw error;
  }
  if (sessions.has_more || sessions.data.length > 0) {
    await holdCheckoutAttempt(attemptId, 'creating', 'held');
    throw new Error('Existing open Stripe Checkout Session requires reconciliation');
  }
}

function matchesCheckoutSession(
  session: Stripe.Checkout.Session,
  claim: ExistingCheckoutClaim,
  input: CreateCheckoutInput,
  customerId: string,
): boolean {
  return session.id === claim.sessionId &&
    stripeCustomerId(session.customer) === customerId &&
    session.mode === 'subscription' &&
    session.client_reference_id === claim.attemptId &&
    session.metadata?.attemptId === claim.attemptId &&
    session.metadata?.tenantId === input.tenantId &&
    session.metadata?.plan === claim.plan;
}

async function inspectOpenAttempt(
  stripe: Stripe,
  claim: ExistingCheckoutClaim,
  input: CreateCheckoutInput,
  customerId: string,
): Promise<{ sessionId: string; url: string } | 'expired' | 'completed'> {
  if (claim.customerId !== customerId || !claim.sessionId) {
    throw new Error('Existing Checkout attempt Customer or Session mismatch');
  }

  // A failed retrieval leaves the open claim intact. A Session is never
  // released solely because its stored expiry timestamp has passed.
  const session = await stripe.checkout.sessions.retrieve(claim.sessionId);
  if (!matchesCheckoutSession(session, claim, input, customerId)) {
    await holdCheckoutAttempt(claim.attemptId, 'open', 'held');
    throw new Error('Existing Stripe Checkout Session identity mismatch');
  }

  if (session.status === 'expired') {
    await settleCheckoutSession(claim.attemptId, session.id, 'expired');
    return 'expired';
  }
  if (session.status === 'complete') {
    await settleCheckoutSession(claim.attemptId, session.id, 'completed');
    return 'completed';
  }
  if (session.status !== 'open' || !hasCheckoutUrl(session.url)) {
    await holdCheckoutAttempt(claim.attemptId, 'open', 'held');
    throw new Error('Existing Stripe Checkout Session requires reconciliation');
  }
  if (claim.plan !== input.plan || claim.priceId !== resolvePriceId(input.plan)) {
    // A deliberate plan switch expires the old provider Session first. If
    // Stripe times out or the Session completes concurrently, keep the claim.
    const expired = await stripe.checkout.sessions.expire(session.id);
    if (!matchesCheckoutSession(expired, claim, input, customerId) ||
        expired.status !== 'expired') {
      await holdCheckoutAttempt(claim.attemptId, 'open', 'held');
      throw new Error('Stripe Checkout Session expiry was not verified');
    }
    await settleCheckoutSession(claim.attemptId, session.id, 'expired');
    return 'expired';
  }
  return { sessionId: session.id, url: session.url };
}

async function reconcileCompletedAttempt(
  stripe: Stripe,
  claim: ExistingCheckoutClaim,
  input: CreateCheckoutInput,
  customerId: string,
): Promise<void> {
  if (claim.customerId !== customerId || !claim.sessionId) {
    throw new Error('Completed Checkout attempt identity mismatch');
  }
  const session = await stripe.checkout.sessions.retrieve(claim.sessionId);
  if (!matchesCheckoutSession(session, claim, input, customerId) ||
      session.status !== 'complete') {
    throw new Error('Completed Checkout Session requires reconciliation');
  }
  const subscriptionId = typeof session.subscription === 'string'
    ? session.subscription : session.subscription?.id;
  if (!subscriptionId || !subscriptionId.startsWith('sub_')) {
    throw new Error('Completed Checkout has no confirmed Subscription ID');
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const subscriptionCustomerId = typeof subscription.customer === 'string'
    ? subscription.customer : subscription.customer?.id;
  if (subscription.id !== subscriptionId ||
      subscriptionCustomerId !== customerId ||
      (subscription.status !== 'canceled' &&
        subscription.status !== 'incomplete_expired')) {
    throw new Error('Completed Checkout Subscription is not terminal');
  }

  // All known Stripe subscriptions and open Sessions must be accounted for
  // before the local completed hold can be retired. An incomplete list blocks.
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 100,
  });
  if (subscriptions.has_more || subscriptions.data.some(
    (item) =>
      item.status !== 'canceled' &&
      item.status !== 'incomplete_expired',
  )) {
    throw new Error('Stripe customer has another nonterminal Subscription');
  }
  const openSessions = await stripe.checkout.sessions.list({
    customer: customerId,
    status: 'open',
    limit: 100,
  });
  if (openSessions.has_more || openSessions.data.length > 0) {
    throw new Error('Stripe customer has another open Checkout Session');
  }

  // The RPC independently confirms the exact terminal local mirror under
  // the tenant row lock. A failed/lost response leaves the hold in place.
  await retireCompletedCheckoutAttempt(
    claim.attemptId, session.id, subscriptionId,
  );
}

/**
 * Parametr z referencji API 2026-09-30.endive. Ta wersja usunęła
 * `payment_method_types` z tworzenia Session (400), a stripe-node 22.1.1 ma typy
 * z 2026-04-22.dahlia i `allowed_payment_method_types` jeszcze nie zna. Zawężamy
 * tylko tutaj: nazwę i wartości sprawdza test na poziomie HTTP.
 */
type BlikSessionCreateParams = Stripe.Checkout.SessionCreateParams & {
  allowed_payment_method_types: Array<'card' | 'blik'>;
};

/**
 * Odmowa pewna: Stripe przeczytał żądanie i odrzucił je przed utworzeniem Session.
 * 400/404 to `StripeInvalidRequestError`, 403 to `StripePermissionError`. Patrzymy
 * na typ, nie na `code`, bo odmowa metody płatności nie ma stałego kodu: bywa bez
 * niego (tylko `param`), z `payment_method_unactivated` albo `capability_not_active`.
 * Klucz idempotencji w użyciu, 429, 5xx i zerwane połączenie zostają niepewne.
 */
function isCertainStripeRefusal(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const type = (error as { type?: unknown }).type;
  return type === 'StripeInvalidRequestError' || type === 'StripePermissionError';
}

/**
 * Sygnał dla operatora. Nigdy nie rzuca: nie może zmienić wyniku tworzenia Session.
 * `audit_logs.entity_id` to UUID, więc idzie tu identyfikator próby, nie Session:
 * wiersz z `cs_…` baza by odrzuciła.
 */
async function reportBlikUnavailable(
  input: CreateCheckoutInput,
  attemptId: string,
  reason: 'refused' | 'filtered',
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await logAuditSystem({
      action: 'billing.checkout.blik_unavailable',
      tenantId: input.tenantId,
      userId: null,
      entityType: 'stripe_checkout_attempt',
      entityId: attemptId,
      metadata: { reason, attemptId, ...details },
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: 'billing.audit' },
      extra: { attemptId, tenantId: input.tenantId },
    });
  }
}

/**
 * Tworzy Session wariantem z BLIK-iem. Każda lista parametrów ma własny klucz
 * idempotencji, bo Stripe odrzuca ten sam klucz z innymi parametrami. Oba klucze
 * są stałe dla tego claimu, więc automatyczne powtórzenie SDK niczego nie dubluje.
 */
async function createBlikSession(
  stripe: Stripe,
  params: Stripe.Checkout.SessionCreateParams,
  input: CreateCheckoutInput,
  attemptId: string,
): Promise<Stripe.Checkout.Session> {
  const blikParams: BlikSessionCreateParams = {
    ...params,
    allowed_payment_method_types: ['card', 'blik'],
  };
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(blikParams, {
      idempotencyKey: 'faktflow-checkout-blik-v1:' + attemptId,
      apiVersion: BLIK_API_VERSION,
    });
  } catch (error) {
    if (!isCertainStripeRefusal(error)) throw error;
    const { statusCode, code, param } = error as {
      statusCode?: number;
      code?: string;
      param?: string;
    };
    Sentry.captureException(error, {
      tags: { area: 'billing.checkout.blik' },
      extra: { attemptId, tenantId: input.tenantId, statusCode, code, param },
    });
    await reportBlikUnavailable(input, attemptId, 'refused', {
      statusCode: statusCode ?? null,
      stripeCode: code ?? null,
      stripeParam: param ?? null,
    });
    // Wersja API klienta i jej parametr: to ponowienie nie zależy od niczego,
    // co mogło zawieść w wariancie z BLIK-iem. Przy podniesieniu globalnej wersji
    // do endive trzeba tu przejść na `allowed_payment_method_types`.
    return stripe.checkout.sessions.create({
      ...params,
      payment_method_types: ['card'],
    }, {
      idempotencyKey: 'faktflow-checkout-card-v1:' + attemptId,
    });
  }

  // `allowed_payment_method_types` to filtr: BLIK nieaktywny na koncie znika bez
  // błędu, a `payment_method_types` w odpowiedzi mówi, co klient naprawdę zobaczy.
  // Session z samą kartą jest poprawna, operator ma się tylko o tym dowiedzieć.
  if (!session.payment_method_types?.includes('blik')) {
    Sentry.captureMessage('Stripe Checkout offered no BLIK despite STRIPE_BLIK_RECURRING=on', {
      level: 'warning',
      tags: { area: 'billing.checkout.blik' },
      extra: { attemptId, tenantId: input.tenantId, offered: session.payment_method_types ?? null },
    });
    await reportBlikUnavailable(input, attemptId, 'filtered', {
      offeredPaymentMethods: session.payment_method_types ?? null,
    });
  }
  return session;
}

async function createClaimedSession(
  stripe: Stripe,
  input: CreateCheckoutInput,
  customerId: string,
  priceId: string,
  attemptId: string,
): Promise<{ sessionId: string; url: string }> {
  await preflightClaimedAttempt(stripe, customerId, attemptId);

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    customer: customerId,
    client_reference_id: attemptId,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: TRIAL_DAYS,
      metadata: {
        tenantId: input.tenantId,
        plan: input.plan,
      },
    },
    automatic_tax: { enabled: false },
    allow_promotion_codes: true,
    success_url: input.baseUrl +
      '/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: input.baseUrl + '/settings/billing?checkout=canceled',
    metadata: {
      tenantId: input.tenantId,
      plan: input.plan,
      attemptId,
    },
    invoice_creation: undefined,
  };
  const offerBlik = input.offerBlik === true && isBlikAvailable();

  let session: Stripe.Checkout.Session;
  try {
    session = offerBlik
      ? await createBlikSession(stripe, params, input, attemptId)
      : await stripe.checkout.sessions.create(params, {
          // Stable for this one durable attempt; contains no tenant PII or ID.
          idempotencyKey: 'faktflow-checkout-v2:' + attemptId,
        });

    if (!session.id.startsWith('cs_') ||
        stripeCustomerId(session.customer) !== customerId ||
        session.mode !== 'subscription' ||
        session.status !== 'open' ||
        session.client_reference_id !== attemptId ||
        session.metadata?.attemptId !== attemptId ||
        session.metadata?.tenantId !== input.tenantId ||
        session.metadata?.plan !== input.plan ||
        !hasCheckoutUrl(session.url) ||
        !Number.isSafeInteger(session.expires_at) ||
        session.expires_at <= Math.floor(Date.now() / 1000)) {
      throw new Error('Stripe Checkout Session response is incomplete or mismatched');
    }

    // If this write is uncertain, the creating claim remains blocking. A
    // later caller must inspect it; it cannot create a fresh Session.
    await recordCheckoutSession(attemptId, session.id, session.expires_at);
  } catch (error) {
    try {
      await holdCheckoutAttempt(attemptId, 'creating', 'uncertain');
    } catch (holdError) {
      // Record may in fact have committed despite a lost response. In that
      // case open still blocks another create; do not overwrite it.
      Sentry.captureException(holdError, {
        tags: { area: 'billing.checkout.hold' },
        extra: { tenantId: input.tenantId, attemptId },
      });
    }
    throw error;
  }

  try {
    await logAuditSystem({
      action: 'billing.checkout.session_created',
      tenantId: input.tenantId,
      userId: null,
      entityType: 'stripe_session',
      entityId: session.id,
      metadata: {
        plan: input.plan,
        customerId,
        amountCents: session.amount_total ?? null,
        currency: session.currency ?? 'pln',
        attemptId,
      },
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: 'billing.audit' },
      extra: { sessionId: session.id, tenantId: input.tenantId },
    });
  }

  // url has been checked in the response validation above.
  return { sessionId: session.id, url: session.url as string };
}

export async function createCheckoutSession(
  input: CreateCheckoutInput,
): Promise<{ sessionId: string; url: string }> {
  const priceId = resolvePriceId(input.plan);
  const stripe = getStripe();

  // Fast user feedback; the claim RPC checks the local mirror again under the
  // tenant lock because this read may race a subscription webhook.
  if (await getActiveSubscription(input.tenantId)) {
    throw new Error('Tenant already has a nonterminal subscription');
  }

  const { customerId } = await ensureStripeCustomer({
    tenantId: input.tenantId,
    email: input.email,
    name: input.tenantName,
    nip: input.nip,
  });

  // At most one retry after a provider-confirmed expired Session. Never loop
  // or take over a creating/uncertain claim.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claim = await claimCheckoutAttempt(
      input.tenantId, customerId, priceId, input.plan,
    );
    if (claim.state === 'subscription') {
      throw new Error('Tenant already has a nonterminal subscription');
    }
    if (claim.state === 'claimed') {
      return createClaimedSession(stripe, input, customerId, priceId, claim.attemptId);
    }
    if (claim.state === 'open') {
      const existing = await inspectOpenAttempt(stripe, claim, input, customerId);
      if (existing !== 'expired' && existing !== 'completed') return existing;
      continue;
    }
    if (claim.state === 'completed') {
      await reconcileCompletedAttempt(stripe, claim, input, customerId);
      continue;
    }
    if (claim.state === 'creating') {
      throw new Error('Checkout Session creation is already in progress');
    }
    throw new Error('Checkout attempt requires manual reconciliation');
  }
  throw new Error('Checkout expiry transition could not be confirmed');
}
