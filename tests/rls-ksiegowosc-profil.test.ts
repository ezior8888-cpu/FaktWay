import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { czytajWersjeProfilu } from '@/lib/ksiegowosc/profil';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00166 na prawdziwej bazie: profil podatkowy z historią (plan księgowości
 * JDG, K2, D3).
 *
 * Właściciel i administrator zapisują wersje kluczem użytkownika, członek
 * firmy tylko czyta, inna firma nie widzi nic, a nikt poza service_role nie
 * usuwa. Wyzwalacz pilnuje, że forma zmienia się tylko od 1 stycznia, CHECK-i
 * pilnują stawki ryczałtu i daty etapu ZUS.
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

const ORG = '00166166-0000-4000-8000-000000000001';
const OTHER_ORG = '00166166-0000-4000-8000-000000000002';
const OWNER_EMAIL = 'rls-profil-owner@ksef-saas.test';
const MEMBER_EMAIL = 'rls-profil-member@ksef-saas.test';
const OTHER_EMAIL = 'rls-profil-other@ksef-saas.test';
const PASS = 'RlsProfilPass2026Aa!';

const RYCZALT = {
  forma: 'ryczalt',
  stawka_domyslna: 1200,
  zus_etap: 'pelny',
  zus_od: null,
  chorobowe: false,
  nrs_zus: null,
};

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

async function sprzataj() {
  for (const org of [ORG, OTHER_ORG]) {
    await admin.from('tax_profiles').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
    await admin.from('tenants').delete().eq('id', org);
  }
}

describe.skipIf(!hasDatabase)('00166: profil podatkowy na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    const ownerId = await userId(OWNER_EMAIL);
    const memberId = await userId(MEMBER_EMAIL);
    const otherId = await userId(OTHER_EMAIL);
    await sprzataj();
    const { error: tErr } = await admin.from('tenants').insert([
      { id: ORG, nip: '9480000014', name: 'Firma Profil 00166' },
      { id: OTHER_ORG, nip: '9480000021', name: 'Inna firma 00166' },
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
    await sprzataj();
  });

  it('właściciel zapisuje pierwszą wersję od dowolnego dnia i ją czyta', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const { error } = await owner.from('tax_profiles').insert({ tenant_id: ORG, valid_from: '2026-03-15', ...RYCZALT });
    expect(error).toBeNull();
    const wersje = await czytajWersjeProfilu(owner, ORG);
    expect(wersje.map((w) => [w.validFrom, w.forma, w.stawkaDomyslna])).toEqual([['2026-03-15', 'ryczalt', 1200]]);
  });

  it('członek firmy czyta, ale nie zapisuje', async () => {
    const member = await signedIn(MEMBER_EMAIL, ORG);
    expect((await czytajWersjeProfilu(member, ORG)).length).toBe(1);
    const { error } = await member.from('tax_profiles').insert({ tenant_id: ORG, valid_from: '2026-06-01', ...RYCZALT });
    expect(error?.code).toBe('42501');
  });

  it('inna firma nie widzi wersji i nie wpisze ich cudzej firmie', async () => {
    const other = await signedIn(OTHER_EMAIL, OTHER_ORG);
    expect(await czytajWersjeProfilu(other, ORG)).toEqual([]);
    const { error } = await other.from('tax_profiles').insert({ tenant_id: ORG, valid_from: '2026-07-01', ...RYCZALT });
    expect(error?.code).toBe('42501');
  });

  it('wyzwalacz: zmiana formy w trakcie roku odrzucona, od 1 stycznia przyjęta', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const skala = { ...RYCZALT, forma: 'skala', stawka_domyslna: null };
    const wTrakcie = await owner.from('tax_profiles').insert({ tenant_id: ORG, valid_from: '2026-09-01', ...skala });
    expect(wTrakcie.error?.code).toBe('23514');
    expect(wTrakcie.error?.hint).toBe('tax_profile_form_change');
    const odStycznia = await owner.from('tax_profiles').insert({ tenant_id: ORG, valid_from: '2027-01-01', ...skala });
    expect(odStycznia.error).toBeNull();
  });

  it('ta sama forma od dowolnego miesiąca; poprawka wersji to upsert po dniu', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const lipiec = await owner.from('tax_profiles').insert({ tenant_id: ORG, valid_from: '2026-07-01', ...RYCZALT, zus_etap: 'etat_obok' });
    expect(lipiec.error).toBeNull();
    const poprawka = await owner
      .from('tax_profiles')
      .upsert({ tenant_id: ORG, valid_from: '2026-07-01', ...RYCZALT, stawka_domyslna: 850 }, { onConflict: 'tenant_id,valid_from' })
      .select('stawka_domyslna')
      .single();
    expect(poprawka.error).toBeNull();
    expect(poprawka.data).toEqual({ stawka_domyslna: 850 });
  });

  // Nazwa ograniczenia w komunikacie, bo wyzwalacz formy też zwraca 23514.
  // Pusta stawka przy ryczałcie była czerwona przed poprawką: CHECK przepuszcza NULL.
  it('CHECK: ryczałt bez stawki, skala ze stawką i ulga na start bez daty odrzucone', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const bezStawki = await owner.from('tax_profiles').insert({ tenant_id: ORG, valid_from: '2028-01-01', ...RYCZALT, stawka_domyslna: null });
    expect(bezStawki.error?.code).toBe('23514');
    expect(bezStawki.error?.message).toContain('tax_profiles_stawka_check');
    const skalaZeStawka = await owner.from('tax_profiles').insert({ tenant_id: ORG, valid_from: '2028-01-01', ...RYCZALT, forma: 'skala' });
    expect(skalaZeStawka.error?.message).toContain('tax_profiles_stawka_check');
    const ulgaBezDaty = await owner.from('tax_profiles').insert({ tenant_id: ORG, valid_from: '2026-08-01', ...RYCZALT, zus_etap: 'ulga_na_start' });
    expect(ulgaBezDaty.error?.message).toContain('tax_profiles_zus_od_check');
  });

  it('nikt poza kluczem serwisowym nie usuwa wersji', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const przed = (await czytajWersjeProfilu(owner, ORG)).length;
    const { data, error } = await owner.from('tax_profiles').delete().eq('tenant_id', ORG).select('id');
    expect(error?.code === '42501' || (data ?? []).length === 0).toBe(true);
    expect((await czytajWersjeProfilu(owner, ORG)).length).toBe(przed);
  });
});
