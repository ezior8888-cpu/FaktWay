import 'server-only';

import { randomUUID } from 'node:crypto';

import * as Sentry from '@sentry/nextjs';
import { isAuthRetryableFetchError, type AuthError, type JwtPayload, type SupabaseClient, type User } from '@supabase/supabase-js';
import type { NextResponse } from 'next/server';

import { createMobileAuthClient, createMobileDbClient, type MobileSupabaseTarget } from '@/lib/api/mobile/db';
import { MOBILE_ACTIVE_ORG_HEADER } from '@/lib/api/mobile/kontrakt';
import { MOBILE_UNAVAILABLE, MobileUpstreamError, mobileError, mobileFailure } from '@/lib/api/mobile/responses';
import { clientIpFromHeaders } from '@/lib/auth/client-ip';
import { readAccessTokenFacts } from '@/lib/auth/sessions/access-token';
import { getVerifiedMfaStateForToken } from '@/lib/auth/verified-mfa';
import { isMaintenanceMode } from '@/lib/feature-flags/maintenance';
import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit';
import { isUuid } from '@/lib/supabase/active-org';
import type { UserRole } from '@/lib/supabase/auth-context';

/**
 * Uwierzytelnienie żądania `/api/mobile/v1` tokenem sesji Supabase z nagłówka
 * `Authorization: Bearer` (plan aplikacji mobilnej 4.3, etap M6). Telefon
 * loguje się w GoTrue sam (M5b) i nie ma ciasteczek, więc akcje serwera strony
 * są dla niego niedostępne; te trasy dają mu to samo za tymi samymi bramkami.
 *
 * Kolejność (każdy krok odmawia, zanim dotknie następnego):
 *  1. limit na adres IP: obejmuje też żądania bez tokenu i ze złym tokenem;
 *  2. przerwa techniczna: 503 bez GoTrue i bazy (proxy nie sprawdza jej dla
 *     `/api/mobile`, bo nie buduje tu klienta z ciasteczek);
 *  3. token z nagłówka (kształt JWT sprawdzony bez sieci);
 *  4. GoTrue: `getUser(token)` (tożsamość, czynniki 2FA) i `getClaims(token)`
 *     (poziom tej sesji), ta sama reguła co strona (`getVerifiedMfaStateForToken`):
 *     konto z TOTP w sesji AAL1 dostaje 403 `mfa_required`;
 *  5. limit na osobę (z kilku adresów i telefonów razem);
 *  6. przy trasie z danymi firmy: `X-Active-Org` i aktywne członkostwo,
 *     sprawdzone tokenem klienta (RLS), bez klucza serwisowego.
 *
 * Awaria GoTrue to 503 `session_verification_failed`, nie 401: aplikacja po 401
 * kończy sesję w telefonie, a klient nie może zostać wylogowany przez awarię.
 *
 * Limity jak na stronie: bez Redisa liczy pamięć procesu (`checkRateLimit`,
 * AUD-62; jeden proces web na app-1), zamiast odmawiać wszystkim telefonom.
 */

export const MOBILE_API_RATE_LIMITS = {
  /**
   * Na adres IP: 300 na minutę. Kilka telefonów jednego biura za wspólnym
   * adresem; zalew złych tokenów kończy się tu, zanim dotrze do GoTrue.
   */
  ip: { limit: 300, windowSeconds: 60 },
  /**
   * Na osobę: 120 na minutę (średnio dwa na sekundę). Odczyty idą z telefonu
   * wprost do bazy (RLS), przez API tylko zapisy i operacje serwera.
   */
  user: { limit: 120, windowSeconds: 60 },
} as const;

const REALM = 'Bearer realm="FaktWay"';
/** Token sesji GoTrue ma od kilkuset bajtów do kilku KB; dłuższy nagłówek nie idzie do GoTrue. */
const MAX_TOKEN_LENGTH = 8192;
const BEARER = /^bearer +(\S+)$/i;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface MobileSessionClaims {
  /** `session_id` tokenu (wpis `auth.login`, lista urządzeń 00174); `null`, gdy go brak. */
  sessionId: string | null;
  aal: 'aal1' | 'aal2';
  /** Metody z claimu `amr` (np. `password`, `oauth`, `totp`). */
  amrMethods: string[];
}

export type MobileTokenState =
  | { status: 'ok'; user: User; mfaEnabled: boolean; claims: MobileSessionClaims }
  | { status: 'unauthenticated' }
  | { status: 'challenge_required' };

