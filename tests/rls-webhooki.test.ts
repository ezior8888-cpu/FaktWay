import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00187 na prawdziwym PostgREST: webhooki publicznego API (krok 7.1 planu
 * kompletnej aplikacji, część 3).
 *
 * - `webhook_endpoints`: dodają, usuwają i ponownie włączają tylko właściciel
 *   i administrator swojej firmy; szyfrogram sekretu nie wraca do klienta;
 *   autor, daty i liczniki z bazy; najwyżej 5 na firmę; każda zmiana
 *   w `audit_logs` (wyzwalacz).
 * - `webhook_deliveries` (dziennik dostaw): czytają właściciel i administrator
 *   (bez treści zdarzenia), piszą tylko funkcje workera (`service_role`).
 * - Jedna dostawa na (webhook, zdarzenie): ponowione zdarzenie nie wyśle się
 *   drugi raz, a po sukcesie dostawy nie da się przejąć ponownie.
 * - Ponowienia 1 min, 5 min, 30 min, 2 h, 12 h (6 prób), potem `failed`.
 * - Po 20 nieudanych dostawach z rzędu webhook wyłącza się sam: oczekujące
 *   dostawy anulowane, wpis `webhook.auto_disabled`, informacja dla Ustawień.
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

const ORG = '00187187-0000-4000-8000-000000000001';
const OTHER_ORG = '00187187-0000-4000-8000-000000000002';
const OWNER_EMAIL = 'rls-webhook-owner@ksef-saas.test';
const ADMIN_EMAIL = 'rls-webhook-admin@ksef-saas.test';
const MEMBER_EMAIL = 'rls-webhook-member@ksef-saas.test';
const OTHER_EMAIL = 'rls-webhook-other@ksef-saas.test';
const PASS = 'RlsWebhookiPass2026Aa!';

// Szyfrogram w formacie aplikacji (base64), bez entropii: baza sprawdza tylko kształt.
const CIPHERTEXT = 'A'.repeat(140);

let ownerId = '';
let adminId = '';

function sessionClient(activeOrg: string) {
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

const sessions = new Map<string, Promise<SupabaseClient>>();
function signedIn(email: string, org: string): Promise<SupabaseClient> {
  const cacheKey = `${email}|${org}`;
  let session = sessions.get(cacheKey);
  if (!session) {
    session = (async () => {
      const client = sessionClient(org);
      const { error } = await client.auth.signInWithPassword({ email, password: PASS });
      if (error) throw error;
      return client;
    })();
    sessions.set(cacheKey, session);
  }
  return session;
}

const endpoint = (tenantId: string, overrides: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  tenant_id: tenantId,
  url: 'https://hooks.example.com/faktway',
  events: ['invoice.ksef_accepted', 'payment.recorded'],
  secret_ciphertext: CIPHERTEXT,
  ...overrides,
});

/** Chwila po utworzeniu webhooków: zdarzenie „później” niż webhook (reguła created_at). */
const soon = () => new Date(Date.now() + 5_000).toISOString();

async function createDeliveries(tenantId: string, eventType: string, occurredAt = soon(), eventId: string = crypto.randomUUID()) {
  const { data, error } = await admin.rpc('webhook_create_deliveries', {
    p_tenant_id: tenantId,
    p_event_type: eventType,
    p_event_id: eventId,
    p_occurred_at: occurredAt,
    p_data: { invoice: { id: '00187187-1000-4000-8000-000000000001' } },
  });
  if (error) throw new Error(`webhook_create_deliveries: ${error.message}`);
  return { ids: (data ?? []) as string[], eventId };
}

