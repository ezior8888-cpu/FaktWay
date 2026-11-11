import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createArchiveOrder, deletePendingOrder, readArchiveOrders } from '@/lib/archiwum/zlecenia';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00178 na prawdziwej bazie: zlecenia archiwum dokumentów i paczki na
 * kontrolę (plan kompletnej aplikacji, krok 6.4, część 1).
 *
 * Właściciel zakłada zlecenie kluczem użytkownika (stan, autora i czas
 * ustawia baza), członek firmy nie widzi i nie zleca nic, inna firma nie
 * widzi cudzych zleceń, a UPDATE ma tylko service_role. Wyzwalacz pilnuje
 * limitu jednego zlecenia na 10 minut na firmę i zamyka zlecenie aktywne
 * dłużej niż 6 godzin; indeks częściowy pilnuje jednego aktywnego na okres.
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

const ORG = '00178178-0000-4000-8000-000000000001';
const OTHER_ORG = '00178178-0000-4000-8000-000000000002';
const OWNER_EMAIL = 'rls-archiwum-owner@ksef-saas.test';
const MEMBER_EMAIL = 'rls-archiwum-member@ksef-saas.test';
const OTHER_EMAIL = 'rls-archiwum-other@ksef-saas.test';
const PASS = 'RlsArchiwumPass2026Aa!';

const MARZEC = { kind: 'archive' as const, periodStart: '2026-03-01', periodEnd: '2026-03-31' };

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

/** Cofa czas założenia zleceń firmy: następne nie trafi w limit 10 minut. */
async function cofnij(org: string, minutes: number) {
  const { data, error } = await admin.from('document_archives').select('id, created_at').eq('tenant_id', org);
  if (error) throw error;
  for (const row of data ?? []) {
    const at = new Date(new Date(row.created_at as string).getTime() - minutes * 60_000).toISOString();
    const { error: upErr } = await admin.from('document_archives').update({ created_at: at }).eq('id', row.id);
    if (upErr) throw upErr;
  }
}

async function sprzataj() {
  for (const org of [ORG, OTHER_ORG]) {
    await admin.from('document_archives').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
    await admin.from('tenants').delete().eq('id', org);
  }
}

