import { createHmac } from 'node:crypto';

/**
 * Krótki token do PostgREST-a dla jednego żądania `/api/v1` (00181).
 *
 * Rola `api_key_client` i skrót klucza; firmę i zakres ustala baza ze skrótu
 * (`api_key_request_tenant`), więc token nie niesie firmy, którą dałoby się
 * podmienić. Podpis HS256 sekretem JWT Supabase (ten sam, którym PostgREST
 * sprawdza tokeny GoTrue). Token żyje 60 s i nie wychodzi poza serwer
 * aplikacji: klient API dostaje tylko odpowiedź.
 */

export const API_DB_ROLE = 'api_key_client';
export const REQUEST_TOKEN_TTL_SECONDS = 60;

/** Sekret z `SUPABASE_JWT_SECRET`; krótszy niż 32 znaki traktujemy jak brak. */
export function readApiJwtSecret(env: Record<string, string | undefined> = process.env): string | null {
  const secret = env.SUPABASE_JWT_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function mintApiKeyToken(
  keyHash: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const payload = {
    role: API_DB_ROLE,
    api_key_hash: keyHash,
    // Jak tokeny GoTrue: PostgREST ze skonfigurowanym `jwt-aud` przyjmie i ten.
    aud: 'authenticated',
    iss: 'faktway-api',
    iat: nowSeconds,
    exp: nowSeconds + REQUEST_TOKEN_TTL_SECONDS,
  };
  const unsigned = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}
