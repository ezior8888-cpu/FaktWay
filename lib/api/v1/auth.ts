import 'server-only';

import { randomUUID } from 'node:crypto';

import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { NextResponse } from 'next/server';

import { isPublicApiEnabled } from '@/lib/api/v1/availability';
import { createApiKeyDbClient } from '@/lib/api/v1/db';
import { hashApiKey, parseBearerKey } from '@/lib/api/v1/keys';
import { API_KEY_SCOPES, type ApiKeyScope } from '@/lib/api/v1/scopes';
import { apiError } from '@/lib/api/v1/responses';
import { mintApiKeyToken, readApiJwtSecret } from '@/lib/api/v1/token';
import { clientIpFromHeaders } from '@/lib/auth/client-ip';
import { isRedisConfigured } from '@/lib/cache/redis';
import { isMaintenanceMode } from '@/lib/feature-flags/maintenance';
import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit';

/**
 * Uwierzytelnienie żądania `/api/v1` kluczem API (krok 7.1, 00181).
 *
 * Kolejność (każdy krok odmawia, zanim dotknie następnego):
 *  1. flaga `publicApiEnabled`, przerwa techniczna, konfiguracja (sekret JWT
 *     i Redis): bez nich 503, bez bazy;
 *  2. limit na adres IP: obejmuje też żądania bez klucza i ze złym kluczem;
 *  3. klucz z `Authorization: Bearer` (format sprawdzony bez bazy);
 *  4. limit na klucz (po skrócie, przed bazą: odmowa nie kosztuje zapytania);
 *  5. `api_key_session()` tokenem roli `api_key_client`: baza sprawdza klucz,
 *     zapisuje jego użycie w `audit_logs` i zwraca firmę i zakresy;
 *  6. zakres punktu (`scope: null` zostawia to punktowi, np. łączu MCP).
 *
 * Limity są fail-closed: bez Redisa (albo przy jego awarii, gdy limiter liczy
 * tylko w pamięci procesu) API odpowiada 503, bo limitu na klucz nie da się
 * wtedy dotrzymać przy kilku procesach.
 *
 * Dane czyta potem ten sam klient (`db`): RLS z 00181 wpuszcza tylko wiersze
 * firmy klucza i jego zakresu. Trasy i tak filtrują po `key.tenantId`.
 */

export const API_RATE_LIMITS = {
  /** Na klucz: 60 zapytań na minutę (średnio jedno na sekundę). */
  key: { limit: 60, windowSeconds: 60 },
  /** Na adres IP: 600 na minutę, np. biuro rachunkowe z kluczami wielu firm. */
  ip: { limit: 600, windowSeconds: 60 },
  /**
   * Zapis na klucz (POST, krok 7.1, część 2): 20 na minutę, osobno i dodatkowo
   * do limitu zapytań. Każdy zapis to faktura i być może wysyłka do KSeF.
   */
  write: { limit: 20, windowSeconds: 60 },
} as const;

export interface ApiKeyIdentity {
  id: string;
  tenantId: string;
  scopes: ApiKeyScope[];
  prefix: string;
}

export type ApiAuthResult =
  | {
    ok: true;
    db: SupabaseClient;
    key: ApiKeyIdentity;
    requestId: string;
    /** Nagłówki dla każdej odpowiedzi tego żądania (identyfikator, limit). */
    headers: Record<string, string>;
  }
  | { ok: false; response: NextResponse };

const REALM = 'Bearer realm="FaktWay API"';

const UNAVAILABLE = 'Publiczne API FaktWay jest chwilowo niedostępne. Spróbuj ponownie za kilka minut.';

function fail(response: NextResponse): ApiAuthResult {
  return { ok: false, response };
}

function rateLimited(result: RateLimitResult, requestId: string): ApiAuthResult {
  const retryAfter = String(Math.max(1, result.retryAfter));
  return fail(apiError(429, 'rate_limited', `Za dużo zapytań. Spróbuj ponownie za ${retryAfter} s.`, {
    'Retry-After': retryAfter,
    'X-Request-Id': requestId,
  }));
}

function parseSession(data: unknown): ApiKeyIdentity | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  const scopes = Array.isArray(row.scopes)
    ? row.scopes.filter((scope): scope is ApiKeyScope => API_KEY_SCOPES.includes(scope as ApiKeyScope))
    : [];
  if (typeof row.key_id !== 'string' || typeof row.tenant_id !== 'string' || typeof row.key_prefix !== 'string') {
    return null;
  }
  return { id: row.key_id, tenantId: row.tenant_id, scopes, prefix: row.key_prefix };
}

/**
 * Osobny limit zapisu (POST) dla klucza po udanym uwierzytelnieniu. `null`
 * znaczy „można iść dalej”. Bez liczenia odmów, jak limit na klucz; awaria
 * Redisa daje 503 (fail-closed).
 */