export interface MobileCaller {
  requestId: string;
  /** Nagłówki dla każdej odpowiedzi tego żądania. */
  headers: Record<string, string>;
  user: { id: string; email: string | null };
  /** Konto ma zweryfikowany TOTP (i ta sesja jest po kodzie, inaczej byłoby 403). */
  mfaEnabled: boolean;
  session: MobileSessionClaims;
  /** Tylko przy `org: 'required'`. */
  org: { tenantId: string; role: UserRole } | null;
  /** Token klienta (i `x-active-org` przy firmie): RLS jak na stronie. */
  db: SupabaseClient;
}

export type MobileAuthResult = { ok: true; caller: MobileCaller } | { ok: false; response: NextResponse };

function fail(response: NextResponse): MobileAuthResult {
  return { ok: false, response };
}

function rateLimited(result: RateLimitResult, headers: Record<string, string>): MobileAuthResult {
  const retryAfter = String(Math.max(1, result.retryAfter));
  return fail(mobileError(429, 'rate_limited', `Za dużo zapytań. Spróbuj ponownie za ${retryAfter} s.`, {
    ...headers,
    'Retry-After': retryAfter,
  }));
}

type BearerResult = { ok: true; token: string } | { ok: false; reason: 'missing' | 'invalid' };

function parseBearer(header: string | null): BearerResult {
  if (header === null || header.trim() === '') return { ok: false, reason: 'missing' };
  const match = BEARER.exec(header.trim());
  const token = match?.[1];
  if (!token || token.length > MAX_TOKEN_LENGTH || !JWT_SHAPE.test(token)) return { ok: false, reason: 'invalid' };
  return { ok: true, token };
}

/**
 * Odpowiedź GoTrue, po której nie wolno uznać tokenu za nieważny: sieć
 * (`AuthRetryableFetchError`), 5xx, limit GoTrue. Błąd bez kodu HTTP to
 * odmowa: inaczej martwy token dawałby 503 bez końca i telefon by nie wiedział,
 * że trzeba odświeżyć sesję.
 */
function isTransientAuthError(error: AuthError): boolean {
  if (isAuthRetryableFetchError(error)) return true;
  const status = typeof error.status === 'number' ? error.status : null;
  return status !== null && (status === 429 || status >= 500);
}

function invalidToken(headers: Record<string, string>): MobileAuthResult {
  return fail(mobileError(401, 'invalid_token', 'Sesja wygasła. Zaloguj się ponownie.', {
    ...headers,
    'WWW-Authenticate': `${REALM}, error="invalid_token"`,
  }));
}

/**
 * Werdykt dla tokenu telefonu: tożsamość i czynniki z GoTrue, poziom z claims
 * TEGO tokenu (te same, które sprawdził `getClaims`, bez drugiego zapytania).
 * Rzuca, gdy GoTrue nie odpowiada albo odpowiedź się nie zgadza; wywołujący
 * zamienia to na 503.
 */
export async function verifyMobileToken(token: string, target: MobileSupabaseTarget = {}): Promise<MobileTokenState> {
  const { auth } = createMobileAuthClient(target);
  let verifiedClaims: JwtPayload | null = null;
  const state = await getVerifiedMfaStateForToken({
    getUser: async (jwt?: string) => {
      const result = await auth.getUser(jwt);
      if (result.error && isTransientAuthError(result.error)) throw new Error('mobile_auth_unavailable');
      return result;
    },
    getClaims: async (...args: Parameters<SupabaseClient['auth']['getClaims']>) => {
      const result = await auth.getClaims(...args);
      verifiedClaims = result.data?.claims ?? null;
      return result;
    },
  } as Pick<SupabaseClient['auth'], 'getUser' | 'getClaims'>, token);

  if (state.status === 'unauthenticated') return state;
  if (state.status === 'challenge_required') return { status: 'challenge_required' };
  const claims = verifiedClaims as JwtPayload | null;
  if (!claims || claims.sub !== state.user.id) throw new Error('mobile_claims_missing');
  // Podpis i ważność tokenu sprawdził już GoTrue, więc jego `session_id` i `amr` czytamy jak strona.
  const facts = readAccessTokenFacts(token);
  return {
    status: 'ok',
    user: state.user,
    mfaEnabled: state.status === 'verified',
    claims: { sessionId: facts.sessionId, aal: claims.aal === 'aal2' ? 'aal2' : 'aal1', amrMethods: facts.amrMethods },
  };
}

