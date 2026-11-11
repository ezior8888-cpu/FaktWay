import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Podpis webhooka (wzór Stripe), nagłówek `FaktWay-Signature: t=<czas>,v1=<podpis>`.
 *
 * - `t`: czas wysyłki w sekundach od 1970-01-01 (UTC), osobny przy każdej próbie,
 * - `v1`: HMAC-SHA256 (hex) napisu `<t>.<treść żądania>` sekretem webhooka.
 *
 * Odbiorca liczy to samo ze swoją kopią sekretu, porównuje w stałym czasie
 * i odrzuca podpisy starsze niż 5 minut (ochrona przed powtórzeniem
 * przechwyconego żądania). Opis dla klientów: `/api/docs`, sekcja „Webhooki”.
 */

export const SIGNATURE_HEADER = 'FaktWay-Signature';
export const EVENT_ID_HEADER = 'FaktWay-Event-Id';
export const EVENT_TYPE_HEADER = 'FaktWay-Event-Type';
/** Okno ważności podpisu po stronie odbiorcy (zalecenie z dokumentacji). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** HMAC-SHA256 (hex) napisu `<t>.<treść>`. */
export function webhookSignature(signingSecret: string, timestampSeconds: number, body: string): string {
  return createHmac('sha256', signingSecret).update(`${timestampSeconds}.${body}`, 'utf8').digest('hex');
}

export function signatureHeader(signingSecret: string, timestampSeconds: number, body: string): string {
  return `t=${timestampSeconds},v1=${webhookSignature(signingSecret, timestampSeconds, body)}`;
}

/**
 * Weryfikacja po stronie odbiorcy (ten sam algorytm co w dokumentacji; tu do
 * testów i dla przykładu). Kilka `v1` w nagłówku przyjmujemy jak Stripe:
 * wystarczy jeden pasujący.
 */
export function verifyWebhookSignature(input: {
  header: string;
  body: string;
  signingSecret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const part of input.header.split(',')) {
    const [name, value] = part.trim().split('=', 2);
    if (name === 't' && value && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (name === 'v1' && value && /^[0-9a-f]{64}$/.test(value)) candidates.push(value);
  }
  if (timestamp === null || candidates.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > tolerance) return false;

  const expected = Buffer.from(webhookSignature(input.signingSecret, timestamp, input.body), 'hex');
  return candidates.some((candidate) => timingSafeEqual(expected, Buffer.from(candidate, 'hex')));
}
