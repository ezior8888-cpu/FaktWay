import 'server-only';

import * as Sentry from '@sentry/nextjs';
import type { NextResponse } from 'next/server';
import { z } from 'zod';

import { authenticateMobileRequest, verifyMobileToken, type MobileTokenState } from '@/lib/api/mobile/auth';
import { resolveTarget, type MobileSupabaseTarget } from '@/lib/api/mobile/db';
import type { KodOdpowiedz } from '@/lib/api/mobile/kontrakt';
import { MobileUpstreamError, mobileError, mobileFailure, mobileJson } from '@/lib/api/mobile/responses';
import { logAudit } from '@/lib/audit/log';
import { checkMfaRateLimit } from '@/lib/rate-limit/mfa';

/**
 * Kod 2FA z telefonu przez nasze API (plan aplikacji mobilnej, etap M6c).
 *
 * Dlaczego nie wprost do GoTrue jak w M5b i M6b: telefon wołał wtedy
 * `mfa.challengeAndVerify` sam, więc omijał limit prób kodu strony
 * (`checkMfaRateLimit`) i nie zostawiał wpisów w audycie. Trasa robi to samo co
 * `verifyMfaChallengeAction` (`app/(auth)/login/two-factor/actions.ts`), w tej
 * samej kolejności (każdy krok odmawia, zanim dotknie następnego):
 *  1. bramka `authenticateMobileRequest` w wariancie `mfa: 'challenge'`: limit na
 *     adres, przerwa techniczna, token, GoTrue; przechodzi TYLKO sesja AAL1 konta
 *     z 2FA (inna dostaje 409 `mfa_not_required`), potem limit na osobę;
 *  2. treść `{ kod }`: kod spoza sześciu cyfr to 400 `invalid_code` bez zużycia
 *     próby i bez GoTrue (jak strona);
 *  3. `checkMfaRateLimit`: 5 prób na 5 minut na konto, wspólny ze stroną i z
 *     ustawieniami 2FA. Bez Redisa (albo przy jego awarii) trasa ODMAWIA
 *     (503 `service_unavailable`, fail-closed, jak strona). Klient: „spróbuj za
 *     chwilę”; operator przywraca Redisa (skutki w `lib/cache/redis.ts`);
 *  4. czynnik TOTP z odpowiedzi GoTrue (bramka), wyzwanie i kod w GoTrue TOKENEM
 *     KLIENTA i kluczem anon (`verifyMobileTotpCode`), nigdy kluczem serwisowym;
 *  5. nowy token sprawdzony w GoTrue (AAL2, to samo konto): sama odpowiedź
 *     GoTrue nie wystarcza, jak na stronie;
 *  6. wpisy jak na stronie: `auth.mfa_challenge_failed` przy odrzuconym kodzie,
 *     `auth.mfa_challenge_succeeded` po kodzie (oba z `client: 'mobile'`).
 *
 * Ponowienie (telefon ponawia tylko po 401 i tylko raz, `mobile/src/lib/api/rdzen.ts`):
 * każda próba liczy się w limicie; wyzwanie w GoTrue jest jednorazowe i nowe
 * przy każdej próbie; po udanym kodzie stary token AAL1 dalej mówi `aal1`, więc
 * telefon, który nie dostał odpowiedzi i wyśle ten sam kod drugi raz, dostanie
 * nowe wyzwanie, drugi wpis i drugą próbę z limitu. Nic nie dzieje się dwa razy
 * bez nowego żądania.
 *
 * Kod nie trafia do Sentry, audytu ani logów.
 */

const INVALID_CODE = 'Kod nieprawidłowy. Sprawdź godzinę w telefonie i wpisz aktualny kod z aplikacji TOTP.';
/** Tekst strony przy `verification_unavailable` (`app/(auth)/login/two-factor/page.tsx`). */
const VERIFICATION_UNAVAILABLE = 'Nie możemy teraz sprawdzić kodu. Spróbuj ponownie za chwilę.';
/** Tyle telefon czeka po odmowie bez Redisa i po limicie GoTrue (który nie podaje czasu). */
const RETRY_AFTER_SECONDS = '60';
/** Treść to jedno krótkie pole; dłuższa nie jest czytana. */
const MAX_BODY_BYTES = 1024;
/**
 * Tyle najdłużej czekamy na GoTrue przy jednym kroku (wyzwanie albo kod). Dwa kroki
 * i bramka muszą zmieścić się w 15 s telefonu (`LIMIT_ZADANIA_MS`), inaczej telefon
 * zrywa żądanie, a serwer mimo to podnosi sesję do AAL2 i zapisuje sukces.
 */
