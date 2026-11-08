import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { czytajRozliczenia } from '@/lib/ksiegowosc/ten-miesiac-dane';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00168 na prawdziwej bazie: zatwierdzone rozliczenia miesiąca (plan
 * księgowości JDG, K4, D6) i próg najmu w profilu.
 *
 * Właściciel zatwierdza i oznacza zapłatę kluczem użytkownika, członek firmy
 * tylko czyta, inna firma nie widzi nic, a DELETE nie ma nikt poza
 * service_role. Kwoty, wersji ani autora nie zmieni klucz użytkownika
 * (granty kolumnowe), a kwoty nie zmieni nawet klucz serwisowy (wyzwalacz).
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

const ORG = '00168168-0000-4000-8000-000000000001';
const OTHER_ORG = '00168168-0000-4000-8000-000000000002';
const OWNER_EMAIL = 'rls-rozliczenia-owner@ksef-saas.test';
const MEMBER_EMAIL = 'rls-rozliczenia-member@ksef-saas.test';
const OTHER_EMAIL = 'rls-rozliczenia-other@ksef-saas.test';
const PASS = 'RlsRozliczeniaPass2026Aa!';

const WIERSZ = {
  tenant_id: ORG,
  okres: '2026-10-01',
  rodzaj: 'ryczalt',
  wersja: 1,
  kwota_gr: 155600,
  termin: '2026-11-20',
  migawka: { wejscia: { lancuch: [] }, spoleczneBezFpGr: 0 },
  parametry_wersja: 'abcd1234abcd1234',
  wejscia_hash: 'a'.repeat(64),
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
    await admin.from('tax_settlements').delete().eq('tenant_id', org);
    await admin.from('tax_profiles').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
    await admin.from('tenants').delete().eq('id', org);
  }
}

const odczyt = (client: SupabaseClient) => czytajRozliczenia(client, ORG, '2026-10');