describe.skipIf(!hasDatabase)('00178: zlecenia archiwum dokumentów na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    ownerId = await userId(OWNER_EMAIL);
    const memberId = await userId(MEMBER_EMAIL);
    const otherId = await userId(OTHER_EMAIL);
    await sprzataj();
    const { error: tErr } = await admin.from('tenants').insert([
      { id: ORG, nip: '9480000090', name: 'Firma archiwum 00178' },
      { id: OTHER_ORG, nip: '9480000107', name: 'Inna firma 00178' },
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

  it('właściciel zleca; stan, autora i czas ustawia baza; drugie zlecenie przed upływem 10 minut odbija limit', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const first = await createArchiveOrder(owner, ORG, MARZEC);
    expect(first).toEqual({ ok: true, id: expect.any(String) });
    const { data } = await admin.from('document_archives').select('status, requested_by, kind').eq('tenant_id', ORG).single();
    expect(data).toEqual({ status: 'pending', requested_by: ownerId, kind: 'archive' });

    const second = await createArchiveOrder(owner, ORG, { kind: 'audit', periodStart: '2026-04-01', periodEnd: '2026-04-30' });
    expect(second).toMatchObject({ ok: false, reason: 'limit', message: expect.stringMatching(/^Kolejną paczkę można zlecić po \d{2}:\d{2}\.$/) });

    // Klucz użytkownika nie ustawi stanu przy zakładaniu (granty kolumnowe) ani nie zmieni go potem.
    const { error: insErr } = await owner.from('document_archives').insert({ tenant_id: ORG, kind: 'archive', period_start: '2026-05-01', period_end: '2026-05-31', status: 'completed' });
    expect(insErr?.code).toBe('42501');
    const { error: upErr } = await owner.from('document_archives').update({ status: 'failed' }).eq('tenant_id', ORG);
    expect(upErr?.code).toBe('42501');
  });

  it('członek firmy nie widzi zleceń i nie zleca; inna firma nie widzi cudzych', async () => {
    const member = await signedIn(MEMBER_EMAIL, ORG);
    expect(await readArchiveOrders(member, ORG)).toEqual([]);
    expect(await createArchiveOrder(member, ORG, { ...MARZEC, periodStart: '2026-06-01', periodEnd: '2026-06-30' })).toMatchObject({ ok: false, reason: 'forbidden' });

    const other = await signedIn(OTHER_EMAIL, OTHER_ORG);
    expect(await readArchiveOrders(other, OTHER_ORG)).toEqual([]);
    const { data } = await other.from('document_archives').select('id').eq('tenant_id', ORG);
    expect(data).toEqual([]);
    // Cudza firma w zleceniu: odmowa uprawnień, a nie komunikat limitu tamtej firmy.
    expect(await createArchiveOrder(other, ORG, MARZEC)).toMatchObject({ ok: false, reason: 'forbidden' });
  });

  it('jedno aktywne zlecenie na okres; utknięte ponad 6 godzin zamyka się przy następnym zleceniu', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    await admin.from('document_archives').update({ status: 'generating' }).eq('tenant_id', ORG);
    await cofnij(ORG, 20);
    expect(await createArchiveOrder(owner, ORG, MARZEC)).toMatchObject({ ok: false, reason: 'active' });

    await cofnij(ORG, 7 * 60);
    const fresh = await createArchiveOrder(owner, ORG, MARZEC);
    expect(fresh).toEqual({ ok: true, id: expect.any(String) });
    const orders = await readArchiveOrders(owner, ORG);
    expect(orders.map((o) => o.status).sort()).toEqual(['failed', 'pending']);
    expect(orders.find((o) => o.status === 'failed')?.error_message).toMatch(/Zleć ją ponownie/);
  });

  it('usunąć można tylko własne zlecenie „pending”; gotowość wymaga pliku pod kluczem zlecenia', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const [pending] = (await readArchiveOrders(owner, ORG)).filter((o) => o.status === 'pending');
    const { data: inne } = await admin.from('document_archives').select('id').eq('tenant_id', ORG).neq('id', pending!.id).single();

    await deletePendingOrder(owner, ORG, inne!.id as string);
    expect((await readArchiveOrders(owner, ORG)).length).toBe(2);
    const member = await signedIn(MEMBER_EMAIL, ORG);
    await deletePendingOrder(member, ORG, pending!.id);
    expect((await readArchiveOrders(owner, ORG)).length).toBe(2);
    await deletePendingOrder(owner, ORG, pending!.id);
    expect((await readArchiveOrders(owner, ORG)).length).toBe(1);

    const id = inne!.id as string;
    const { error: bezPliku } = await admin.from('document_archives').update({ status: 'completed' }).eq('id', id);
    expect(bezPliku?.message).toMatch(/document_archives_completed_check/);
    const done = { status: 'completed', file_name: 'a.zip', size_bytes: 1, files_count: 1, missing_count: 0, finished_at: new Date().toISOString(), expires_at: new Date().toISOString() };
    const { error: obcyKlucz } = await admin.from('document_archives').update({ ...done, file_key: `exports/${OTHER_ORG}/archiwum/${id}/a.zip` }).eq('id', id);
    expect(obcyKlucz?.message).toMatch(/document_archives_file_key_check/);
    const { error: ok } = await admin.from('document_archives').update({ ...done, file_key: `exports/${ORG}/archiwum/${id}/a.zip` }).eq('id', id);
    expect(ok).toBeNull();
  });

  it('okres: pełne miesiące, najwyżej 12, od 2015 r. (CHECK także dla klucza serwisowego)', async () => {
    for (const [period_start, period_end] of [['2026-03-02', '2026-03-31'], ['2026-03-01', '2026-03-30'], ['2025-01-01', '2026-01-31'], ['2014-12-01', '2014-12-31']]) {
      const { error } = await admin.from('document_archives').insert({ tenant_id: OTHER_ORG, kind: 'archive', period_start, period_end });
      expect(error?.message, `${period_start}..${period_end}`).toMatch(/document_archives_period_check/);
    }
  });
});
