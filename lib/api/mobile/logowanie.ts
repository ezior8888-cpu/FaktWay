import 'server-only';

import { randomUUID } from 'node:crypto';

import * as Sentry from '@sentry/nextjs';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import type { NextResponse } from 'next/server';
import { z } from 'zod';

import { createMobileDbClient, createMobileLoginClient, type MobileSupabaseTarget } from '@/lib/api/mobile/db';
import type { LogowanieOdpowiedz } from '@/lib/api/mobile/kontrakt';
import { MobileUpstreamError, mobileError, mobileFailure, mobileJson } from '@/lib/api/mobile/responses';
import { recordMobileLoginSession } from '@/lib/api/mobile/sesja';
import { logAudit } from '@/lib/audit/log';
import { clientIpFromHeaders } from '@/lib/auth/client-ip';
import { readAccessTokenFacts } from '@/lib/auth/sessions/access-token';
import { isMaintenanceMode } from '@/lib/feature-flags/maintenance';
import { hashIdentifier } from '@/lib/rate-limit';
import { checkMobileLoginRateLimits } from '@/lib/rate-limit/auth';
import { isGoTrueCaptchaRejection } from '@/lib/security/bot-check';

/**
 * Logowanie hasłem z telefonu przez nasze API (plan aplikacji mobilnej, etap
 * M6b, decyzja Bartosza D16 z 13.11.2026).
 *
 * Dlaczego nie wprost do GoTrue jak w M5b: po kroku 2 runbooka
 * `docs/runbooks/captcha-w-gotrue.md` GoTrue odrzuca logowanie hasłem bez
 * tokenu Turnstile (`captcha_failed`), a natywna aplikacja go nie ma. GoTrue
 * przepuszcza bez captchy żądania z kluczem serwisowym w `Authorization`
 * (`createMobileLoginClient`), więc trasa loguje tym kluczem, a w zamian za
 * captchę stawia nasze limity prób i wpis w audycie. Sprawdzone na lokalnym
 * GoTrue z captchą (13.11.2026, wynik w opisie PR M6b): odświeżanie sesji,
 * kod 2FA (`/factors/.../challenge`, `/verify`) i wylogowanie captchy nie
 * wymagają, więc telefon robi je dalej sam w GoTrue.
 *
 * Kolejność (każdy krok odmawia, zanim dotknie następnego):
 *  1. przerwa techniczna: 503 bez GoTrue;
 *  2. treść żądania (`email`, `haslo`): 400 bez GoTrue;
 *  3. limity prób (`checkMobileLoginRateLimits`): adres IP, e-mail i wspólny
 *     ze stroną. Bez Redisa (albo przy jego awarii) trasa ODMAWIA (503
 *     `login_unavailable`, fail-closed): to jedyna ochrona przed zgadywaniem
 *     haseł, a limit w pamięci procesu nie jest wspólny. Klient dostaje drogę
 *     wyjścia: logowanie na faktway.pl (z Turnstile) albo za kilka minut;
 *     operator przywraca Redisa (lista skutków w `lib/cache/redis.ts`);
 *  4. GoTrue kluczem serwisowym. Odmowa captchy mimo klucza (zła konfiguracja)
 *     to 503 `login_unavailable` i zgłoszenie do Sentry, nie „złe hasło”;
 *  5. udane: wpis `auth.login` jak na stronie (zaraz po haśle, także przed
 *     kodem 2FA) i zlecenie maila o nowym urządzeniu; nieudane (złe dane):
 *     wpis `auth.login_failed` bez konta i adresu e-mail (tylko jego skrót).
 *
 * Ponowienie: trasa niczego nie robi dwa razy sama. Telefon, który ponowi po
 * zerwanym połączeniu, dostaje drugą sesję (druga sesja w GoTrue, drugi wpis
 * `auth.login`; mail o nowym urządzeniu zna już pierwszą sesję, więc drugi raz
 * nie wyjdzie). Każda próba liczy się w limitach.
 *
 * Hasło i adres e-mail nie trafiają do Sentry, audytu ani logów.
 */

const LOGIN_UNAVAILABLE = 'Logowanie w aplikacji jest chwilowo niedostępne. Zaloguj się na faktway.pl albo spróbuj za kilka minut.';
const INVALID_CREDENTIALS = 'Nieprawidłowy e-mail lub hasło. Upewnij się, że e-mail jest potwierdzony.';
/** Tyle telefon czeka po `login_unavailable` z powodu limitów i po limicie GoTrue (który nie podaje czasu). */
const RETRY_AFTER_SECONDS = '60';
/** Treść logowania to dwa krótkie pola; dłuższa nie jest czytana. */
const MAX_BODY_BYTES = 4096;

/** Jak formularz strony (`loginWithEmail`): e-mail bez spacji i małymi literami, hasło bez zmian. */
const loginBodySchema = z.object({
  email: z.string().trim().toLowerCase().min(3).max(320).regex(/^[^\s@]+@[^\s@]+$/),
  haslo: z.string().min(1).max(1024),
});

export type MobilePasswordSignIn =
  | {
    status: 'ok';
    userId: string;
    accessToken: string;
    refreshToken: string;
    /** Konto ma zweryfikowany czynnik 2FA, a sesja jest na `aal1` (reguła strony). */
    wymagaKodu: boolean;
    sessionId: string | null;
    amrMethods: string[];
  }
  | { status: 'invalid_credentials' }
  | { status: 'rate_limited' }
  | { status: 'captcha_rejected' };

