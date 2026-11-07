import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { czytajWpisyReczne } from '@/lib/ksiegowosc/wpisy-reczne';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00167 na prawdziwej bazie: wpisy ręczne ewidencji przychodów (plan
 * księgowości JDG, K3, D5).
 *
 * Właściciel dodaje i usuwa wpisy kluczem użytkownika, członek firmy tylko
 * czyta, inna firma nie widzi nic, a UPDATE nie ma nikt poza service_role.
 * Datę wpisu i autora ustawia baza: INSERT dla authenticated obejmuje tylko
 * kolumny treści. CHECK-i pilnują kwoty, stawki K_9, daty, dowodu i opisu.
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

const ORG = '00167167-0000-4000-8000-000000000001';
const OTHER_ORG = '00167167-0000-4000-8000-000000000002';
const OWNER_EMAIL = 'rls-wpisy-owner@ksef-saas.test';
const MEMBER_EMAIL = 'rls-wpisy-member@ksef-saas.test';
const OTHER_EMAIL = 'rls-wpisy-other@ksef-saas.test';
const PASS = 'RlsWpisyPass2026Aa!';

const WPIS = {
  tenant_id: ORG,
  rodzaj: 'raport_kasy',
  data_przychodu: '2026-03-31',
  dokument: 'RK/03/2026',
  kwota_gr: 250000,
  stawka_pb: 300,
  opis: null,
};

let ownerId = '';

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
    await admin.from('ledger_manual_entries').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
    await admin.from('tenants').delete().eq('id', org);
  }
}

describe.skipIf(!hasDatabase)('00167: wpisy ręczne ewidencji na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    ownerId = await userId(OWNER_EMAIL);
    const memberId = await userId(MEMBER_EMAIL);
    const otherId = await userId(OTHER_EMAIL);
    await sprzataj();
    const { error: tErr } = await admin.from('tenants').insert([
      { id: ORG, nip: '9480000038', name: 'Firma Wpisy 00167' },
      { id: OTHER_ORG, nip: '9480000045', name: 'Inna firma 00167' },
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

  it('właściciel dodaje wpis; datę wpisu i autora ustawia baza', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const { data, error } = await owner.from('ledger_manual_entries').insert(WPIS).select('data_wpisu, created_by').single();
    expect(error).toBeNull();
    const dzis = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(new Date());
    expect(data).toEqual({ data_wpisu: dzis, created_by: ownerId });
    const wpisy = await czytajWpisyReczne(owner, ORG, '2026-01-01', '2026-12-31');
    expect(wpisy.map((w) => [w.dokument, w.kwotaGr, w.stawkaPb])).toEqual([['RK/03/2026', 250000, 300]]);
  });

  it('daty wpisu ani autora nie da się podstawić kluczem użytkownika', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const zData = await owner.from('ledger_manual_entries').insert({ ...WPIS, dokument: 'RK/X', data_wpisu: '2026-01-01' });
    expect(zData.error?.code).toBe('42501');
    const zAutorem = await owner.from('ledger_manual_entries').insert({ ...WPIS, dokument: 'RK/Y', created_by: '00000000-0000-4000-8000-000000000000' });
    expect(zAutorem.error?.code).toBe('42501');
  });

  it('członek firmy czyta, ale nie dodaje i nie usuwa', async () => {
    const member = await signedIn(MEMBER_EMAIL, ORG);
    expect((await czytajWpisyReczne(member, ORG, '2026-01-01', '2026-12-31')).length).toBe(1);
    const dodanie = await member.from('ledger_manual_entries').insert({ ...WPIS, dokument: 'RK/M' });
    expect(dodanie.error?.code).toBe('42501');
    const { data, error } = await member.from('ledger_manual_entries').delete().eq('tenant_id', ORG).select('id');
    expect(error?.code === '42501' || (data ?? []).length === 0).toBe(true);
    expect((await czytajWpisyReczne(member, ORG, '2026-01-01', '2026-12-31')).length).toBe(1);
  });

  it('inna firma nie widzi wpisów i nie wpisze ich cudzej firmie', async () => {
    const other = await signedIn(OTHER_EMAIL, OTHER_ORG);
    expect(await czytajWpisyReczne(other, ORG, '2026-01-01', '2026-12-31')).toEqual([]);
    const { error } = await other.from('ledger_manual_entries').insert({ ...WPIS, dokument: 'RK/O' });
    expect(error?.code).toBe('42501');
  });

  // Nazwa ograniczenia w komunikacie, żeby każdy przypadek dowodził swojego CHECK-a.
  it('CHECK: kwota zero, stawka spoza K_9, data sprzed 2026, pusty dowód i za długi opis odrzucone', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const przypadki: [Record<string, unknown>, string][] = [
      [{ kwota_gr: 0 }, 'ledger_manual_entries_kwota_check'],
      [{ stawka_pb: 2300 }, 'ledger_manual_entries_stawka_check'],
      [{ data_przychodu: '2025-12-31' }, 'ledger_manual_entries_data_check'],
      [{ dokument: '   ' }, 'ledger_manual_entries_dokument_check'],
      [{ opis: 'x'.repeat(257) }, 'ledger_manual_entries_opis_check'],
      [{ rodzaj: 'faktura' }, 'ledger_manual_entries_rodzaj_check'],
    ];
    for (const [zmiana, ograniczenie] of przypadki) {
      const { error } = await owner.from('ledger_manual_entries').insert({ ...WPIS, ...zmiana });
      expect(error?.code, ograniczenie).toBe('23514');
      expect(error?.message).toContain(ograniczenie);
    }
    const zwrot = await owner.from('ledger_manual_entries').insert({ ...WPIS, dokument: 'RK/ZWROT', kwota_gr: -1250 });
    expect(zwrot.error).toBeNull();
  });

  it('wpisu nie da się zmienić; właściciel go usuwa', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const zmiana = await owner.from('ledger_manual_entries').update({ kwota_gr: 1 }).eq('tenant_id', ORG).select('id');
    expect(zmiana.error?.code === '42501' || (zmiana.data ?? []).length === 0).toBe(true);
    const przed = await czytajWpisyReczne(owner, ORG, '2026-01-01', '2026-12-31');
    expect(przed.map((w) => w.kwotaGr).sort()).toEqual([-1250, 250000]);
    const { data, error } = await owner.from('ledger_manual_entries').delete().eq('dokument', 'RK/ZWROT').select('id');
    expect(error).toBeNull();
    expect((data ?? []).length).toBe(1);
    expect((await czytajWpisyReczne(owner, ORG, '2026-01-01', '2026-12-31')).length).toBe(1);
  });
});
