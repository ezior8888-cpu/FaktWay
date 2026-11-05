import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestDatabaseUrl, getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00161 (pomiar FaktWay 1.0) na prawdziwej bazie i prawdziwym PostgREST:
 *
 *   - zgoda i źródło w `users`: członkowie firmy widzą nawzajem swoje wiersze
 *     (RLS), więc kolumny są zamknięte uprawnieniami, a klient rusza je tylko
 *     przez `sync_analytics_consent` (ostatni wybór wygrywa);
 *   - `tenants.first_invoice_accepted_at` pisze tylko serwer;
 *   - `admin_funnel_weekly` liczy lejek w SQL, tylko dla service_role, a podział
 *     na źródła pokazuje wyłącznie firmy, których właściciel ma zgodę.
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);
const hasDatabaseUrl = hasDatabase && Boolean(process.env.RLS_TEST_DATABASE_URL?.trim());
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey)
  : (null as unknown as SupabaseClient);

const PASS = 'RlsLejekPass2026Aa!';
const OWNER_EMAIL = 'rls-lejek-owner@ksef-saas.test';
const MEMBER_EMAIL = 'rls-lejek-member@ksef-saas.test';
const DENIED_EMAIL = 'rls-lejek-denied@ksef-saas.test';
const NONE_EMAIL = 'rls-lejek-none@ksef-saas.test';

// Losowe identyfikatory: płatności i subskrypcje mają własne strażniki usuwania.
const RUN = randomUUID().replaceAll('-', '').slice(0, 12);
const ORG = randomUUID();
const PAID = randomUUID();
const TRIAL_ONLY = randomUUID();
const NO_CONSENT = randomUUID();
const NOTHING = randomUUID();
const REVOKED_OWNER = randomUUID();
const ORGS = [ORG, PAID, TRIAL_ONLY, NO_CONSENT, NOTHING, REVOKED_OWNER];

const SOURCE = {
  channel: 'google_ads', utm_source: 'google', utm_medium: 'cpc',
  referrer_host: 'www.google.com', landing_path: '/pricing', at: '2026-06-01',
};

/** Poniedziałek sprzed ok. 20 tygodni, w południe: tej kohorty nie zaśmiecą inne testy. */
function cohortMonday(): Date {
  const date = new Date(Date.now() - 20 * 7 * 86400_000);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date;
}
const COHORT = cohortMonday();
const COHORT_DAY = COHORT.toISOString().slice(0, 10);
const COHORT_ISO = COHORT.toISOString();

let ownerId = '';
let memberId = '';
let deniedId = '';
let noneId = '';
let owner: SupabaseClient;
let member: SupabaseClient;

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

async function signedIn(email: string, org: string): Promise<SupabaseClient> {
  const client = anonClient(org);
  const { error } = await client.auth.signInWithPassword({ email, password: PASS });
  if (error) throw error;
  return client;
}

function nip(index: number): string {
  return `9${String(Date.now() % 10_000_000).padStart(7, '0')}${String(index).padStart(2, '0')}`;
}

async function subscription(tenantId: string, status: string, label: string, extra: Record<string, unknown>) {
  const stripeSubscription = `sub_lejek${RUN}${label}`;
  const { data: claim, error: claimError } = await admin
    .rpc('claim_stripe_subscription_sync', { p_subscription_id: stripeSubscription })
    .single<{ claimed: boolean; claim_token: string; fence: number }>();
  if (claimError || !claim?.claimed) throw new Error(`claim: ${claimError?.message ?? 'busy'}`);
  const { data, error } = await admin.rpc('apply_stripe_subscription_sync', {
    p_subscription_id: stripeSubscription,
    p_claim_token: claim.claim_token,
    p_fence: claim.fence,
    p_snapshot: {
      tenant_id: tenantId,
      stripe_subscription_id: stripeSubscription,
      stripe_customer_id: `cus_lejek${RUN}${label}`,
      stripe_price_id: 'price_rls',
      status,
      plan: 'monthly',
      current_period_start: null,
      current_period_end: null,
      trial_start: null,
      trial_end: null,
      cancel_at_period_end: false,
      canceled_at: null,
      ...extra,
    },
  });
  if (error || data !== true) throw new Error(`apply: ${error?.message ?? 'not written'}`);
}

