import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { czytajWysylki, zalozWysylke, zamknijPrzerwane, zmienWysylke } from '@/lib/ksiegowosc/wysylka-jpk/zapis';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00170 na prawdziwej bazie: wysyłki JPK do MF (plan księgowości JDG, K6, D9).
 *
 * Właściciel zakłada wysyłkę i zmienia jej stan kluczem użytkownika, członek
 * firmy tylko czyta, inna firma nie widzi nic, a DELETE nie ma nikt poza
 * service_role. Jedna wysyłka w toku na miesiąc (indeks częściowy),
 * przejścia stanów i niezmienność pliku pilnuje wyzwalacz, także dla
 * klucza serwisowego.
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

const ORG = '00170170-0000-4000-8000-000000000001';
const OTHER_ORG = '00170170-0000-4000-8000-000000000002';
const OWNER_EMAIL = 'rls-jpk-owner@ksef-saas.test';
const MEMBER_EMAIL = 'rls-jpk-member@ksef-saas.test';
const OTHER_EMAIL = 'rls-jpk-other@ksef-saas.test';
const PASS = 'RlsJpkPass2026Aa!';
const NUMER = 'b7a0810e02818670000000b92c9f5343';

const WYSYLKA = {
  okres: '2026-10-01',
  cel: 1 as const,
  srodowisko: 'test' as const,
  skrotPliku: 'AM/SlQpito+9Ctp5oFY8PT+eS1PXNokUptIKKh3xMCw=',
  deklaracja: { P_38: 230, P_39: 0, P_48: 0, P_51: 230, P_62: 0 },
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
    await admin.from('jpk_submissions').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
    await admin.from('tenants').delete().eq('id', org);
  }
}

