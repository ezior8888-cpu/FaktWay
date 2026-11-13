import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { verifyMobileToken } from '@/lib/api/mobile/auth';
import { signInMobileWithPassword } from '@/lib/api/mobile/logowanie';
import { isGoTrueCaptchaRejection } from '@/lib/security/bot-check';

import { getRlsTestEnvironment } from './helpers/rls-environment';
import { totpCode } from './helpers/totp';

/**
 * Etap M6b planu aplikacji mobilnej (decyzja D16) na prawdziwym GoTrue:
 * telefon loguje się hasłem przez `POST /api/mobile/v1/logowanie`, bo po
 * kroku 2 runbooka `docs/runbooks/captcha-w-gotrue.md` GoTrue odrzuca
 * logowanie hasłem bez tokenu Turnstile, a aplikacja go nie ma.
 *
 * Zawsze (także w CI, gdzie GoTrue nie ma captchy):
 * - logowanie kluczem serwisowym daje zwykłą sesję klienta (rola
 *   `authenticated`, AAL1, metoda `password`, `session_id`), którą API
 *   telefonu uznaje (`verifyMobileToken`);
 * - złe hasło i nieznany e-mail to odmowa, nie awaria;
 * - konto z TOTP: `wymagaKodu`, a kod wpisany w telefonie (klucz anon, sesja
 *   z trasy przez `setSession`) daje AAL2;
 * - sesja z trasy odświeża się w telefonie kluczem anon.
 *
 * Z `RLS_TEST_GOTRUE_CAPTCHA=on` na GoTrue z włączoną captchą (`[auth.captcha]`
 * w konfiguracji stosu; w CI tego stosu nie ma) dodatkowo: logowanie kluczem
 * anon, jak w aplikacji M5b, dostaje odmowę captchy, a trasa nie; odświeżenie,
 * kod 2FA i wylogowanie kluczem anon przechodzą bez captchy.
 *
 * Logowań hasłem jest sześć (siedem z captchą), poniżej limitu GoTrue
 * (30 na 5 minut z jednego adresu).
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);
const captchaInGoTrue = process.env.RLS_TEST_GOTRUE_CAPTCHA === 'on';
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : (null as unknown as SupabaseClient);
const target = environment
  ? { url: environment.url, anonKey: environment.anonKey, serviceRoleKey: environment.serviceRoleKey }
  : {};

const RUN = Date.now().toString(36);
const A_EMAIL = `rls-mobile-login-a-${RUN}@ksef-saas.test`;
const T_EMAIL = `rls-mobile-login-totp-${RUN}@ksef-saas.test`;
const PASS = 'RlsMobileLoginPass2026Aa!';

/** Klient jak w telefonie: klucz anon, sesja w pamięci. */
function phoneClient(): SupabaseClient {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function signedInThroughRoute(email: string): Promise<{ phone: SupabaseClient; accessToken: string; refreshToken: string; wymagaKodu: boolean }> {
  const result = await signInMobileWithPassword(email, PASS, target);
  if (result.status !== 'ok') throw new Error(`logowanie: ${result.status}`);
  const phone = phoneClient();
  const { error } = await phone.auth.setSession({ access_token: result.accessToken, refresh_token: result.refreshToken });
  if (error) throw error;
  return { phone, accessToken: result.accessToken, refreshToken: result.refreshToken, wymagaKodu: result.wymagaKodu };
}

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe.skipIf(!hasDatabase)('M6b: logowanie telefonu przez API na prawdziwym GoTrue', () => {
  let aId = '';
  let tId = '';
  let factorId = '';
  let totpSecret = '';

  beforeAll(async () => {
    for (const email of [A_EMAIL, T_EMAIL]) {
      const { data, error } = await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true });
      if (error || !data.user) throw error ?? new Error('createUser');
      if (email === A_EMAIL) aId = data.user.id;
      else tId = data.user.id;
    }
    // TOTP włączony z sesji z trasy: przy captchy w GoTrue klucz anon nie zaloguje się hasłem.
    const { phone } = await signedInThroughRoute(T_EMAIL);
    const enroll = await phone.auth.mfa.enroll({ factorType: 'totp' });
    if (enroll.error || !enroll.data) throw enroll.error ?? new Error('enroll');
    factorId = enroll.data.id;
    totpSecret = enroll.data.totp.secret;
    const verified = await phone.auth.mfa.challengeAndVerify({ factorId, code: totpCode(totpSecret) });
    if (verified.error) throw verified.error;
  });

  afterAll(async () => {
    // Wpisy audytu są nieusuwalne (00052), więc usunięcie konta z nimi może odmówić; baza CI jest jednorazowa.
    for (const id of [aId, tId]) if (id) await admin.auth.admin.deleteUser(id).catch(() => null);
  });

  it('hasło: zwykła sesja klienta (AAL1, password, session_id), którą API telefonu uznaje', async () => {
    const result = await signInMobileWithPassword(A_EMAIL.toUpperCase(), PASS, target);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.userId).toBe(aId);
    expect(result.wymagaKodu).toBe(false);
    // Klucz serwisowy w nagłówku nie zmienia sesji w sesję serwisową.
    expect(claimsOf(result.accessToken)).toMatchObject({ role: 'authenticated', aal: 'aal1', sub: aId });
    const state = await verifyMobileToken(result.accessToken, target);
    expect(state.status).toBe('ok');
    if (state.status !== 'ok') return;
    expect(state.user.id).toBe(aId);
    expect(state.claims.amrMethods).toContain('password');
    expect(state.claims.sessionId).toBe(result.sessionId);
  });

  it('złe hasło i nieznany e-mail: invalid_credentials (odmowa, nie awaria)', async () => {
    await expect(signInMobileWithPassword(A_EMAIL, 'zle-haslo-2026', target)).resolves.toEqual({ status: 'invalid_credentials' });
    await expect(signInMobileWithPassword(`nikt-${RUN}@ksef-saas.test`, PASS, target)).resolves.toEqual({ status: 'invalid_credentials' });
  });

  it('konto z TOTP: wymagaKodu, a kod wpisany w telefonie (klucz anon) daje AAL2', async () => {
    const { phone, accessToken, wymagaKodu } = await signedInThroughRoute(T_EMAIL);
    expect(wymagaKodu).toBe(true);
    await expect(verifyMobileToken(accessToken, target)).resolves.toEqual({ status: 'challenge_required' });

    // Kod z następnego okna 30 s (GoTrue przyjmuje jedno okno w przód): inny niż kod z włączania.
    const verified = await phone.auth.mfa.challengeAndVerify({ factorId, code: totpCode(totpSecret, Date.now() + 30_000) });
    expect(verified.error).toBeNull();
    const session = (await phone.auth.getSession()).data.session!;
    expect(claimsOf(session.access_token)).toMatchObject({ aal: 'aal2' });
    const state = await verifyMobileToken(session.access_token, target);
    expect(state.status).toBe('ok');
  });

  it('sesja z trasy odświeża się w telefonie kluczem anon i kończy wylogowaniem', async () => {
    const { phone, accessToken, refreshToken } = await signedInThroughRoute(A_EMAIL);
    const refreshed = await phone.auth.refreshSession();
    expect(refreshed.error).toBeNull();
    expect(refreshed.data.session?.refresh_token).not.toBe(refreshToken);
    const { error } = await phone.auth.signOut({ scope: 'local' });
    expect(error).toBeNull();
    await expect(verifyMobileToken(accessToken, target)).resolves.toEqual({ status: 'unauthenticated' });
  });

  describe.skipIf(!captchaInGoTrue)('GoTrue z włączoną captchą', () => {
    it('logowanie hasłem kluczem anon (aplikacja M5b) dostaje odmowę captchy', async () => {
      const { data, error } = await phoneClient().auth.signInWithPassword({ email: A_EMAIL, password: PASS });
      expect(data.session).toBeNull();
      expect(isGoTrueCaptchaRejection(error)).toBe(true);
    });

    it('trasa loguje mimo captchy; odświeżenie, kod 2FA i wylogowanie kluczem anon przechodzą bez captchy', async () => {
      const { phone, wymagaKodu } = await signedInThroughRoute(T_EMAIL);
      expect(wymagaKodu).toBe(true);
      const challenge = await phone.auth.mfa.challenge({ factorId });
      expect(challenge.error).toBeNull();
      const verify = await phone.auth.mfa.verify({
        factorId, challengeId: challenge.data!.id, code: totpCode(totpSecret, Date.now() + 30_000),
      });
      expect(verify.error).toBeNull();
      const refreshed = await phone.auth.refreshSession();
      expect(refreshed.error).toBeNull();
      expect(claimsOf(refreshed.data.session!.access_token)).toMatchObject({ aal: 'aal2' });
      expect((await phone.auth.signOut({ scope: 'local' })).error).toBeNull();
    });
  });
});