async function payment(tenantId: string, label: string, amountCents: number) {
  const { error } = await admin.from('stripe_payments').insert({
    tenant_id: tenantId,
    stripe_invoice_id: `in_lejek${RUN}${label}`,
    stripe_payment_intent_id: `pi_lejek${RUN}${label}`,
    stripe_charge_id: `ch_lejek${RUN}${label}`,
    stripe_payment_refs_verified: true,
    status: 'succeeded',
    amount_cents: amountCents,
    currency: 'pln',
    paid_at: COHORT_ISO,
    last_webhook_payload: { id: `in_lejek${RUN}${label}`, status: 'paid', currency: 'pln', amount_paid: amountCents },
  });
  if (error) throw new Error(`payment ${label}: ${error.message}`);
}

async function resetConsent(id: string, values: Record<string, unknown> = {}) {
  const { error } = await admin.from('users').update({
    analytics_consent: null, analytics_consent_at: null, signup_source: null, ...values,
  }).eq('id', id);
  if (error) throw new Error(`reset: ${error.message}`);
}

async function consentRow(id: string) {
  const { data, error } = await admin.from('users')
    .select('analytics_consent, analytics_consent_at, signup_source').eq('id', id).single();
  if (error) throw new Error(`read: ${error.message}`);
  return data as { analytics_consent: string | null; analytics_consent_at: string | null; signup_source: unknown };
}