/**
 * Logowanie hasłem w GoTrue kluczem serwisowym. Odmowa danych to wynik, nie
 * wyjątek; sieć, 5xx i odpowiedź bez kodu HTTP rzucają `MobileUpstreamError`
 * (telefon ponawia, a nie słyszy „złe hasło”).
 */
export async function signInMobileWithPassword(
  email: string,
  password: string,
  target: MobileSupabaseTarget = {},
): Promise<MobilePasswordSignIn> {
  const client = createMobileLoginClient(target);
  const { data, error } = await client.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
  if (error) {
    if (isAuthRetryableFetchError(error)) throw new MobileUpstreamError('gotrue');
    const status = typeof error.status === 'number' ? error.status : null;
    if (status === null || status >= 500) throw new MobileUpstreamError('gotrue');
    if (status === 429) return { status: 'rate_limited' };
    if (isGoTrueCaptchaRejection(error)) return { status: 'captcha_rejected' };
    return { status: 'invalid_credentials' };
  }
  if (!data.session || !data.user) throw new MobileUpstreamError('gotrue session');

  // Ta sama reguła co strona po haśle (`app/(auth)/login/actions.ts`): sesja z pamięci tego klienta, bez sieci.
  const { data: aal, error: aalError } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalError || !aal) throw new MobileUpstreamError('gotrue aal');
  const facts = readAccessTokenFacts(data.session.access_token);
  return {
    status: 'ok',
    userId: data.user.id,
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    wymagaKodu: aal.currentLevel === 'aal1' && aal.nextLevel === 'aal2',
    sessionId: facts.sessionId,
    amrMethods: facts.amrMethods,
  };
}

async function readLoginBody(request: Request): Promise<z.infer<typeof loginBodySchema> | null> {
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
  const parsed = loginBodySchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** `POST /api/mobile/v1/logowanie`: cała obsługa poza samym eksportem trasy. */
export async function handleMobilePasswordLogin(request: Request): Promise<NextResponse> {
  const requestId = randomUUID();
  const base = { 'X-Request-Id': requestId };

  if (await isMaintenanceMode()) {
    return mobileError(503, 'maintenance', 'Trwa przerwa techniczna FaktWay. Spróbuj ponownie za kilka minut.', {
      ...base,
      'Retry-After': '300',
    });
  }

  const body = await readLoginBody(request);
  if (!body) return mobileError(400, 'invalid_request', 'Wpisz e-mail i hasło.', base);

  // Brak adresu (poza proxy Coolify) to jeden wspólny kubełek, jak w `lib/api/mobile/auth.ts`.
  const ip = clientIpFromHeaders(request.headers) ?? 'unknown';
  const limit = await checkMobileLoginRateLimits(ip, body.email);
  if (limit.fallback) {
    Sentry.captureMessage('api_mobile: logowanie bez limitów prób (Redis niedostępny), odmowa', {
      level: 'warning',
      tags: { area: 'api.mobile.login' },
      extra: { requestId },
    });
    return mobileError(503, 'login_unavailable', LOGIN_UNAVAILABLE, { ...base, 'Retry-After': RETRY_AFTER_SECONDS });
  }
  if (!limit.allowed) {
    const retryAfter = String(Math.max(1, limit.retryAfter));
    return mobileError(429, 'rate_limited', `Zbyt wiele prób logowania. Spróbuj ponownie za ${retryAfter} s.`, {
      ...base,
      'Retry-After': retryAfter,
    });
  }

  let result: MobilePasswordSignIn;
  try {
    result = await signInMobileWithPassword(body.email, body.haslo);
  } catch (error) {
    return mobileFailure(error, requestId, base);
  }

  if (result.status === 'rate_limited') {
    return mobileError(429, 'rate_limited', 'Zbyt wiele prób logowania. Spróbuj ponownie za minutę.', {
      ...base,
      'Retry-After': RETRY_AFTER_SECONDS,
    });
  }
  if (result.status === 'captcha_rejected') {
    // Klucz serwisowy powinien pomijać captchę; odmowa znaczy zły klucz albo zmianę w GoTrue.
    Sentry.captureMessage('api_mobile: GoTrue odrzucił captchą logowanie kluczem serwisowym', {
      level: 'error',
      tags: { area: 'api.mobile.login' },
      extra: { requestId },
    });
    return mobileError(503, 'login_unavailable', LOGIN_UNAVAILABLE, { ...base, 'Retry-After': RETRY_AFTER_SECONDS });
  }
  if (result.status === 'invalid_credentials') {
    await logAudit({
      action: 'auth.login_failed',
      tenantId: null,
      userId: null,
      metadata: { method: 'password', client: 'mobile', reason: 'invalid_credentials', email_hash: hashIdentifier(body.email) },
    });
    return mobileError(400, 'invalid_credentials', INVALID_CREDENTIALS, base);
  }

  try {
    await recordMobileLoginSession({
      userId: result.userId,
      sessionId: result.sessionId,
      amrMethods: result.amrMethods,
      db: createMobileDbClient(result.accessToken),
      nowa: true,
    });
  } catch {
    // Jak na stronie: wpis nie blokuje logowania. Bez wpisu nie ma zlecenia maila; zrobi je `POST /sesja`.
    Sentry.captureMessage('api_mobile: wpis logowania z telefonu niezapisany', {
      level: 'warning',
      tags: { area: 'api.mobile.login' },
      extra: { requestId },
    });
  }

  const response: LogowanieOdpowiedz = {
    sesja: { accessToken: result.accessToken, refreshToken: result.refreshToken },
    wymagaKodu: result.wymagaKodu,
  };
  return mobileJson(response, 200, base);
}
