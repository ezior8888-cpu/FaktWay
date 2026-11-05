import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { czytajFlageFirmy } from '@/lib/ksiegowosc/wylacznik';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00165 na prawdziwej bazie: wyłącznik modułu księgowości (plan księgowości
 * JDG, K1, D10).
 *
 * `tenant_feature_flags.ksiegowosc_enabled` domyślnie false; firma czyta
 * swój wiersz kluczem użytkownika (polityka z 00031), nie czyta cudzego
 * i nie może sama włączyć modułu. `killKsiegowosc` czeka w
 * `global_feature_flags` wyłączony, gotowy do przestawienia jednym UPDATE-em.
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

const ORG = '00165165-0000-4000-8000-000000000001';
const OTHER_ORG = '00165165-0000-4000-8000-000000000002';
const OWNER_EMAIL = 'rls-ksiegowosc-owner@ksef-saas.test';
const OTHER_EMAIL = 'rls-ksiegowosc-other@ksef-saas.test';
const PASS = 'RlsKsiegowoscPass2026Aa!';

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

describe.skipIf(!hasDatabase)('00165: wyłącznik modułu księgowości na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    const ownerId = await userId(OWNER_EMAIL);
    const otherId = await userId(OTHER_EMAIL);
    for (const org of [ORG, OTHER_ORG]) {
      await admin.from('tenant_feature_flags').delete().eq('tenant_id', org);
      await admin.from('memberships').delete().eq('organization_id', org);
      await admin.from('tenants').delete().eq('id', org);
    }
    const { error: tErr } = await admin.from('tenants').insert([
      { id: ORG, nip: '9480000014', name: 'Firma Księgowość 00165' },
      { id: OTHER_ORG, nip: '9480000021', name: 'Inna firma 00165' },
    ]);
    if (tErr) throw tErr;
    await admin.from('users').upsert(
      [{ id: ownerId, name: 'Owner' }, { id: otherId, name: 'Other' }],
      { onConflict: 'id' },
    );
    const { error: mErr } = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ownerId, role: 'owner', status: 'active' },
      { organization_id: OTHER_ORG, user_id: otherId, role: 'owner', status: 'active' },
    ]);
    if (mErr) throw mErr;
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    for (const org of [ORG, OTHER_ORG]) {
      await admin.from('tenant_feature_flags').delete().eq('tenant_id', org);
      await admin.from('memberships').delete().eq('organization_id', org);
      await admin.from('tenants').delete().eq('id', org);
    }
  });

  it('nowy wiersz flag ma ksiegowosc_enabled = false (opt-in)', async () => {
    const { error } = await admin.from('tenant_feature_flags').upsert({ tenant_id: ORG }, { onConflict: 'tenant_id' });
    expect(error).toBeNull();
    const owner = await signedIn(OWNER_EMAIL, ORG);
    expect(await czytajFlageFirmy(owner, ORG)).toBe(false);
  });

  it('po włączeniu kluczem serwisowym firma czyta true kluczem użytkownika', async () => {
    const { error } = await admin
      .from('tenant_feature_flags')
      .upsert({ tenant_id: ORG, ksiegowosc_enabled: true }, { onConflict: 'tenant_id' });
    expect(error).toBeNull();
    const owner = await signedIn(OWNER_EMAIL, ORG);
    expect(await czytajFlageFirmy(owner, ORG)).toBe(true);
  });

  it('członek innej firmy nie widzi cudzego wiersza', async () => {
    const other = await signedIn(OTHER_EMAIL, OTHER_ORG);
    expect(await czytajFlageFirmy(other, ORG)).toBe(false);
  });

  it('firma nie włączy ani nie wyłączy modułu sama', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    // Brak uprawnienia (42501) albo brak polityki UPDATE (zero wierszy): oba
    // znaczą „bez zmiany”; liczy się to, że wartość zostaje.
    const { data, error } = await owner
      .from('tenant_feature_flags')
      .update({ ksiegowosc_enabled: false })
      .eq('tenant_id', ORG)
      .select('tenant_id');
    expect(error?.code === '42501' || (data ?? []).length === 0).toBe(true);
    expect(await czytajFlageFirmy(owner, ORG)).toBe(true);
  });

  it('killKsiegowosc istnieje i jest wyłączony', async () => {
    const { data, error } = await admin
      .from('global_feature_flags')
      .select('enabled')
      .eq('flag', 'killKsiegowosc')
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toEqual({ enabled: false });
  });
});