describe.skipIf(!hasDatabase)('00161: pomiar na prawdziwej bazie', () => {
  beforeAll(async () => {
    ownerId = await userId(OWNER_EMAIL);
    memberId = await userId(MEMBER_EMAIL);
    deniedId = await userId(DENIED_EMAIL);
    noneId = await userId(NONE_EMAIL);
    await admin.from('users').upsert(
      [ownerId, memberId, deniedId, noneId].map((id) => ({ id, name: 'Lejek' })),
      { onConflict: 'id' },
    );

    const tenantRows = ORGS.map((id, i) => ({
      id, nip: nip(i), name: `Firma lejka ${i}`, created_at: COHORT_ISO,
      stripe_customer_id: `cus_lejek${RUN}${i}`,
    }));
    const { error: tenantsError } = await admin.from('tenants').insert(tenantRows);
    if (tenantsError) throw new Error(`tenants: ${tenantsError.message}`);

    const { error: membershipsError } = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ownerId, role: 'owner', status: 'active', joined_at: '2026-01-01T00:00:00Z' },
      { organization_id: ORG, user_id: memberId, role: 'member', status: 'active', joined_at: '2026-01-02T00:00:00Z' },
      // Firma z dwoma właścicielami: liczy się najstarszy aktywny.
      { organization_id: PAID, user_id: ownerId, role: 'owner', status: 'active', joined_at: '2026-01-01T00:00:00Z' },
      { organization_id: PAID, user_id: deniedId, role: 'owner', status: 'active', joined_at: '2026-02-01T00:00:00Z' },
      { organization_id: TRIAL_ONLY, user_id: memberId, role: 'owner', status: 'active', joined_at: '2026-01-01T00:00:00Z' },
      { organization_id: NO_CONSENT, user_id: deniedId, role: 'owner', status: 'active', joined_at: '2026-01-01T00:00:00Z' },
      { organization_id: NOTHING, user_id: noneId, role: 'owner', status: 'active', joined_at: '2026-01-01T00:00:00Z' },
      // Odwołany właściciel ze zgodą nie użycza swojego źródła.
      { organization_id: REVOKED_OWNER, user_id: ownerId, role: 'owner', status: 'revoked', joined_at: '2026-01-01T00:00:00Z' },
      { organization_id: REVOKED_OWNER, user_id: noneId, role: 'owner', status: 'active', joined_at: '2026-03-01T00:00:00Z' },
    ]);
    if (membershipsError) throw new Error(`memberships: ${membershipsError.message}`);

    owner = await signedIn(OWNER_EMAIL, ORG);
    member = await signedIn(MEMBER_EMAIL, ORG);
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await admin.from('stripe_payments').delete().in('tenant_id', ORGS);
    await admin.from('memberships').delete().in('organization_id', ORGS);
    await admin.from('tenants').delete().in('id', ORGS);
    for (const id of [ownerId, memberId, deniedId, noneId]) await resetConsent(id);
  });

  describe('kolumny zgody i źródła w users', () => {
    it.each(['signup_source', 'analytics_consent', 'analytics_consent_at'])('klient nie czyta %s, nawet swojego', async (column) => {
      const { error } = await owner.from('users').select(column).eq('id', ownerId);
      expect(error?.code).toBe('42501');
    });

    it.each([
      ['signup_source', { channel: 'direct', at: '2026-01-01' }],
      ['analytics_consent', 'granted'],
      ['analytics_consent_at', '2026-01-01T00:00:00Z'],
    ])('klient nie zapisze %s wprost', async (column, value) => {
      const { error } = await owner.from('users').update({ [column]: value }).eq('id', ownerId);
      expect(error?.code).toBe('42501');
    });

    it('dotychczasowe odczyty i zapisy klienta działają bez zmian', async () => {
      const self = await owner.from('users').select('id, name, last_login, created_at, last_active_tenant_id').eq('id', ownerId).single();
      expect(self.error).toBeNull();
      const colleague = await owner.from('users').select('name').eq('id', memberId).single();
      expect(colleague.error).toBeNull();
      const embed = await owner.from('memberships').select('id, users!memberships_user_id_fkey(name)').eq('organization_id', ORG);
      expect(embed.error).toBeNull();
      expect(embed.data?.length).toBe(2);
      const write = await owner.from('users').update({ last_active_tenant_id: ORG }).eq('id', ownerId).select('id');
      expect(write.error).toBeNull();
      expect(write.data).toHaveLength(1);
    });

    it('CHECK: źródło tylko przy zgodzie, kanał z listy, ograniczony rozmiar, zgoda zawsze z datą', async () => {
      await resetConsent(noneId);
      const noConsent = await admin.from('users').update({ signup_source: SOURCE }).eq('id', noneId);
      expect(noConsent.error?.code).toBe('23514');
      const grant = { analytics_consent: 'granted', analytics_consent_at: new Date().toISOString() };
      for (const signup_source of [
        { ...SOURCE, channel: 'kanal-spoza-listy' },
        { utm_source: 'google', at: '2026-06-01' },
        ['lista'],
        { ...SOURCE, utm_term: 'x'.repeat(3000) },
      ]) {
        const { error } = await admin.from('users').update({ ...grant, signup_source }).eq('id', noneId);
        expect(error?.code, JSON.stringify(signup_source).slice(0, 40)).toBe('23514');
      }
      const noDate = await admin.from('users').update({ analytics_consent: 'granted' }).eq('id', noneId);
      expect(noDate.error?.code).toBe('23514');
      const badValue = await admin.from('users')
        .update({ analytics_consent: 'moze', analytics_consent_at: new Date().toISOString() }).eq('id', noneId);
      expect(badValue.error?.code).toBe('23514');
    });
  });

  describe('sync_analytics_consent: ostatni wybór wygrywa', () => {
    const T0 = '2026-09-01T10:00:00.000Z';
    const OLDER = '2026-08-01T10:00:00.000Z';
    const T1 = '2026-10-01T10:00:00.000Z';

    const sync = async (client: SupabaseClient, consent: string | null, chosenAt: string | null) => {
      const { data, error } = await client.rpc('sync_analytics_consent', { p_consent: consent, p_chosen_at: chosenAt });
      return {
        row: (data as Array<{ consent: string | null; consent_at: string | null; changed: boolean; withdrawn: boolean }> | null)?.[0],
        error,
      };
    };

    it('anonim nie woła funkcji', async () => {
      const { error } = await sync(anonClient(), 'granted', T0);
      expect(error).not.toBeNull();
    });

    it('pierwsza decyzja zapisuje wybór i chwilę; starsza zgoda przegrywa, nowsza wygrywa', async () => {
      await resetConsent(ownerId);
      const first = await sync(owner, 'granted', T0);
      expect(first.error).toBeNull();
      expect(first.row).toMatchObject({ consent: 'granted', changed: true });
      expect(new Date(first.row!.consent_at!).toISOString()).toBe(T0);

      const newer = await sync(owner, 'denied', T1);
      expect(newer.row).toMatchObject({ consent: 'denied', changed: true });
      // Odwołanie dostaje stempel serwera, nie datę z urządzenia.
      expect(new Date(newer.row!.consent_at!).getTime()).toBeGreaterThanOrEqual(new Date(T1).getTime());

      // Starsza zgoda nie cofa nowszego odwołania.
      const older = await sync(owner, 'granted', T0);
      expect(older.row).toMatchObject({ consent: 'denied', changed: false });
    });

    it('sam odczyt niczego nie zmienia, także gdy dostanie datę bez wyboru', async () => {
      await resetConsent(ownerId, { analytics_consent: 'granted', analytics_consent_at: T0 });
      const read = await sync(owner, null, null);
      expect(read.row).toMatchObject({ consent: 'granted', changed: false });
      const withDate = await sync(owner, null, T1);
      expect(withDate.row).toMatchObject({ consent: 'granted', changed: false });
      expect(new Date((await consentRow(ownerId)).analytics_consent_at!).toISOString()).toBe(T0);
    });

    it('brak decyzji na koncie: odczyt zwraca same puste wartości', async () => {
      await resetConsent(ownerId);
      const read = await sync(owner, null, null);
      expect(read.row).toEqual({ consent: null, consent_at: null, changed: false, withdrawn: false });
    });

    it('withdrawn: tylko odwołanie zgody, która była; pierwsza odmowa i powtórka nie są odwołaniem', async () => {
      await resetConsent(ownerId);
      const first = await sync(owner, 'denied', T0);
      expect(first.row).toMatchObject({ consent: 'denied', changed: true, withdrawn: false });

      await resetConsent(ownerId, { analytics_consent: 'granted', analytics_consent_at: T0, signup_source: SOURCE });
      const withdrawal = await sync(owner, 'denied', T1);
      expect(withdrawal.row).toMatchObject({ consent: 'denied', changed: true, withdrawn: true });
      const again = await sync(owner, 'denied', T1);
      expect(again.row).toMatchObject({ changed: false, withdrawn: false });

      // Odwołanie ma stempel serwera, więc ponowna zgoda musi być od niego późniejsza (data z przyszłości
      // jest obcinana do chwili serwera).
      const grant = await sync(owner, 'granted', new Date(Date.now() + 60_000).toISOString());
      expect(grant.row).toMatchObject({ consent: 'granted', changed: true, withdrawn: false });
    });

    it('odwołanie kasuje źródło wejścia od razu', async () => {
      await resetConsent(ownerId, { analytics_consent: 'granted', analytics_consent_at: T0, signup_source: SOURCE });
      await sync(owner, 'denied', T1);
      expect(await consentRow(ownerId)).toMatchObject({ analytics_consent: 'denied', signup_source: null });
    });

    it('odwołanie wygrywa z datą z urządzenia: zegar do tyłu go nie blokuje, a źródło znika', async () => {
      // Konto ma zgodę z chwili T1, a urządzenie z zegarem do tyłu podaje wcześniejsze T0.
      await resetConsent(ownerId, { analytics_consent: 'granted', analytics_consent_at: T1, signup_source: SOURCE });
      const behind = await sync(owner, 'denied', T0);
      expect(behind.row).toMatchObject({ consent: 'denied', changed: true });
      expect(new Date(behind.row!.consent_at!).getTime()).toBeGreaterThanOrEqual(new Date(T1).getTime());
      expect(await consentRow(ownerId)).toMatchObject({ analytics_consent: 'denied', signup_source: null });
    });

    it('odwołanie bez daty też wygrywa, a powtórzone niczego nie zmienia', async () => {
      await resetConsent(ownerId, { analytics_consent: 'granted', analytics_consent_at: T1, signup_source: SOURCE });
      const undated = await sync(owner, 'denied', null);
      expect(undated.row).toMatchObject({ consent: 'denied', changed: true });
      const stamp = (await consentRow(ownerId)).analytics_consent_at;
      const again = await sync(owner, 'denied', OLDER);
      expect(again.row).toMatchObject({ consent: 'denied', changed: false });
      expect((await consentRow(ownerId)).analytics_consent_at).toBe(stamp);
    });

    it('data z przyszłości (zły zegar urządzenia) nie blokuje późniejszych wyborów', async () => {
      await resetConsent(ownerId);
      const future = new Date(Date.now() + 365 * 86400_000).toISOString();
      const { row } = await sync(owner, 'granted', future);
      expect(new Date(row!.consent_at!).getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
      const later = await sync(owner, 'denied', new Date(Date.now() + 120_000).toISOString());
      expect(later.row?.consent).toBe('denied');
    });

    it('wybór bez daty (sprzed zmiany) działa tylko na koncie bez decyzji', async () => {
      await resetConsent(ownerId);
      const applied = await sync(owner, 'granted', null);
      expect(applied.row).toMatchObject({ consent: 'granted', changed: true });
      await resetConsent(ownerId, { analytics_consent: 'denied', analytics_consent_at: T0 });
      const ignored = await sync(owner, 'granted', null);
      expect(ignored.row).toMatchObject({ consent: 'denied', changed: false });
    });

    it('wartość spoza listy: odmowa', async () => {
      const { error } = await sync(owner, 'wszystko', T0);
      expect(error?.code).toBe('22023');
    });

    it('zmienia wyłącznie konto zalogowanego', async () => {
      await resetConsent(ownerId);
      await resetConsent(memberId);
      await sync(member, 'granted', T0);
      expect((await consentRow(ownerId)).analytics_consent).toBeNull();
      expect((await consentRow(memberId)).analytics_consent).toBe('granted');
      await resetConsent(memberId);
    });
  });

  describe('tenants.first_invoice_accepted_at', () => {
    const STAMP = '2026-10-01T10:00:00.000Z';

    it('właściciel firmy nie ustawi daty ani jej nie zmieni, a inne pola zapisze dalej', async () => {
      const blocked = await owner.from('tenants').update({ first_invoice_accepted_at: STAMP }).eq('id', ORG);
      expect(blocked.error?.code).toBe('42501');

      const set = await admin.from('tenants').update({ first_invoice_accepted_at: STAMP }).eq('id', ORG);
      expect(set.error).toBeNull();
      const changed = await owner.from('tenants').update({ first_invoice_accepted_at: null }).eq('id', ORG);
      expect(changed.error?.code).toBe('42501');

      const other = await owner.from('tenants').update({ name: 'Firma lejka po zmianie' }).eq('id', ORG).select('id');
      expect(other.error).toBeNull();
      expect(other.data).toHaveLength(1);
    });

    it('członek firmy czyta datę (GRANT SELECT jak w 00112)', async () => {
      const { data, error } = await member.from('tenants').select('first_invoice_accepted_at').eq('id', ORG).single();
      expect(error).toBeNull();
      expect(new Date(data!.first_invoice_accepted_at as string).toISOString()).toBe(STAMP);
    });

    it('warunkowy UPDATE rozstrzyga: drugi zapis nie dotyka wiersza', async () => {
      const second = await admin.from('tenants')
        .update({ first_invoice_accepted_at: '2027-01-01T00:00:00.000Z' })
        .eq('id', ORG)
        .is('first_invoice_accepted_at', null)
        .select('id');
      expect(second.error).toBeNull();
      expect(second.data).toEqual([]);
    });
  });

  describe('analytics_tenant_owner', () => {
    it('zwraca najstarszego aktywnego właściciela, pomija odwołanego', async () => {
      expect((await admin.rpc('analytics_tenant_owner', { p_tenant_id: PAID })).data).toBe(ownerId);
      expect((await admin.rpc('analytics_tenant_owner', { p_tenant_id: REVOKED_OWNER })).data).toBe(noneId);
      expect((await admin.rpc('analytics_tenant_owner', { p_tenant_id: randomUUID() })).data).toBeNull();
    });

    it('niedostępne dla klienta', async () => {
      expect((await owner.rpc('analytics_tenant_owner', { p_tenant_id: ORG })).error).not.toBeNull();
      expect((await anonClient().rpc('analytics_tenant_owner', { p_tenant_id: ORG })).error).not.toBeNull();
    });
  });

  describe('admin_funnel_weekly', () => {
    interface FunnelRow {
      week_start: string; source: string; new_tenants: number; ksef_connected: number;
      first_invoice: number; trial_started: number; paying: number; churned: number;
    }

    beforeAll(async () => {
      // ORG: KSeF, faktura, próba, płaci, działa. Źródło: google_ads, zgoda.
      await admin.from('tenants').update({
        ksef_verified_at: COHORT_ISO, ksef_verified_environment: 'test', first_invoice_accepted_at: COHORT_ISO,
      }).eq('id', ORG);
      await subscription(ORG, 'active', '0', { trial_start: COHORT_ISO, trial_end: COHORT_ISO });
      await payment(ORG, 'a', 2999);

      // PAID: płaci, potem rezygnacja. Właściciel ten sam co w ORG.
      await admin.from('tenants').update({ ksef_verified_at: COHORT_ISO, ksef_verified_environment: 'test' }).eq('id', PAID);
      await subscription(PAID, 'canceled', '1', { trial_start: COHORT_ISO, trial_end: COHORT_ISO, canceled_at: COHORT_ISO });
      await payment(PAID, 'b', 2999);

      // TRIAL_ONLY: próba bez płatności (tylko faktura 0 zł), odeszła. Źródło: tiktok, zgoda.
      await subscription(TRIAL_ONLY, 'canceled', '2', { trial_start: COHORT_ISO, trial_end: COHORT_ISO, canceled_at: COHORT_ISO });
      await payment(TRIAL_ONLY, 'c', 0);

      // NO_CONSENT: pełna droga bez zgody: w lejku tak, w podziale na źródła nie.
      await admin.from('tenants').update({
        ksef_verified_at: COHORT_ISO, ksef_verified_environment: 'test', first_invoice_accepted_at: COHORT_ISO,
      }).eq('id', NO_CONSENT);
      await subscription(NO_CONSENT, 'active', '3', {});
      await payment(NO_CONSENT, 'd', 2999);

      // NOTHING i REVOKED_OWNER: tylko nowe firmy, właściciel bez decyzji.
      const now = new Date().toISOString();
      await resetConsent(ownerId, { analytics_consent: 'granted', analytics_consent_at: now, signup_source: SOURCE });
      await resetConsent(memberId, {
        analytics_consent: 'granted', analytics_consent_at: now,
        signup_source: { channel: 'tiktok', utm_source: 'tiktok', landing_path: '/', at: '2026-06-01' },
      });
      // Odmowa ze źródłem jest niemożliwa (CHECK), więc odmowa to po prostu brak kanału.
      await resetConsent(deniedId, { analytics_consent: 'denied', analytics_consent_at: now });
      await resetConsent(noneId);
    });

    async function funnel(weeks = 30): Promise<FunnelRow[]> {
      const { data, error } = await admin.rpc('admin_funnel_weekly', { p_weeks: weeks });
      if (error) throw new Error(error.message);
      return data as FunnelRow[];
    }

    it('anonim i zalogowany klient nie mają dostępu', async () => {
      expect((await owner.rpc('admin_funnel_weekly', { p_weeks: 4 })).error?.code).toBe('42501');
      expect((await anonClient().rpc('admin_funnel_weekly', { p_weeks: 4 })).error).not.toBeNull();
    });

    it('wynik tygodnia na zasianych danych: każdy krok i odejścia', async () => {
      const rows = await funnel();
      expect(rows.find((r) => r.week_start === COHORT_DAY && r.source === 'all')).toEqual({
        week_start: COHORT_DAY,
        source: 'all',
        new_tenants: 6,
        ksef_connected: 3,
        first_invoice: 2,
        trial_started: 3,
        paying: 3,
        churned: 2,
      });
    });

    it('środowisko KSeF: firma zweryfikowana w innym środowisku nie liczy się jako podłączona', async () => {
      const connected = async (environment?: string) => {
        const { data, error } = await admin.rpc('admin_funnel_weekly', {
          p_weeks: 30,
          ...(environment ? { p_environment: environment } : {}),
        });
        if (error) throw new Error(error.message);
        return (data as FunnelRow[]).find((r) => r.week_start === COHORT_DAY && r.source === 'all')!.ksef_connected;
      };
      expect(await connected()).toBe(3);
      expect(await connected('test')).toBe(3);
      expect(await connected('production')).toBe(0);
    });

    it('podział na źródła tylko z firm, których właściciel ma zgodę', async () => {
      const rows = (await funnel()).filter((r) => r.week_start === COHORT_DAY && r.source !== 'all');
      expect(rows).toEqual([
        { week_start: COHORT_DAY, source: 'google_ads', new_tenants: 2, ksef_connected: 2, first_invoice: 1, trial_started: 2, paying: 2, churned: 1 },
        { week_start: COHORT_DAY, source: 'tiktok', new_tenants: 1, ksef_connected: 0, first_invoice: 0, trial_started: 1, paying: 0, churned: 1 },
      ]);
    });

    it('odwołanie zgody znika z podziału od razu, ogólny lejek bez zmian', async () => {
      await member.rpc('sync_analytics_consent', { p_consent: 'denied', p_chosen_at: new Date(Date.now() + 1000).toISOString() });
      const rows = (await funnel()).filter((r) => r.week_start === COHORT_DAY);
      expect(rows.map((r) => r.source).sort()).toEqual(['all', 'google_ads']);
      expect(rows.find((r) => r.source === 'all')?.new_tenants).toBe(6);
    });

    it('bez danych osobowych: same liczby, data i kanał', async () => {
      const rows = await funnel();
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual([
          'churned', 'first_invoice', 'ksef_connected', 'new_tenants', 'paying', 'source', 'trial_started', 'week_start',
        ]);
      }
      expect(JSON.stringify(rows)).not.toMatch(/rls-lejek|Firma lejka|@ksef-saas/);
    });

    it('każdy tydzień z zakresu ma wiersz, także bez nowych firm, a górny limit mieści się w 1000 wierszy', async () => {
      const all = (await funnel(4)).filter((r) => r.source === 'all');
      expect(all).toHaveLength(4);
      expect(new Set(all.map((r) => r.week_start)).size).toBe(4);

      const clamped = await funnel(100_000);
      expect(clamped.filter((r) => r.source === 'all')).toHaveLength(52);
      expect(clamped.length).toBeLessThanOrEqual(52 * 9);
      expect((await funnel(0)).filter((r) => r.source === 'all')).toHaveLength(1);
      expect(clamped[0]!.week_start >= clamped.at(-1)!.week_start).toBe(true);
    });
  });
});

