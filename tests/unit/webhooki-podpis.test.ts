import { describe, expect, it } from 'vitest';

/**
 * Krok 7.1, część 3: podpis webhooka (wzór Stripe) i identyfikator zdarzenia.
 *
 * `FaktWay-Signature: t=<czas unix>,v1=<HMAC-SHA256 hex>` liczony z napisu
 * `<t>.<treść>` sekretem webhooka. Wektor policzony niezależnie z góry
 * (`openssl dgst -sha256 -hmac`), a identyfikator zdarzenia to UUID v5
 * (Python `uuid.uuid5`), więc test nie sprawdza kodu nim samym.
 *
 * Sekret testowy bez entropii (skan sekretów patrzy na całą historię gałęzi).
 */

import {
  signatureHeader,
  verifyWebhookSignature,
  webhookSignature,
} from '@/lib/webhooks/signature';
import { webhookEventId } from '@/lib/webhooks/event-id';

const TEST_SIGNING_VALUE = `fwws_${'a'.repeat(43)}`;
const T = 1731312000;
const BODY = '{"id":"evt_1","type":"invoice.ksef_accepted"}';
// printf '%s' "1731312000.$BODY" | openssl dgst -sha256 -hmac "fwws_aaaa…a" (43 × a)
const WEKTOR_V1 = 'cba3495c8115701b4134b35b75f6899e9bed38eef0923aaa2600d2d4885c0544';

describe('podpis FaktWay-Signature', () => {
  it('HMAC-SHA256 z „t.treść”: znany wektor', () => {
    expect(webhookSignature(TEST_SIGNING_VALUE, T, BODY)).toBe(WEKTOR_V1);
  });

  it('nagłówek w formacie t=…,v1=…', () => {
    expect(signatureHeader(TEST_SIGNING_VALUE, T, BODY)).toBe(`t=${T},v1=${WEKTOR_V1}`);
  });

  it('weryfikacja: przyjmuje poprawny podpis w oknie 5 minut', () => {
    const header = signatureHeader(TEST_SIGNING_VALUE, T, BODY);
    expect(verifyWebhookSignature({ header, body: BODY, signingSecret: TEST_SIGNING_VALUE, nowSeconds: T + 299 })).toBe(true);
  });

  it('weryfikacja: odrzuca zmienioną treść, inny sekret, stary czas, czas z przyszłości i zły nagłówek', () => {
    const header = signatureHeader(TEST_SIGNING_VALUE, T, BODY);
    const verify = (overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]>) =>
      verifyWebhookSignature({ header, body: BODY, signingSecret: TEST_SIGNING_VALUE, nowSeconds: T, ...overrides });

    expect(verify({ body: BODY.replace('evt_1', 'evt_2') })).toBe(false);
    expect(verify({ signingSecret: `fwws_${'b'.repeat(43)}` })).toBe(false);
    expect(verify({ nowSeconds: T + 301 })).toBe(false);
    expect(verify({ nowSeconds: T - 301 })).toBe(false);
    for (const bad of ['', 'v1=abc', `t=${T}`, `t=abc,v1=${WEKTOR_V1}`, `t=${T},v0=${WEKTOR_V1}`, `t=${T},v1=${WEKTOR_V1.slice(0, 63)}`]) {
      expect(verify({ header: bad }), bad).toBe(false);
    }
  });

  it('weryfikacja: przyjmuje nagłówek z kilkoma v1 (zmiana sekretu po stronie odbiorcy)', () => {
    const header = `t=${T},v1=${'0'.repeat(64)},v1=${WEKTOR_V1}`;
    expect(verifyWebhookSignature({ header, body: BODY, signingSecret: TEST_SIGNING_VALUE, nowSeconds: T })).toBe(true);
  });
});

describe('identyfikator zdarzenia (FaktWay-Event-Id)', () => {
  it('UUID v8 z typu i obiektu: to samo zdarzenie ma zawsze ten sam identyfikator', () => {
    // v8 z SHA-256 zamiast v5 (CodeQL js/weak-cryptographic-algorithm)
    const I = '11111111-1111-4111-8111-111111111111';
    expect(webhookEventId('invoice.ksef_accepted', I)).toBe('82b2d7b7-d95a-87a5-b956-d48099692a68');
    expect(webhookEventId('payment.recorded', I)).toBe('601c7b22-c9e2-8631-b1b8-d98106f1ccf3');
    expect(webhookEventId('payment.recorded', I)).toBe(webhookEventId('payment.recorded', I));
  });

  it('inny typ albo inny obiekt to inne zdarzenie', () => {
    const a = webhookEventId('expense.ksef_received', '11111111-1111-4111-8111-111111111111');
    expect(a).not.toBe(webhookEventId('expense.ksef_received', '22222222-2222-4222-8222-222222222222'));
    expect(a).not.toBe(webhookEventId('invoice.ksef_accepted', '11111111-1111-4111-8111-111111111111'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
