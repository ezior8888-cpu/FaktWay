import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00182 na prawdziwej bazie: adres kalendarza (krok 7.3 planu kompletnej
 * aplikacji) w `calendar_feed_tokens`. Jeden wiersz na firmę (wymiana
 * nadpisuje skrót), zapis i usunięcie owner/admin, członek niczego nie widzi,
 * skrót tokenu nie wychodzi do klienta (grant kolumnowy), a odczyt publiczny
 * idzie tylko przez `calendar_feed_tenant`, dostępną wyłącznie dla service_role.
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

const ORG = '00182182-0000-4000-8000-000000000001';
const OTHER_ORG = '00182182-0000-4000-8000-000000000002';
const OWNER_EMAIL = 'rls-kalendarz-owner@ksef-saas.test';
const MEMBER_EMAIL = 'rls-kalendarz-member@ksef-saas.test';
const OTHER_EMAIL = 'rls-kalendarz-other@ksef-saas.test';
const PASS = 'RlsKalendarzPass2026Aa!';

// Skróty testowe o zerowej entropii (64 znaki hex).
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

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
    await admin.from('calendar_feed_tokens').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
    await admin.from('tenants').delete().eq('id', org);
  }
}

describe.skipIf(!hasDatabase)('00182: adres kalendarza na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    const ownerId = await userId(OWNER_EMAIL);
    const memberId = await userId(MEMBER_EMAIL);
    const otherId = await userId(OTHER_EMAIL);
    await sprzataj();
    const { error: tErr } = await admin.from('tenants').insert([
      { id: ORG, nip: '9480000134', name: 'Firma Kalendarz 00182' },
      { id: OTHER_ORG, nip: '9480000141', name: 'Inna firma 00182' },
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

  it('właściciel zapisuje adres; skrót musi być 64 znakami hex, a drugi wiersz tej firmy nie powstanie', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    expect((await owner.from('calendar_feed_tokens').insert({ tenant_id: ORG, token_hash: 'za-krotki' })).error?.message).toMatch(
      /calendar_feed_tokens_hash_check/,
    );
    expect((await owner.from('calendar_feed_tokens').insert({ tenant_id: ORG, token_hash: HASH_A })).error).toBeNull();
    expect((await owner.from('calendar_feed_tokens').insert({ tenant_id: ORG, token_hash: HASH_B })).error?.message).toMatch(
      /calendar_feed_tokens_pkey|duplicate/,
    );
  });

  it('skrót tokenu nie wychodzi do klienta: odczyt kolumn jawnych działa, odczyt skrótu to brak uprawnień', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const jawne = await owner.from('calendar_feed_tokens').select('tenant_id, created_at').eq('tenant_id', ORG);
    expect(jawne.error).toBeNull();
    expect(jawne.data).toHaveLength(1);
    expect((await owner.from('calendar_feed_tokens').select('token_hash').eq('tenant_id', ORG)).error?.message).toMatch(/permission denied/);
  });

  it('funkcja zwraca firmę dla skrótu, NULL dla nieznanego; wymiana unieważnia stary skrót', async () => {
    expect((await admin.rpc('calendar_feed_tenant', { p_token_hash: HASH_A })).data).toBe(ORG);
    expect((await admin.rpc('calendar_feed_tenant', { p_token_hash: HASH_B })).data).toBeNull();

    const owner = await signedIn(OWNER_EMAIL, ORG);
    const wymiana = await owner.from('calendar_feed_tokens').update({ token_hash: HASH_B }).eq('tenant_id', ORG).select('tenant_id');
    expect(wymiana.error).toBeNull();
    expect(wymiana.data).toHaveLength(1);
    expect((await admin.rpc('calendar_feed_tenant', { p_token_hash: HASH_A })).data).toBeNull();
    expect((await admin.rpc('calendar_feed_tenant', { p_token_hash: HASH_B })).data).toBe(ORG);
  });

  it('funkcja jest niedostępna dla anon i zalogowanych (nie da się zgadywać skrótów przez API)', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    expect((await owner.rpc('calendar_feed_tenant', { p_token_hash: HASH_B })).error?.message).toMatch(/permission denied/);
    const anon = anonClient(ORG);
    expect((await anon.rpc('calendar_feed_tenant', { p_token_hash: HASH_B })).error?.message).toMatch(/permission denied/);
  });

  it('członek firmy ani nie widzi, ani nie zapisuje, ani nie usuwa; inna firma też nie', async () => {
    const member = await signedIn(MEMBER_EMAIL, ORG);
    expect((await member.from('calendar_feed_tokens').select('tenant_id').eq('tenant_id', ORG)).data ?? []).toEqual([]);
    expect((await member.from('calendar_feed_tokens').update({ token_hash: HASH_A }).eq('tenant_id', ORG).select('tenant_id')).data ?? []).toEqual([]);
    expect((await member.from('calendar_feed_tokens').delete().eq('tenant_id', ORG).select('tenant_id')).data ?? []).toEqual([]);
    expect((await member.from('calendar_feed_tokens').insert({ tenant_id: OTHER_ORG, token_hash: HASH_A })).error?.message).toMatch(/row-level security/);

    const other = await signedIn(OTHER_EMAIL, OTHER_ORG);
    expect((await other.from('calendar_feed_tokens').select('tenant_id').eq('tenant_id', ORG)).data ?? []).toEqual([]);
    expect((await other.from('calendar_feed_tokens').insert({ tenant_id: ORG, token_hash: HASH_A })).error?.message).toMatch(/row-level security/);
    expect((await other.from('calendar_feed_tokens').delete().eq('tenant_id', ORG).select('tenant_id')).data ?? []).toEqual([]);
  });

  it('właściciel usuwa adres, po czym funkcja zwraca NULL (adres przestaje działać)', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const { data, error } = await owner.from('calendar_feed_tokens').delete().eq('tenant_id', ORG).select('tenant_id');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect((await admin.rpc('calendar_feed_tenant', { p_token_hash: HASH_B })).data).toBeNull();
  });
});
