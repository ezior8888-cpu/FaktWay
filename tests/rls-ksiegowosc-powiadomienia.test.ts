import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { zajmij, zamknij } from '@/lib/ksiegowosc/powiadomienia';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00169 na prawdziwej bazie: powiadomienia modułu księgowości (plan
 * księgowości JDG, K5). `tax_notifications` piszą i czytają tylko zadania
 * (service_role); UNIQUE (firma, rozliczenie, etap) zatrzymuje drugą
 * wysyłkę, a wpis „failed” da się przejąć. Zgoda push `notify_ksiegowosc`
 * jest domyślnie włączona i użytkownik zmienia ją sam.
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

const ORG = '00169169-0000-4000-8000-000000000001';
const OWNER_EMAIL = 'rls-powiadomienia-owner@ksef-saas.test';
const PASS = 'RlsPowiadomieniaPass2026Aa!';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/rls-00169';

let ownerId = '';

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

async function signedIn(): Promise<SupabaseClient> {
  const client = createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-active-org': ORG } },
  });
  const { error } = await client.auth.signInWithPassword({ email: OWNER_EMAIL, password: PASS });
  if (error) throw error;
  return client;
}

async function sprzataj() {
  await admin.from('tax_notifications').delete().eq('tenant_id', ORG);
  await admin.from('push_subscriptions').delete().eq('endpoint', ENDPOINT);
  await admin.from('memberships').delete().eq('organization_id', ORG);
  await admin.from('tenants').delete().eq('id', ORG);
}

describe.skipIf(!hasDatabase)('00169: powiadomienia modułu księgowości na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    ownerId = await userId(OWNER_EMAIL);
    await sprzataj();
    const { error: tErr } = await admin.from('tenants').insert({ id: ORG, nip: '9480000076', name: 'Firma Powiadomienia 00169' });
    if (tErr) throw tErr;
    await admin.from('users').upsert([{ id: ownerId, name: 'Owner' }], { onConflict: 'id' });
    const { error: mErr } = await admin.from('memberships').insert({ organization_id: ORG, user_id: ownerId, role: 'owner', status: 'active' });
    if (mErr) throw mErr;
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await sprzataj();
  });

  it('zadanie zajmuje wpis przed wysyłką; drugi przebieg to duplikat, a wpis „failed” da się przejąć', async () => {
    expect(await zajmij(admin, ORG, '2026-10', 'wyliczone')).toBe('zajete');
    await zamknij(admin, ORG, '2026-10', 'wyliczone', { status: 'sent', wynik: { push: 1 } });
    expect(await zajmij(admin, ORG, '2026-10', 'wyliczone')).toBe('duplikat');

    expect(await zajmij(admin, ORG, '2026-10', 'termin-5:2026-11-20')).toBe('zajete');
    await zamknij(admin, ORG, '2026-10', 'termin-5:2026-11-20', { status: 'failed', blad: 'push padł' });
    expect(await zajmij(admin, ORG, '2026-10', 'termin-5:2026-11-20')).toBe('zajete');

    const { data } = await admin.from('tax_notifications').select('etap, status, wynik, wyslano_o').eq('tenant_id', ORG).order('etap');
    expect(data?.map((w) => [w.etap, w.status])).toEqual([
      ['termin-5:2026-11-20', 'sending'],
      ['wyliczone', 'sent'],
    ]);
  });

  it('klucz użytkownika (nawet właściciela) nie czyta ani nie pisze tax_notifications', async () => {
    const owner = await signedIn();
    const odczyt = await owner.from('tax_notifications').select('id').eq('tenant_id', ORG);
    expect(odczyt.error?.code === '42501' || (odczyt.data ?? []).length === 0).toBe(true);
    const zapis = await owner.from('tax_notifications').insert({ tenant_id: ORG, rozliczenie: '2026-09', etap: 'wyliczone' });
    expect(zapis.error?.code).toBe('42501');
  });

  // Nazwa ograniczenia w komunikacie: każdy przypadek dowodzi swojego CHECK-a.
  it('CHECK: miesiąc rozliczenia, etap i status', async () => {
    const przypadki: [Record<string, unknown>, string][] = [
      [{ rozliczenie: '2026-13' }, 'tax_notifications_rozliczenie_check'],
      [{ etap: 'termin-3:2026-11-20' }, 'tax_notifications_etap_check'],
      [{ status: 'wysylany' }, 'tax_notifications_status_check'],
    ];
    for (const [zmiana, ograniczenie] of przypadki) {
      const { error } = await admin.from('tax_notifications').insert({ tenant_id: ORG, rozliczenie: '2026-08', etap: 'wyliczone', ...zmiana });
      expect(error?.message, ograniczenie).toContain(ograniczenie);
    }
  });

  it('zgoda push „Księgowość” jest domyślnie włączona, a użytkownik zmienia ją na swoim urządzeniu', async () => {
    const { error } = await admin.from('push_subscriptions').insert({ user_id: ownerId, tenant_id: ORG, endpoint: ENDPOINT, p256dh: 'p', auth: 'a' });
    expect(error).toBeNull();
    const owner = await signedIn();
    const przed = await owner.from('push_subscriptions').select('notify_ksiegowosc').eq('endpoint', ENDPOINT).single();
    expect(przed.data).toEqual({ notify_ksiegowosc: true });
    const zmiana = await owner.from('push_subscriptions').update({ notify_ksiegowosc: false }).eq('endpoint', ENDPOINT).select('notify_ksiegowosc');
    expect(zmiana.data).toEqual([{ notify_ksiegowosc: false }]);
  });
});