const GOTRUE_TIMEOUT_MS = 5_000;

const kodBodySchema = z.object({ kod: z.string().max(64) });

export type MobileTotpVerification =
  | { status: 'ok'; accessToken: string; refreshToken: string }
  /** GoTrue odrzucił kod (zły, z innego okna, wyzwanie wygasło). */
  | { status: 'invalid_code' }
  /** Token nie ma już sesji w GoTrue (wylogowanie, odebrany dostęp). */
  | { status: 'session_gone' }
  /** Limit GoTrue (na adres app-1), nie nasz limit konta. */
  | { status: 'rate_limited' };

type GoTrueReply = { status: number; body: unknown };

/**
 * `POST /auth/v1/factors/...` tokenem klienta. Bez `supabase-js`: jego
 * `mfa.challenge` i `mfa.verify` biorą token z sesji w pamięci klienta, a
 * trasa ma tylko token dostępu z nagłówka (refresh tokenu telefonu celowo nie
 * przyjmuje: odświeżenie na serwerze zmieniłoby go telefonowi).
 */
async function callFactors(path: string, token: string, body: unknown, target: MobileSupabaseTarget): Promise<GoTrueReply> {
  const { url, anonKey } = resolveTarget(target);
  let response: Response;
  try {
    response = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/factors/${path}`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GOTRUE_TIMEOUT_MS),
    });
  } catch {
    throw new MobileUpstreamError('gotrue factors');
  }
  return { status: response.status, body: await response.json().catch(() => null) };
}

/**
 * Token bez sesji w GoTrue: 401 (zły albo wygasły JWT) albo 403 `session_not_found`
 * (wylogowanie). Inne 403 to nie koniec sesji: telefon po 401 odświeża sesję i wysyła
 * ten sam kod drugi raz, więc dostają 503 bez ponowienia.
 */
function isSessionGone(reply: GoTrueReply): boolean {
  if (reply.status === 401) return true;
  return reply.status === 403 && stringField(reply.body, 'error_code') === 'session_not_found';
}

function stringField(body: unknown, field: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Wyzwanie i kod TOTP w GoTrue tokenem klienta (to samo, co `mfa.challenge` i
 * `mfa.verify` strony). Odmowy to wyniki; sieć, 5xx i odpowiedź spoza kształtu
 * rzucają `MobileUpstreamError` (telefon ponawia, nie słyszy „zły kod”).
 */
export async function verifyMobileTotpCode(
  token: string,
  factorId: string,
  code: string,
  target: MobileSupabaseTarget = {},
): Promise<MobileTotpVerification> {
  const factor = encodeURIComponent(factorId);
  const challenge = await callFactors(`${factor}/challenge`, token, {}, target);
  if (isSessionGone(challenge)) return { status: 'session_gone' };
  if (challenge.status === 429) return { status: 'rate_limited' };
  const challengeId = challenge.status === 200 ? stringField(challenge.body, 'id') : null;
  if (!challengeId) throw new MobileUpstreamError(`gotrue challenge ${challenge.status}`);

  const verify = await callFactors(`${factor}/verify`, token, { challenge_id: challengeId, code }, target);
  if (isSessionGone(verify)) return { status: 'session_gone' };
  if (verify.status === 429) return { status: 'rate_limited' };
  // GoTrue: 422 `mfa_verification_failed` (zły kod), `mfa_challenge_expired`; 400 przy kodzie w złym kształcie.
  if (verify.status === 400 || verify.status === 422) return { status: 'invalid_code' };
  const accessToken = verify.status === 200 ? stringField(verify.body, 'access_token') : null;
  const refreshToken = verify.status === 200 ? stringField(verify.body, 'refresh_token') : null;
  if (!accessToken || !refreshToken) throw new MobileUpstreamError(`gotrue verify ${verify.status}`);
  return { status: 'ok', accessToken, refreshToken };
}

async function readKodBody(request: Request): Promise<z.infer<typeof kodBodySchema> | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const text = await request.text().catch(() => null);
  if (text === null || text.length > MAX_BODY_BYTES) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = kodBodySchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function unavailable(headers: Record<string, string>): NextResponse {
  return mobileError(503, 'service_unavailable', VERIFICATION_UNAVAILABLE, { ...headers, 'Retry-After': RETRY_AFTER_SECONDS });
}

/** `POST /api/mobile/v1/kod`: cała obsługa poza samym eksportem trasy. */
export async function handleMobileMfaCode(request: Request): Promise<NextResponse> {
  const auth = await authenticateMobileRequest(request, { org: 'none', mfa: 'challenge' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  const base = caller.headers;
  const token = caller.accessToken;
  if (!token) throw new Error('api_mobile: wariant challenge bez tokenu');

  const body = await readKodBody(request);
  if (!body) return mobileError(400, 'invalid_request', 'Wpisz kod z aplikacji uwierzytelniającej.', base);
  const code = body.kod.trim();
  // Bez wyszukania kodu, zużycia próby i wpisu (jak strona); kod ratunkowy telefon też dostaje jako zły kod.
  if (!/^[0-9]{6}$/.test(code)) return mobileError(400, 'invalid_code', INVALID_CODE, base);

  if (!caller.totpFactorId) {
    // Konto ma 2FA, którego aplikacja nie obsługuje (tylko TOTP): jak `no_factor` na stronie, bez zużycia próby.
    return mobileError(400, 'invalid_request', 'Nie znaleźliśmy aktywnego 2FA. Skontaktuj się z pomocą techniczną.', base);
  }

  const limit = await checkMfaRateLimit(caller.user.id);
  if (limit.unavailable) {
    Sentry.captureMessage('api_mobile: kod 2FA bez limitu prób (Redis niedostępny), odmowa', {
      level: 'warning',
      tags: { area: 'api.mobile.mfa' },
      extra: { requestId: caller.requestId },
    });
    return unavailable(base);
  }
  if (!limit.allowed) {
    const retryAfter = String(Math.max(1, limit.retryAfter));
    return mobileError(429, 'rate_limited', `Zbyt wiele prób. Spróbuj ponownie za ${retryAfter} s.`, {
      ...base,
      'Retry-After': retryAfter,
    });
  }

  let result: MobileTotpVerification;
  try {
    result = await verifyMobileTotpCode(token, caller.totpFactorId, code);
  } catch (error) {
    return mobileFailure(error, caller.requestId, base);
  }

  if (result.status === 'session_gone') {
    return mobileError(401, 'invalid_token', 'Sesja wygasła. Zaloguj się ponownie.', {
      ...base,
      'WWW-Authenticate': 'Bearer realm="FaktWay", error="invalid_token"',
    });
  }
  if (result.status === 'rate_limited') {
    return mobileError(429, 'rate_limited', 'Zbyt wiele prób. Spróbuj ponownie za minutę.', {
      ...base,
      'Retry-After': RETRY_AFTER_SECONDS,
    });
  }
  if (result.status === 'invalid_code') {
    await logAudit({
      action: 'auth.mfa_challenge_failed',
      tenantId: null,
      userId: caller.user.id,
      metadata: { method: 'totp', stage: 'verify', client: 'mobile' },
    });
    return mobileError(400, 'invalid_code', INVALID_CODE, base);
  }

  // Sama odpowiedź GoTrue nie dowodzi silniejszej sesji (jak `getVerifiedMfaState` po kodzie na stronie).
  let finalState: MobileTokenState | null;
  try {
    finalState = await verifyMobileToken(result.accessToken);
  } catch {
    finalState = null;
  }
  if (
    !finalState ||
    finalState.status !== 'ok' ||
    finalState.user.id !== caller.user.id ||
    finalState.claims.aal !== 'aal2' ||
    !finalState.mfaEnabled
  ) {
    Sentry.captureMessage('api_mobile: GoTrue przyjął kod 2FA, ale nowa sesja nie jest AAL2', {
      level: 'error',
      tags: { area: 'api.mobile.mfa' },
      extra: { requestId: caller.requestId, status: finalState?.status ?? 'unavailable' },
    });
    return unavailable(base);
  }

  await logAudit({
    action: 'auth.mfa_challenge_succeeded',
    tenantId: null,
    userId: caller.user.id,
    metadata: { method: 'totp', client: 'mobile' },
  });
  const response: KodOdpowiedz = { sesja: { accessToken: result.accessToken, refreshToken: result.refreshToken } };
  return mobileJson(response, 200, base);
}
