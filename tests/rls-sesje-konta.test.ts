import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { describeUserAgent } from '@/lib/auth/sessions/user-agent';

import { getRlsTestEnvironment } from './helpers/rls-environment';
import { totpCode } from './helpers/totp';

/**
 * 00174 (krok 8.5 planu kompletnej aplikacji) na prawdziwej bazie, prawdziwym
 * PostgREST i prawdziwym GoTrue: zalogowane urządzenia, wylogowanie na odległość
 * i historia logowań.
 *
 * Tego nie da się sprawdzić w pamięci: uprawnienia funkcji (anon, pomocnicze),
 * izolacja kont, `auth.jwt() ->> 'session_id'` z PostgREST, krok kodu przy 2FA
 * i to, że usunięty wiersz `auth.sessions` naprawdę wylogowuje: GoTrue przestaje
 * uznawać token (`GET /user`, to samo pyta proxy aplikacji) i nie odświeży sesji.
 *
 * Sesje tworzy logowanie hasłem wprost z procesu testu (Node), więc GoTrue
 * zapisuje w nich nagłówki tego procesu. Tak samo wyglądają sesje, które FaktWay
 * loguje z serwera, i dlatego urządzenie bierzemy z wpisu `auth.login` w audycie.
 * Wpisy audytu wstawia tu klucz serwisowy, jak `logAudit`.
 *
 * Kolejność przypadków ma znaczenie: dzielą sesje, a wylogowanie jest nieodwracalne.
 * Logowań jest sześć, poniżej limitu GoTrue (30 na 5 minut z jednego adresu).
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

const RUN = Date.now().toString(36);
const A_EMAIL = `rls-sesje-a-${RUN}@ksef-saas.test`;
const B_EMAIL = `rls-sesje-b-${RUN}@ksef-saas.test`;
const TOTP_EMAIL = `rls-sesje-totp-${RUN}@ksef-saas.test`;
const PASS = 'RlsSesjePass2026Aa!';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MASKED = /\/(24|48|120)$/;

interface Signed {
  client: SupabaseClient;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
}

interface SessionRow {
  session_id: string;
  is_current: boolean;
  signed_in_at: string;
  last_active_at: string;
  login_method: string | null;
  user_agent: string | null;
  ip_prefix: string | null;
  device_source: 'login' | 'session';
}

interface LoginRow {
  signed_in_at: string;
  action: string;
  login_method: string | null;
  user_agent: string | null;
  ip_prefix: string | null;
  session_id: string | null;
  is_current: boolean;
  is_active: boolean;
}

function anonClient(): SupabaseClient {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function claims(accessToken: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function createUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true });
  if (error || !data.user) throw error ?? new Error('createUser');
  return data.user.id;
}

async function signedIn(email: string): Promise<Signed> {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASS });
  if (error || !data.session) throw error ?? new Error('signIn');
  const sessionId = claims(data.session.access_token).session_id;
  if (typeof sessionId !== 'string') throw new Error('token bez session_id');
  return { client, sessionId, accessToken: data.session.access_token, refreshToken: data.session.refresh_token };
}

/** Czy GoTrue uznaje sesję tego tokenu: `GET /user`, to samo pytanie zadaje proxy aplikacji. */
async function stillSignedIn(accessToken: string): Promise<boolean> {
  const { data, error } = await anonClient().auth.getUser(accessToken);
  return !error && data.user !== null;
}

async function sessions(client: SupabaseClient): Promise<SessionRow[]> {
  const { data, error } = await client.rpc('list_account_sessions');
  if (error) throw error;
  return data as SessionRow[];
}

async function logins(client: SupabaseClient, limit: number): Promise<LoginRow[]> {
  const { data, error } = await client.rpc('list_account_logins', { p_limit: limit });
  if (error) throw error;
  return data as LoginRow[];
}

async function insertLogin(row: Record<string, unknown>): Promise<void> {
  const { error } = await admin.from('audit_logs').insert({ tenant_id: null, action: 'auth.login', ...row });
  if (error) throw error;
}

