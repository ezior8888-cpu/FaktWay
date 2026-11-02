import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import Stripe from 'stripe';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BLIK obok karty przy próbie (FAKTWAY-1-0, sekcja 3 pkt 5).
 *
 * Prawdziwy klient stripe-node rozmawia z lokalnym serwerem HTTP. Dzięki temu
 * test widzi to, co naprawdę idzie do Stripe (nagłówki `Stripe-Version`
 * i `Idempotency-Key`, ciało formularza), i dostaje prawdziwe klasy błędów SDK.
 * Podmienione są tylko baza (claim, hold, record) i audyt.
 *
 * Reguły z referencji API 2026-09-30.endive i stripe-node 22.1.1:
 *   - ta wersja usunęła `payment_method_types` z tworzenia Session (400),
 *     został `allowed_payment_method_types`, którego typy SDK jeszcze nie znają,
 *   - `allowed_payment_method_types` to filtr: BLIK nieaktywny na koncie znika
 *     z odpowiedzi bez błędu, więc „odmowa” to dwa różne przypadki.
 */

const mocks = vi.hoisted(() => ({
  getStripe: vi.fn(),
  getActiveSubscription: vi.fn(),
  ensureStripeCustomer: vi.fn(),
  claim: vi.fn(),
  record: vi.fn(),
  hold: vi.fn(),
  abandon: vi.fn(),
  settle: vi.fn(),
  retire: vi.fn(),
  audit: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => { throw new Error('redirect:' + path); },
}));
vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: async () => ({
    role: 'owner',
    tenantId: '11111111-1111-4111-8111-111111111111',
    user: { id: 'u-1', email: 'owner@example.test' },
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { name: 'Firma Testowa', nip: '1234567890', stripe_customer_id: 'cus_TestA' },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));
vi.mock('@/lib/auth/sensitive-mfa', () => ({
  assertSensitiveMfa: async () => undefined,
  SensitiveMfaRequiredError: class extends Error {},
}));
vi.mock('@/lib/stripe/customer-email', () => ({ syncStripeCustomerEmail: async () => undefined }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.logAudit }));
vi.mock('@/lib/stripe/client', () => ({
  getStripe: mocks.getStripe,
  isStripeConfigured: () => true,
}));
vi.mock('@/lib/stripe/subscription', () => ({
  getActiveSubscription: mocks.getActiveSubscription,
}));
vi.mock('@/lib/stripe/customer', () => ({
  ensureStripeCustomer: mocks.ensureStripeCustomer,
}));
vi.mock('@/lib/stripe/checkout-store', () => ({
  claimCheckoutAttempt: mocks.claim,
  recordCheckoutSession: mocks.record,
  holdCheckoutAttempt: mocks.hold,
  abandonCheckoutAttempt: mocks.abandon,
  settleCheckoutSession: mocks.settle,
  retireCompletedCheckoutAttempt: mocks.retire,
}));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: mocks.audit }));
vi.mock('@sentry/nextjs', () => ({
  captureException: mocks.captureException,
  captureMessage: mocks.captureMessage,
}));

import { startCheckoutAction } from '@/app/(dashboard)/settings/billing/actions';
import { BLIK_RECURRING_STATEMENT } from '@/lib/legal/versions';
import { createCheckoutSession, type CreateCheckoutInput } from '@/lib/stripe/checkout';

const tenantId = '11111111-1111-4111-8111-111111111111';
const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const customerId = 'cus_TestA';
const sessionId = 'cs_test_TestA';
const DEFAULT_API_VERSION = '2024-11-20.acacia';
const BLIK_API_VERSION = '2026-09-30.endive';
const CARD_KEY = 'faktflow-checkout-v2:' + attemptId;
const CARD_ONLY_KEY = 'faktflow-checkout-card-v1:' + attemptId;

const input: CreateCheckoutInput = {
  tenantId,
  email: 'owner@example.test',
  plan: 'monthly',
  baseUrl: 'https://app.example.test',
};