describe.skipIf(!hasDatabase)('00170: wysyłki JPK na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    ownerId = await userId(OWNER_EMAIL);
    const memberId = await userId(MEMBER_EMAIL);
    const otherId = await userId(OTHER_EMAIL);
    await sprzataj();
    const { error: tErr } = await admin.from('tenants').insert([
      { id: ORG, nip: '9480000076', name: 'Firma JPK 00170' },
      { id: OTHER_ORG, nip: '9480000083', name: 'Inna firma 00170' },
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

  it('właściciel zakłada wysyłkę; stan, autora i czas ustawia baza; druga za ten miesiąc czeka na pierwszą', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const zalozona = await zalozWysylke(owner, ORG, WYSYLKA);
    expect(zalozona).toEqual({ id: expect.any(String) });
    const { data } = await admin.from('jpk_submissions').select('stan, wyslal, rodzaj, numer_referencyjny').eq('tenant_id', ORG).single();
    expect(data).toEqual({ stan: 'wysylanie', wyslal: ownerId, rodzaj: 'JPK_V7M', numer_referencyjny: null });

    // Indeks jpk_submissions_jedna_w_toku: drugie kliknięcie nie zakłada drugiej wysyłki.
    expect(await zalozWysylke(owner, ORG, WYSYLKA)).toBe('w_toku');
    // Klucz użytkownika nie ustawi stanu ani autora przy zakładaniu (granty kolumnowe).
    const { error } = await owner.from('jpk_submissions').insert({ tenant_id: ORG, okres: '2026-09-01', rodzaj: 'JPK_V7M', cel: 1, srodowisko: 'test', skrot_pliku: WYSYLKA.skrotPliku, deklaracja: {}, stan: 'przyjeta' });
    expect(error?.code).toBe('42501');
  });

  it('przejścia stanów: wysyłka → w toku z numerem → przyjęta z UPO; stan końcowy się nie zmienia', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const [w] = await czytajWysylki(owner, ORG, ['2026-10-01']);
    // Bez numeru nie ma „w toku” (CHECK), a „przyjęta” bez UPO też nie.
    await expect(zmienWysylke(owner, w.id, 'wysylanie', { stan: 'w_toku' })).rejects.toThrow(/jpk_submissions_numer_stan_check/);
    expect(await zmienWysylke(owner, w.id, 'wysylanie', { stan: 'w_toku', numer_referencyjny: NUMER, wyslano_o: new Date().toISOString() })).toBe(true);
    // Warunek na stan poprzedni: spóźnione przejście z „wysylanie” nic nie zmienia.
    expect(await zmienWysylke(owner, w.id, 'wysylanie', { stan: 'przerwana' })).toBe(false);
    await expect(zmienWysylke(owner, w.id, 'w_toku', { stan: 'przyjeta' })).rejects.toThrow(/jpk_submissions_upo_check/);
    expect(await zmienWysylke(owner, w.id, 'w_toku', { stan: 'przyjeta', status_kod: 200, upo_sciezka: `upo/${ORG}/jpk/2026-10/${NUMER}.xml` })).toBe(true);

    await expect(zmienWysylke(owner, w.id, 'przyjeta', { stan: 'odrzucona' })).rejects.toThrow(/nie przechodzi w stan/);
    // Pliku, deklaracji i numeru nie zmienia nawet klucz serwisowy.
    const { error: plik } = await admin.from('jpk_submissions').update({ deklaracja: { P_51: 1 } }).eq('id', w.id);
    expect(plik?.message).toMatch(/Wysłanego pliku nie zmienia się/);
    const { error: numer } = await admin.from('jpk_submissions').update({ numer_referencyjny: 'a'.repeat(32) }).eq('id', w.id);
    expect(numer?.message).toMatch(/Wysłanego pliku nie zmienia się/);
    // Po zakończeniu pierwszej można wysłać kolejną za ten sam miesiąc.
    expect(await zalozWysylke(owner, ORG, { ...WYSYLKA, cel: 2 })).toEqual({ id: expect.any(String) });
  });

  it('wysyłka, która utknęła przed numerem, zamyka się jako przerwana po 15 minutach', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const okresy = ['2026-10-01'];
    const utknieta = (await czytajWysylki(owner, ORG, okresy)).find((w) => w.stan === 'wysylanie')!;
    await zamknijPrzerwane(owner, ORG, '2026-10-01', new Date(Date.now() + 5 * 60_000));
    expect((await czytajWysylki(owner, ORG, okresy)).find((w) => w.id === utknieta.id)?.stan).toBe('wysylanie');
    await zamknijPrzerwane(owner, ORG, '2026-10-01', new Date(Date.now() + 16 * 60_000));
    expect((await czytajWysylki(owner, ORG, okresy)).find((w) => w.id === utknieta.id)?.stan).toBe('przerwana');
  });

  it('członek firmy czyta, ale nie zakłada ani nie zmienia; inna firma nie widzi nic; DELETE tylko service_role', async () => {
    const member = await signedIn(MEMBER_EMAIL, ORG);
    expect((await czytajWysylki(member, ORG, ['2026-10-01'])).length).toBeGreaterThan(0);
    await expect(zalozWysylke(member, ORG, { ...WYSYLKA, okres: '2026-08-01' })).rejects.toThrow(/row-level security/);
    const [w] = await czytajWysylki(member, ORG, ['2026-10-01']);
    expect(await zmienWysylke(member, w.id, w.stan, { blad: 'x' })).toBe(false);

    const other = await signedIn(OTHER_EMAIL, OTHER_ORG);
    expect(await czytajWysylki(other, ORG, ['2026-10-01'])).toEqual([]);
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const { data: usuniete } = await owner.from('jpk_submissions').delete().eq('tenant_id', ORG).select('id');
    expect(usuniete ?? []).toEqual([]);
    expect((await czytajWysylki(owner, ORG, ['2026-10-01'])).length).toBeGreaterThan(0);
  });

  it('CHECK-i: okres od lutego 2026, skrót SHA-256 w Base64, numer referencyjny bez znaków spoza liter i cyfr', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    await expect(zalozWysylke(owner, ORG, { ...WYSYLKA, okres: '2026-01-01' })).rejects.toThrow(/jpk_submissions_okres_check/);
    await expect(zalozWysylke(owner, ORG, { ...WYSYLKA, okres: '2026-07-01', skrotPliku: 'abc' })).rejects.toThrow(/jpk_submissions_skrot_check/);
    const nowa = await zalozWysylke(owner, ORG, { ...WYSYLKA, okres: '2026-07-01' });
    if (nowa === 'w_toku') throw new Error('nieoczekiwana wysyłka w toku');
    await expect(zmienWysylke(owner, nowa.id, 'wysylanie', { stan: 'w_toku', numer_referencyjny: '../Status' })).rejects.toThrow(/jpk_submissions_numer_check/);
  });
});
