import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(), claims: vi.fn(), mfa: vi.fn(),
  claim: vi.fn(), finalize: vi.fn(), handler: vi.fn(),
  captureException: vi.fn(), captureMessage: vi.fn(), network: vi.fn(),
}));
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.create }));
vi.mock('@/lib/auth/verified-mfa', () => ({ getVerifiedMfaState: mocks.mfa }));
vi.mock('@sentry/nextjs', () => ({
  captureException: mocks.captureException, captureMessage: mocks.captureMessage,
}));
vi.mock('@/lib/stripe/client', async () => {
  const { default: Sdk } = await import('stripe');
  // Real local signature verification; no API client, key or transport.
  return { getStripe: () => ({ webhooks: Sdk.webhooks }) };
});
vi.mock('@/lib/stripe/webhook-store', () => ({
  tryClaimWebhookEvent: mocks.claim, finalizeWebhookEvent: mocks.finalize,
}));
vi.mock('@/lib/stripe/webhook-handlers', () => ({
  handleSubscriptionUpserted: mocks.handler,
  handleSubscriptionDeleted: mocks.handler,
  handleInvoicePaymentFailed: mocks.handler,
  handleInvoicePaymentSucceeded: mocks.handler,
  handleTrialWillEnd: mocks.handler,
}));

import { config, proxy } from '@/proxy';
import { POST } from '@/app/api/stripe/webhook/route';

const endpoint = '/api/stripe/webhook';
const origin = 'https://app.example.test';
const signingSecret = 'synthetic-local-webhook-signing-fixture';
const event = {
  id: 'evt_local_fixture', type: 'customer.subscription.created',
  data: { object: { id: 'sub_local_fixture' } },
};
const body = JSON.stringify(event);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', signingSecret);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-local-anon-fixture');
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
  mocks.claims.mockResolvedValue({ data: null, error: null });
  mocks.create.mockReturnValue({ auth: { getClaims: mocks.claims } });
  mocks.claim.mockResolvedValue({ state: 'claimed', token: '11111111-1111-4111-8111-111111111111' });
  mocks.finalize.mockResolvedValue(undefined);
  mocks.handler.mockResolvedValue(undefined);
  mocks.network.mockImplementation(() => { throw new Error('Unexpected network request in local test'); });
  vi.stubGlobal('fetch', mocks.network);
});
afterEach(() => {
  expect(mocks.network).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function signedHeader(payload = body, secret = signingSecret, timestamp?: number) {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
}

function request(signature?: string, payload = body) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (signature !== undefined) headers.set('stripe-signature', signature);
  return new NextRequest(origin + endpoint, { method: 'POST', headers, body: payload });
}

async function throughProxy(req: NextRequest) {
  // Model the Next routing boundary: only a continuation reaches the handler.
  expect(unstable_doesMiddlewareMatch({ config, url: req.url })).toBe(true);
  const gate = await proxy(req);
  return gate.headers.get('x-middleware-next') === '1' ? POST(req) : gate;
}

describe('Stripe webhook through the real application proxy', () => {
  it('accepts a valid signed delivery without any user cookies', async () => {
    const req = request(signedHeader());
    expect(req.cookies.getAll()).toEqual([]);
    const response = await throughProxy(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, eventId: event.id });
    expect(mocks.claim).toHaveBeenCalledWith(event.id, event.type, event);
    expect(mocks.handler).toHaveBeenCalledWith(event.data.object, true);
    expect(mocks.finalize).toHaveBeenCalledWith(event.id, '11111111-1111-4111-8111-111111111111', 'processed');
    expect(mocks.mfa).not.toHaveBeenCalled();
  });

  it.each([
    '/api/stripe', '/api/stripe/checkout', '/api/stripe/portal',
    '/api/stripe/webhook/child', '/api/stripe/webhook-extra', '/api/stripe/webhook/',
  ])('keeps adjacent or nested Stripe paths private: %s', async (path) => {
    const req = new NextRequest(origin + path, { method: 'POST' });
    expect(unstable_doesMiddlewareMatch({ config, url: req.url })).toBe(true);
    const response = await proxy(req);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'not_authenticated' });
    expect(response.headers.get('x-middleware-next')).toBeNull();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('still rejects a missing signature before database or billing effects', async () => {
    const response = await throughProxy(request());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing stripe-signature' });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it.each(['wrong secret', 'tampered body', 'expired signature'] as const)(
    'rejects %s with real Stripe verification after the proxy', async (scenario) => {
      const signature = scenario === 'wrong secret'
        ? signedHeader(body, 'different-synthetic-fixture')
        : signedHeader(body, signingSecret, scenario === 'expired signature'
          ? Math.floor(Date.now() / 1000) - 600 : undefined);
      const payload = scenario === 'tampered body' ? body.replace(event.id, 'evt_tampered') : body;
      const response = await throughProxy(request(signature, payload));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid signature' });
      expect(mocks.claim).not.toHaveBeenCalled();
      expect(mocks.handler).not.toHaveBeenCalled();
      expect(mocks.finalize).not.toHaveBeenCalled();
      expect(mocks.captureException).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the webhook signing secret is absent', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');
    const response = await throughProxy(request(signedHeader()));
    expect(response.status).toBe(500);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.handler).not.toHaveBeenCalled();
  });
});
