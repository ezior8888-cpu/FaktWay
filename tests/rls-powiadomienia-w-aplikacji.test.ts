import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00188 na prawdziwej bazie: powiadomienia w aplikacji, czyli dzwonek
 * w nagłówku (plan kompletnej aplikacji, krok 8.1, część 2).
 *
 * Zadanie (service_role) woła `app_notification_publish`, która dopisuje wpis
 * każdemu AKTYWNEMU członkowi firmy. UNIQUE (odbiorca, firma, rodzaj, klucz
 * obiektu) z ON CONFLICT DO NOTHING: ponowienie joba od zera nie dubluje
 * wpisu. Użytkownik czyta tylko swoje wpisy aktywnej firmy, nie pisze do
 * tabeli wprost, a datę przeczytania ustawia tylko
 * `app_notifications_mark_read` (swoje wpisy, aktywna firma, zawsze „teraz”).
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

const ORG = '00188188-0000-4000-8000-000000000001';
const OTHER_ORG = '00188188-0000-4000-8000-000000000002';
const INVOICE = '00188188-0000-4000-8000-0000000000a1';
const EXPENSE = '00188188-0000-4000-8000-0000000000b1';
const OWNER_EMAIL = 'rls-dzwonek-owner@ksef-saas.test';
const MEMBER_EMAIL = 'rls-dzwonek-member@ksef-saas.test';
const SUSPENDED_EMAIL = 'rls-dzwonek-suspended@ksef-saas.test';
const OTHER_EMAIL = 'rls-dzwonek-other@ksef-saas.test';
const PASS = 'RlsDzwonekPass2026Aa!';

let ownerId = '';
let memberId = '';
let suspendedId = '';
let otherId = '';

/** Wpis z wszystkimi polami, które zadanie podaje funkcji zapisu. */
const WPIS = {
  p_tenant_id: ORG,
  p_kind: 'inbox_new',
  p_object_key: INVOICE,
  p_title: 'Nowa faktura zakupu',
  p_body: 'FV 1/2026 od Dostawca sp. z o.o., 123,00 zł',
  p_link: `/expenses/${EXPENSE}`,
};

