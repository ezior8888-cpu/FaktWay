import { createHash, randomBytes } from 'node:crypto';

/**
 * Klucze publicznego API firmy (krok 7.1 planu kompletnej aplikacji, 00181).
 *
 * Klucz to `fwk_` i 43 znaki base64url (32 losowe bajty). Klient widzi go raz,
 * przy utworzeniu. Baza trzyma skrót SHA-256 (hex) i prefiks `fwk_` + 8 znaków,
 * po którym klient rozpozna klucz na liście. SHA-256 bez soli wystarcza, bo
 * klucz ma 256 bitów losowości: skrótu nie da się odwrócić zgadywaniem.
 *
 * Tylko serwer (`node:crypto`). Zakresy i formularz: `lib/api/v1/scopes.ts`.
 */

export {
  API_KEY_SCOPE_LABELS,
  API_KEY_SCOPES,
  apiKeyCreateSchema,
  canonicalScopes,
  MAX_ACTIVE_API_KEYS,
  type ApiKeyScope,
} from '@/lib/api/v1/scopes';

const KEY_PATTERN = /^fwk_[A-Za-z0-9_-]{43}$/;
// Nazwa schematu bez względu na wielkość liter (RFC 7235), jeden odstęp, jeden klucz.
const BEARER_PATTERN = /^Bearer (\S+)$/i;

export interface GeneratedApiKey {
  /** Pełny klucz: tylko do pokazania klientowi raz. */
  key: string;
  /** `fwk_` i pierwsze 8 znaków sekretu (kolumna `key_prefix`). */
  prefix: string;
  /** SHA-256 klucza w hex (kolumna `key_hash`). */
  hash: string;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): GeneratedApiKey {
  const key = `fwk_${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, 12), hash: hashApiKey(key) };
}

export type BearerKey =
  | { ok: true; key: string }
  | { ok: false; reason: 'missing' | 'malformed' };

/** Klucz z nagłówka `Authorization: Bearer fwk_…`. Format sprawdzamy przed bazą. */
export function parseBearerApiKey(header: string | null): BearerKey {
  if (header === null || header.trim() === '') return { ok: false, reason: 'missing' };
  const match = BEARER_PATTERN.exec(header.trim());
  const key = match?.[1];
  if (!key || !KEY_PATTERN.test(key)) return { ok: false, reason: 'malformed' };
  return { ok: true, key };
}
