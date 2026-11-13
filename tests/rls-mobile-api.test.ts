import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { findActiveMembership, verifyMobileToken } from '@/lib/api/mobile/auth';
import { createMobileDbClient } from '@/lib/api/mobile/db';
import { readMobileAccountFirms, readMobileActiveFirm } from '@/lib/api/mobile/konto';
import { isLoginRecorded } from '@/lib/api/mobile/sesja';

import { getRlsTestEnvironment } from './helpers/rls-environment';
import { totpCode } from './helpers/totp';

/**
 * Etap M6 planu aplikacji mobilnej (4.3) na prawdziwym GoTrue i PostgREST:
 * API `/api/mobile/v1` buduje klienta bazy z tokenu sesji telefonu, więc
 * o dostępie decyduje RLS, jak na stronie.
 *
 * Tego nie sprawdzi atrapa w `tests/unit/mobile-api-trasy.test.ts`:
 * - które tokeny GoTrue uznaje (`getUser`, `getClaims`): sesja klienta tak;
 *   klucz anon, klucz serwisowy, podrobiony podpis i wylogowana sesja nie
 *   (i to jako odmowa, nie jako awaria, która dałaby 503);
 * - poziom AAL1 i AAL2 konta z prawdziwym TOTP;
 * - polityki `memberships_select_self_or_org` (00058) i `tenants_select_member_of`
 *   (00037): lista firm tylko z aktywnych członkostw właściciela tokenu;
 * - `get_current_tenant_id()` z nagłówka `x-active-org` (00037): obca firma
 *   w nagłówku nie oddaje jej faktur, nawet gdyby trasa nie sprawdziła członkostwa;
 * - filtr `metadata->>session_id` przez PostgREST przy wpisie logowania.
 *
 * Logowań jest pięć, poniżej limitu GoTrue (30 na 5 minut z jednego adresu).
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
const target = environment ? { url: environment.url, anonKey: environment.anonKey } : {};

const RUN = Date.now().toString(36);
const A_EMAIL = `rls-mobile-a-${RUN}@ksef-saas.test`;
const B_EMAIL = `rls-mobile-b-${RUN}@ksef-saas.test`;
const T_EMAIL = `rls-mobile-totp-${RUN}@ksef-saas.test`;
const PASS = 'RlsMobileApiPass2026Aa!';

const ORG_A = '000a6000-0000-4000-8000-000000000001';
const ORG_A2 = '000a6000-0000-4000-8000-000000000002';
const ORG_B = '000a6000-0000-4000-8000-000000000003';
const ORG_T = '000a6000-0000-4000-8000-000000000004';
const INV_A = '000a6000-1000-4000-8000-000000000001';
const INV_B = '000a6000-1000-4000-8000-000000000002';

const baseInvoice = {
  invoice_type: 'VAT', invoice_kind: 'regular', origin: 'app', seller_nip: '1234567890', buyer_nip: '1234567890',
  payment_due_date: '2026-11-30', currency: 'PLN', direction: 'outgoing', issue_date: '2026-11-02',
  net_total: 10, vat_total: 2.3, gross_total: 12.3, ksef_status: 'draft',
};

function anonClient(): SupabaseClient {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function createUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true });
  if (error || !data.user) throw error ?? new Error('createUser');
  return data.user.id;
}

async function signedIn(email: string): Promise<{ client: SupabaseClient; token: string }> {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASS });
  if (error || !data.session) throw error ?? new Error('signIn');
  return { client, token: data.session.access_token };
}

async function invoiceIds(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db.from('invoices').select('id').in('id', [INV_A, INV_B]);
  if (error) throw new Error(error.message);
  return ((data ?? []) as { id: string }[]).map((row) => row.id).sort();
}

/**
 * Ten sam token z jednym znakiem podpisu zmienionym w środku. Nie na końcu:
 * ostatni znak base64url niesie bity dopełnienia, a ich zmiana nie zmienia podpisu.
 */
function tamperedSignature(token: string): string {
  const [head, payload, signature] = token.split('.');
  const at = Math.floor(signature!.length / 2);
  const swapped = signature![at] === 'A' ? 'B' : 'A';
  return `${head}.${payload}.${signature!.slice(0, at)}${swapped}${signature!.slice(at + 1)}`;
}

