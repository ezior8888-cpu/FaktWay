/**
 * HMAC-signed unsubscribe tokens (Faza 26).
 *
 * Strategia: bezstanowy token z `{ userId, category, exp }` zapakowany w
 * base64url + HMAC-SHA256 signature. Sprawdzenie nie wymaga DB hitu —
 * link w mailu działa nawet jak Supabase padnie.
 *
 * Format URL (RFC 8058 one-click):
 *   https://faktway.pl/api/email/unsubscribe?t=<token>&c=<category>
 *
 * Token = `<base64url payload>.<base64url HMAC>`
 *
 * Bezpieczeństwo:
 *   - HMAC-SHA256 z `EMAIL_UNSUBSCRIBE_SECRET` (osobny od auth/Stripe secrets)
 *   - Expiry 90 dni (typowy mail w skrzynce nie żyje dłużej)
 *   - Constant-time compare (timingSafeEqual) — bez tego attacker mógłby
 *     brute-force signature byte-by-byte przez timing
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

// Lokalny typ — `email_category_enum` powstaje w 00047, jeszcze przed regeneracją.
type EmailCategory = 'transactional' | 'product_updates' | 'marketing';

const TOKEN_VERSION = 1;
const DEFAULT_TTL_DAYS = 90;

interface TokenPayload {
  v: number;
  userId: string;
  category: EmailCategory;
  /** Issued-at (unix seconds). */
  iat: number;
  /** Expires-at (unix seconds). */
  exp: number;
}

function getSecret(): string {
  const secret = process.env.EMAIL_UNSUBSCRIBE_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error(
      'EMAIL_UNSUBSCRIBE_SECRET missing or too short (>= 32 chars wymagane)',
    );
  }
  return secret;
}

function b64UrlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function b64UrlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export function createUnsubscribeToken(
  userId: string,
  category: EmailCategory,
  ttlDays: number = DEFAULT_TTL_DAYS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = {
    v: TOKEN_VERSION,
    userId,
    category,
    iat: now,
    exp: now + ttlDays * 24 * 60 * 60,
  };

  const payloadB64 = b64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sigB64 = b64UrlEncode(
    createHmac('sha256', getSecret()).update(payloadB64).digest(),
  );
  return `${payloadB64}.${sigB64}`;
}

export type VerifyResult =
  | { valid: true; userId: string; category: EmailCategory }
  | {
      valid: false;
      reason: 'malformed' | 'invalid_signature' | 'expired' | 'wrong_version';
    };

export function verifyUnsubscribeToken(token: string): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed' };
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return { valid: false, reason: 'malformed' };

  let expected: Buffer;
  let received: Buffer;
  try {
    expected = createHmac('sha256', getSecret()).update(payloadB64).digest();
    received = b64UrlDecode(sigB64);
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (expected.length !== received.length) {
    return { valid: false, reason: 'invalid_signature' };
  }
  if (!timingSafeEqual(expected, received)) {
    return { valid: false, reason: 'invalid_signature' };
  }

  let payload: TokenPayload;
  try {
    const raw = b64UrlDecode(payloadB64).toString('utf8');
    payload = JSON.parse(raw) as TokenPayload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (payload.v !== TOKEN_VERSION) {
    return { valid: false, reason: 'wrong_version' };
  }
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    return { valid: false, reason: 'expired' };
  }
  if (
    typeof payload.userId !== 'string' ||
    !/^[0-9a-fA-F-]{36}$/.test(payload.userId)
  ) {
    return { valid: false, reason: 'malformed' };
  }
  if (
    payload.category !== 'transactional' &&
    payload.category !== 'product_updates' &&
    payload.category !== 'marketing'
  ) {
    return { valid: false, reason: 'malformed' };
  }

  return { valid: true, userId: payload.userId, category: payload.category };
}

/**
 * Sprawdza czy `EMAIL_UNSUBSCRIBE_SECRET` jest skonfigurowane. Pozwala
 * `lib/email/send.ts` dodać `List-Unsubscribe` header tylko gdy mamy
 * sensowny secret — bez tego token byłby fake i kliknięcie failowałoby.
 */
export function isUnsubscribeConfigured(): boolean {
  const secret = process.env.EMAIL_UNSUBSCRIBE_SECRET?.trim();
  return Boolean(secret && secret.length >= 32);
}
