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
 *     konto z TOTP w sesji AAL1 dostaje 403 `mfa_required`. Wyjątek to tylko
 *     `mfa: 'challenge'` (trasa kodu 2FA, M6c): przepuszcza właśnie taką sesję,
 *     a każdą inną (bez 2FA albo już po kodzie) odrzuca 409 `mfa_not_required`;
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
  /**
   * Najpóźniejsze potwierdzenie tożsamości w tej sesji (sekundy, z `amr[].timestamp`
   * sprawdzonego tokenu); `null` bez `amr`. Świeże logowanie przy usuwaniu konta (M10b).
   */
  potwierdzonoO: number | null;
}

/** Najpóźniejszy znacznik czasu z `amr` sprawdzonego tokenu. */
function amrTimestamp(claims: JwtPayload): number | null {
  const amr = (claims as { amr?: unknown }).amr;
  if (!Array.isArray(amr)) return null;
  const times = amr.flatMap((entry: unknown) => {
    const t = typeof entry === 'object' && entry !== null ? (entry as { timestamp?: unknown }).timestamp : undefined;
    return typeof t === 'number' && Number.isFinite(t) ? [t] : [];
  });
  return times.length > 0 ? Math.max(...times) : null;
}

export type MobileTokenState =
  | { status: 'ok'; user: User; mfaEnabled: boolean; claims: MobileSessionClaims }
  | { status: 'unauthenticated' }
  /** Konto z 2FA w sesji AAL1. Konto i claims tylko dla trasy kodu (`mfa: 'challenge'`); reszta odmawia. */
  | { status: 'challenge_required'; user: User; claims: MobileSessionClaims };

export interface MobileCaller {
  requestId: string;
  /** Nagłówki dla każdej odpowiedzi tego żądania. */
  headers: Record<string, string>;
  user: {
    id: string;
    email: string | null;
    /** Metody logowania konta z GoTrue (`app_metadata.providers`, np. `email`, `google`); `email` to konto z hasłem. */
    providers: string[];
  };
  /**
   * Konto ma zweryfikowany TOTP (i ta sesja jest po kodzie, inaczej byłoby 403).
   * Przy `mfa: 'challenge'` sesja jest na AAL1 i czeka na kod; `true` tylko z czynnikiem TOTP.
   */
  mfaEnabled: boolean;
  /** Token z nagłówka. Tylko przy `mfa: 'challenge'`: trasa kodu potwierdza nim kod w GoTrue. */
  accessToken: string | null;
  /**
   * Zweryfikowany czynnik TOTP z odpowiedzi GoTrue (`getUser`), nie z treści tokenu.
   * Tylko przy `mfa: 'challenge'`; `null`, gdy konto ma 2FA innego rodzaju niż TOTP.
   */
  totpFactorId: string | null;
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
  const claims = verifiedClaims as JwtPayload | null;
  if (!claims || claims.sub !== state.user.id) throw new Error('mobile_claims_missing');
  // Podpis i ważność tokenu sprawdził już GoTrue, więc jego `session_id` i `amr` czytamy jak strona.
  const facts = readAccessTokenFacts(token);
  const sessionClaims: MobileSessionClaims = {
    sessionId: facts.sessionId,
    aal: claims.aal === 'aal2' ? 'aal2' : 'aal1',
    amrMethods: facts.amrMethods,
    potwierdzonoO: amrTimestamp(claims),
  };
  if (state.status === 'challenge_required') return { status: 'challenge_required', user: state.user, claims: sessionClaims };
  return { status: 'ok', user: state.user, mfaEnabled: state.status === 'verified', claims: sessionClaims };
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

/**
 * `mfa` (domyślnie `verified`): konto z 2FA tylko po kodzie (AAL2), jak strona.
 * `challenge` ma tylko `POST /kod` (M6c): przepuszcza sesję AAL1 konta z 2FA,
 * żeby można było w niej wpisać kod. Sesja przed kodem nie dostaje firmy.
 */
export type MobileAuthOptions =
  | { org: 'none' | 'required'; mfa?: 'verified' }
  | { org: 'none'; mfa: 'challenge' };

function providersOf(user: User): string[] {
  const providers = (user.app_metadata as { providers?: unknown; provider?: unknown } | undefined)?.providers;
  if (Array.isArray(providers)) return providers.filter((p): p is string => typeof p === 'string');
  const provider = user.app_metadata?.provider;
  return typeof provider === 'string' ? [provider] : [];
}

export async function authenticateMobileRequest(
  request: Request,
  options: MobileAuthOptions,
): Promise<MobileAuthResult> {
  const mfaMode = options.mfa ?? 'verified';
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
  if (mfaMode === 'verified' && state.status === 'challenge_required') {
    return fail(mobileError(403, 'mfa_required', 'Wpisz kod z aplikacji uwierzytelniającej, żeby dokończyć logowanie.', base));
  }
  if (mfaMode === 'challenge' && state.status !== 'challenge_required') {
    return fail(mobileError(409, 'mfa_not_required', 'Ta sesja nie czeka na kod. Możesz korzystać z aplikacji.', base));
  }

  // Bez liczenia odmów: `Retry-After` to czas, po którym zapytanie naprawdę przejdzie.
  const userLimit = await checkRateLimit({
    bucket: 'mobile_api_user',
    identifier: state.user.id,
    ...MOBILE_API_RATE_LIMITS.user,
    countDenied: false,
  });
  if (!userLimit.allowed) return rateLimited(userLimit, base);

  const totpFactorId = state.user.factors?.find((factor) => factor.factor_type === 'totp' && factor.status === 'verified')?.id ?? null;

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
      user: { id: state.user.id, email: state.user.email ?? null, providers: providersOf(state.user) },
      mfaEnabled: state.status === 'challenge_required' ? totpFactorId !== null : state.mfaEnabled,
      accessToken: mfaMode === 'challenge' ? bearer.token : null,
      totpFactorId: mfaMode === 'challenge' ? totpFactorId : null,
      session: state.claims,
      org,
      db: createMobileDbClient(bearer.token, { activeOrg: org?.tenantId ?? null }),
    },
  };
}