async function claim(ids: string[]) {
  const { data, error } = await admin.rpc('webhook_claim_deliveries', { p_delivery_ids: ids, p_limit: ids.length || 1 });
  if (error) throw new Error(`webhook_claim_deliveries: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

async function record(id: string, attempt: number, succeeded: boolean, statusCode: number | null, error: string | null, counts = true) {
  const { data, error: rpcError } = await admin.rpc('webhook_record_attempt', {
    p_delivery_id: id,
    p_attempt: attempt,
    p_succeeded: succeeded,
    p_status_code: statusCode,
    p_error: error,
    p_duration_ms: 42,
    p_counts_toward_disable: counts,
  });
  if (rpcError) throw new Error(`webhook_record_attempt: ${rpcError.message}`);
  return data as Record<string, unknown>;
}

async function delivery(id: string) {
  const { data, error } = await admin.from('webhook_deliveries').select('*').eq('id', id).single();
  if (error) throw new Error(error.message);
  return data as Record<string, unknown>;
}

async function hook(id: string) {
  const { data, error } = await admin.from('webhook_endpoints').select('*').eq('id', id).single();
  if (error) throw new Error(error.message);
  return data as Record<string, unknown>;
}

/** Następna próba „już teraz” (zamiast czekać minutę albo 12 godzin). */
async function makeDue(id: string) {
  const { error } = await admin.from('webhook_deliveries').update({ next_attempt_at: new Date(Date.now() - 1_000).toISOString() }).eq('id', id);
  if (error) throw new Error(error.message);
}

async function sprzataj() {
  for (const org of [ORG, OTHER_ORG]) {
    await admin.from('webhook_endpoints').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
  }
}

describe.skipIf(!hasDatabase)('00187: webhooki i dziennik dostaw na prawdziwym PostgREST', () => {
  let ownerHook = '';
  let adminHook = '';

  beforeAll(async () => {
    ownerId = await userId(OWNER_EMAIL);
    adminId = await userId(ADMIN_EMAIL);
    const memberId = await userId(MEMBER_EMAIL);
    const otherId = await userId(OTHER_EMAIL);
    await sprzataj();
    const { error: tErr } = await admin.from('tenants').upsert([
      { id: ORG, nip: '1234567890', name: 'Firma webhooki 00187' },
      { id: OTHER_ORG, nip: '1234567890', name: 'Inna firma webhooki 00187' },
    ], { onConflict: 'id' });
    if (tErr) throw tErr;
    await admin.from('users').upsert(
      [{ id: ownerId, name: 'Owner' }, { id: adminId, name: 'Admin' }, { id: memberId, name: 'Member' }, { id: otherId, name: 'Other' }],
      { onConflict: 'id' },
    );
    const { error: mErr } = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ownerId, role: 'owner', status: 'active' },
      { organization_id: ORG, user_id: adminId, role: 'admin', status: 'active' },
      { organization_id: ORG, user_id: memberId, role: 'member', status: 'active' },
      { organization_id: OTHER_ORG, user_id: otherId, role: 'owner', status: 'active' },
    ]);
    if (mErr) throw mErr;
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    // Wpisy audytu zostają (append-only, 00052); firmy z nimi też, `upsert` je przyjmie.
    await sprzataj();
  });

  it('właściciel i administrator dodają webhook; autor, daty i liczniki z bazy; audyt webhook.created bez pełnego adresu', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const row = endpoint(ORG, { url: 'https://hooks.example.com/faktway?token=abc' });
    const created = await owner.from('webhook_endpoints').insert(row).select('id').single();
    expect(created.error).toBeNull();
    ownerHook = created.data!.id as string;
    expect(ownerHook).toBe(row.id);

    const adminClient = await signedIn(ADMIN_EMAIL, ORG);
    const byAdmin = await adminClient.from('webhook_endpoints').insert(endpoint(ORG, { events: ['expense.ksef_received'] })).select('id').single();
    expect(byAdmin.error).toBeNull();
    adminHook = byAdmin.data!.id as string;

    expect(await hook(ownerHook)).toMatchObject({
      created_by: ownerId, disabled_at: null, disabled_reason: null, consecutive_failures: 0, last_success_at: null, last_failure_at: null,
    });

    const audit = await admin.from('audit_logs').select('user_id, metadata').eq('action', 'webhook.created').eq('entity_id', ownerHook);
    expect(audit.data).toEqual([{ user_id: ownerId, metadata: { host: 'hooks.example.com', events: ['invoice.ksef_accepted', 'payment.recorded'] } }]);
    expect(JSON.stringify(audit.data)).not.toContain('token=abc');
  });

  it('członek i obca firma nie dodają; liczników, dat i stanu nie podstawi klient; CHECK-i; najwyżej 5 na firmę', async () => {
    const member = await signedIn(MEMBER_EMAIL, ORG);
    expect((await member.from('webhook_endpoints').insert(endpoint(ORG))).error?.message).toMatch(/row-level security/);
    const otherAsOrg = await signedIn(OTHER_EMAIL, ORG);
    expect((await otherAsOrg.from('webhook_endpoints').insert(endpoint(ORG))).error?.message).toMatch(/row-level security/);

    const owner = await signedIn(OWNER_EMAIL, ORG);
    for (const forged of [{ created_by: adminId }, { disabled_at: '2026-01-01T00:00:00Z' }, { consecutive_failures: 3 }, { created_at: '2020-01-01T00:00:00Z' }, { last_success_at: '2026-01-01T00:00:00Z' }]) {
      expect((await owner.from('webhook_endpoints').insert(endpoint(ORG, forged))).error?.message, JSON.stringify(forged)).toMatch(/permission denied/);
    }
    for (const [bad, constraint] of [
      [{ url: 'http://hooks.example.com/x' }, 'webhook_endpoints_url_check'],
      [{ url: 'https://hooks.example.com:8443/x' }, 'webhook_endpoints_url_check'],
      [{ url: 'https://ktos:x@hooks.example.com/x' }, 'webhook_endpoints_url_check'],
      [{ url: 'https://10.0.0.1/x' }, 'webhook_endpoints_url_check'],
      [{ events: [] }, 'webhook_endpoints_events_check'],
      [{ events: ['invoice.deleted'] }, 'webhook_endpoints_events_check'],
      [{ secret_ciphertext: 'jawny sekret' }, 'webhook_endpoints_secret_check'],
    ] as const) {
      expect((await owner.from('webhook_endpoints').insert(endpoint(ORG, bad))).error?.message, JSON.stringify(bad)).toMatch(new RegExp(constraint));
    }

    const other = await signedIn(OTHER_EMAIL, OTHER_ORG);
    for (let i = 0; i < 5; i++) {
      expect((await other.from('webhook_endpoints').insert(endpoint(OTHER_ORG))).error, `webhook ${i + 1}`).toBeNull();
    }
    expect((await other.from('webhook_endpoints').insert(endpoint(OTHER_ORG))).error?.message).toMatch(/webhook_limit/);
  });

  it('listę czytają właściciel i administrator, bez szyfrogramu; członek i obca firma nic', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const listed = await owner.from('webhook_endpoints').select('id, url, events, disabled_at, consecutive_failures').eq('tenant_id', ORG);
    expect((listed.data ?? []).map((r) => r.id).sort()).toEqual([ownerHook, adminHook].sort());
    expect((await owner.from('webhook_endpoints').select('secret_ciphertext').eq('tenant_id', ORG)).error?.message).toMatch(/permission denied/);
    const adminClient = await signedIn(ADMIN_EMAIL, ORG);
    expect(((await adminClient.from('webhook_endpoints').select('id').eq('tenant_id', ORG)).data ?? []).length).toBe(2);
    const member = await signedIn(MEMBER_EMAIL, ORG);
    expect((await member.from('webhook_endpoints').select('id')).data ?? []).toEqual([]);
    const otherAsOrg = await signedIn(OTHER_EMAIL, ORG);
    expect((await otherAsOrg.from('webhook_endpoints').select('id').eq('tenant_id', ORG)).data ?? []).toEqual([]);
  });

  it('funkcji workera nie woła klient ani anon', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const anon = sessionClient(ORG);
    for (const client of [owner, anon]) {
      expect((await client.rpc('webhook_claim_deliveries', { p_delivery_ids: null, p_limit: 1 })).error?.message).toMatch(/permission denied/);
      expect((await client.rpc('webhook_create_deliveries', {
        p_tenant_id: ORG, p_event_type: 'payment.recorded', p_event_id: crypto.randomUUID(), p_occurred_at: soon(), p_data: {},
      })).error?.message).toMatch(/permission denied/);
      expect((await client.rpc('webhook_record_attempt', {
        p_delivery_id: crypto.randomUUID(), p_attempt: 1, p_succeeded: true, p_status_code: 200, p_error: null, p_duration_ms: 1, p_counts_toward_disable: true,
      })).error?.message).toMatch(/permission denied/);
    }
    expect((await owner.from('webhook_deliveries').insert({
      tenant_id: ORG, webhook_id: ownerHook, event_id: crypto.randomUUID(), event_type: 'payment.recorded', occurred_at: soon(), data: {},
    })).error?.message).toMatch(/permission denied/);
  });

  it('dostawy tylko dla webhooków firmy z tym zdarzeniem, włączonych i dodanych przed zdarzeniem; ten sam event id drugi raz nic nie tworzy', async () => {
    const first = await createDeliveries(ORG, 'invoice.ksef_accepted');
    expect(first.ids).toHaveLength(1);
    expect(await delivery(first.ids[0]!)).toMatchObject({ webhook_id: ownerHook, tenant_id: ORG, status: 'pending', attempts: 0, event_id: first.eventId });

    const again = await createDeliveries(ORG, 'invoice.ksef_accepted', soon(), first.eventId);
    expect(again.ids).toEqual([]);

    // Webhook administratora słucha tylko kosztów; obca firma nie dostaje nic.
    expect((await createDeliveries(ORG, 'expense.ksef_received')).ids).toHaveLength(1);
    expect((await createDeliveries(OTHER_ORG, 'expense.ksef_received')).ids).toEqual([]);
    // Zdarzenie sprzed dodania webhooka (np. ponowna emisja ze starego kosztu) nie trafia do nowego adresu.
    expect((await createDeliveries(ORG, 'invoice.ksef_accepted', '2020-01-01T00:00:00Z')).ids).toEqual([]);
  });

  it('sukces: przejęcie z adresem i szyfrogramem, zapis kodu; drugi raz ani przejęcia, ani nowej dostawy', async () => {
    const { ids: [id], eventId } = await createDeliveries(ORG, 'payment.recorded');
    await admin.from('webhook_endpoints').update({ consecutive_failures: 7 }).eq('id', ownerHook);

    const claimed = await claim([id!]);
    expect(claimed).toEqual([expect.objectContaining({
      delivery_id: id, webhook_id: ownerHook, tenant_id: ORG, url: 'https://hooks.example.com/faktway?token=abc',
      secret_ciphertext: CIPHERTEXT, event_id: eventId, event_type: 'payment.recorded', attempt: 1,
    })]);
    // Dzierżawa: równoległy przebieg nie weźmie tej samej dostawy.
    expect(await claim([id!])).toEqual([]);

    expect(await record(id!, 1, true, 200, null)).toMatchObject({ applied: true, status: 'succeeded' });
    expect(await delivery(id!)).toMatchObject({ status: 'succeeded', attempts: 1, last_status_code: 200, last_error: null, locked_until: null });
    expect((await delivery(id!)).delivered_at).not.toBeNull();
    expect(await hook(ownerHook)).toMatchObject({ consecutive_failures: 0 });
    expect((await hook(ownerHook)).last_success_at).not.toBeNull();

    await makeDue(id!);
    expect(await claim([id!])).toEqual([]);
    expect((await createDeliveries(ORG, 'payment.recorded', soon(), eventId)).ids).toEqual([]);
    // Spóźniony drugi zapis wyniku nie zmienia dostawy po sukcesie.
    expect(await record(id!, 1, false, 500, 'http_status')).toMatchObject({ applied: false });
  });

  it('ponowienia 1 min, 5 min, 30 min, 2 h, 12 h, potem „nieudana”; dziennik: kod, błąd, liczba prób', async () => {
    const { ids: [id] } = await createDeliveries(ORG, 'payment.recorded');
    const expected = [60, 300, 1_800, 7_200, 43_200];

    for (let attempt = 1; attempt <= 5; attempt++) {
      const [claimed] = await claim([id!]);
      expect(claimed?.attempt, `próba ${attempt}`).toBe(attempt);
      // Zły numer próby (dzierżawa przejęta przez inny przebieg) nie zapisuje nic.
      expect(await record(id!, attempt + 1, false, 500, 'http_status')).toMatchObject({ applied: false });
      expect(await record(id!, attempt, false, 500 + attempt, 'http_status')).toMatchObject({ applied: true, status: 'pending' });
      const row = await delivery(id!);
      expect(row).toMatchObject({ status: 'pending', attempts: attempt, last_status_code: 500 + attempt, last_error: 'http_status', locked_until: null });
      const waitSeconds = (Date.parse(String(row.next_attempt_at)) - Date.now()) / 1000;
      expect(waitSeconds, `odstęp po próbie ${attempt}`).toBeGreaterThan(expected[attempt - 1]! - 30);
      expect(waitSeconds, `odstęp po próbie ${attempt}`).toBeLessThan(expected[attempt - 1]! + 30);
      // Przed terminem dostawy nie da się przejąć.
      expect(await claim([id!])).toEqual([]);
      await makeDue(id!);
    }

    const [last] = await claim([id!]);
    expect(last?.attempt).toBe(6);
    expect(await record(id!, 6, false, null, 'timeout')).toMatchObject({ applied: true, status: 'failed' });
    const row = await delivery(id!);
    expect(row).toMatchObject({ status: 'failed', attempts: 6, last_status_code: null, last_error: 'timeout' });
    expect(row.finished_at).not.toBeNull();
    expect(await hook(ownerHook)).toMatchObject({ consecutive_failures: 1, disabled_at: null });
    await makeDue(id!);
    expect(await claim([id!])).toEqual([]);

    // Właściciel widzi dziennik (bez treści zdarzenia); członek nie.
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const log = await owner.from('webhook_deliveries').select('id, status, attempts, last_status_code, last_error, last_attempt_at, event_type').eq('id', id!);
    expect(log.data).toEqual([expect.objectContaining({ status: 'failed', attempts: 6, last_error: 'timeout', event_type: 'payment.recorded' })]);
    expect((await owner.from('webhook_deliveries').select('data').eq('id', id!)).error?.message).toMatch(/permission denied/);
    const member = await signedIn(MEMBER_EMAIL, ORG);
    expect((await member.from('webhook_deliveries').select('id').eq('id', id!)).data ?? []).toEqual([]);
  });

  it('porażka po stronie FaktWay (bez klucza do podpisu) nie liczy się do wyłączenia', async () => {
    const before = Number((await hook(ownerHook)).consecutive_failures);
    const { ids: [id] } = await createDeliveries(ORG, 'payment.recorded');
    await admin.from('webhook_deliveries').update({ attempts: 5 }).eq('id', id!);
    await claim([id!]);
    expect(await record(id!, 6, false, null, 'signing_unavailable', false)).toMatchObject({ applied: true, status: 'failed' });
    expect(Number((await hook(ownerHook)).consecutive_failures)).toBe(before);
  });

  it('20 nieudanych dostaw z rzędu: webhook wyłączony, oczekujące anulowane, audyt, brak nowych dostaw', async () => {
    await admin.from('webhook_endpoints').update({ consecutive_failures: 19 }).eq('id', ownerHook);
    const { ids: [failing] } = await createDeliveries(ORG, 'payment.recorded');
    const { ids: [waiting] } = await createDeliveries(ORG, 'invoice.ksef_accepted');
    await admin.from('webhook_deliveries').update({ attempts: 5 }).eq('id', failing!);
    await claim([failing!]);

    expect(await record(failing!, 6, false, 404, 'http_status')).toMatchObject({ applied: true, status: 'failed', webhook_disabled: true });
    const disabled = await hook(ownerHook);
    expect(disabled).toMatchObject({ consecutive_failures: 20, disabled_reason: 'consecutive_failures' });
    expect(disabled.disabled_at).not.toBeNull();
    expect(await delivery(waiting!)).toMatchObject({ status: 'cancelled', last_error: 'webhook_disabled' });

    const audit = await admin.from('audit_logs').select('user_id, metadata').eq('action', 'webhook.auto_disabled').eq('entity_id', ownerHook);
    expect(audit.data).toEqual([{ user_id: null, metadata: expect.objectContaining({ host: 'hooks.example.com', reason: 'consecutive_failures', consecutive_failures: 20 }) }]);

    await makeDue(waiting!);
    expect(await claim([waiting!])).toEqual([]);
    expect((await createDeliveries(ORG, 'payment.recorded')).ids).toEqual([]);

    // Informacja w Ustawieniach: właściciel widzi stan i powód.
    const owner = await signedIn(OWNER_EMAIL, ORG);
    const seen = await owner.from('webhook_endpoints').select('disabled_at, disabled_reason, consecutive_failures').eq('id', ownerHook).single();
    expect(seen.data).toMatchObject({ disabled_reason: 'consecutive_failures', consecutive_failures: 20 });
  });

  it('ponowne włączenie: tylko właściciel albo administrator, licznik od zera, audyt; innych zmian klient nie zrobi', async () => {
    const member = await signedIn(MEMBER_EMAIL, ORG);
    expect((await member.from('webhook_endpoints').update({ disabled_at: null }).eq('id', ownerHook).select('id')).data ?? []).toEqual([]);

    const owner = await signedIn(OWNER_EMAIL, ORG);
    expect((await owner.from('webhook_endpoints').update({ url: 'https://inny.example.com/x' }).eq('id', ownerHook)).error?.message).toMatch(/permission denied/);
    expect((await owner.from('webhook_endpoints').update({ consecutive_failures: 0 }).eq('id', ownerHook)).error?.message).toMatch(/permission denied/);

    const enabled = await owner.from('webhook_endpoints').update({ disabled_at: null }).eq('id', ownerHook).not('disabled_at', 'is', null).select('id');
    expect(enabled.error).toBeNull();
    expect(enabled.data).toEqual([{ id: ownerHook }]);
    expect(await hook(ownerHook)).toMatchObject({ disabled_at: null, disabled_reason: null, consecutive_failures: 0 });
    const audit = await admin.from('audit_logs').select('user_id').eq('action', 'webhook.enabled').eq('entity_id', ownerHook);
    expect(audit.data).toEqual([{ user_id: ownerId }]);

    // Włączonego nie da się „wyłączyć” datą z przeglądarki.
    const disable = await owner.from('webhook_endpoints').update({ disabled_at: '2026-01-01T00:00:00Z' }).eq('id', ownerHook).select('id');
    expect(disable.data ?? []).toEqual([]);
    expect((await createDeliveries(ORG, 'payment.recorded')).ids).toHaveLength(1);
  });

  it('usunięcie: właściciel albo administrator, dostawy znikają razem z webhookiem, audyt', async () => {
    const member = await signedIn(MEMBER_EMAIL, ORG);
    expect((await member.from('webhook_endpoints').delete().eq('id', adminHook).select('id')).data ?? []).toEqual([]);

    const { ids: [id] } = await createDeliveries(ORG, 'expense.ksef_received');
    const adminClient = await signedIn(ADMIN_EMAIL, ORG);
    const removed = await adminClient.from('webhook_endpoints').delete().eq('id', adminHook).select('id');
    expect(removed.error).toBeNull();
    expect(removed.data).toEqual([{ id: adminHook }]);
    expect((await admin.from('webhook_deliveries').select('id').eq('id', id!)).data).toEqual([]);
    const audit = await admin.from('audit_logs').select('user_id, metadata').eq('action', 'webhook.deleted').eq('entity_id', adminHook);
    expect(audit.data).toEqual([{ user_id: adminId, metadata: expect.objectContaining({ host: 'hooks.example.com' }) }]);
  });
});