describe.skipIf(!hasDatabase)('00174: zalogowane urządzenia i historia logowań na prawdziwej bazie', () => {
  let aId = '';
  let bId = '';
  let a1: Signed;
  let a2: Signed;
  let a3: Signed;
  let b1: Signed;
  const createdUsers: string[] = [];

  beforeAll(async () => {
    aId = await createUser(A_EMAIL);
    bId = await createUser(B_EMAIL);
    createdUsers.push(aId, bId);
    a1 = await signedIn(A_EMAIL);
    a2 = await signedIn(A_EMAIL);
    a3 = await signedIn(A_EMAIL);
    b1 = await signedIn(B_EMAIL);

    // Logowanie A na „iPhonie” (sesja a1) i starsze logowanie biometrią bez sesji w metadanych.
    await insertLogin({
      user_id: aId, user_agent: IPHONE, ip_address: '83.21.104.77',
      metadata: { method: 'password', session_id: a1.sessionId },
    });
    // Miesiąc temu: w oknie retencji audytu (12 miesięcy), więc żaden inny test go nie sprząta.
    await insertLogin({
      user_id: aId, user_agent: IPHONE, ip_address: '2a02:a311:4a3f:1::5',
      metadata: { method: 'passkey' }, created_at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
    });
    // Logowanie B, którego A nie może zobaczyć.
    await insertLogin({
      user_id: bId, user_agent: IPHONE, ip_address: '198.51.100.23',
      metadata: { method: 'password', session_id: b1.sessionId },
    });
  });

  afterAll(async () => {
    // Wpisy audytu są nieusuwalne (00052), więc usunięcie konta z nimi może odmówić;
    // baza CI jest jednorazowa.
    for (const id of createdUsers) await admin.auth.admin.deleteUser(id).catch(() => null);
  });

  it('anon nie wywoła żadnej z funkcji', async () => {
    const anon = anonClient();
    for (const [fn, args] of [
      ['list_account_sessions', {}],
      ['list_account_logins', { p_limit: 5 }],
      ['revoke_account_session', { p_session_id: a2.sessionId }],
      ['revoke_other_account_sessions', {}],
      ['account_security_session', {}],
      ['account_ip_prefix', { p_ip: '83.21.104.77' }],
    ] as const) {
      const { error } = await anon.rpc(fn, args);
      expect(error?.code, fn).toBe('42501');
    }
    expect(await stillSignedIn(a2.accessToken)).toBe(true);
  });

  it('funkcje pomocnicze są tylko dla funkcji 00174, nie dla zalogowanego', async () => {
    expect((await a1.client.rpc('account_security_session')).error?.code).toBe('42501');
    expect((await a1.client.rpc('account_ip_prefix', { p_ip: '83.21.104.77' })).error?.code).toBe('42501');
  });

  it('lista: tylko własne sesje, bieżąca pierwsza, urządzenie z wpisu logowania, adres skrócony', async () => {
    const rows = await sessions(a1.client);
    const ids = rows.map((row) => row.session_id);
    expect(ids).toEqual(expect.arrayContaining([a1.sessionId, a2.sessionId, a3.sessionId]));
    expect(ids).not.toContain(b1.sessionId);
    expect(rows[0]).toMatchObject({
      session_id: a1.sessionId, is_current: true, device_source: 'login',
      login_method: 'password', user_agent: IPHONE, ip_prefix: '83.21.104.0/24',
    });
    expect(rows.filter((row) => row.is_current)).toHaveLength(1);

    // Sesja bez wpisu logowania: GoTrue zapisał nagłówki procesu, który się logował
    // (tu Node testu, na produkcji serwer FaktWay), nie przeglądarki.
    const fromGoTrue = rows.find((row) => row.session_id === a2.sessionId)!;
    expect(fromGoTrue).toMatchObject({ is_current: false, device_source: 'session', login_method: null });
    expect(describeUserAgent(fromGoTrue.user_agent).fromServer).toBe(true);
    if (fromGoTrue.ip_prefix !== null) expect(fromGoTrue.ip_prefix).toMatch(MASKED);

    for (const row of rows) {
      expect(new Date(row.last_active_at).getTime()).toBeGreaterThanOrEqual(new Date(row.signed_in_at).getTime());
    }
    expect(JSON.stringify(rows)).not.toContain('83.21.104.77');

    expect((await sessions(b1.client)).map((row) => row.session_id)).toEqual([b1.sessionId]);
  });

  it('historia: tylko własne logowania, najnowsze najpierw, adres skrócony, stan sesji', async () => {
    const rows = await logins(a1.client, 20);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      action: 'auth.login', login_method: 'password', user_agent: IPHONE, ip_prefix: '83.21.104.0/24',
      session_id: a1.sessionId, is_current: true, is_active: true,
    });
    expect(rows[1]).toMatchObject({
      login_method: 'passkey', ip_prefix: '2a02:a311:4a3f::/48', session_id: null, is_current: false, is_active: false,
    });
    expect(JSON.stringify(rows)).not.toMatch(/83\.21\.104\.77|198\.51\.100|2a02:a311:4a3f:1::5/);

    expect(await logins(a1.client, 1)).toHaveLength(1);
    expect(await logins(a1.client, 0)).toHaveLength(1);
    expect(await logins(a1.client, 100000)).toHaveLength(2);
    expect((await logins(b1.client, 20)).map((row) => row.ip_prefix)).toEqual(['198.51.100.0/24']);
  });

  it('A nie wyloguje sesji B, a bieżącej nie wyloguje tą funkcją', async () => {
    const foreign = await a1.client.rpc('revoke_account_session', { p_session_id: b1.sessionId });
    expect(foreign).toMatchObject({ data: false, error: null });
    expect(await stillSignedIn(b1.accessToken)).toBe(true);

    const current = await a1.client.rpc('revoke_account_session', { p_session_id: a1.sessionId });
    expect(current.error).toMatchObject({ code: '22023', message: 'current_session' });
    expect(await stillSignedIn(a1.accessToken)).toBe(true);
  });

  it('wylogowanie jednej sesji: GoTrue jej nie uznaje, odświeżenie pada, jej token niczego już nie zrobi', async () => {
    expect(await stillSignedIn(a2.accessToken)).toBe(true);
    const revoked = await a1.client.rpc('revoke_account_session', { p_session_id: a2.sessionId });
    expect(revoked).toMatchObject({ data: true, error: null });

    expect(await stillSignedIn(a2.accessToken)).toBe(false);
    const refresh = await anonClient().auth.refreshSession({ refresh_token: a2.refreshToken });
    expect(refresh.error).not.toBeNull();
    expect(refresh.data.session).toBeNull();

    // Token dostępu działa w PostgREST do wygaśnięcia, więc funkcje same pytają o sesję.
    for (const fn of ['list_account_sessions', 'revoke_other_account_sessions'] as const) {
      const { error } = await a2.client.rpc(fn);
      expect(error, fn).toMatchObject({ code: '42501', message: 'session_not_found' });
    }
    expect(await stillSignedIn(a1.accessToken)).toBe(true);
    expect(await stillSignedIn(a3.accessToken)).toBe(true);

    expect((await a1.client.rpc('revoke_account_session', { p_session_id: a2.sessionId })).data).toBe(false);
    expect((await sessions(a1.client)).map((row) => row.session_id)).not.toContain(a2.sessionId);
  });

  it('wylogowanie wszystkich pozostałych: tylko własne, bieżąca zostaje', async () => {
    const revoked = await a1.client.rpc('revoke_other_account_sessions');
    expect(revoked).toMatchObject({ data: 1, error: null });
    expect(await stillSignedIn(a3.accessToken)).toBe(false);
    expect(await stillSignedIn(a1.accessToken)).toBe(true);
    expect(await stillSignedIn(b1.accessToken)).toBe(true);
    expect((await sessions(a1.client)).map((row) => row.session_id)).toEqual([a1.sessionId]);
    expect((await a1.client.rpc('revoke_other_account_sessions')).data).toBe(0);

    // Historia zostaje po wylogowaniu: to wpisy audytu, nie sesje.
    expect(await logins(a1.client, 20)).toHaveLength(2);
  });

  it('konto z 2FA: sesja bez kodu (AAL1) dostaje code_step_required, sesja z kodem działa', async () => {
    const id = await createUser(TOTP_EMAIL);
    createdUsers.push(id);
    const enrolled = await signedIn(TOTP_EMAIL);
    const enroll = await enrolled.client.auth.mfa.enroll({ factorType: 'totp' });
    if (enroll.error || !enroll.data) throw enroll.error ?? new Error('enroll');
    const verified = await enrolled.client.auth.mfa.challengeAndVerify({
      factorId: enroll.data.id, code: totpCode(enroll.data.totp.secret),
    });
    expect(verified.error).toBeNull();
    const aal2Token = (await enrolled.client.auth.getSession()).data.session!.access_token;
    expect(claims(aal2Token)).toMatchObject({ aal: 'aal2', session_id: enrolled.sessionId });

    // Nowe logowanie hasłem daje AAL1, tak samo jak sesja po biometrii.
    const aal1 = await signedIn(TOTP_EMAIL);
    for (const [fn, args] of [
      ['list_account_sessions', {}],
      ['list_account_logins', { p_limit: 5 }],
      ['revoke_account_session', { p_session_id: enrolled.sessionId }],
      ['revoke_other_account_sessions', {}],
    ] as const) {
      const { error } = await aal1.client.rpc(fn, args);
      expect(error, fn).toMatchObject({ code: '42501', message: 'code_step_required' });
    }
    expect(await stillSignedIn(aal2Token)).toBe(true);

    const rows = await sessions(enrolled.client);
    expect(rows.map((row) => row.session_id)).toEqual(expect.arrayContaining([enrolled.sessionId, aal1.sessionId]));
    const revoked = await enrolled.client.rpc('revoke_account_session', { p_session_id: aal1.sessionId });
    expect(revoked).toMatchObject({ data: true, error: null });
    expect(await stillSignedIn(aal1.accessToken)).toBe(false);
  });
});
