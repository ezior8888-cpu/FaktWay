import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00203 na prawdziwej bazie: `tenants.logo_storage_key`, logo firmy na
 * wydruku (plan kompletnej aplikacji, krok 2.2, część 1).
 *
 * Wydruk czyta plik logo kluczem serwisowym magazynu, więc klucz w wierszu
 * firmy decyduje, czyj plik trafi na PDF. Dlatego:
 *  - CHECK wiąże klucz z firmą wiersza (`tenants/<id>/logo/<uuid>.png|jpg`)
 *    także dla klucza serwisowego: inna firma, inny katalog, `..` odpadają;
 *  - wyzwalacz `guard_tenant_logo_storage_key` (wzór 00117) nie pozwala
 *    zmienić kolumny sesji klienta (`authenticated`), choć polityka
 *    `tenants_update_own_owner` daje właścicielowi UPDATE całego wiersza:
 *    zapis idzie tylko przez serwer po sprawdzeniu pliku, z audytem
 *    i sprzątaniem magazynu;
 *  - od 00112 kolumny `tenants` czyta się tylko po jawnym GRANT SELECT,
 *    więc członek firmy czyta klucz (podgląd w ustawieniach), a obca firma
 *    nie widzi wiersza (RLS bez zmian).
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey)
  : (null as unknown as SupabaseClient);

const ORG = '00203203-0000-4000-8000-000000000001';
const OTHER_ORG = '00203203-0000-4000-8000-000000000002';
const OWNER_EMAIL = 'rls-logo-owner@ksef-saas.test';
const MEMBER_EMAIL = 'rls-logo-member@ksef-saas.test';
const OTHER_EMAIL = 'rls-logo-other@ksef-saas.test';
const PASS = 'RlsLogoPass2026Aa!';

const KEY = `tenants/${ORG}/logo/5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f.png`;
const KEY_JPG = `tenants/${ORG}/logo/6d7e8f9a-0b1c-4d2e-8f3a-4b5c6d7e8f9a.jpg`;

function anonClient(activeOrg: string) {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-active-org': activeOrg } },
  });
}

async function userId(email: string): Promise<string> {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 1000) break;
  }
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true });
  if (error || !data.user) throw error ?? new Error('createUser');
  return data.user.id;
}

async function signedIn(email: string, org: string): Promise<SupabaseClient> {
  const client = anonClient(org);
  const { error } = await client.auth.signInWithPassword({ email, password: PASS });
  if (error) throw error;
  return client;
}

async function storedKey(): Promise<string | null> {
  const { data, error } = await admin.from('tenants').select('logo_storage_key').eq('id', ORG).single();
  if (error) throw error;
  return (data as { logo_storage_key: string | null }).logo_storage_key;
}

async function setKey(key: string | null) {
  return admin.from('tenants').update({ logo_storage_key: key }).eq('id', ORG);
}