export async function checkApiWriteLimit(
  auth: Extract<ApiAuthResult, { ok: true }>,
): Promise<NextResponse | null> {
  const result = await checkRateLimit({
    bucket: 'api_v1_write',
    identifier: auth.key.id,
    ...API_RATE_LIMITS.write,
    countDenied: false,
  });
  if (result.fallback) return apiError(503, 'service_unavailable', UNAVAILABLE, auth.headers);
  if (result.allowed) return null;
  const retryAfter = String(Math.max(1, result.retryAfter));
  return apiError(429, 'rate_limited', `Za dużo zapisów tym kluczem. Spróbuj ponownie za ${retryAfter} s.`, {
    ...auth.headers,
    'Retry-After': retryAfter,
  });
}

export async function authenticateApiRequest(
  request: Request,
  { scope }: { scope: ApiKeyScope | null },
): Promise<ApiAuthResult> {
  const requestId = randomUUID();
  const base = { 'X-Request-Id': requestId };

  if (!(await isPublicApiEnabled())) {
    return fail(apiError(503, 'api_disabled', 'Publiczne API FaktWay nie jest jeszcze udostępnione.', base));
  }
  if (await isMaintenanceMode()) {
    return fail(apiError(503, 'maintenance', 'Trwa przerwa techniczna FaktWay. Spróbuj ponownie później.', {
      ...base,
      'Retry-After': '300',
    }));
  }
  const secret = readApiJwtSecret();
  if (!secret || !isRedisConfigured()) {
    Sentry.captureMessage('api_v1: brak konfiguracji (SUPABASE_JWT_SECRET albo Redis)', {
      level: 'error',
      tags: { area: 'api.v1.auth' },
      extra: { jwtSecret: Boolean(secret), redis: isRedisConfigured() },
    });
    return fail(apiError(503, 'service_unavailable', UNAVAILABLE, base));
  }

  // Brak adresu (poza proxy) to jeden wspólny kubełek 'unknown', jak w getClientIp; nie ma kluczy per żądanie.
  const ip = clientIpFromHeaders(request.headers) ?? 'unknown';
  const ipLimit = await checkRateLimit({ bucket: 'api_v1_ip', identifier: ip, ...API_RATE_LIMITS.ip });
  if (ipLimit.fallback) return fail(apiError(503, 'service_unavailable', UNAVAILABLE, base));
  if (!ipLimit.allowed) return rateLimited(ipLimit, requestId);

  const bearer = parseBearerKey(request.headers.get('authorization'));
  if (!bearer.ok) {
    return bearer.reason === 'missing'
      ? fail(apiError(401, 'missing_api_key', 'Brak klucza API. Dodaj nagłówek Authorization: Bearer <klucz>.', {
        ...base,
        'WWW-Authenticate': REALM,
      }))
      : fail(apiError(401, 'invalid_api_key', 'Klucz API jest nieprawidłowy albo został odwołany.', {
        ...base,
        'WWW-Authenticate': `${REALM}, error="invalid_token"`,
      }));
  }

  const keyHash = hashApiKey(bearer.key);
  // Bez liczenia odmów: `Retry-After` to czas, po którym zapytanie naprawdę przejdzie.
  const keyLimit = await checkRateLimit({
    bucket: 'api_v1_key',
    identifier: keyHash,
    ...API_RATE_LIMITS.key,
    countDenied: false,
  });
  if (keyLimit.fallback) return fail(apiError(503, 'service_unavailable', UNAVAILABLE, base));
  if (!keyLimit.allowed) return rateLimited(keyLimit, requestId);

  const url = new URL(request.url);
  const db = createApiKeyDbClient(mintApiKeyToken(keyHash, secret));
  const { data, error } = await db.rpc('api_key_session', {
    p_endpoint: `${request.method} ${url.pathname}${url.search}`,
    p_request_id: requestId,
    p_ip: ip === 'unknown' ? null : ip,
    p_user_agent: request.headers.get('user-agent'),
  });
  if (error) {
    // Bez wpisu audytu nie oddajemy danych (fail-closed), a treść błędu bazy zostaje u nas.
    Sentry.captureMessage('api_v1: api_key_session nieudane', {
      level: 'error',
      tags: { area: 'api.v1.auth' },
      extra: { code: error.code, requestId },
    });
    return fail(apiError(503, 'service_unavailable', UNAVAILABLE, base));
  }

  const key = parseSession(data);
  if (!key) {
    return fail(apiError(401, 'invalid_api_key', 'Klucz API jest nieprawidłowy albo został odwołany.', {
      ...base,
      'WWW-Authenticate': `${REALM}, error="invalid_token"`,
    }));
  }
  // `null`: punkt sprawdza zakresy sam (łącze MCP, krok 7.2: zakres zależy od narzędzia).
  if (scope !== null && !key.scopes.includes(scope)) {
    return fail(apiError(403, 'insufficient_scope', `Ten klucz API nie ma uprawnienia ${scope}. Utwórz klucz z tym uprawnieniem w Ustawieniach FaktWay.`, {
      ...base,
      'WWW-Authenticate': `${REALM}, error="insufficient_scope", scope="${scope}"`,
    }));
  }

  return {
    ok: true,
    db,
    key,
    requestId,
    headers: {
      ...base,
      'X-RateLimit-Limit': String(API_RATE_LIMITS.key.limit),
      'X-RateLimit-Remaining': String(keyLimit.remaining),
    },
  };
}
