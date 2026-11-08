import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { czytajSpisy } from '@/lib/ksiegowosc/spis-z-natury';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00173 na prawdziwej bazie: spis z natury (plan księgowości JDG, K7.4, D19)
 * w `ledger_inventory_counts`. Jeden spis na dzień (UNIQUE), data od
 * 31.12.2025, wartość nie ujemna; zapis i usunięcie owner/admin jak w 00167,
 * członek firmy tylko czyta, inna firma nie widzi nic, bez UPDATE.
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

const ORG = '00173173-0000-4000-8000-000000000001';
const OTHER_ORG = '00173173-0000-4000-8000-000000000002';
const OWNER_EMAIL = 'rls-spis-owner@ksef-saas.test';
const MEMBER_EMAIL = 'rls-spis-member@ksef-saas.test';
const OTHER_EMAIL = 'rls-spis-other@ksef-saas.test';
const PASS = 'RlsSpisPass2026Aa!';

const SPIS = { tenant_id: ORG, data: '2025-12-31', kwota_gr: 500_000, opis: 'Towar' };

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
    await admin.from('ledger_inventory_counts').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
    await admin.from('tenants').delete().eq('id', org);
  }
}

describe.skipIf(!hasDatabase)('00173: spis z natury na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    const ownerId = await userId(OWNER_EMAIL);
    const memberId = await userId(MEMBER_EMAIL);
    const otherId = await userId(OTHER_EMAIL);
    await sprzataj();
    const { error: tErr } = await admin.from('tenants').insert([
      { id: ORG, nip: '9480000113', name: 'Firma Spis 00173' },
      { id: OTHER_ORG, nip: '9480000120', name: 'Inna firma 00173' },
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

  it('właściciel zapisuje spis; drugi z tego dnia to UNIQUE, data sprzed 31.12.2025 i wartość ujemna to CHECK; autora i daty wpisu nie podstawi', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    expect((await owner.from('ledger_inventory_counts').insert(SPIS)).error).toBeNull();
    expect((await owner.from('ledger_inventory_counts').insert({ ...SPIS, kwota_gr: 1 })).error?.message).toMatch(/ledger_inventory_counts_dzien_unikalny/);
    expect((await owner.from('ledger_inventory_counts').insert({ ...SPIS, data: '2025-12-30' })).error?.message).toMatch(/ledger_inventory_counts_data_check/);
    expect((await owner.from('ledger_inventory_counts').insert({ ...SPIS, data: '2026-12-31', kwota_gr: -1 })).error?.message).toMatch(/ledger_inventory_counts_kwota_check/);
    expect((await owner.from('ledger_inventory_counts').insert({ ...SPIS, data: '2026-06-30', created_by: '00000000-0000-4000-8000-000000000000' })).error?.message).toMatch(/permission denied/);
    expect((await owner.from('ledger_inventory_counts').insert({ ...SPIS, data: '2026-12-31', kwota_gr: 600_000, opis: null })).error).toBeNull();
  });

  it('odczyt roku: od 31 grudnia poprzedniego roku do 31 grudnia, rosnąco; bez UPDATE', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    expect((await czytajSpisy(owner, ORG, 2026)).map((s) => [s.data, s.kwotaGr])).toEqual([
      ['2025-12-31', 500_000],
      ['2026-12-31', 600_000],
    ]);
    expect((await czytajSpisy(owner, ORG, 2027)).map((s) => s.data)).toEqual(['2026-12-31']);
    const zmiana = await owner.from('ledger_inventory_counts').update({ kwota_gr: 1 }).eq('tenant_id', ORG).select('id');
    expect(zmiana.error?.message).toMatch(/permission denied/);
  });

  it('członek firmy czyta, ale nie dodaje ani nie usuwa; inna firma nie widzi spisów', async () => {
    const member = await signedIn(MEMBER_EMAIL, ORG);
    expect((await czytajSpisy(member, ORG, 2026)).length).toBe(2);
    expect((await member.from('ledger_inventory_counts').insert({ ...SPIS, data: '2026-03-31' })).error?.message).toMatch(/row-level security/);
    const usun = await member.from('ledger_inventory_counts').delete().eq('tenant_id', ORG).select('id');
    expect(usun.data ?? []).toEqual([]);
    const other = await signedIn(OTHER_EMAIL, OTHER_ORG);
    expect(await czytajSpisy(other, ORG, 2026)).toEqual([]);
  });

  it('właściciel usuwa spis i dostaje usunięty wiersz (audyt)', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const { data, error } = await owner.from('ledger_inventory_counts').delete().eq('tenant_id', ORG).eq('data', '2026-12-31').select('id, data, kwota_gr, opis');
    expect(error).toBeNull();
    expect(data).toEqual([expect.objectContaining({ data: '2026-12-31', kwota_gr: 600_000 })]);
  });
});