describe.skipIf(!hasDatabase)('00203: logo firmy w tenants na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    const ownerId = await userId(OWNER_EMAIL);
    const memberId = await userId(MEMBER_EMAIL);
    const otherId = await userId(OTHER_EMAIL);
    for (const org of [ORG, OTHER_ORG]) {
      await admin.from('memberships').delete().eq('organization_id', org);
      await admin.from('tenants').delete().eq('id', org);
    }
    const { error: tErr } = await admin.from('tenants').insert([
      { id: ORG, nip: '9480000038', name: 'Firma Logo 00203' },
      { id: OTHER_ORG, nip: '9480000045', name: 'Inna firma 00203' },
    ]);
    if (tErr) throw tErr;
    await admin.from('users').upsert(
      [{ id: ownerId, name: 'Owner' }, { id: memberId, name: 'Member' }, { id: otherId, name: 'Other' }],
      { onConflict: 'id' },
    );
    const { error: mErr } = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ownerId, role: 'owner', status: 'active' },
      { organization_id: ORG, user_id: memberId, role: 'member', status: 'active' },
      { organization_id: OTHER_ORG, user_id: otherId, role: 'owner', status: 'active' },
    ]);
    if (mErr) throw mErr;
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    for (const org of [ORG, OTHER_ORG]) {
      await admin.from('memberships').delete().eq('organization_id', org);
      await admin.from('tenants').delete().eq('id', org);
    }
  });

  it('klucz serwisowy zapisuje i czyści klucz w katalogu logo tej firmy (PNG i JPEG)', async () => {
    expect((await setKey(KEY)).error).toBeNull();
    expect(await storedKey()).toBe(KEY);
    expect((await setKey(KEY_JPG)).error).toBeNull();
    expect((await setKey(null)).error).toBeNull();
    expect(await storedKey()).toBeNull();
  });

  it.each([
    ['katalog logo innej firmy', `tenants/${OTHER_ORG}/logo/5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f.png`],
    ['inny katalog tej firmy (zdjęcie kosztu)', `tenants/${ORG}/expenses/2026/11/5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f.png`],
    ['ścieżka z ..', `tenants/${ORG}/logo/../../${OTHER_ORG}/logo/5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f.png`],
    ['bez przedrostka tenants/', `${ORG}/logo/5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f.png`],
    ['rozszerzenie spoza PNG i JPEG (SVG)', `tenants/${ORG}/logo/5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f.svg`],
    ['nazwa, która nie jest identyfikatorem', `tenants/${ORG}/logo/logo.png`],
    ['wielkie litery w identyfikatorze', `tenants/${ORG}/logo/5C6D7E8F-9A0B-4C1D-8E2F-3A4B5C6D7E8F.png`],
  ])('CHECK odrzuca także kluczem serwisowym: %s', async (_opis, key) => {
    const result = await setKey(key);
    expect(result.error?.code).toBe('23514');
    expect(await storedKey()).toBeNull();
  });

  it('członek firmy czyta klucz kluczem użytkownika (GRANT SELECT z 00203)', async () => {
    expect((await setKey(KEY)).error).toBeNull();
    const member = await signedIn(MEMBER_EMAIL, ORG);
    const { data, error } = await member.from('tenants').select('logo_storage_key').eq('id', ORG).maybeSingle();
    expect(error).toBeNull();
    expect(data).toEqual({ logo_storage_key: KEY });
  });

  it('obca firma nie widzi wiersza (RLS wiersza bez zmian)', async () => {
    const other = await signedIn(OTHER_EMAIL, OTHER_ORG);
    const { data, error } = await other.from('tenants').select('logo_storage_key').eq('id', ORG).maybeSingle();
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it('właściciel nie zmieni ani nie wyczyści klucza sesją klienta (wyzwalacz, 42501), choć może zmienić nazwę', async () => {
    expect((await setKey(KEY)).error).toBeNull();
    const owner = await signedIn(OWNER_EMAIL, ORG);

    const change = await owner.from('tenants').update({ logo_storage_key: KEY_JPG }).eq('id', ORG).select('id');
    expect(change.error?.code).toBe('42501');
    const clear = await owner.from('tenants').update({ logo_storage_key: null }).eq('id', ORG).select('id');
    expect(clear.error?.code).toBe('42501');
    expect(await storedKey()).toBe(KEY);

    const rename = await owner.from('tenants').update({ name: 'Firma Logo 00203 (nowa nazwa)' }).eq('id', ORG).select('id');
    expect(rename.error).toBeNull();
    expect(rename.data).toHaveLength(1);
    expect(await storedKey()).toBe(KEY);
  });

  it('zapis tej samej wartości sesją klienta przechodzi (wyzwalacz patrzy na zmianę, nie na listę kolumn)', async () => {
    expect((await setKey(KEY)).error).toBeNull();
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const same = await owner.from('tenants').update({ logo_storage_key: KEY }).eq('id', ORG).select('id');
    expect(same.error).toBeNull();
  });
});