/** Parametry żądania sprzed BLIK-a. Wyłączony przełącznik ma wysyłać dokładnie to. */
const TODAY_BODY: Record<string, string> = {
  mode: 'subscription',
  customer: customerId,
  client_reference_id: attemptId,
  'line_items[0][price]': 'price_monthly',
  'line_items[0][quantity]': '1',
  'subscription_data[trial_period_days]': '30',
  'subscription_data[metadata][tenantId]': tenantId,
  'subscription_data[metadata][plan]': 'monthly',
  'automatic_tax[enabled]': 'false',
  allow_promotion_codes: 'true',
  success_url: 'https://app.example.test/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}',
  cancel_url: 'https://app.example.test/settings/billing?checkout=canceled',
  'metadata[tenantId]': tenantId,
  'metadata[plan]': 'monthly',
  'metadata[attemptId]': attemptId,
};

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: sessionId,
    object: 'checkout.session',
    url: 'https://checkout.stripe.test/cs_test_TestA',
    mode: 'subscription',
    status: 'open',
    customer: customerId,
    client_reference_id: attemptId,
    metadata: { tenantId, plan: 'monthly', attemptId },
    expires_at: 2_000_000_000,
    amount_total: 0,
    currency: 'pln',
    subscription: null,
    payment_method_types: ['card', 'blik'],
    ...overrides,
  };
}

type Programmed = { status: number; body: unknown } | 'reset';
interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, string>;
}

let server: Server;
let port = 0;
let createResponses: Programmed[] = [];
let seen: SeenRequest[] = [];

const stripeError = (status: number, error: Record<string, unknown>): Programmed => ({
  status,
  body: { error },
});

const createCalls = () =>
  seen.filter((r) => r.method === 'POST' && r.url === '/v1/checkout/sessions');

function bodyWithout(body: Record<string, string>, ...keys: string[]) {
  const rest = { ...body };
  for (const key of keys) delete rest[key];
  return rest;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_test' });
        res.end(JSON.stringify(json));
      };
      if (req.method === 'GET') {
        reply(200, { object: 'list', data: [], has_more: false, url: req.url });
        return;
      }
      const next = createResponses.shift();
      if (!next) {
        reply(500, { error: { type: 'api_error', message: 'Nieoczekiwane żądanie w teście' } });
        return;
      }
      if (next === 'reset') {
        req.socket.destroy();
        return;
      }
      reply(next.status, next.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  seen = [];
  createResponses = [{ status: 200, body: session() }];
  vi.stubEnv('STRIPE_PRICE_MONTHLY', 'price_monthly');
  vi.stubEnv('STRIPE_PRICE_ANNUAL', 'price_annual');
  mocks.getStripe.mockImplementation(() => new Stripe('sk_test_lokalny', {
    apiVersion: DEFAULT_API_VERSION as never,
    host: '127.0.0.1',
    port,
    protocol: 'http',
    maxNetworkRetries: 0,
    timeout: 3_000,
  }));
  mocks.getActiveSubscription.mockResolvedValue(null);
  mocks.ensureStripeCustomer.mockResolvedValue({ customerId, created: false });
  mocks.claim.mockResolvedValue({ state: 'claimed', attemptId });
  mocks.record.mockResolvedValue(undefined);
  mocks.hold.mockResolvedValue(undefined);
  mocks.abandon.mockResolvedValue(undefined);
  mocks.audit.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('przełącznik STRIPE_BLIK_RECURRING wyłączony: żądanie jak dziś', () => {
  it.each([
    ['brak zmiennej', undefined],
    ['pusta zmienna', ''],
    ['„off”', 'off'],
    ['„true” (włącza tylko dokładnie „on”)', 'true'],
    ['„ON” (włącza tylko dokładnie „on”)', 'ON'],
  ])('%s: ten sam klucz, ta sama wersja API, te same parametry', async (_name, value) => {
    if (value !== undefined) vi.stubEnv('STRIPE_BLIK_RECURRING', value);

    // Stara zakładka albo zły klient może prosić o BLIK. Wyłączony przełącznik wygrywa.
    await createCheckoutSession({ ...input, offerBlik: true });

    expect(createCalls()).toHaveLength(1);
    const [request] = createCalls();
    expect(request.headers['idempotency-key']).toBe(CARD_KEY);
    expect(request.headers['stripe-version']).toBe(DEFAULT_API_VERSION);
    expect(request.body).toEqual(TODAY_BODY);
    expect(mocks.record).toHaveBeenCalledWith(attemptId, sessionId, 2_000_000_000);
    expect(mocks.hold).not.toHaveBeenCalled();
  });

  it('audyt utworzenia Session ma te same pola co przed BLIK-iem', async () => {
    await createCheckoutSession(input);

    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'billing.checkout.session_created',
      metadata: {
        plan: 'monthly',
        customerId,
        amountCents: 0,
        currency: 'pln',
        attemptId,
      },
    }));
  });

});

