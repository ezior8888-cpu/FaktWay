import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';
import { totpCode } from './helpers/totp';

/**
 * 00159 na prawdziwej bazie i prawdziwym PostgREST: `user_passkeys`
 * i `webauthn_challenges`.
 *
 * Tego nie da się sprawdzić w pamięci: RLS, granty kolumnowe, wyzwania
 * zużywane przez `DELETE ... RETURNING` przy równoległych żądaniach,
 * polityka usuwania zależna od AAL i kaskada z `auth.users`.
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
const OWNER_EMAIL = `rls-passkey-owner-${RUN}@ksef-saas.test`;
const OTHER_EMAIL = `rls-passkey-other-${RUN}@ksef-saas.test`;
const TOTP_EMAIL = `rls-passkey-totp-${RUN}@ksef-saas.test`;
const CASCADE_EMAIL = `rls-passkey-cascade-${RUN}@ksef-saas.test`;
const PASS = 'RlsPasskeyPass2026Aa!';
const FUTURE = '2999-01-01T00:00:00.000Z';

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

async function signedIn(email: string): Promise<SupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password: PASS });
  if (error) throw error;
  return client;
}

function passkeyRow(userId: string, credentialId: string) {
  return {
    user_id: userId, credential_id: credentialId, public_key: 'klucz-publiczny', counter: 0,
    transports: ['internal'], device_label: 'Telefon testowy', backed_up: false,
  };
}

describe.skipIf(!hasDatabase)('00159: logowanie biometrią na prawdziwej bazie', () => {
  let ownerId = '';
  let otherId = '';
  let totpUserId = '';
  let owner: SupabaseClient;
  const createdUsers: string[] = [];

  beforeAll(async () => {
    ownerId = await createUser(OWNER_EMAIL);
    otherId = await createUser(OTHER_EMAIL);
    totpUserId = await createUser(TOTP_EMAIL);
    createdUsers.push(ownerId, otherId, totpUserId);
    owner = await signedIn(OWNER_EMAIL);
  });

  afterAll(async () => {
    for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
  });

  describe('user_passkeys', () => {
    it('anon nie czyta i nie pisze', async () => {
      const client = anonClient();
      const read = await client.from('user_passkeys').select('id').limit(1);
      expect(read.error?.code).toBe('42501');
      const write = await client.from('user_passkeys').insert(passkeyRow(ownerId, `anon-${RUN}`));
      expect(write.error?.code).toBe('42501');
    });

    it('zalogowany nie zapisze ani nie zmieni wiersza: zapis tylko service_role', async () => {
      const insert = await owner.from('user_passkeys').insert(passkeyRow(ownerId, `wlasny-${RUN}`));
      expect(insert.error?.code).toBe('42501');

      const seeded = await admin.from('user_passkeys').insert(passkeyRow(ownerId, `zapis-${RUN}`)).select('id').single();
      expect(seeded.error).toBeNull();
      const update = await owner.from('user_passkeys').update({ counter: 99 }).eq('id', seeded.data!.id).select('id');
      expect(update.error?.code).toBe('42501');
      const after = await admin.from('user_passkeys').select('counter').eq('id', seeded.data!.id).single();
      expect(after.data?.counter).toBe(0);
    });

    it('widzi tylko swoje urządzenia i tylko bezpieczne kolumny', async () => {
      const mine = await admin.from('user_passkeys').insert(passkeyRow(ownerId, `moj-${RUN}`)).select('id').single();
      const theirs = await admin.from('user_passkeys').insert(passkeyRow(otherId, `cudzy-${RUN}`)).select('id').single();
      expect(mine.error).toBeNull();
      expect(theirs.error).toBeNull();

      const visible = await owner.from('user_passkeys').select('id, user_id, device_label, backed_up, created_at, last_used_at');
      expect(visible.error).toBeNull();
      expect(visible.data!.map((row) => row.id)).toContain(mine.data!.id);
      expect(visible.data!.every((row) => row.user_id === ownerId)).toBe(true);

      for (const column of ['public_key', 'credential_id', 'counter']) {
        const secret = await owner.from('user_passkeys').select(column).limit(1);
        expect(secret.error?.code, column).toBe('42501');
      }
    });

    it('usuwa swoje, cudzego nie', async () => {
      const mine = await admin.from('user_passkeys').insert(passkeyRow(ownerId, `usun-${RUN}`)).select('id').single();
      const theirs = await admin.from('user_passkeys').insert(passkeyRow(otherId, `nie-usun-${RUN}`)).select('id').single();

      const blocked = await owner.from('user_passkeys').delete().eq('id', theirs.data!.id).select('id');
      expect(blocked.error).toBeNull();
      expect(blocked.data).toEqual([]);
      const stillThere = await admin.from('user_passkeys').select('id').eq('id', theirs.data!.id);
      expect(stillThere.data).toHaveLength(1);

      const removed = await owner.from('user_passkeys').delete().eq('id', mine.data!.id).select('id');
      expect(removed.data).toEqual([{ id: mine.data!.id }]);
    });

    it('credential_id jest unikalny także między kontami', async () => {
      const first = await admin.from('user_passkeys').insert(passkeyRow(ownerId, `wspolny-${RUN}`));
      expect(first.error).toBeNull();
      const second = await admin.from('user_passkeys').insert(passkeyRow(otherId, `wspolny-${RUN}`));
      expect(second.error?.code).toBe('23505');
    });

    it('konto z 2FA: sesja AAL1 nie usunie urządzenia prosto przez PostgREST, sesja AAL2 usunie', async () => {
      const enrolled = await signedIn(TOTP_EMAIL);
      const enroll = await enrolled.auth.mfa.enroll({ factorType: 'totp' });
      if (enroll.error || !enroll.data) throw enroll.error ?? new Error('enroll');
      const verified = await enrolled.auth.mfa.challengeAndVerify({
        factorId: enroll.data.id, code: totpCode(enroll.data.totp.secret),
      });
      expect(verified.error).toBeNull();

      const row = await admin.from('user_passkeys').insert(passkeyRow(totpUserId, `aal-${RUN}`)).select('id').single();
      expect(row.error).toBeNull();

      // Nowe logowanie hasłem daje AAL1, tak samo jak sesja po biometrii.
      const aal1 = await signedIn(TOTP_EMAIL);
      const denied = await aal1.from('user_passkeys').delete().eq('id', row.data!.id).select('id');
      expect(denied.error).toBeNull();
      expect(denied.data).toEqual([]);
      const list = await aal1.from('user_passkeys').select('id').eq('id', row.data!.id);
      expect(list.data).toHaveLength(1);

      const removed = await enrolled.from('user_passkeys').delete().eq('id', row.data!.id).select('id');
      expect(removed.data).toEqual([{ id: row.data!.id }]);
    });
  });

  describe('webauthn_challenges', () => {
    it('anon i zalogowany nie mają dostępu', async () => {
      for (const client of [anonClient(), owner]) {
        const read = await client.from('webauthn_challenges').select('id').limit(1);
        expect(read.error?.code).toBe('42501');
        const write = await client.from('webauthn_challenges').insert({ challenge: `x-${RUN}`, purpose: 'login' });
        expect(write.error?.code).toBe('42501');
        const remove = await client.from('webauthn_challenges').delete().eq('challenge', `x-${RUN}`).select('id');
        expect(remove.error?.code).toBe('42501');
      }
    });

    it('domyślnie wygasa po 5 minutach', async () => {
      const inserted = await admin.from('webauthn_challenges')
        .insert({ challenge: `termin-${RUN}`, purpose: 'login' }).select('created_at, expires_at').single();
      expect(inserted.error).toBeNull();
      const ms = new Date(inserted.data!.expires_at).getTime() - new Date(inserted.data!.created_at).getTime();
      expect(ms).toBe(5 * 60 * 1000);
    });

    it('rejestracja wymaga konta, logowanie go nie ma', async () => {
      const noUser = await admin.from('webauthn_challenges').insert({ challenge: `r-${RUN}`, purpose: 'registration' });
      expect(noUser.error?.code).toBe('23514');
      const loginWithUser = await admin.from('webauthn_challenges').insert({ challenge: `l-${RUN}`, purpose: 'login', user_id: ownerId });
      expect(loginWithUser.error?.code).toBe('23514');
      const badPurpose = await admin.from('webauthn_challenges').insert({ challenge: `p-${RUN}`, purpose: 'cokolwiek' });
      expect(badPurpose.error?.code).toBe('23514');
    });

    it('równoległe zużycie: wiersz dostaje dokładnie jeden DELETE ... RETURNING', async () => {
      const challenge = `wyscig-${RUN}`;
      const inserted = await admin.from('webauthn_challenges').insert({ challenge, purpose: 'login', expires_at: FUTURE });
      expect(inserted.error).toBeNull();
      const results = await Promise.all(Array.from({ length: 8 }, () =>
        admin.from('webauthn_challenges').delete().eq('challenge', challenge).eq('purpose', 'login').select('id')));
      for (const result of results) expect(result.error).toBeNull();
      expect(results.reduce((sum, result) => sum + (result.data?.length ?? 0), 0)).toBe(1);
    });

    it('prawdziwa funkcja zużycia: raz, zły cel i termin nie działają', async () => {
      const { consumeChallengeWith } = await import('@/lib/auth/passkey/challenges');
      const challenge = `funkcja-${RUN}`;
      await admin.from('webauthn_challenges').insert({ challenge, purpose: 'login', expires_at: FUTURE });
      await expect(consumeChallengeWith(admin, { challenge, purpose: 'registration', userId: ownerId })).resolves.toBe(false);
      await expect(consumeChallengeWith(admin, { challenge, purpose: 'login' })).resolves.toBe(true);
      await expect(consumeChallengeWith(admin, { challenge, purpose: 'login' })).resolves.toBe(false);

      const late = `po-terminie-${RUN}`;
      await admin.from('webauthn_challenges').insert({ challenge: late, purpose: 'login', expires_at: '2020-01-01T00:00:00.000Z' });
      await expect(consumeChallengeWith(admin, { challenge: late, purpose: 'login' })).resolves.toBe(false);

      const foreign = `cudze-${RUN}`;
      await admin.from('webauthn_challenges').insert({ challenge: foreign, purpose: 'registration', user_id: ownerId, expires_at: FUTURE });
      await expect(consumeChallengeWith(admin, { challenge: foreign, purpose: 'registration', userId: otherId })).resolves.toBe(false);
      await expect(consumeChallengeWith(admin, { challenge: foreign, purpose: 'registration', userId: ownerId })).resolves.toBe(true);
    });

    it('sprzątanie przy tworzeniu nowego usuwa tylko wygasłe', async () => {
      const { storeChallengeWith } = await import('@/lib/auth/passkey/challenges');
      const dead = `martwe-${RUN}`;
      const alive = `zywe-${RUN}`;
      await admin.from('webauthn_challenges').insert([
        { challenge: dead, purpose: 'login', expires_at: '2020-01-01T00:00:00.000Z' },
        { challenge: alive, purpose: 'login', expires_at: FUTURE },
      ]);
      await storeChallengeWith(admin, { challenge: `nowe-${RUN}`, purpose: 'login' });
      const left = await admin.from('webauthn_challenges').select('challenge').in('challenge', [dead, alive, `nowe-${RUN}`]);
      expect(left.data!.map((row) => row.challenge).sort()).toEqual([`nowe-${RUN}`, alive].sort());
    });
  });

  it('usunięcie konta kasuje jego urządzenia i wyzwania', async () => {
    const id = await createUser(CASCADE_EMAIL);
    const passkey = await admin.from('user_passkeys').insert(passkeyRow(id, `kaskada-${RUN}`)).select('id').single();
    const challenge = await admin.from('webauthn_challenges')
      .insert({ challenge: `kaskada-${RUN}`, purpose: 'registration', user_id: id, expires_at: FUTURE }).select('id').single();
    expect(passkey.error).toBeNull();
    expect(challenge.error).toBeNull();

    const removed = await admin.auth.admin.deleteUser(id);
    expect(removed.error).toBeNull();

    expect((await admin.from('user_passkeys').select('id').eq('id', passkey.data!.id)).data).toEqual([]);
    expect((await admin.from('webauthn_challenges').select('id').eq('id', challenge.data!.id)).data).toEqual([]);
  });
});