/**
 * Uzupełnienie dat z migracji, uruchomione jeszcze raz na świeżych danych.
 * Instrukcja jest idempotentna, więc na bazie z wgraną migracją nic poza
 * tymi firmami się nie zmieni. Wymaga `RLS_TEST_DATABASE_URL` i `psql`.
 */
describe.skipIf(!hasDatabaseUrl)('00161: uzupełnienie first_invoice_accepted_at', () => {
  const WITH_INVOICES = randomUUID();
  const ONLY_IMPORTED = randomUUID();
  const ALREADY_SET = randomUUID();
  const ORG_LIST = [WITH_INVOICES, ONLY_IMPORTED, ALREADY_SET];
  const EARLY_IMPORT = '2026-01-01T10:00:00.000Z';
  const FIRST_APP = '2026-03-01T10:00:00.000Z';
  const LATER_APP = '2026-04-01T10:00:00.000Z';
  let counter = 0;

  function backfillStatement(): string {
    const sql = readFileSync('supabase/migrations/00161_analytics_consent_funnel.sql', 'utf8')
      .replace(/--[^\n]*/g, '');
    const statement = sql.match(/UPDATE public\.tenants[\s\S]*?;/)?.[0];
    if (!statement) throw new Error('Brak instrukcji uzupełnienia w 00161');
    return statement;
  }

  async function invoice(tenantId: string, fields: Record<string, unknown>) {
    counter += 1;
    const { error } = await admin.from('invoices').insert({
      tenant_id: tenantId,
      direction: 'outgoing',
      origin: 'app',
      internal_number: `LEJEK/${RUN}/${counter}`,
      ksef_number: `9480000014-20260915-${RUN}${String(counter).padStart(4, '0')}`,
      ksef_status: 'accepted',
      ksef_environment: 'test',
      xml_storage_path: 'x.xml',
      invoice_type: 'VAT',
      issue_date: '2026-01-01',
      seller_nip: '9480000014',
      currency: 'PLN',
      gross_total: 123,
      net_total: 100,
      vat_total: 23,
      fa3_data: {},
      ...fields,
    });
    if (error) throw new Error(`invoice: ${error.message}`);
  }

  beforeAll(async () => {
    const { error } = await admin.from('tenants').insert(ORG_LIST.map((id, i) => ({
      id, nip: nip(50 + i), name: `Firma uzupełnienia ${i}`,
    })));
    if (error) throw new Error(`tenants: ${error.message}`);
    await invoice(WITH_INVOICES, { ksef_accepted_at: LATER_APP });
    await invoice(WITH_INVOICES, { ksef_accepted_at: FIRST_APP });
    await invoice(WITH_INVOICES, { ksef_accepted_at: EARLY_IMPORT, origin: 'ksef_import' });
    await invoice(WITH_INVOICES, { ksef_accepted_at: EARLY_IMPORT, origin: 'file_import' });
    await invoice(WITH_INVOICES, { ksef_status: 'draft', ksef_number: null, ksef_environment: null, xml_storage_path: null });
    await invoice(ONLY_IMPORTED, { ksef_accepted_at: EARLY_IMPORT, origin: 'ksef_import' });
    await invoice(ALREADY_SET, { ksef_accepted_at: FIRST_APP });
    const stamp = await admin.from('tenants').update({ first_invoice_accepted_at: LATER_APP }).eq('id', ALREADY_SET);
    if (stamp.error) throw new Error(stamp.error.message);

    execFileSync('psql', [getRlsTestDatabaseUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '-c', backfillStatement()], { stdio: 'pipe' });
  });

  afterAll(async () => {
    await admin.from('invoices').delete().in('tenant_id', ORG_LIST);
    await admin.from('tenants').delete().in('id', ORG_LIST);
  });

  async function stamp(id: string): Promise<string | null> {
    const { data, error } = await admin.from('tenants').select('first_invoice_accepted_at').eq('id', id).single();
    if (error) throw new Error(error.message);
    return data.first_invoice_accepted_at ? new Date(data.first_invoice_accepted_at as string).toISOString() : null;
  }

  it('bierze najwcześniejszą przyjętą fakturę wystawioną w FaktWay, bez historii z KSeF i importu z pliku', async () => {
    expect(await stamp(WITH_INVOICES)).toBe(FIRST_APP);
  });

  it('sama sprzedaż pobrana z KSeF nie robi pierwszej faktury', async () => {
    expect(await stamp(ONLY_IMPORTED)).toBeNull();
  });

  it('nie nadpisuje wartości już ustawionej', async () => {
    expect(await stamp(ALREADY_SET)).toBe(LATER_APP);
  });
});
