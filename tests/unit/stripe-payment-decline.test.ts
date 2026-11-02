import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Kod odmowy BLIK-a przy odczycie PaymentIntent, na prawdziwym stripe-node
 * i lokalnym serwerze HTTP, który odpowiada jak Stripe według changelogu endive
 * („Returns specific decline codes for BLIK payment failures”): wersje przed
 * 2026-09-30.endive dostają `generic_decline` zamiast kodu szczegółowego.
 *
 * Mock samej metody `retrieve` tego nie widzi, bo zwraca kod niezależnie od wersji.
 */

const mocks = vi.hoisted(() => ({
  getStripe: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@/lib/stripe/client', () => ({ getStripe: mocks.getStripe }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.captureException }));

import { paymentFailureAdvice } from '@/lib/billing/payment-failure';
import { readPaymentDeclineCode } from '@/lib/stripe/payment-decline';

const DEFAULT_API_VERSION = '2024-11-20.acacia';
const ENDIVE = '2026-09-30.endive';
const PAYMENT_INTENT = 'pi_BlikOdmowa0001';

interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

let server: Server;
let port = 0;
let seen: SeenRequest[] = [];
let specificCode = 'insufficient_funds';
let status = 200;

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const version = req.headers['stripe-version'];
    res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_test' });
    res.end(JSON.stringify(status === 200
      ? {
          id: PAYMENT_INTENT,
          object: 'payment_intent',
          status: 'requires_payment_method',
          payment_method_types: ['blik'],
          last_payment_error: {
            type: 'card_error',
            code: 'payment_method_provider_decline',
            decline_code: version === ENDIVE ? specificCode : 'generic_decline',
          },
        }
      : { error: { type: 'api_error', message: 'Internal' } }));
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
  specificCode = 'insufficient_funds';
  status = 200;
  mocks.getStripe.mockImplementation(() => new Stripe('sk_test_lokalny', {
    apiVersion: DEFAULT_API_VERSION as never,
    host: '127.0.0.1',
    port,
    protocol: 'http',
    timeout: 3_000,
  }));
});

describe('readPaymentDeclineCode: wersja API odczytu', () => {
  it('PaymentIntent idzie w wersji endive, choć klient ma globalnie acacia', async () => {
    await readPaymentDeclineCode(PAYMENT_INTENT);

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('GET');
    expect(seen[0].url).toBe('/v1/payment_intents/' + PAYMENT_INTENT);
    expect(seen[0].headers['stripe-version']).toBe(ENDIVE);
  });

  it.each([
    'insufficient_funds',
    'customer_declined',
    'payment_limit_exceeded',
    'partner_generic_decline',
  ])('%s: kod szczegółowy, a nie generic_decline, daje klientowi konkretną podpowiedź', async (code) => {
    specificCode = code;

    const declineCode = await readPaymentDeclineCode(PAYMENT_INTENT);

    expect(declineCode).toBe(code);
    expect(paymentFailureAdvice(declineCode).reason).not.toBeNull();
  });

  it('awaria odczytu nie zatrzymuje webhooka i nie ponawia: null i Sentry', async () => {
    status = 500;

    await expect(readPaymentDeclineCode(PAYMENT_INTENT)).resolves.toBeNull();

    // Webhook ma odpowiedzieć szybko: bez automatycznych powtórzeń SDK.
    expect(seen).toHaveLength(1);
    expect(mocks.captureException).toHaveBeenCalledOnce();
  });

  it('bez identyfikatora PaymentIntent nie ma żądania', async () => {
    await expect(readPaymentDeclineCode(null)).resolves.toBeNull();
    expect(seen).toEqual([]);
  });
});
