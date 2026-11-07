import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { czytajWpisyKpir, czytajWpisyReczne } from '@/lib/ksiegowosc/wpisy-reczne';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00171 na prawdziwej bazie: wpisy ręczne KPiR (plan księgowości JDG, K7)
 * w `ledger_manual_entries`. Wpis ma stawkę ryczałtu albo kolumnę KPiR,
 * nigdy oba i nigdy żadne (CHECK); ewidencja czyta tylko wpisy ze stawką,
 * KPiR tylko wpisy z kolumną. Zapis owner/admin jak w 00167, członek firmy
 * tylko czyta, inna firma nie widzi nic.
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

const ORG = '00171171-0000-4000-8000-000000000001';
const OTHER_ORG = '00171171-0000-4000-8000-000000000002';
const OWNER_EMAIL = 'rls-kpir-owner@ksef-saas.test';
const MEMBER_EMAIL = 'rls-kpir-member@ksef-saas.test';
const OTHER_EMAIL = 'rls-kpir-other@ksef-saas.test';
const PASS = 'RlsKpirPass2026Aa!';

const WPIS = { tenant_id: ORG, rodzaj: 'inny', data_przychodu: '2026-10-15', dokument: 'NOTA/1', kwota_gr: 12_345, opis: 'Odsetki' };

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

describe.skipIf(!hasDatabase)('00171: wpisy ręczne KPiR na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    const ownerId = await userId(OWNER_EMAIL);
    const memberId = await userId(MEMBER_EMAIL);
    const otherId = await userId(OTHER_EMAIL);
    await sprzataj();
    const { error: tErr } = await admin.from('tenants').insert([
      { id: ORG, nip: '9480000090', name: 'Firma KPiR 00171' },
      { id: OTHER_ORG, nip: '9480000106', name: 'Inna firma 00171' },
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

  it('właściciel dodaje wpis KPiR z kolumną; stawka albo kolumna, nigdy oba i nigdy żadne', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const { error } = await owner.from('ledger_manual_entries').insert({ ...WPIS, kolumna: 'k8' });
    expect(error).toBeNull();
    const oba = await owner.from('ledger_manual_entries').insert({ ...WPIS, dokument: 'OBA/1', kolumna: 'k13', stawka_pb: 1200 });
    expect(oba.error?.message).toMatch(/ledger_manual_entries_rodzaj_ksiegi_check/);
    const zaden = await owner.from('ledger_manual_entries').insert({ ...WPIS, dokument: 'ZADEN/1' });
    expect(zaden.error?.message).toMatch(/ledger_manual_entries_rodzaj_ksiegi_check/);
    const zlaKolumna = await owner.from('ledger_manual_entries').insert({ ...WPIS, dokument: 'K15/1', kolumna: 'k15' });
    expect(zlaKolumna.error?.message).toMatch(/ledger_manual_entries_kolumna_check/);
    // Wpis ewidencji ryczałtu (K3) działa jak dotąd.
    const ryczalt = await owner.from('ledger_manual_entries').insert({ ...WPIS, dokument: 'RK/10', rodzaj: 'raport_kasy', stawka_pb: 1200 });
    expect(ryczalt.error).toBeNull();
  });

  it('ewidencja czyta tylko wpisy ze stawką, KPiR tylko wpisy z kolumną', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    expect((await czytajWpisyReczne(owner, ORG, '2026-10-01', '2026-10-31')).map((w) => w.dokument)).toEqual(['RK/10']);
    expect((await czytajWpisyKpir(owner, ORG, '2026-10-01', '2026-10-31')).map((w) => [w.dokument, w.kolumna, w.kwotaGr])).toEqual([['NOTA/1', 'k8', 12_345]]);
  });

  it('członek firmy czyta, ale nie dodaje; inna firma nie widzi wpisów', async () => {
    const member = await signedIn(MEMBER_EMAIL, ORG);
    expect((await czytajWpisyKpir(member, ORG, '2026-10-01', '2026-10-31')).length).toBe(1);
    const { error } = await member.from('ledger_manual_entries').insert({ ...WPIS, dokument: 'CZLONEK/1', kolumna: 'k13' });
    expect(error?.message).toMatch(/row-level security/);
    const other = await signedIn(OTHER_EMAIL, OTHER_ORG);
    expect(await czytajWpisyKpir(other, ORG, '2026-10-01', '2026-10-31')).toEqual([]);
  });

  it('właściciel usuwa wpis KPiR i dostaje cały wiersz z kolumną (audyt usunięcia); członek firmy nie usuwa nic', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const { data: nowy, error } = await owner.from('ledger_manual_entries').insert({ ...WPIS, dokument: 'USUN/1', kolumna: 'k13' }).select('id').single();
    expect(error).toBeNull();
    const member = await signedIn(MEMBER_EMAIL, ORG);
    const zCzlonka = await member.from('ledger_manual_entries').delete().eq('id', nowy!.id).eq('tenant_id', ORG).select('*');
    expect(zCzlonka.data ?? []).toEqual([]);
    const usuniete = await owner.from('ledger_manual_entries').delete().eq('id', nowy!.id).eq('tenant_id', ORG).select('*');
    expect(usuniete.error).toBeNull();
    expect(usuniete.data).toEqual([expect.objectContaining({ dokument: 'USUN/1', kolumna: 'k13', stawka_pb: null })]);
  });
});

