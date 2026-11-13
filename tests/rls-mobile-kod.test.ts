import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { verifyMobileToken } from '@/lib/api/mobile/auth';
import { verifyMobileTotpCode } from '@/lib/api/mobile/kod';
import { signInMobileWithPassword } from '@/lib/api/mobile/logowanie';

import { getRlsTestEnvironment } from './helpers/rls-environment';
import { totpCode } from './helpers/totp';

/**
 * Etap M6c planu aplikacji mobilnej na prawdziwym GoTrue: kod 2FA z telefonu
 * idzie przez `POST /api/mobile/v1/kod`, a trasa potwierdza go w GoTrue
 * tokenem klienta (`verifyMobileTotpCode`: `/factors/{id}/challenge` i
 * `/verify` z kluczem anon, jak strona). Limit prób i audyt trasy sprawdza
 * `tests/unit/mobile-api-kod.test.ts` (Redis w CI RLS nie ma).
 *
 * Tu: bramka w wariancie dla kodu dostaje konto i poziom sesji AAL1, zły kod
 * to odmowa (nie awaria), dobry daje AAL2 tej samej sesji GoTrue z refresh
 * tokenem, który telefon odświeża kluczem anon, a zakończona sesja to
 * `session_gone`, nie wyjątek.
 *
 * Logowań hasłem są trzy, kodów pięć: poniżej limitów GoTrue.
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : (null as unknown as SupabaseClient);
const target = environment
  ? { url: environment.url, anonKey: environment.anonKey, serviceRoleKey: environment.serviceRoleKey }
  : {};

const RUN = Date.now().toString(36);
const T_EMAIL = `rls-mobile-kod-totp-${RUN}@ksef-saas.test`;
const PASS = 'RlsMobileKodPass2026Aa!';

/** Klient jak w telefonie: klucz anon, sesja w pamięci. */
function phoneClient(): SupabaseClient {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function aal1Session(): Promise<{ accessToken: string; refreshToken: string }> {
  const result = await signInMobileWithPassword(T_EMAIL, PASS, target);
  if (result.status !== 'ok' || !result.wymagaKodu) throw new Error(`logowanie: ${result.status}`);
  return { accessToken: result.accessToken, refreshToken: result.refreshToken };
}

describe.skipIf(!hasDatabase)('M6c: kod 2FA telefonu przez API na prawdziwym GoTrue', () => {
  let tId = '';
  let factorId = '';
  let totpSecret = '';

  beforeAll(async () => {
    const { data, error } = await admin.auth.admin.createUser({ email: T_EMAIL, password: PASS, email_confirm: true });
    if (error || !data.user) throw error ?? new Error('createUser');
    tId = data.user.id;
    // TOTP włączony z sesji z trasy logowania (przy captchy w GoTrue klucz anon nie zaloguje się hasłem).
    const login = await signInMobileWithPassword(T_EMAIL, PASS, target);
    if (login.status !== 'ok') throw new Error(`logowanie: ${login.status}`);
    const phone = phoneClient();
    const set = await phone.auth.setSession({ access_token: login.accessToken, refresh_token: login.refreshToken });
    if (set.error) throw set.error;
    const enroll = await phone.auth.mfa.enroll({ factorType: 'totp' });
    if (enroll.error || !enroll.data) throw enroll.error ?? new Error('enroll');
    factorId = enroll.data.id;
    totpSecret = enroll.data.totp.secret;
    const verified = await phone.auth.mfa.challengeAndVerify({ factorId, code: totpCode(totpSecret) });
    if (verified.error) throw verified.error;
  });

  afterAll(async () => {
    // Wpisy audytu są nieusuwalne (00052), więc usunięcie konta może odmówić; baza CI jest jednorazowa.
    if (tId) await admin.auth.admin.deleteUser(tId).catch(() => null);
  });

  it('bramka w wariancie dla kodu: sesja AAL1 konta z TOTP ma konto, czynnik i sesję', async () => {
    const { accessToken } = await aal1Session();
    const state = await verifyMobileToken(accessToken, target);
    expect(state.status).toBe('challenge_required');
    if (state.status !== 'challenge_required') return;
    expect(state.user.id).toBe(tId);
    expect(state.user.factors?.some((factor) => factor.id === factorId && factor.status === 'verified')).toBe(true);
    expect(state.claims).toMatchObject({ aal: 'aal1', sessionId: claimsOf(accessToken).session_id });
  });

  it('zły kod: invalid_code; dobry kod: AAL2 tej samej sesji, którą API uznaje i telefon odświeża', async () => {
    const { accessToken } = await aal1Session();
    // Kod spoza okien, które GoTrue przyjmuje (poprzednie, bieżące, następne).
    const accepted = new Set([-30_000, 0, 30_000, 60_000].map((shift) => totpCode(totpSecret, Date.now() + shift)));
    let wrong = 100_000;
    while (accepted.has(String(wrong))) wrong += 1;
    await expect(verifyMobileTotpCode(accessToken, factorId, String(wrong), target)).resolves.toEqual({ status: 'invalid_code' });

    // Kod z następnego okna 30 s: inny niż kod z włączania w `beforeAll`.
    const result = await verifyMobileTotpCode(accessToken, factorId, totpCode(totpSecret, Date.now() + 30_000), target);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(claimsOf(result.accessToken)).toMatchObject({ sub: tId, aal: 'aal2', session_id: claimsOf(accessToken).session_id });

    const state = await verifyMobileToken(result.accessToken, target);
    expect(state.status).toBe('ok');
    if (state.status !== 'ok') return;
    expect(state.mfaEnabled).toBe(true);
    expect(state.claims.aal).toBe('aal2');

    const phone = phoneClient();
    expect((await phone.auth.setSession({ access_token: result.accessToken, refresh_token: result.refreshToken })).error).toBeNull();
    const refreshed = await phone.auth.refreshSession();
    expect(refreshed.error).toBeNull();
    expect(claimsOf(refreshed.data.session!.access_token)).toMatchObject({ aal: 'aal2' });
    expect((await phone.auth.signOut({ scope: 'local' })).error).toBeNull();
  });

  it('sesja zakończona przed kodem: session_gone, nie wyjątek', async () => {
    const { accessToken, refreshToken } = await aal1Session();
    const phone = phoneClient();
    expect((await phone.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })).error).toBeNull();
    expect((await phone.auth.signOut({ scope: 'local' })).error).toBeNull();
    await expect(verifyMobileTotpCode(accessToken, factorId, totpCode(totpSecret), target)).resolves.toEqual({ status: 'session_gone' });
  });
});