describe('przełącznik włączony: karta i BLIK jawnie, wersja API na to jedno żądanie', () => {
  beforeEach(() => vi.stubEnv('STRIPE_BLIK_RECURRING', 'on'));

  it('wysyła allowed_payment_method_types z wersją endive i własnym kluczem idempotencji', async () => {
    await expect(createCheckoutSession({ ...input, offerBlik: true })).resolves.toEqual({
      sessionId,
      url: 'https://checkout.stripe.test/cs_test_TestA',
    });

    expect(createCalls()).toHaveLength(1);
    const [request] = createCalls();
    expect(request.headers['stripe-version']).toBe(BLIK_API_VERSION);
    expect(request.headers['idempotency-key']).toBe('faktflow-checkout-blik-v1:' + attemptId);
    expect(request.headers['idempotency-key']).not.toBe(CARD_KEY);
    expect(request.headers['idempotency-key']).not.toContain(tenantId);
    expect(request.body['allowed_payment_method_types[0]']).toBe('card');
    expect(request.body['allowed_payment_method_types[1]']).toBe('blik');
    // Endive odrzuca ten parametr kodem 400, a mandat bez daty końca jest bezterminowy.
    expect(Object.keys(request.body).filter((k) => k.startsWith('payment_method_types'))).toEqual([]);
    expect(Object.keys(request.body).filter((k) => k.startsWith('payment_method_options'))).toEqual([]);
    // Reszta parametrów bez zmian: próba, metadane, adresy powrotu.
    expect(bodyWithout(
      request.body,
      'allowed_payment_method_types[0]',
      'allowed_payment_method_types[1]',
    )).toEqual(TODAY_BODY);
    expect(mocks.record).toHaveBeenCalledWith(attemptId, sessionId, 2_000_000_000);
    expect(mocks.hold).not.toHaveBeenCalled();
    expect(mocks.captureMessage).not.toHaveBeenCalled();
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('strona bez potwierdzonych ujawnień: jawnie sama karta, bo bez listy Stripe wziąłby metody z Dashboardu', async () => {
    createResponses = [{ status: 200, body: session({ payment_method_types: ['card'] }) }];

    await expect(createCheckoutSession(input)).resolves.toMatchObject({ sessionId });

    expect(createCalls()).toHaveLength(1);
    const [request] = createCalls();
    expect(request.headers['stripe-version']).toBe(DEFAULT_API_VERSION);
    expect(request.headers['idempotency-key']).toBe(CARD_ONLY_KEY);
    expect(request.body['payment_method_types[0]']).toBe('card');
    expect(request.body['payment_method_types[1]']).toBeUndefined();
    expect(Object.keys(request.body).filter((k) => k.startsWith('allowed_payment_method_types'))).toEqual([]);
    expect(bodyWithout(request.body, 'payment_method_types[0]')).toEqual(TODAY_BODY);
    expect(mocks.record).toHaveBeenCalledWith(attemptId, sessionId, 2_000_000_000);
    expect(mocks.hold).not.toHaveBeenCalled();
    // Sama karta jest tu zamierzona, a nie sygnałem, że Stripe odrzucił BLIK.
    expect(mocks.captureMessage).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'billing.checkout.blik_unavailable',
    }));
  });

  it('strona bez ujawnień i błąd Stripe: hold uncertain, bez ponowienia', async () => {
    createResponses = [stripeError(400, { type: 'invalid_request_error', message: 'No such price' })];

    await expect(createCheckoutSession(input)).rejects.toThrow('No such price');

    expect(createCalls()).toHaveLength(1);
    expect(mocks.hold).toHaveBeenCalledWith(attemptId, 'creating', 'uncertain');
  });

  it('nie zmienia wersji API klienta: odczyty przed tworzeniem idą w starej wersji', async () => {
    await createCheckoutSession({ ...input, offerBlik: true });

    const reads = seen.filter((r) => r.method === 'GET');
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read.headers['stripe-version']).toBe(DEFAULT_API_VERSION);
  });

  it('BLIK odfiltrowany przez Stripe (konto bez aktywnego BLIK-a): Session działa, bez ponowienia, Sentry i audyt', async () => {
    createResponses = [{ status: 200, body: session({ payment_method_types: ['card'] }) }];

    await expect(createCheckoutSession({ ...input, offerBlik: true }))
      .resolves.toMatchObject({ sessionId });

    expect(createCalls()).toHaveLength(1);
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(mocks.hold).not.toHaveBeenCalled();
    expect(mocks.captureMessage).toHaveBeenCalledOnce();
    expect(mocks.captureMessage.mock.calls[0][1]).toMatchObject({
      level: 'warning',
      tags: { area: 'billing.checkout.blik' },
    });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'billing.checkout.blik_unavailable',
      tenantId,
      // `audit_logs.entity_id` to UUID: identyfikator Session (`cs_…`) baza by odrzuciła.
      entityId: attemptId,
      metadata: expect.objectContaining({
        reason: 'filtered',
        attemptId,
        offeredPaymentMethods: ['card'],
      }),
    }));
  });

  it.each([
    ['400 bez kodu, parametr listy metod', 400, {
      type: 'invalid_request_error',
      param: 'allowed_payment_method_types',
      message: 'The payment method type provided: blik is invalid.',
    }],
    ['400 payment_method_unactivated', 400, {
      type: 'invalid_request_error',
      code: 'payment_method_unactivated',
      message: 'The operation cannot be performed.',
    }],
    ['400 nieznana wersja API', 400, {
      type: 'invalid_request_error',
      message: 'Invalid Stripe API version: 2026-09-30.endive',
    }],
    ['403 brak uprawnienia konta', 403, {
      type: 'invalid_request_error',
      code: 'capability_not_active',
      message: 'Your account is missing the active capabilities.',
    }],
  ])('odmowa pewna (%s): jedno ponowienie tylko z kartą, bez stanu uncertain', async (_name, status, error) => {
    const cardSession = session({ id: 'cs_test_TestCard', payment_method_types: ['card'] });
    createResponses = [stripeError(status, error), { status: 200, body: cardSession }];

    await expect(createCheckoutSession({ ...input, offerBlik: true })).resolves.toMatchObject({
      sessionId: 'cs_test_TestCard',
    });

    expect(createCalls()).toHaveLength(2);
    const [, retry] = createCalls();
    // Ponowienie: wersja API klienta, parametr tej wersji i klucz inny niż obie próby.
    expect(retry.headers['stripe-version']).toBe(DEFAULT_API_VERSION);
    expect(retry.headers['idempotency-key']).toBe('faktflow-checkout-card-v1:' + attemptId);
    expect(retry.body['payment_method_types[0]']).toBe('card');
    expect(retry.body['payment_method_types[1]']).toBeUndefined();
    expect(Object.keys(retry.body).filter((k) => k.startsWith('allowed_payment_method_types'))).toEqual([]);
    expect(bodyWithout(retry.body, 'payment_method_types[0]')).toEqual(TODAY_BODY);

    // Odmowa pewna nie jest stanem uncertain: claim dalej „creating”, a Session zapisana.
    expect(mocks.hold).not.toHaveBeenCalled();
    expect(mocks.abandon).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(mocks.record).toHaveBeenCalledWith(attemptId, 'cs_test_TestCard', 2_000_000_000);

    expect(mocks.captureException).toHaveBeenCalledOnce();
    expect(mocks.captureException.mock.calls[0][1]).toMatchObject({
      tags: { area: 'billing.checkout.blik' },
    });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'billing.checkout.blik_unavailable',
      tenantId,
      metadata: expect.objectContaining({ reason: 'refused', attemptId, statusCode: status }),
    }));
  });

  it('błąd audytu odmowy nie zatrzymuje ponowienia z kartą', async () => {
    mocks.audit.mockRejectedValueOnce(new Error('audyt niedostępny'));
    createResponses = [
      stripeError(400, { type: 'invalid_request_error', message: 'blik not available' }),
      { status: 200, body: session({ payment_method_types: ['card'] }) },
    ];

    await expect(createCheckoutSession({ ...input, offerBlik: true }))
      .resolves.toMatchObject({ sessionId });

    expect(createCalls()).toHaveLength(2);
    expect(mocks.hold).not.toHaveBeenCalled();
  });

  it('odmowa, a potem błąd ponowienia z kartą: jak dziś hold uncertain, bez trzeciej próby', async () => {
    createResponses = [
      stripeError(400, { type: 'invalid_request_error', message: 'blik not available' }),
      stripeError(400, { type: 'invalid_request_error', message: 'No such price' }),
    ];

    await expect(createCheckoutSession({ ...input, offerBlik: true })).rejects.toThrow('No such price');

    expect(createCalls()).toHaveLength(2);
    expect(mocks.hold).toHaveBeenCalledOnce();
    expect(mocks.hold).toHaveBeenCalledWith(attemptId, 'creating', 'uncertain');
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each<[string, Programmed]>([
    ['500 od Stripe', stripeError(500, { type: 'api_error', message: 'Internal' })],
    ['429 limit żądań', stripeError(429, { type: 'invalid_request_error', code: 'lock_timeout', message: 'busy' })],
    ['409 klucz w użyciu', stripeError(409, { type: 'idempotency_error', code: 'idempotency_key_in_use', message: 'in use' })],
    ['400 idempotency_error', stripeError(400, { type: 'idempotency_error', message: 'Keys can only be used with the same parameters' })],
    ['zerwane połączenie', 'reset'],
  ])('wynik niepewny (%s): hold uncertain i bez ponowienia z kartą, Session mogła powstać', async (_name, response) => {
    // stripe-node sam powtarza żądanie po zerwanym połączeniu, z TYM SAMYM kluczem.
    createResponses = [response, response];

    await expect(createCheckoutSession({ ...input, offerBlik: true })).rejects.toBeInstanceOf(Error);

    expect([...new Set(createCalls().map((r) => r.headers['idempotency-key']))]).toEqual([
      'faktflow-checkout-blik-v1:' + attemptId,
    ]);
    expect(createCalls().flatMap((r) => Object.keys(r.body)).filter((k) => k.startsWith('payment_method_types'))).toEqual([]);
    expect(mocks.hold).toHaveBeenCalledOnce();
    expect(mocks.hold).toHaveBeenCalledWith(attemptId, 'creating', 'uncertain');
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'billing.checkout.blik_unavailable',
    }));
  });

  it('niezgodna odpowiedź wariantu z BLIK-iem: hold uncertain, nie ponowienie', async () => {
    createResponses = [{ status: 200, body: session({ metadata: { tenantId, plan: 'monthly' } }) }];

    await expect(createCheckoutSession({ ...input, offerBlik: true }))
      .rejects.toThrow('incomplete or mismatched');

    expect(createCalls()).toHaveLength(1);
    expect(mocks.hold).toHaveBeenCalledWith(attemptId, 'creating', 'uncertain');
  });

  it('otwarta Session jest użyta ponownie, bez nowego żądania tworzenia', async () => {
    mocks.claim.mockResolvedValue({
      state: 'open',
      attemptId,
      customerId,
      priceId: 'price_monthly',
      plan: 'monthly',
      sessionId,
    });
    mocks.getStripe.mockImplementation(() => ({
      checkout: { sessions: { retrieve: async () => session() } },
    }));

    await expect(createCheckoutSession({ ...input, offerBlik: true }))
      .resolves.toEqual({ sessionId, url: 'https://checkout.stripe.test/cs_test_TestA' });

    expect(createCalls()).toHaveLength(0);
  });

  it('drugi klient w czasie odmowy widzi „creating” i nie tworzy drugiej Session', async () => {
    mocks.claim.mockResolvedValue({
      state: 'creating',
      attemptId,
      customerId,
      priceId: 'price_monthly',
      plan: 'monthly',
      sessionId: null,
    });

    await expect(createCheckoutSession({ ...input, offerBlik: true }))
      .rejects.toThrow('already in progress');

    expect(createCalls()).toHaveLength(0);
  });
});

