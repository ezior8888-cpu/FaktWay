import 'server-only';

import { PASSKEY_SESSION_COOKIE } from '@/lib/auth/device-cookies';

/**
 * Znacznik „ta sesja zaczęła się od asercji WebAuthn z weryfikacją użytkownika”.
 *
 * GoTrue wystawia po logowaniu biometrią zwykłą sesję AAL1 (magic link), a konto
 * z TOTP dostałoby wtedy prośbę o kod. Asercja z biometrią to już dwa składniki,
 * więc bramka panelu (`lib/auth/panel-mfa.ts`) przepuszcza taką sesję po tym
 * znaczniku. Operacje wrażliwe czytają `getVerifiedMfaState` i dalej wymagają kodu.
 *
 * Działa w proxy bez bazy: podpis HMAC po `sub`, `session_id` z JWT i czasie
 * ważności. `session_id` nie zmienia się przy odświeżaniu tokenu, a wygasa
 * z sesją, więc znacznik nie zadziała dla innej sesji ani innego konta.
 *
 * Klucz: HKDF z `SUPABASE_SERVICE_ROLE_KEY` z osobnym `info`, bez nowej zmiennej
 * środowiskowej. Rotacja klucza serwisowego unieważnia znaczniki (użytkownik poda
 * kod albo zaloguje się biometrią ponownie), czyli kończy się bezpiecznie.
 *
 * WebCrypto, nie `node:crypto`: ten sam kod działa w proxy i w końcówkach,
 * a `crypto.subtle.verify` porównuje podpis w stałym czasie.
 */

export { PASSKEY_SESSION_COOKIE };
export const PASSKEY_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const VERSION = 'v1';
const HKDF_INFO = 'faktway/passkey-session-marker/v1';
/** `v1.<czas ważności w sekundach>.<HMAC-SHA256 w base64url>`. */
const MARKER_PATTERN = /^v1\.(\d{10,12})\.([A-Za-z0-9_-]{43})$/;

export interface PasskeySessionSubject {
  sub: string;
  sessionId: string;
}

const encoder = new TextEncoder();
let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

function signingKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret === secret) return cachedKey.key;
  const key = crypto.subtle
    .importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
    .then((material) => crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(HKDF_INFO) },
      material,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign', 'verify'],
    ));
  cachedKey = { secret, key };
  return key;
}

function signedData({ sub, sessionId }: PasskeySessionSubject, expiry: string): Uint8Array<ArrayBuffer> {
  return encoder.encode([VERSION, sub, sessionId, expiry].join('\n'));
}

function isUsableSubject({ sub, sessionId }: PasskeySessionSubject): boolean {
  return Boolean(sub) && Boolean(sessionId) && !sub.includes('\n') && !sessionId.includes('\n');
}

function toBase64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0));
}

export async function createPasskeySessionMarker(
  subject: PasskeySessionSubject,
  now: () => number = Date.now,
): Promise<string> {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error('passkey_marker_key_missing');
  if (!isUsableSubject(subject)) throw new Error('passkey_marker_subject_invalid');
  const expiry = String(Math.floor(now() / 1000) + PASSKEY_SESSION_MAX_AGE_SECONDS);
  const mac = await crypto.subtle.sign('HMAC', await signingKey(secret), signedData(subject, expiry));
  return [VERSION, expiry, toBase64Url(mac)].join('.');
}

/** Każdy błąd i każda niezgodność to `false`: brak znacznika oznacza zwykłą prośbę o kod. */
export async function verifyPasskeySessionMarker(
  marker: string | null | undefined,
  subject: PasskeySessionSubject,
  now: () => number = Date.now,
): Promise<boolean> {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || typeof marker !== 'string' || !isUsableSubject(subject)) return false;
  const parts = MARKER_PATTERN.exec(marker);
  if (!parts) return false;
  const [, expiry, mac] = parts;
  if (Number(expiry) <= Math.floor(now() / 1000)) return false;
  try {
    return await crypto.subtle.verify(
      'HMAC',
      await signingKey(secret),
      fromBase64Url(mac!),
      signedData(subject, expiry!),
    );
  } catch {
    return false;
  }
}

export function passkeySessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: PASSKEY_SESSION_MAX_AGE_SECONDS,
  };
}
