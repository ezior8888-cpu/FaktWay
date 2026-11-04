/**
 * Stripe webhook endpoint (Faza 25 Krok 3).
 *
 * Setup w Stripe Dashboard → Webhooks → Add endpoint:
 *   URL:  https://faktway.pl/api/stripe/webhook
 *   Events: subscribe TYLKO do tych których obsługujemy (lista w `HANDLED_EVENTS`).
 *
 * Bezpieczeństwo:
 *   1. **Signature verification** przez `stripe.webhooks.constructEvent` z raw body.
 *      Bez tego ktoś z internetu mógłby spamować nasze handlery payload'ami.
 *   2. **Idempotency** przez atomowy claim zdarzenia + token właściciela.
 *      Przetworzone duplikaty pomijamy; zajęte zgłaszamy do ponowienia.
 *   3. **Runtime: nodejs** — weryfikacja podpisu wymaga surowego body.
 *
 * Performance:
 *   - Stripe oczekuje 200 OK w < 5s — handlery powinny być szybkie. Długie
 *     operacje (self-invoicing przez KSeF — Krok 4) idą do Inngest async.
 *   - Podpis sprawdzamy przed dotknięciem bazy. Claim wykonujemy przed handlerem.
 */

import { NextResponse } from 'next/server';
import type Stripe from 'stripe';

import * as Sentry from '@sentry/nextjs';

import { getStripe } from '@/lib/stripe/client';
import { handleCheckoutSessionStateEvent } from '@/lib/stripe/checkout-reconcile';
import { handleFinancialStripeEvent } from '@/lib/stripe/financial-events';
import { ReconciliationRequiredWebhookError, RetryablePreEffectWebhookError } from '@/lib/stripe/webhook-errors';
import {
  handleInvoicePaymentFailed,
  handleInvoicePaymentSucceeded,
  handleSubscriptionDeleted,
  handleSubscriptionUpserted,
  handleTrialWillEnd,
} from '@/lib/stripe/webhook-handlers';
import {
  finalizeWebhookEvent,
  tryClaimWebhookEvent,
} from '@/lib/stripe/webhook-store';

export const runtime = 'nodejs';
// Webhook zawsze odczytuje bieżące żądanie i nie może być cachowany.
export const dynamic = 'force-dynamic';

const HANDLED_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.expired',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.trial_will_end',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'refund.created',
  'refund.updated',
  'refund.failed',
  'charge.refund.updated',
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
]);

export async function POST(req: Request): Promise<Response> {
  const stripeSignature = req.headers.get('stripe-signature');
  if (!stripeSignature) {
    return NextResponse.json({ error: 'Missing stripe-signature' }, { status: 400 });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    Sentry.captureMessage('Stripe webhook received but STRIPE_WEBHOOK_SECRET missing', {
      level: 'error',
    });
    return NextResponse.json(
      { error: 'Webhook secret not configured' },
      { status: 500 },
    );
  }

  // Raw body wymagane do signature verify. `req.text()` nie parsuje JSON.
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, stripeSignature, webhookSecret);
  } catch {
    // Zła signature = bezpieczeństwo, nie hałasujmy w Sentry per request
    // (atakujący mógłby zalać error tracking).
    return NextResponse.json(
      {
        error: 'Invalid signature',
      },
      { status: 400 },
    );
  }

  // Skip unhandled event types — Stripe może wysyłać więcej niż subskrybujemy
  // jeśli ktoś w dashboard zmieni listę. Tylko 200 OK + komentarz.
  if (!HANDLED_EVENTS.has(event.type)) {
    return NextResponse.json({ skipped: true, type: event.type });
  }

  // Claim w bazie jest atomowy. Zajętej próby nie wykonujemy drugi raz, ale
  // nie potwierdzamy jej Stripe jako zakończonej.
  let claim: Awaited<ReturnType<typeof tryClaimWebhookEvent>>;
  try {
    claim = await tryClaimWebhookEvent(event.id, event.type, event);
  } catch (err) {
    const errorId = Sentry.captureException(err, { tags: { area: 'stripe.webhook.idempotency' } });
    return NextResponse.json({ error: 'Idempotency check failed', errorId }, { status: 500 });
  }
  if (claim.state === 'processed') {
    return NextResponse.json({ duplicate: true, eventId: event.id });
  }
  if (claim.state === 'busy') {
    return NextResponse.json(
      { error: 'Webhook processing in progress' },
      { status: 503, headers: { 'Retry-After': '60' } },
    );
  }

  // Błąd handlera może oznaczać częściowe skutki uboczne. Zapisujemy bezpieczny
  // kod błędu i oddajemy 500, by Stripe ponowił dostawę.
  try {
    await dispatch(event);
  } catch (err) {
    const errorId = Sentry.captureException(err, {
      tags: { area: 'stripe.webhook.dispatch', eventType: event.type },
      extra: { eventId: event.id },
    });
    try {
      await finalizeWebhookEvent(
        event.id,
        claim.token,
        err instanceof RetryablePreEffectWebhookError ? 'retryable' : 'failed',
        err instanceof RetryablePreEffectWebhookError ||
        err instanceof ReconciliationRequiredWebhookError
          ? err.code : 'handler_failed',
      );
    } catch (finalizeError) {
      Sentry.captureException(finalizeError, {
        tags: { area: 'stripe.webhook.finalize' },
        extra: { eventId: event.id },
      });
    }
    return NextResponse.json(
      { error: 'Handler failed', errorId },
      { status: 500 },
    );
  }

  // Finalizacja po udanym handlerze jest odrębną granicą. Jej błąd nie może
  // zmienić poprawnie wykonanego handlera na failed i uruchomić go ponownie.
  try {
    await finalizeWebhookEvent(event.id, claim.token, 'processed');
  } catch (err) {
    const errorId = Sentry.captureException(err, {
      tags: { area: 'stripe.webhook.finalize' },
      extra: { eventId: event.id },
    });
    return NextResponse.json(
      { error: 'Finalization failed', errorId },
      { status: 500 },
    );
  }

  return NextResponse.json({ received: true, eventId: event.id });
}

async function dispatch(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.expired':
      await handleCheckoutSessionStateEvent(event.data.object as Stripe.Checkout.Session);
      return;
    case 'customer.subscription.created':
      await handleSubscriptionUpserted(event.data.object as Stripe.Subscription, true);
      return;
    case 'customer.subscription.updated':
      await handleSubscriptionUpserted(event.data.object as Stripe.Subscription, false);
      return;
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
      return;
    case 'customer.subscription.trial_will_end':
      await handleTrialWillEnd(event.data.object as Stripe.Subscription);
      return;
    case 'invoice.payment_succeeded':
      await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice);
      return;
    case 'invoice.payment_failed':
      await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
      return;
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
    case 'charge.refund.updated':
    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed':
    case 'charge.dispute.funds_withdrawn':
    case 'charge.dispute.funds_reinstated':
      await handleFinancialStripeEvent(event);
      return;
  }
}