describe.skipIf(!hasDatabase)('00168: rozliczenia miesiąca na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    ownerId = await userId(OWNER_EMAIL);
    const memberId = await userId(MEMBER_EMAIL);
    const otherId = await userId(OTHER_EMAIL);
    await sprzataj();
    const { error: tErr } = await admin.from('tenants').insert([
      { id: ORG, nip: '9480000052', name: 'Firma Rozliczenia 00168' },
      { id: OTHER_ORG, nip: '9480000069', name: 'Inna firma 00168' },
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

  it('właściciel zatwierdza; autora, czas i status ustawia baza', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const { data, error } = await owner.from('tax_settlements').insert(WIERSZ).select('status, zatwierdzone_przez, zaplacone_o').single();
    expect(error).toBeNull();
    expect(data).toEqual({ status: 'zatwierdzone', zatwierdzone_przez: ownerId, zaplacone_o: null });
    expect((await odczyt(owner)).map((r) => [r.rodzaj, r.wersja, r.kwotaGr])).toEqual([['ryczalt', 1, 155600]]);
  });

  it('autora, statusu ani daty zapłaty nie podstawi klucz użytkownika przy zatwierdzeniu', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    for (const zmiana of [{ zatwierdzone_przez: '00000000-0000-4000-8000-000000000000' }, { status: 'zaplacone', zaplacone_o: '2026-11-05' }]) {
      const { error } = await owner.from('tax_settlements').insert({ ...WIERSZ, rodzaj: 'zdrowotna', ...zmiana });
      expect(error?.code).toBe('42501');
    }
  });

  it('członek firmy czyta, ale nie zatwierdza i nie oznacza zapłaty; inna firma nic nie widzi', async () => {
    const member = await signedIn(MEMBER_EMAIL, ORG);
    expect((await odczyt(member)).length).toBe(1);
    expect((await member.from('tax_settlements').insert({ ...WIERSZ, rodzaj: 'zus_spoleczne' })).error?.code).toBe('42501');
    const zaplata = await member.from('tax_settlements').update({ status: 'zaplacone', zaplacone_o: '2026-11-05' }).eq('tenant_id', ORG).select('id');
    expect(zaplata.error?.code === '42501' || (zaplata.data ?? []).length === 0).toBe(true);
    const other = await signedIn(OTHER_EMAIL, OTHER_ORG);
    expect(await odczyt(other)).toEqual([]);
    expect((await other.from('tax_settlements').insert({ ...WIERSZ, rodzaj: 'zdrowotna' })).error?.code).toBe('42501');
  });

  it('zapłata: status z datą i cofnięcie przechodzą; status bez daty, data sprzed miesiąca i z przyszłości odrzuca baza', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const bezDaty = await owner.from('tax_settlements').update({ status: 'zaplacone' }).eq('tenant_id', ORG);
    expect(bezDaty.error?.message).toContain('tax_settlements_zaplata_check');
    const przedMiesiacem = await owner.from('tax_settlements').update({ status: 'zaplacone', zaplacone_o: '2026-09-30' }).eq('tenant_id', ORG);
    expect(przedMiesiacem.error?.message).toContain('tax_settlements_zaplata_od_okresu_check');
    const zPrzyszlosci = await owner.from('tax_settlements').update({ status: 'zaplacone', zaplacone_o: '2099-01-05' }).eq('tenant_id', ORG);
    expect([zPrzyszlosci.error?.code, zPrzyszlosci.error?.hint]).toEqual(['23514', 'tax_settlement_future_payment']);
    expect((await owner.from('tax_settlements').update({ status: 'zaplacone', zaplacone_o: '2026-11-05' }).eq('tenant_id', ORG)).error).toBeNull();
    expect((await odczyt(owner))[0]).toMatchObject({ status: 'zaplacone', zaplaconeO: '2026-11-05' });
    expect((await owner.from('tax_settlements').update({ status: 'zatwierdzone', zaplacone_o: null }).eq('tenant_id', ORG)).error).toBeNull();
  });

  it('kwoty nie zmieni klucz użytkownika (grant) ani serwisowy (wyzwalacz); usunąć może tylko service_role', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    expect((await owner.from('tax_settlements').update({ kwota_gr: 1 }).eq('tenant_id', ORG)).error?.code).toBe('42501');
    const serwis = await admin.from('tax_settlements').update({ kwota_gr: 1 }).eq('tenant_id', ORG);
    expect([serwis.error?.code, serwis.error?.hint]).toEqual(['23514', 'tax_settlement_immutable']);
    const usun = await owner.from('tax_settlements').delete().eq('tenant_id', ORG).select('id');
    expect(usun.error?.code === '42501' || (usun.data ?? []).length === 0).toBe(true);
    expect((await odczyt(owner))[0].kwotaGr).toBe(155600);
  });

  it('wersje: ta sama wersja drugi raz to UNIQUE; kolejna wersja przechodzi', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    expect((await owner.from('tax_settlements').insert(WIERSZ)).error?.code).toBe('23505');
    expect((await owner.from('tax_settlements').insert({ ...WIERSZ, wersja: 2, kwota_gr: 160000, wejscia_hash: 'b'.repeat(64) })).error).toBeNull();
  });

  // Nazwa ograniczenia w komunikacie: każdy przypadek dowodzi swojego CHECK-a.
  it('CHECK: okres nie od pierwszego dnia, zły rodzaj, ujemna kwota, zły skrót; najem przy skali', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const przypadki: [Record<string, unknown>, string][] = [
      [{ okres: '2026-10-15' }, 'tax_settlements_okres_check'],
      [{ rodzaj: 'cit' }, 'tax_settlements_rodzaj_check'],
      [{ kwota_gr: -1 }, 'tax_settlements_kwota_check'],
      [{ wejscia_hash: 'xyz' }, 'tax_settlements_hash_check'],
    ];
    for (const [zmiana, ograniczenie] of przypadki) {
      const { error } = await owner.from('tax_settlements').insert({ ...WIERSZ, wersja: 9, ...zmiana });
      expect(error?.message, ograniczenie).toContain(ograniczenie);
    }
    const najem = await owner.from('tax_profiles').insert({ tenant_id: ORG, valid_from: '2026-01-01', forma: 'skala', stawka_domyslna: null, zus_etap: 'pelny', najem: true });
    expect(najem.error?.message).toContain('tax_profiles_najem_check');
    const ryczalt = await owner.from('tax_profiles').insert({ tenant_id: ORG, valid_from: '2026-01-01', forma: 'ryczalt', stawka_domyslna: 850, zus_etap: 'pelny', najem: true });
    expect(ryczalt.error).toBeNull();
  });

  it('odczyt miesiąca: jego wersje i wszystkie wcześniejsze zapłacone (odliczenie po dniu zapłaty), bez niezapłaconych z innych miesięcy', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const wstaw = await owner.from('tax_settlements').insert([
      { ...WIERSZ, okres: '2026-08-01', rodzaj: 'zus_spoleczne', migawka: { spoleczneBezFpGr: 178829 }, wejscia_hash: 'c'.repeat(64) },
      { ...WIERSZ, okres: '2026-09-01', rodzaj: 'zus_spoleczne', wejscia_hash: 'd'.repeat(64) },
    ]);
    expect(wstaw.error).toBeNull();
    const zaplata = await owner.from('tax_settlements').update({ status: 'zaplacone', zaplacone_o: '2026-10-05' }).eq('tenant_id', ORG).eq('okres', '2026-08-01');
    expect(zaplata.error).toBeNull();
    const listopad = await czytajRozliczenia(owner, ORG, '2026-11');
    expect(listopad.map((r) => [r.miesiac, r.rodzaj, r.status, r.spoleczneBezFpGr])).toEqual([['2026-08', 'zus_spoleczne', 'zaplacone', 178829]]);
  });

  it('00172: zapłata spoza wyliczenia za grudzień 2025 r. przechodzi, okres sprzed 2025 r. dalej odrzuca CHECK; odczyt ma oznaczenie i bez daty też', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const reczna = { ...WIERSZ, okres: '2025-12-01', rodzaj: 'zus_spoleczne', parametry_wersja: 'reczna', wejscia_hash: 'e'.repeat(64) };
    const grudzien = await owner
      .from('tax_settlements')
      .insert({ ...reczna, migawka: { reczna: true, spoleczneBezFpGr: 178829 } })
      .select('id')
      .single();
    expect(grudzien.error).toBeNull();
    const zaplata = await owner.from('tax_settlements').update({ status: 'zaplacone', zaplacone_o: '2026-01-15' }).eq('id', grudzien.data!.id);
    expect(zaplata.error).toBeNull();
    const bezDaty = await owner.from('tax_settlements').insert({ ...reczna, okres: '2025-11-01', migawka: { reczna: true, spoleczneBezFpGr: 0 }, wejscia_hash: 'f'.repeat(64) });
    expect(bezDaty.error).toBeNull();
    const zaWczesnie = await owner.from('tax_settlements').insert({ ...reczna, okres: '2024-12-01', wejscia_hash: '1'.repeat(64) });
    expect(zaWczesnie.error?.message).toContain('tax_settlements_okres_check');

    const styczen = await czytajRozliczenia(owner, ORG, '2026-01');
    expect(styczen.filter((r) => r.reczna).map((r) => [r.miesiac, r.status, r.spoleczneBezFpGr])).toEqual([
      ['2025-11', 'zatwierdzone', 0],
      ['2025-12', 'zaplacone', 178829],
    ]);
  });
});