function anonClient(activeOrg?: string) {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: activeOrg ? { headers: { 'x-active-org': activeOrg } } : undefined,
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

async function signedIn(email: string, org?: string): Promise<SupabaseClient> {
  const client = anonClient(org);
  const { error } = await client.auth.signInWithPassword({ email, password: PASS });
  if (error) throw error;
  return client;
}

async function wpisyFirmy(org: string) {
  const { data, error } = await admin
    .from('app_notifications')
    .select('id, user_id, kind, object_key, title, body, link, created_at, read_at')
    .eq('tenant_id', org)
    .order('created_at');
  if (error) throw error;
  return data ?? [];
}

async function sprzataj() {
  for (const org of [ORG, OTHER_ORG]) {
    await admin.from('app_notifications').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
    await admin.from('tenants').delete().eq('id', org);
  }
}

describe.skipIf(!hasDatabase)('00188: powiadomienia w aplikacji na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    ownerId = await userId(OWNER_EMAIL);
    memberId = await userId(MEMBER_EMAIL);
    suspendedId = await userId(SUSPENDED_EMAIL);
    otherId = await userId(OTHER_EMAIL);
    await sprzataj();
    const { error: tErr } = await admin.from('tenants').insert([
      { id: ORG, nip: '9480000137', name: 'Firma Dzwonek 00188' },
      { id: OTHER_ORG, nip: '9480000144', name: 'Inna firma 00188' },
    ]);
    if (tErr) throw tErr;
    await admin.from('users').upsert(
      [
        { id: ownerId, name: 'Owner' },
        { id: memberId, name: 'Member' },
        { id: suspendedId, name: 'Suspended' },
        { id: otherId, name: 'Other' },
      ],
      { onConflict: 'id' },
    );
    const { error: mErr } = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ownerId, role: 'owner', status: 'active' },
      { organization_id: ORG, user_id: memberId, role: 'member', status: 'active' },
      { organization_id: ORG, user_id: suspendedId, role: 'member', status: 'suspended' },
      { organization_id: OTHER_ORG, user_id: otherId, role: 'owner', status: 'active' },
      // Właściciel ORG obsługuje też drugą firmę: dzwonek pokazuje tylko aktywną.
      { organization_id: OTHER_ORG, user_id: ownerId, role: 'accountant', status: 'active' },
    ]);
    if (mErr) throw mErr;
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await sprzataj();
  });

  it('zadanie dopisuje wpis każdemu aktywnemu członkowi; ponowienie z tym samym kluczem nic nie dodaje', async () => {
    const pierwszy = await admin.rpc('app_notification_publish', WPIS);
    expect(pierwszy.error).toBeNull();
    expect(pierwszy.data).toBe(2);

    const ponowienie = await admin.rpc('app_notification_publish', WPIS);
    expect(ponowienie.error).toBeNull();
    expect(ponowienie.data).toBe(0);

    const wpisy = await wpisyFirmy(ORG);
    expect(wpisy.map((w) => w.user_id).sort()).toEqual([ownerId, memberId].sort());
    expect(wpisy.every((w) => w.read_at === null)).toBe(true);
    expect(wpisy[0]).toMatchObject({ kind: 'inbox_new', object_key: INVOICE, title: WPIS.p_title, body: WPIS.p_body, link: WPIS.p_link });

    // Klucz obejmuje rodzaj: ta sama faktura przyjęta w KSeF to osobny wpis.
    const inny = await admin.rpc('app_notification_publish', {
      ...WPIS,
      p_kind: 'invoice_accepted',
      p_title: 'Faktura przyjęta w KSeF',
      p_body: null,
      p_link: `/invoices/${INVOICE}`,
    });
    expect(inny.data).toBe(2);
    expect(await wpisyFirmy(ORG)).toHaveLength(4);

    const drugaFirma = await admin.rpc('app_notification_publish', { ...WPIS, p_tenant_id: OTHER_ORG, p_link: null });
    expect(drugaFirma.data).toBe(2);
  });

  it('użytkownik widzi tylko swoje wpisy aktywnej firmy', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const wlasne = await owner.from('app_notifications').select('user_id, tenant_id, kind');
    expect(wlasne.error).toBeNull();
    expect(wlasne.data?.map((w) => w.kind).sort()).toEqual(['inbox_new', 'invoice_accepted']);
    expect(wlasne.data?.every((w) => w.user_id === ownerId && w.tenant_id === ORG)).toBe(true);

    const member = await signedIn(MEMBER_EMAIL, ORG);
    const czlonka = await member.from('app_notifications').select('user_id');
    expect(czlonka.data?.length).toBe(2);
    expect(czlonka.data?.every((w) => w.user_id === memberId)).toBe(true);

    // Zawieszony członek i osoba spoza firmy z nagłówkiem tej firmy: nic.
    const zawieszony = await signedIn(SUSPENDED_EMAIL, ORG);
    expect((await zawieszony.from('app_notifications').select('id')).data ?? []).toEqual([]);
    const obcy = await signedIn(OTHER_EMAIL, ORG);
    expect((await obcy.from('app_notifications').select('id')).data ?? []).toEqual([]);

    // Ta sama osoba w drugiej firmie widzi tylko jej wpis.
    const ownerDruga = await signedIn(OWNER_EMAIL, OTHER_ORG);
    const drugiej = await ownerDruga.from('app_notifications').select('tenant_id, user_id');
    expect(drugiej.data).toEqual([{ tenant_id: OTHER_ORG, user_id: ownerId }]);

    // Bez aktywnej firmy: nic.
    const bezFirmy = await signedIn(OWNER_EMAIL);
    expect((await bezFirmy.from('app_notifications').select('id')).data ?? []).toEqual([]);
  });

  it('klucz użytkownika nie dopisuje, nie zmienia i nie usuwa wpisów ani nie woła zapisu zadania; anon nic', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const dopisz = await owner.from('app_notifications').insert({
      tenant_id: ORG,
      user_id: ownerId,
      kind: 'inbox_new',
      object_key: 'wlasny-wpis',
      title: 'Wpis z przeglądarki',
    });
    expect(dopisz.error?.code).toBe('42501');
    const zmien = await owner.from('app_notifications').update({ read_at: null }).eq('tenant_id', ORG).select('id');
    expect(zmien.error?.code).toBe('42501');
    const usun = await owner.from('app_notifications').delete().eq('tenant_id', ORG).select('id');
    expect(usun.error?.code).toBe('42501');
    const zadanie = await owner.rpc('app_notification_publish', { ...WPIS, p_object_key: 'z-przegladarki' });
    expect(zadanie.error?.code).toBe('42501');

    const anon = anonClient(ORG);
    const odczyt = await anon.from('app_notifications').select('id');
    expect(odczyt.error?.code === '42501' || (odczyt.data ?? []).length === 0).toBe(true);
    expect((await anon.rpc('app_notifications_mark_read', { p_ids: null })).error).not.toBeNull();
    expect((await anon.rpc('app_notification_publish', WPIS)).error).not.toBeNull();
    expect((await wpisyFirmy(ORG)).length).toBe(4);
  });

  it('oznaczanie: jeden wpis, potem wszystkie; tylko własne, tylko w aktywnej firmie, zawsze „teraz”', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const wlasne = (await wpisyFirmy(ORG)).filter((w) => w.user_id === ownerId);
    const cudzy = (await wpisyFirmy(ORG)).find((w) => w.user_id === memberId)!;
    expect(wlasne).toHaveLength(2);

    const jeden = await owner.rpc('app_notifications_mark_read', { p_ids: [wlasne[0]!.id] });
    expect(jeden.error).toBeNull();
    expect(jeden.data).toBe(1);
    expect((await owner.rpc('app_notifications_mark_read', { p_ids: [wlasne[0]!.id] })).data).toBe(0);
    // Cudzy wpis podany wprost: bez zmiany.
    expect((await owner.rpc('app_notifications_mark_read', { p_ids: [cudzy.id] })).data).toBe(0);

    const wszystkie = await owner.rpc('app_notifications_mark_read', { p_ids: null });
    expect(wszystkie.data).toBe(1);

    const poOznaczeniu = await wpisyFirmy(ORG);
    for (const w of poOznaczeniu.filter((x) => x.user_id === ownerId)) {
      expect(w.read_at).not.toBeNull();
      expect(Date.parse(w.read_at as string)).toBeGreaterThanOrEqual(Date.parse(w.created_at as string));
    }
    expect(poOznaczeniu.filter((x) => x.user_id === memberId).every((w) => w.read_at === null)).toBe(true);
    // Wpis właściciela w drugiej firmie zostaje nieprzeczytany.
    const drugiej = (await wpisyFirmy(OTHER_ORG)).find((w) => w.user_id === ownerId)!;
    expect(drugiej.read_at).toBeNull();

    const bezFirmy = await signedIn(OWNER_EMAIL);
    expect((await bezFirmy.rpc('app_notifications_mark_read', { p_ids: null })).error?.code).toBe('42501');
  });

  // Nazwa ograniczenia w komunikacie: każdy przypadek dowodzi swojego CHECK-a.
  it('CHECK: rodzaj, klucz, tytuł i link tylko wewnątrz aplikacji', async () => {
    const przypadki: [Record<string, unknown>, string][] = [
      [{ p_kind: 'cos_innego' }, 'app_notifications_kind_check'],
      [{ p_object_key: '' }, 'app_notifications_object_key_check'],
      [{ p_title: '' }, 'app_notifications_title_check'],
      [{ p_body: '' }, 'app_notifications_body_check'],
      [{ p_link: 'https://faktway.example/expenses' }, 'app_notifications_link_check'],
      [{ p_link: '//faktway.example/expenses' }, 'app_notifications_link_check'],
      [{ p_link: '/expenses/x y' }, 'app_notifications_link_check'],
    ];
    for (const [zmiana, ograniczenie] of przypadki) {
      const { error } = await admin.rpc('app_notification_publish', { ...WPIS, p_object_key: `check-${ograniczenie}`, ...zmiana });
      expect(error?.message, ograniczenie).toContain(ograniczenie);
    }
    expect((await wpisyFirmy(ORG)).length).toBe(4);
  });
});