/** Ładunek innego konta z podpisem tokenu A. */
function swappedSubject(token: string, sub: string): string {
  const [head, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
  return `${head}.${Buffer.from(JSON.stringify({ ...claims, sub })).toString('base64url')}.${signature}`;
}

describe.skipIf(!hasDatabase)('M6: API aplikacji na telefon na prawdziwym GoTrue i PostgREST', () => {
  let aId = '';
  let bId = '';
  let tId = '';
  let tokenA = '';
  let tokenT1 = '';
  let tokenT2 = '';
  const createdUsers: string[] = [];

  beforeAll(async () => {
    aId = await createUser(A_EMAIL);
    bId = await createUser(B_EMAIL);
    tId = await createUser(T_EMAIL);
    createdUsers.push(aId, bId, tId);

    const { error: tenantsError } = await admin.from('tenants').upsert([
      { id: ORG_A, nip: '1234567890', name: 'Firma telefonu A' },
      { id: ORG_A2, nip: '1234567890', name: 'Klient biura A2' },
      { id: ORG_B, nip: '1234567890', name: 'Firma telefonu B' },
      { id: ORG_T, nip: '1234567890', name: 'Firma z 2FA' },
    ], { onConflict: 'id' });
    if (tenantsError) throw tenantsError;
    await admin.from('users').upsert(
      [{ id: aId, name: 'A' }, { id: bId, name: 'B' }, { id: tId, name: 'T' }],
      { onConflict: 'id' },
    );
    const { error: membershipsError } = await admin.from('memberships').insert([
      { organization_id: ORG_A, user_id: aId, role: 'owner', status: 'active', joined_at: '2026-01-02T00:00:00Z' },
      { organization_id: ORG_A2, user_id: aId, role: 'accountant', status: 'active', joined_at: '2026-03-01T00:00:00Z' },
      // Dawny dostęp A do firmy B: cofnięty, więc nie otwiera niczego.
      { organization_id: ORG_B, user_id: aId, role: 'member', status: 'revoked', joined_at: '2026-04-01T00:00:00Z' },
      { organization_id: ORG_B, user_id: bId, role: 'owner', status: 'active', joined_at: '2026-02-01T00:00:00Z' },
      { organization_id: ORG_T, user_id: tId, role: 'owner', status: 'active', joined_at: '2026-02-01T00:00:00Z' },
    ]);
    if (membershipsError) throw membershipsError;
    const { error: profileError } = await admin.from('users').update({ last_active_tenant_id: ORG_A }).eq('id', aId);
    if (profileError) throw profileError;
    const { error: invoicesError } = await admin.from('invoices').insert([
      { ...baseInvoice, id: INV_A, tenant_id: ORG_A, internal_number: 'FV/M6/A', fa3_data: { internalNumber: 'FV/M6/A' } },
      { ...baseInvoice, id: INV_B, tenant_id: ORG_B, internal_number: 'FV/M6/B', fa3_data: { internalNumber: 'FV/M6/B' } },
    ]);
    if (invoicesError) throw invoicesError;

    tokenA = (await signedIn(A_EMAIL)).token;

    // Konto z prawdziwym TOTP: po kodzie AAL2, nowe logowanie hasłem znów AAL1.
    const enrolled = await signedIn(T_EMAIL);
    const enroll = await enrolled.client.auth.mfa.enroll({ factorType: 'totp' });
    if (enroll.error || !enroll.data) throw enroll.error ?? new Error('enroll');
    const verified = await enrolled.client.auth.mfa.challengeAndVerify({
      factorId: enroll.data.id, code: totpCode(enroll.data.totp.secret),
    });
    if (verified.error) throw verified.error;
    tokenT2 = (await enrolled.client.auth.getSession()).data.session!.access_token;
    tokenT1 = (await signedIn(T_EMAIL)).token;
  });

  afterAll(async () => {
    await admin.from('invoices').delete().in('id', [INV_A, INV_B]);
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_A2, ORG_B, ORG_T]);
    // Wpisy audytu są nieusuwalne (00052), więc usunięcie konta z nimi może odmówić;
    // baza CI jest jednorazowa.
    for (const id of createdUsers) await admin.auth.admin.deleteUser(id).catch(() => null);
  });

  it('token sesji klienta: konto bez 2FA, claims tej sesji', async () => {
    const state = await verifyMobileToken(tokenA, target);
    expect(state.status).toBe('ok');
    if (state.status !== 'ok') return;
    expect(state.user.id).toBe(aId);
    expect(state.mfaEnabled).toBe(false);
    expect(state.claims.aal).toBe('aal1');
    expect(state.claims.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.claims.amrMethods).toContain('password');
  });

  it('lista firm z tokenu klienta: tylko aktywne członkostwa, ostatnio używana na wierzchu', async () => {
    const account = await readMobileAccountFirms(createMobileDbClient(tokenA, { target }), aId);
    expect(account).toEqual({
      firmy: [
        { id: ORG_A2, nazwa: 'Klient biura A2', nip: '1234567890', rola: 'accountant' },
        { id: ORG_A, nazwa: 'Firma telefonu A', nip: '1234567890', rola: 'owner' },
      ],
      wszystkie: true,
      aktywnaFirma: ORG_A,
    });
  });

  it('tokenem A nie da się odczytać cudzego konta (RLS, nie filtr w trasie)', async () => {
    const db = createMobileDbClient(tokenA, { target });
    expect(await readMobileAccountFirms(db, bId)).toEqual({ firmy: [], wszystkie: true, aktywnaFirma: null });
    expect(await readMobileActiveFirm(db, bId)).toBeNull();
  });

  it('firma wpisu logowania: ta sama co aktywnaFirma listy', async () => {
    expect(await readMobileActiveFirm(createMobileDbClient(tokenA, { target }), aId)).toBe(ORG_A);
  });

  it('członkostwo z X-Active-Org: własna firma tak, cofnięta i obca nie', async () => {
    const db = createMobileDbClient(tokenA, { target });
    expect(await findActiveMembership(db, aId, ORG_A)).toEqual({ role: 'owner' });
    expect(await findActiveMembership(db, aId, ORG_B)).toBeNull();
    expect(await findActiveMembership(db, bId, ORG_B)).toBeNull();
  });

  it('obca firma w x-active-org nie oddaje jej faktur, nawet bez sprawdzenia w trasie', async () => {
    expect(await invoiceIds(createMobileDbClient(tokenA, { activeOrg: ORG_A, target }))).toEqual([INV_A]);
    expect(await invoiceIds(createMobileDbClient(tokenA, { activeOrg: ORG_B, target }))).toEqual([]);
    expect(await invoiceIds(createMobileDbClient(tokenA, { target }))).toEqual([]);
  });

  it('klucz anon, klucz serwisowy i podrobione tokeny nie są sesją (odmowa, nie awaria)', async () => {
    for (const token of [
      environment!.anonKey,
      environment!.serviceRoleKey,
      tamperedSignature(tokenA),
      swappedSubject(tokenA, bId),
    ]) {
      await expect(verifyMobileToken(token, target)).resolves.toEqual({ status: 'unauthenticated' });
    }
  });

  it('konto z TOTP: sesja AAL1 to challenge_required, po kodzie AAL2 przechodzi', async () => {
    await expect(verifyMobileToken(tokenT1, target)).resolves.toMatchObject({ status: 'challenge_required' });
    const state = await verifyMobileToken(tokenT2, target);
    expect(state.status).toBe('ok');
    if (state.status !== 'ok') return;
    expect(state.mfaEnabled).toBe(true);
    expect(state.claims.aal).toBe('aal2');
    expect(state.claims.amrMethods).toEqual(expect.arrayContaining(['totp', 'password']));
  });

  it('wylogowana sesja telefonu przestaje być ważna (odmowa, nie awaria)', async () => {
    const second = await signedIn(A_EMAIL);
    expect((await verifyMobileToken(second.token, target)).status).toBe('ok');
    const { error } = await second.client.auth.signOut({ scope: 'local' });
    expect(error).toBeNull();
    await expect(verifyMobileToken(second.token, target)).resolves.toEqual({ status: 'unauthenticated' });
  });

  it('wpis logowania sesji znajduje filtr metadata->>session_id przez PostgREST', async () => {
    const state = await verifyMobileToken(tokenA, target);
    if (state.status !== 'ok' || !state.claims.sessionId) throw new Error('brak sesji A');
    const sessionId = state.claims.sessionId;
    expect(await isLoginRecorded(admin, aId, sessionId)).toBe(false);

    const { error } = await admin.from('audit_logs').insert({
      tenant_id: ORG_A, user_id: aId, action: 'auth.login',
      metadata: { method: 'password', session_id: sessionId, client: 'mobile' },
    });
    if (error) throw error;

    expect(await isLoginRecorded(admin, aId, sessionId)).toBe(true);
    expect(await isLoginRecorded(admin, bId, sessionId)).toBe(false);
    expect(await isLoginRecorded(admin, aId, '000a6000-2000-4000-8000-000000000009')).toBe(false);
  });
});
