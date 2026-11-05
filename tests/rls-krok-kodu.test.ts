import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';
import { totpCode } from './helpers/totp';

/**
 * 00163 na prawdziwej bazie i prawdziwym PostgREST: dostęp osób trzecich tylko po kroku kodu.
 *
 * Akcje serwerowe pytają o kod z aplikacji (`requireCodeForAccessGrant`), gdy konto ma 2FA,
 * a sesja kodu nie podała. Taką sesję (AAL1) daje logowanie biometrią, a jej token działa
 * też wprost w PostgREST. Baza stawia więc ten sam warunek przy adresie wysyłki do księgowej,
 * linku dla księgowej, przyjęciu prośby o dostęp i zmianie roli. Cofnięcie dostępu kodu
 * nie wymaga. Sesja AAL1 po haśle jest dla bazy tym samym co sesja po biometrii.
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
const ORG = 'c0de0163-0000-4000-8000-000000000001';
const PASS = 'RlsKrokKoduPass2026Aa!';
const FUTURE = '2999-01-01T00:00:00.000Z';
const SEEDED_EMAIL = 'ksiegowa@ksef-saas.test';
const PEOPLE = ['wlasciciel', 'bez2fa', 'admin', 'czlonek', 'cel', 'prosba1', 'prosba2', 'prosba3'] as const;
type Person = (typeof PEOPLE)[number];

const email = (who: Person) => `rls-kod-${who}-${RUN}@ksef-saas.test`;

function anonClient(): SupabaseClient {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-active-org': ORG } },
  });
}

async function signedIn(who: Person): Promise<SupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email: email(who), password: PASS });
  if (error) throw error;
  return client;
}

async function settingsEmail(): Promise<string | null | undefined> {
  const { data } = await admin.from('accountant_settings').select('accountant_email').eq('tenant_id', ORG).maybeSingle();
  return data?.accountant_email;
}

describe.skipIf(!hasDatabase)('00163: dostęp osób trzecich tylko po kroku kodu', () => {
  const ids = {} as Record<Person, string>;
  const membershipOf = {} as Record<string, string>;
  /** Właściciel z 2FA bez kodu w tej sesji (jak po logowaniu biometrią): AAL1. */
  let bezKodu: SupabaseClient;
  /** Ten sam właściciel po kodzie TOTP: AAL2. */
  let zKodem: SupabaseClient;
  let bez2fa: SupabaseClient;
  let adminBez2fa: SupabaseClient;
  let czlonek: SupabaseClient;

  beforeAll(async () => {
    for (const who of PEOPLE) {
      const { data, error } = await admin.auth.admin.createUser({ email: email(who), password: PASS, email_confirm: true });
      if (error || !data.user) throw error ?? new Error('createUser');
      ids[who] = data.user.id;
    }
    const tenant = await admin.from('tenants').insert({ id: ORG, nip: '1234567890', name: 'Firma Krok Kodu RLS' });
    if (tenant.error) throw tenant.error;
    const users = await admin.from('users').upsert(PEOPLE.map((who) => ({ id: ids[who], name: who })), { onConflict: 'id' });
    if (users.error) throw users.error;
    const members = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ids.wlasciciel, role: 'owner', status: 'active' },
      { organization_id: ORG, user_id: ids.bez2fa, role: 'owner', status: 'active' },
      { organization_id: ORG, user_id: ids.admin, role: 'admin', status: 'active' },
      { organization_id: ORG, user_id: ids.czlonek, role: 'member', status: 'active' },
      { organization_id: ORG, user_id: ids.cel, role: 'member', status: 'active' },
    ]).select('id, user_id');
    if (members.error) throw members.error;
    for (const row of members.data) membershipOf[row.user_id] = row.id;
    const settings = await admin.from('accountant_settings').insert({ tenant_id: ORG, accountant_email: SEEDED_EMAIL });
    if (settings.error) throw settings.error;

    zKodem = await signedIn('wlasciciel');
    const enroll = await zKodem.auth.mfa.enroll({ factorType: 'totp' });
    if (enroll.error || !enroll.data) throw enroll.error ?? new Error('enroll');
    const verified = await zKodem.auth.mfa.challengeAndVerify({
      factorId: enroll.data.id, code: totpCode(enroll.data.totp.secret),
    });
    if (verified.error) throw verified.error;
    bezKodu = await signedIn('wlasciciel');
    bez2fa = await signedIn('bez2fa');
    adminBez2fa = await signedIn('admin');
    czlonek = await signedIn('czlonek');
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await admin.from('accountant_access').delete().eq('tenant_id', ORG);
    await admin.from('accountant_settings').delete().eq('tenant_id', ORG);
    await admin.from('organization_join_requests').delete().eq('organization_id', ORG);
    await admin.from('memberships').delete().eq('organization_id', ORG);
    await admin.from('tenants').delete().eq('id', ORG);
    for (const id of Object.values(ids)) await admin.auth.admin.deleteUser(id);
  });

  describe('wysyłka do księgowej (`accountant_settings`)', () => {
    it('sesja bez kodu na koncie z 2FA nie zmieni adresu ani kopii wprost', async () => {
      const upsert = await bezKodu.from('accountant_settings')
        .upsert({ tenant_id: ORG, accountant_email: 'obcy@ksef-saas.test' }, { onConflict: 'tenant_id' });
      expect(upsert.error?.code).toBe('42501');
      const update = await bezKodu.from('accountant_settings')
        .update({ cc_emails: ['obcy@ksef-saas.test'] }).eq('tenant_id', ORG).select('id');
      expect(update.error?.code).toBe('42501');
      expect(await settingsEmail()).toBe(SEEDED_EMAIL);
    });

    it('członek bez roli właściciela albo administratora nie zapisze ani nie usunie ustawień', async () => {
      const upsert = await czlonek.from('accountant_settings')
        .upsert({ tenant_id: ORG, accountant_email: 'obcy@ksef-saas.test' }, { onConflict: 'tenant_id' });
      expect(upsert.error?.code).toBe('42501');
      const removed = await czlonek.from('accountant_settings').delete().eq('tenant_id', ORG).select('id');
      expect(removed.data ?? []).toEqual([]);
      expect(await settingsEmail()).toBe(SEEDED_EMAIL);
    });

    it('z kodem, bez 2FA i jako administrator zapis działa jak dotąd', async () => {
      const cases: Array<[SupabaseClient, string]> = [
        [zKodem, 'z-kodem@ksef-saas.test'],
        [bez2fa, 'bez-2fa@ksef-saas.test'],
        [adminBez2fa, 'administrator@ksef-saas.test'],
      ];
      for (const [client, address] of cases) {
        const { error } = await client.from('accountant_settings')
          .upsert({ tenant_id: ORG, accountant_email: address }, { onConflict: 'tenant_id' });
        expect(error).toBeNull();
        expect(await settingsEmail()).toBe(address);
      }
    });
  });

  describe('link dla księgowej (`accountant_access`)', () => {
    const link = (hash: string, by: Person = 'wlasciciel') => ({
      tenant_id: ORG, token_hash: hash.repeat(64), accountant_name: 'Księgowa Testowa',
      accountant_email: SEEDED_EMAIL, access_level: 'read_only', expires_at: FUTURE,
      created_by_user_id: ids[by],
    });

    it('sesja bez kodu nie wystawi linku wprost', async () => {
      const { error } = await bezKodu.from('accountant_access').insert(link('b'));
      expect(error?.code).toBe('42501');
      const rows = await admin.from('accountant_access').select('id').eq('token_hash', 'b'.repeat(64));
      expect(rows.data).toEqual([]);
    });

    it('sesja bez kodu nie przedłuży, nie podmieni i nie przywróci linku, a cofnie go', async () => {
      const seeded = await admin.from('accountant_access').insert(link('c')).select('id').single();
      if (seeded.error) throw seeded.error;
      const id = seeded.data.id;

      const extend = await bezKodu.from('accountant_access')
        .update({ expires_at: '3000-01-01T00:00:00.000Z' }).eq('id', id).select('id');
      expect(extend.error?.code).toBe('42501');
      const swap = await bezKodu.from('accountant_access')
        .update({ token_hash: 'd'.repeat(64) }).eq('id', id).select('id');
      expect(swap.error?.code).toBe('42501');

      const revoke = await bezKodu.from('accountant_access')
        .update({ revoked_at: new Date().toISOString() }).eq('id', id).select('id');
      expect(revoke.error).toBeNull();
      expect(revoke.data).toHaveLength(1);

      const restore = await bezKodu.from('accountant_access')
        .update({ revoked_at: null }).eq('id', id).select('id');
      expect(restore.error?.code).toBe('42501');

      const after = await admin.from('accountant_access').select('token_hash, revoked_at').eq('id', id).single();
      expect(after.data?.token_hash).toBe('c'.repeat(64));
      expect(after.data?.revoked_at).not.toBeNull();
    });

    it('z kodem i bez 2FA właściciel wystawia link jak dotąd', async () => {
      const withCode = await zKodem.from('accountant_access').insert(link('e')).select('id').single();
      expect(withCode.error).toBeNull();
      const withoutMfa = await bez2fa.from('accountant_access').insert(link('f', 'bez2fa')).select('id').single();
      expect(withoutMfa.error).toBeNull();
    });
  });

  describe('prośba o dostęp i zmiana roli (RPC)', () => {
    async function pendingRequest(who: Person): Promise<string> {
      const { data, error } = await admin.from('organization_join_requests')
        .insert({ organization_id: ORG, requested_by_user_id: ids[who], status: 'pending' })
        .select('id').single();
      if (error) throw error;
      return data.id;
    }

    it('sesja bez kodu nie przyjmie prośby ani nie zmieni roli', async () => {
      const requestId = await pendingRequest('prosba1');
      const approve = await bezKodu.rpc('approve_join_request', { p_request_id: requestId, p_role: 'admin' });
      expect(approve.error?.code).toBe('42501');
      expect(approve.error?.message).toContain('code_step_required');

      const promote = await bezKodu.rpc('change_membership_role', {
        p_membership_id: membershipOf[ids.cel], p_new_role: 'owner',
      });
      expect(promote.error?.code).toBe('42501');
      expect(promote.error?.message).toContain('code_step_required');

      const request = await admin.from('organization_join_requests').select('status').eq('id', requestId).single();
      expect(request.data?.status).toBe('pending');
      const joined = await admin.from('memberships').select('id')
        .eq('organization_id', ORG).eq('user_id', ids.prosba1);
      expect(joined.data).toEqual([]);
      const role = await admin.from('memberships').select('role').eq('id', membershipOf[ids.cel]).single();
      expect(role.data?.role).toBe('member');
    });

    it('z kodem i bez 2FA przyjęcie prośby i zmiana roli działają jak dotąd', async () => {
      const approveWithCode = await zKodem.rpc('approve_join_request', {
        p_request_id: await pendingRequest('prosba2'), p_role: 'member',
      });
      expect(approveWithCode.error).toBeNull();
      const approveWithoutMfa = await bez2fa.rpc('approve_join_request', {
        p_request_id: await pendingRequest('prosba3'), p_role: 'accountant',
      });
      expect(approveWithoutMfa.error).toBeNull();

      const promote = await zKodem.rpc('change_membership_role', {
        p_membership_id: membershipOf[ids.cel], p_new_role: 'admin',
      });
      expect(promote.error).toBeNull();
      const demote = await bez2fa.rpc('change_membership_role', {
        p_membership_id: membershipOf[ids.cel], p_new_role: 'member',
      });
      expect(demote.error).toBeNull();

      const joined = await admin.from('memberships').select('user_id, role')
        .eq('organization_id', ORG).in('user_id', [ids.prosba2, ids.prosba3]);
      expect(joined.data?.map((row) => row.role).sort()).toEqual(['accountant', 'member']);
    });
  });
});