describe('startCheckoutAction: bramka ujawnień aż do żądania do Stripe', () => {
  const CHECKOUT_URL = 'redirect:https://checkout.stripe.test/cs_test_TestA';

  beforeEach(() => vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test'));

  it('aktualna wersja zgody: karta i BLIK, dowód zgody w audycie', async () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', 'on');

    await expect(startCheckoutAction('monthly', true, BLIK_RECURRING_STATEMENT.version))
      .rejects.toThrow(CHECKOUT_URL);

    const [request] = createCalls();
    expect(request.headers['stripe-version']).toBe(BLIK_API_VERSION);
    expect(request.body['allowed_payment_method_types[1]']).toBe('blik');
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'legal.checkout_statement_accepted',
      metadata: expect.objectContaining({ blikStatementVersion: BLIK_RECURRING_STATEMENT.version }),
    }));
  });

  it.each([
    ['karta sprzed włączenia przełącznika (brak wersji)', null],
    ['karta ze starym brzmieniem zgody', '2000-01-01'],
  ])('%s: Checkout dostaje samą kartę, a klient nie poda kodu BLIK bez ujawnień', async (_name, version) => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', 'on');
    createResponses = [{ status: 200, body: session({ payment_method_types: ['card'] }) }];

    await expect(startCheckoutAction('monthly', true, version)).rejects.toThrow(CHECKOUT_URL);

    expect(createCalls()).toHaveLength(1);
    const [request] = createCalls();
    expect(request.headers['stripe-version']).toBe(DEFAULT_API_VERSION);
    expect(request.headers['idempotency-key']).toBe(CARD_ONLY_KEY);
    expect(request.body['payment_method_types[0]']).toBe('card');
    expect(request.body['payment_method_types[1]']).toBeUndefined();
    const audit = mocks.logAudit.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(audit.metadata).not.toHaveProperty('blikStatementVersion');
  });

  it('przełącznik wyłączony po wyrenderowaniu strony: żądanie sprzed BLIK-a', async () => {
    await expect(startCheckoutAction('monthly', true, BLIK_RECURRING_STATEMENT.version))
      .rejects.toThrow(CHECKOUT_URL);

    const [request] = createCalls();
    expect(request.headers['idempotency-key']).toBe(CARD_KEY);
    expect(request.body).toEqual(TODAY_BODY);
  });
});