/**
 * Aktywne członkostwo w firmie z `X-Active-Org`, czytane tokenem klienta:
 * polityka `memberships_select_self_or_org` (00058) pokazuje mu jego wiersze.
 * `null` = brak członkostwa; błąd bazy rzuca `MobileUpstreamError`.
 */
export async function findActiveMembership(
  db: SupabaseClient,
  userId: string,
  organizationId: string,
): Promise<{ role: UserRole } | null> {
  const { data, error } = await db
    .from('memberships')
    .select('role')
    .eq('user_id', userId)
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw new MobileUpstreamError('memberships');
  if (!data) return null;
  const role = (data as { role?: unknown }).role;
  return { role: (typeof role === 'string' ? role : 'member') as UserRole };
}

export async function authenticateMobileRequest(
  request: Request,
  options: { org: 'none' | 'required' },
): Promise<MobileAuthResult> {
  const requestId = randomUUID();
  const base = { 'X-Request-Id': requestId };

  // Brak adresu (poza proxy Coolify) to jeden wspólny kubełek, jak w `lib/api/v1/auth.ts`.
  const ip = clientIpFromHeaders(request.headers) ?? 'unknown';
  const ipLimit = await checkRateLimit({ bucket: 'mobile_api_ip', identifier: ip, ...MOBILE_API_RATE_LIMITS.ip });
  if (!ipLimit.allowed) return rateLimited(ipLimit, base);

  if (await isMaintenanceMode()) {
    return fail(mobileError(503, 'maintenance', 'Trwa przerwa techniczna FaktWay. Spróbuj ponownie za kilka minut.', {
      ...base,
      'Retry-After': '300',
    }));
  }

  const bearer = parseBearer(request.headers.get('authorization'));
  if (!bearer.ok) {
    return bearer.reason === 'missing'
      ? fail(mobileError(401, 'missing_token', 'Zaloguj się w aplikacji FaktWay.', { ...base, 'WWW-Authenticate': REALM }))
      : invalidToken(base);
  }

  let state: MobileTokenState;
  try {
    state = await verifyMobileToken(bearer.token);
  } catch (error) {
    Sentry.captureMessage('api_mobile: weryfikacja sesji nieudana', {
      level: 'warning',
      tags: { area: 'api.mobile.auth' },
      extra: { requestId, reason: error instanceof Error ? error.message : 'unknown' },
    });
    return fail(mobileError(503, 'session_verification_failed', MOBILE_UNAVAILABLE, base));
  }
  if (state.status === 'unauthenticated') return invalidToken(base);
  if (state.status === 'challenge_required') {
    return fail(mobileError(403, 'mfa_required', 'Wpisz kod z aplikacji uwierzytelniającej, żeby dokończyć logowanie.', base));
  }

  // Bez liczenia odmów: `Retry-After` to czas, po którym zapytanie naprawdę przejdzie.
  const userLimit = await checkRateLimit({
    bucket: 'mobile_api_user',
    identifier: state.user.id,
    ...MOBILE_API_RATE_LIMITS.user,
    countDenied: false,
  });
  if (!userLimit.allowed) return rateLimited(userLimit, base);

  let org: MobileCaller['org'] = null;
  if (options.org === 'required') {
    const header = request.headers.get(MOBILE_ACTIVE_ORG_HEADER)?.trim();
    if (!isUuid(header)) {
      return fail(mobileError(400, 'missing_org', 'Wybierz firmę w aplikacji i spróbuj ponownie.', base));
    }
    let membership: { role: UserRole } | null;
    try {
      membership = await findActiveMembership(createMobileDbClient(bearer.token), state.user.id, header);
    } catch (error) {
      return fail(mobileFailure(error, requestId, base));
    }
    if (!membership) {
      return fail(mobileError(403, 'no_active_org', 'Nie masz już dostępu do tej firmy. Wybierz inną firmę.', base));
    }
    org = { tenantId: header.toLowerCase(), role: membership.role };
  }

  return {
    ok: true,
    caller: {
      requestId,
      headers: base,
      user: { id: state.user.id, email: state.user.email ?? null },
      mfaEnabled: state.mfaEnabled,
      session: state.claims,
      org,
      db: createMobileDbClient(bearer.token, { activeOrg: org?.tenantId ?? null }),
    },
  };
}
