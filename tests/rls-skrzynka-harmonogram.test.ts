import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { INBOX_ACTIVE_SUBSCRIPTION_STATUSES } from '@/lib/ksef/inbox-schedule';

import { getRlsTestDatabaseUrl, getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00160 (harmonogram Skrzynki KSeF) na prawdziwym Postgresie, PostgREST i pg-boss,
 * w jobie CI „RLS isolation”:
 *  - uprawnienia: RPC tylko dla `service_role`, widok i tabela zamknięte; członek
 *    firmy czyta tylko swój ostatni sukces;
 *  - wybór należnych: tylko żywe firmy, od najdawniej należnych, z limitem,
 *    bez firm z dzierżawą; po wygaśnięciu dzierżawy firma wraca;
 *  - rozsyłka: wybór i zapis zleceń w jednej transakcji, druga rozsyłka przy
 *    czekającym zadaniu nic nie dodaje, a błąd zapisu cofa dzierżawę;
 *  - koniec przebiegu: licznik błędów, przyspieszenie w trakcie przebiegu wygrywa;
 *  - „Sprawdź teraz”: warunek 5 min trzyma także bez limitu w aplikacji;
 *  - nowy certyfikat: wiersz i termin „teraz”, błędy na zero;
 *  - alarm: firma zimna po 5 h bez alarmu, firma gorąca po 2 h z alarmem.
 *
 * Kolejka idzie w osobnym schemacie pg-boss: lokalna baza bywa wspólna, a zadanie
 * skrzynki w `pgboss` mógłby wziąć cudzy worker.
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim() &&
    process.env.RLS_TEST_DATABASE_URL?.trim(),
);
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const databaseUrl = hasDatabase ? getRlsTestDatabaseUrl() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey)
  : (null as unknown as SupabaseClient);

const ORG_A = '00160160-0000-4000-8000-00000000000a';
const ORG_B = '00160160-0000-4000-8000-00000000000b';
const ORG_C = '00160160-0000-4000-8000-00000000000c';
const ORG_D = '00160160-0000-4000-8000-00000000000d';
const ORG_DELETED = '00160160-0000-4000-8000-0000000000e1';
const ORG_INACTIVE = '00160160-0000-4000-8000-0000000000e2';
const ORG_EXPIRED = '00160160-0000-4000-8000-0000000000e3';
const ORG_NO_CERT = '00160160-0000-4000-8000-0000000000e4';
const ORG_UNVERIFIED = '00160160-0000-4000-8000-0000000000e5';
const ORG_OTHER_ENV = '00160160-0000-4000-8000-0000000000e6';
const ALL_ORGS = [ORG_A, ORG_B, ORG_C, ORG_D, ORG_DELETED, ORG_INACTIVE, ORG_EXPIRED, ORG_NO_CERT, ORG_UNVERIFIED, ORG_OTHER_ENV];
const LIVE_ORGS = [ORG_A, ORG_B, ORG_C, ORG_D];

const EMAIL_A = 'rls-harmonogram-a@ksef-saas.test';
const PASS = 'RlsHarmonogram2026Aa!';
const ENV = 'demo';
const SCHEMA = 'pgboss_rls_harmonogram';

// Baza może mieć firmy innych testów, a rozsyłka patrzy na całe środowisko:
// środowisko `demo` jest w tych testach puste.
const GAPS = { hot: 1350, warm: 10800, cold: 64800, dormant: 86400 };
const OVERDUE = 3600;
const FAILING = 5400;
const HWM = 21600;

let boss: import('pg-boss').PgBoss | null = null;
let clientA: SupabaseClient;
let stopBoss: typeof import('@/lib/jobs/boss').stopBoss;
let dispatchDueInboxPolls: typeof import('@/lib/ksef/inbox-schedule-db').dispatchDueInboxPolls;
let previousSchema: string | undefined;
let previousDatabaseUrl: string | undefined;

/** Surowy SQL jak połączenie workera (ta sama rola co `DATABASE_URL`). */
async function sql(text: string, values?: unknown[]) {
  const result = await boss!.getDb().executeSql(text, values);
  return result as unknown as { rows: Array<Record<string, unknown>> };
}

function anon(activeOrg?: string) {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: activeOrg ? { 'x-active-org': activeOrg } : {} },
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

/** Stan wiersza harmonogramu ustawiamy wprost: test nie czeka godzinami. */
async function schedule(org: string, patch: Record<string, unknown>) {
  const { error } = await admin.from('ksef_inbox_schedule').update(patch).eq('tenant_id', org);
  if (error) throw new Error(`schedule ${org}: ${error.message}`);
}

async function read(org: string) {
  const { data, error } = await admin.from('ksef_inbox_schedule').select('*').eq('tenant_id', org).single();
  if (error) throw error;
  return data as Record<string, string | number | null>;
}

// Zegar bazy i testu to dwa różne zegary (kontener, CI): „teraz” porównujemy z zapasem.
const CLOCK_TOLERANCE_MS = 5000;
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const minutesAhead = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

async function claim(limit = 100, lease = 1800) {
  const { data, error } = await admin.rpc('claim_ksef_inbox_polls', {
    p_environment: ENV, p_limit: limit, p_lease_seconds: lease,
  });
  if (error) throw error;
  return data as Array<{ tenant_id: string; nip: string; due_at: string }>;
}

async function alarmCounts() {
  const { data, error } = await admin.rpc('ksef_inbox_alarm_counts', {
    p_environment: ENV,
    p_overdue_seconds: OVERDUE,
    p_failing_margin_seconds: FAILING,
    p_hwm_margin_seconds: HWM,
    p_expected_gap_seconds: GAPS,
  });
  if (error) throw error;
  return (data as Array<Record<string, number>>)[0]!;
}

/** Wszystkie żywe firmy poza terminem: zaczynamy każdy test od ciszy. */
async function resetSchedules() {
  for (const org of LIVE_ORGS) {
    await schedule(org, {
      next_poll_at: minutesAhead(60),
      activity_tier: 'hot',
      poll_lease_until: null,
      nudged_at: null,
      consecutive_errors: 0,
      last_error_class: null,
      last_error_at: null,
      last_poll_finished_at: null,
      last_success_at: minutesAgo(1),
    });
  }
  await sql('DELETE FROM public.ksef_inbox_cursor WHERE tenant_id = ANY($1::uuid[])', [ALL_ORGS]);
}

/** Własny schemat kolejki znika po teście: lokalna baza bywa wspólna. W CI baza i tak jest jednorazowa. */
async function stopBossAndDropSchema() {
  await sql(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
  await stopBoss().catch(() => undefined);
}

const describeDb = hasDatabase ? describe : describe.skip;

describeDb('harmonogram skrzynki (00160)', () => {
  beforeAll(async () => {
    previousSchema = process.env.JOBS_PGBOSS_SCHEMA;
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.JOBS_PGBOSS_SCHEMA = SCHEMA;
    process.env.DATABASE_URL = databaseUrl!;

    const bossModule = await import('@/lib/jobs/boss');
    stopBoss = bossModule.stopBoss;
    boss = await bossModule.startBoss();
    await bossModule.ensureQueue('inbox.poll.tenant');
    ({ dispatchDueInboxPolls } = await import('@/lib/ksef/inbox-schedule-db'));

    await sql('DELETE FROM public.tenants WHERE id = ANY($1::uuid[])', [ALL_ORGS]);

    const blob = '\\x' + Buffer.from('zaszyfrowany-blob').toString('hex');
    const live = {
      ksef_credentials_encrypted: blob,
      ksef_verified_at: '2026-10-01T00:00:00Z',
      ksef_verified_environment: ENV,
    };
    const row = (id: string, nip: string, patch: Record<string, unknown>) => ({
      id, name: `Harmonogram ${nip}`, nip,
      // Paczka w PostgREST bierze kolumny z sumy kluczy: brak klucza to NULL, nie domyślna wartość.
      is_active: true, deleted_at: null, ksef_certificate_expiry: null,
      ksef_credentials_encrypted: null, ksef_verified_at: null, ksef_verified_environment: null,
      ...patch,
    });
    const { error } = await admin.from('tenants').insert([
      row(ORG_A, '9480016001', live),
      row(ORG_B, '9480016002', live),
      row(ORG_C, '9480016003', live),
      row(ORG_D, '9480016004', live),
      row(ORG_DELETED, '9480016005', { ...live, deleted_at: '2026-10-01T00:00:00Z' }),
      row(ORG_INACTIVE, '9480016006', { ...live, is_active: false }),
      row(ORG_EXPIRED, '9480016007', { ...live, ksef_certificate_expiry: '2026-01-01T00:00:00Z' }),
      row(ORG_NO_CERT, '9480016008', { ksef_verified_at: live.ksef_verified_at, ksef_verified_environment: ENV }),
      row(ORG_UNVERIFIED, '9480016009', { ksef_credentials_encrypted: blob }),
      row(ORG_OTHER_ENV, '9480016010', { ...live, ksef_verified_environment: 'test' }),
    ]);
    if (error) throw new Error(`insert tenants: ${error.message}`);

    const uidA = await userId(EMAIL_A);
    const { error: memberError } = await admin.from('memberships').upsert(
      { organization_id: ORG_A, user_id: uidA, role: 'owner', status: 'active' },
      { onConflict: 'organization_id,user_id' },
    );
    if (memberError) throw memberError;
    clientA = anon(ORG_A);
    const { error: signInError } = await clientA.auth.signInWithPassword({ email: EMAIL_A, password: PASS });
    if (signInError) throw signInError;
  }, 60_000);

  afterAll(async () => {
    if (boss) {
      await sql('DELETE FROM public.tenants WHERE id = ANY($1::uuid[])', [ALL_ORGS]);
      await stopBossAndDropSchema();
    }
    if (previousSchema === undefined) delete process.env.JOBS_PGBOSS_SCHEMA;
    else process.env.JOBS_PGBOSS_SCHEMA = previousSchema;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }, 30_000);

  beforeEach(async () => {
    await resetSchedules();
  });

  describe('nowy certyfikat (wyzwalacz)', () => {
    it('firma z certyfikatem i weryfikacją ma wiersz; bez któregoś z nich nie ma', async () => {
      for (const org of [ORG_A, ORG_DELETED, ORG_INACTIVE, ORG_EXPIRED, ORG_OTHER_ENV]) {
        await expect(read(org)).resolves.toMatchObject({ tenant_id: org });
      }
      for (const org of [ORG_NO_CERT, ORG_UNVERIFIED]) {
        const { data } = await admin.from('ksef_inbox_schedule').select('tenant_id').eq('tenant_id', org);
        expect(data).toEqual([]);
      }
    });

    it('nowy certyfikat: termin „teraz”, błędy na zero, dzierżawa w dół', async () => {
      await schedule(ORG_A, {
        next_poll_at: minutesAhead(600),
        consecutive_errors: 5,
        last_error_class: 'credentials',
        last_error_at: minutesAgo(5),
        poll_lease_until: minutesAhead(10),
      });
      const blob = '\\x' + Buffer.from('nowy-certyfikat').toString('hex');
      const { error } = await admin.from('tenants').update({ ksef_credentials_encrypted: blob }).eq('id', ORG_A);
      expect(error).toBeNull();
      const row = await read(ORG_A);
      expect(Date.parse(row.next_poll_at as string)).toBeLessThanOrEqual(Date.now() + CLOCK_TOLERANCE_MS);
      expect(row).toMatchObject({ consecutive_errors: 0, last_error_class: null, poll_lease_until: null });
    });

    it('zmiana nazwy firmy nie rusza terminu', async () => {
      const at = minutesAhead(120);
      await schedule(ORG_A, { next_poll_at: at });
      await admin.from('tenants').update({ name: 'Nowa nazwa' }).eq('id', ORG_A);
      expect(Date.parse((await read(ORG_A)).next_poll_at as string)).toBe(Date.parse(at));
    });
  });

  describe('uprawnienia', () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['claim_ksef_inbox_polls', { p_environment: ENV, p_limit: 1, p_lease_seconds: 60 }],
      ['ksef_inbox_poll_backlog', { p_environment: ENV, p_recent_seconds: 60 }],
      ['ksef_inbox_poll_state', { p_tenant_id: ORG_A, p_active_statuses: ['active'] }],
      ['finish_ksef_inbox_poll', {
        p_tenant_id: ORG_A, p_started_at: minutesAgo(1), p_next_poll_at: minutesAhead(1),
        p_activity_tier: 'hot', p_new_invoices: 0, p_error_class: null,
      }],
      ['note_ksef_inbox_activity', { p_tenant_id: ORG_A, p_request_poll: true, p_min_gap_seconds: 300, p_pull_seconds: 900 }],
      ['ksef_inbox_alarm_counts', {
        p_environment: ENV, p_overdue_seconds: 1, p_failing_margin_seconds: 1, p_hwm_margin_seconds: 1, p_expected_gap_seconds: GAPS,
      }],
    ];

    it.each(calls)('%s: anon i zalogowany klient dostają odmowę', async (name, args) => {
      for (const client of [anon(), clientA]) {
        const { error } = await client.rpc(name, args);
        expect(error?.code, name).toBe('42501');
      }
      // Odmowa nie zmieniła stanu.
      expect(Number((await read(ORG_A)).consecutive_errors)).toBe(0);
    });

    it('rola połączenia pg-boss ma prawo wykonać wybór firm', async () => {
      await expect(sql('SELECT tenant_id FROM public.claim_ksef_inbox_polls($1, 0, 60)', [ENV])).resolves.toBeDefined();
    });

    it('widok żywych firm jest zamknięty dla klienta', async () => {
      const { error } = await clientA.from('ksef_inbox_live_tenants').select('id');
      expect(error?.code).toBe('42501');
    });

    it('członek czyta swój ostatni sukces, cudzego wiersza nie widzi', async () => {
      const own = await clientA.from('ksef_inbox_schedule').select('tenant_id, last_success_at');
      expect(own.error).toBeNull();
      expect(own.data?.map((r) => r.tenant_id)).toEqual([ORG_A]);
    });

    it('kolumny operatora (termin, poziom, błędy, dzierżawa) są dla klienta zamknięte', async () => {
      for (const column of ['next_poll_at', 'activity_tier', 'last_error_class', 'consecutive_errors', 'poll_lease_until', 'last_activity_at', '*']) {
        const { error } = await clientA.from('ksef_inbox_schedule').select(column);
        expect(error?.code, column).toBe('42501');
      }
    });

    it('klient niczego nie zapisuje; anon nawet nie czyta', async () => {
      const update = await clientA.from('ksef_inbox_schedule').update({ next_poll_at: minutesAgo(1) }).eq('tenant_id', ORG_A).select('tenant_id');
      expect(update.error?.code).toBe('42501');
      const insert = await clientA.from('ksef_inbox_schedule').insert({ tenant_id: ORG_B });
      expect(insert.error?.code).toBe('42501');
      const del = await clientA.from('ksef_inbox_schedule').delete().eq('tenant_id', ORG_A);
      expect(del.error?.code).toBe('42501');
      const select = await anon().from('ksef_inbox_schedule').select('tenant_id');
      expect(select.error?.code).toBe('42501');
    });

    it('serwer nie usuwa wierszy: znikają tylko kaskadą z firmą', async () => {
      const { error } = await admin.from('ksef_inbox_schedule').delete().eq('tenant_id', ORG_A);
      expect(error?.code).toBe('42501');
    });
  });

  describe('wybór należnych firm', () => {
    it('tylko żywe firmy tego środowiska: usunięta, nieaktywna, z wygasłym certyfikatem i z innego środowiska odpadają', async () => {
      for (const org of [ORG_A, ORG_DELETED, ORG_INACTIVE, ORG_EXPIRED, ORG_OTHER_ENV]) {
        await schedule(org, { next_poll_at: minutesAgo(10), poll_lease_until: null });
      }
      const rows = await claim();
      expect(rows.map((r) => r.tenant_id)).toEqual([ORG_A]);
      expect(rows[0]!.nip).toBe('9480016001');
    });

    it('certyfikat bez daty wygaśnięcia i z datą w przyszłości przechodzi', async () => {
      await admin.from('tenants').update({ ksef_certificate_expiry: minutesAhead(60) }).eq('id', ORG_B);
      await schedule(ORG_B, { next_poll_at: minutesAgo(1) });
      expect((await claim()).map((r) => r.tenant_id)).toEqual([ORG_B]);
      await admin.from('tenants').update({ ksef_certificate_expiry: null }).eq('id', ORG_B);
    });

    it('od najdawniej należnych, z limitem; termin w przyszłości nie wchodzi', async () => {
      await schedule(ORG_A, { next_poll_at: minutesAgo(5) });
      await schedule(ORG_B, { next_poll_at: minutesAgo(50) });
      await schedule(ORG_C, { next_poll_at: minutesAgo(20) });
      await schedule(ORG_D, { next_poll_at: minutesAhead(5) });

      const first = await claim(2);
      expect(first.map((r) => r.tenant_id)).toEqual([ORG_B, ORG_C]);
      expect(Date.parse(first[0]!.due_at)).toBeLessThan(Date.parse(first[1]!.due_at));
      expect((await claim(2)).map((r) => r.tenant_id)).toEqual([ORG_A]);
      expect(await claim(2)).toEqual([]);
    });

    it('firma z czekającym zadaniem nie wraca, dopóki dzierżawa trwa; po wygaśnięciu wraca (worker padł)', async () => {
      await schedule(ORG_A, { next_poll_at: minutesAgo(5) });
      expect(await claim()).toHaveLength(1);
      expect(await claim()).toEqual([]);
      expect(Date.parse((await read(ORG_A)).poll_lease_until as string)).toBeGreaterThan(Date.now());

      await schedule(ORG_A, { poll_lease_until: minutesAgo(1) });
      expect((await claim()).map((r) => r.tenant_id)).toEqual([ORG_A]);
    });

    it('dwa takty naraz nie biorą tej samej firmy', async () => {
      for (const org of LIVE_ORGS) await schedule(org, { next_poll_at: minutesAgo(5) });
      const [first, second] = await Promise.all([claim(3), claim(3)]);
      const taken = [...first!, ...second!].map((r) => r.tenant_id);
      expect(new Set(taken).size).toBe(taken.length);
      expect(taken.length).toBe(4);
    });

    it('liczby taktu: należne, w toku, najstarszy termin', async () => {
      await schedule(ORG_A, { next_poll_at: minutesAgo(30) });
      await schedule(ORG_B, { next_poll_at: minutesAgo(10) });
      await schedule(ORG_C, { next_poll_at: minutesAgo(90), poll_lease_until: minutesAhead(10) });
      const { data, error } = await admin.rpc('ksef_inbox_poll_backlog', { p_environment: ENV, p_recent_seconds: 600 });
      expect(error).toBeNull();
      const row = (data as Array<Record<string, unknown>>)[0]!;
      expect(row).toMatchObject({ due: 2, in_flight: 1 });
      expect(Math.abs(Date.parse(row.oldest_due_at as string) - (Date.now() - 30 * 60_000))).toBeLessThan(5000);
    });
  });

  describe('rozsyłka w jednej transakcji z kolejką', () => {
    async function jobs() {
      const { rows } = await sql(
        `SELECT data, group_id, state FROM ${SCHEMA}.job WHERE name = 'inbox.poll.tenant' AND data->>'environment' = $1`,
        [ENV],
      );
      return rows as unknown as Array<{ data: Record<string, string>; group_id: string; state: string }>;
    }

    beforeEach(async () => {
      await sql(`DELETE FROM ${SCHEMA}.job WHERE name = 'inbox.poll.tenant'`);
    });

    it('zlecenie ma grupę = NIP i termin; druga rozsyłka przy czekającym zadaniu nic nie dodaje', async () => {
      await schedule(ORG_A, { next_poll_at: minutesAgo(5) });
      await schedule(ORG_B, { next_poll_at: minutesAgo(4) });

      await expect(dispatchDueInboxPolls(ENV as never, 10)).resolves.toBe(2);
      const first = await jobs();
      expect(first.map((j) => j.group_id).sort()).toEqual(['9480016001', '9480016002']);
      expect(first.find((j) => j.data.tenantId === ORG_A)?.data.dueAt).toBeTypeOf('string');
      expect(first.every((j) => j.state === 'created')).toBe(true);

      await expect(dispatchDueInboxPolls(ENV as never, 10)).resolves.toBe(0);
      expect(await jobs()).toHaveLength(2);
    });

    it('limit: reszta firm czeka na następny takt', async () => {
      await schedule(ORG_A, { next_poll_at: minutesAgo(5) });
      await schedule(ORG_B, { next_poll_at: minutesAgo(4) });
      await schedule(ORG_C, { next_poll_at: minutesAgo(3) });
      await expect(dispatchDueInboxPolls(ENV as never, 2)).resolves.toBe(2);
      await expect(dispatchDueInboxPolls(ENV as never, 2)).resolves.toBe(1);
      expect(await jobs()).toHaveLength(3);
    });

    it('błąd zapisu zleceń cofa dzierżawę: firma zostaje należna', async () => {
      await schedule(ORG_A, { next_poll_at: minutesAgo(5) });
      await expect(dispatchDueInboxPolls(ENV as never, 10, { queue: 'kolejka-ktorej-nie-ma' })).rejects.toThrow();
      expect((await read(ORG_A)).poll_lease_until).toBeNull();
      expect(await jobs()).toEqual([]);
      await expect(dispatchDueInboxPolls(ENV as never, 10)).resolves.toBe(1);
    });
  });

  describe('duble kategoryzacji: co pg-boss naprawdę robi', () => {
    const QUEUE = 'inbox.invoice-received';
    const INVOICE = '00160160-1111-4000-8000-000000000001';

    beforeEach(async () => {
      await sql(`DELETE FROM ${SCHEMA}.job WHERE name = $1`, [QUEUE]);
    });

    it('singletonKey na kolejce `standard` niczego nie deduplikuje: dwa zlecenia to dwa zadania', async () => {
      const { ensureQueue } = await import('@/lib/jobs/boss');
      await ensureQueue(QUEUE);
      const data = { invoiceId: INVOICE };
      await expect(boss!.send(QUEUE, data, { singletonKey: INVOICE })).resolves.toBeTypeOf('string');
      await expect(boss!.send(QUEUE, data, { singletonKey: INVOICE })).resolves.toBeTypeOf('string');
      const { rows } = await sql(`SELECT count(*)::int AS n FROM ${SCHEMA}.job WHERE name = $1 AND singleton_key = $2`, [QUEUE, INVOICE]);
      expect(rows[0]!.n).toBe(2);
    });

    it('cron uzupełniający widzi czekające zadanie po polu danych, ukończonego już nie', async () => {
      const { ensureQueue } = await import('@/lib/jobs/boss');
      const { findWaitingJobsByDataField } = await import('@/lib/jobs/pending-jobs');
      await ensureQueue(QUEUE);
      const other = '00160160-1111-4000-8000-000000000002';
      await boss!.send(QUEUE, { invoiceId: INVOICE });

      await expect(findWaitingJobsByDataField(QUEUE, 'invoiceId', [INVOICE, other])).resolves.toEqual(new Set([INVOICE]));
      await expect(findWaitingJobsByDataField(QUEUE, 'invoiceId', [])).resolves.toEqual(new Set());

      await sql(`UPDATE ${SCHEMA}.job SET state = 'completed', completed_on = now() WHERE name = $1`, [QUEUE]);
      await expect(findWaitingJobsByDataField(QUEUE, 'invoiceId', [INVOICE])).resolves.toEqual(new Set());
    });
  });

  describe('koniec przebiegu', () => {
    const finish = (patch: Record<string, unknown> = {}) => admin.rpc('finish_ksef_inbox_poll', {
      p_tenant_id: ORG_A,
      p_started_at: minutesAgo(1),
      p_next_poll_at: minutesAhead(15),
      p_activity_tier: 'warm',
      p_new_invoices: 0,
      p_error_class: null,
      ...patch,
    });

    it('sukces: dzierżawa w dół, nowy termin i poziom, błędy na zero', async () => {
      await schedule(ORG_A, { poll_lease_until: minutesAhead(10), consecutive_errors: 3, last_error_class: 'ksef', last_error_at: minutesAgo(2) });
      const { error } = await finish();
      expect(error).toBeNull();
      const row = await read(ORG_A);
      expect(row).toMatchObject({ poll_lease_until: null, consecutive_errors: 0, last_error_class: null, last_error_at: null, activity_tier: 'warm' });
      expect(Date.parse(row.last_success_at as string)).toBeGreaterThan(Date.now() - 10_000);
    });

    it('nowa faktura zapisuje datę; przebieg bez faktur jej nie rusza', async () => {
      await finish({ p_new_invoices: 2 });
      const stamped = (await read(ORG_A)).last_invoice_at;
      expect(Date.parse(stamped as string)).toBeGreaterThan(Date.now() - 10_000);
      await finish();
      expect((await read(ORG_A)).last_invoice_at).toBe(stamped);
    });

    it('błąd: licznik rośnie w bazie, ostatni sukces zostaje', async () => {
      const success = minutesAgo(30);
      await schedule(ORG_A, { last_success_at: success, consecutive_errors: 2 });
      await finish({ p_error_class: 'credentials' });
      const row = await read(ORG_A);
      expect(row).toMatchObject({ consecutive_errors: 3, last_error_class: 'credentials' });
      expect(Date.parse(row.last_success_at as string)).toBe(Date.parse(success));
    });

    it('przyspieszenie zrobione w trakcie przebiegu wygrywa z policzonym terminem', async () => {
      const nudge = minutesAgo(0.2);
      await schedule(ORG_A, { nudged_at: nudge, next_poll_at: nudge });
      await finish({ p_started_at: minutesAgo(1), p_next_poll_at: minutesAhead(15) });
      expect(Date.parse((await read(ORG_A)).next_poll_at as string)).toBe(Date.parse(nudge));
    });

    it('przyspieszenie sprzed przebiegu nie blokuje nowego terminu', async () => {
      await schedule(ORG_A, { nudged_at: minutesAgo(10) });
      const next = minutesAhead(15);
      await finish({ p_started_at: minutesAgo(1), p_next_poll_at: next });
      expect(Date.parse((await read(ORG_A)).next_poll_at as string)).toBe(Date.parse(next));
    });
  });

  describe('aktywność i „Sprawdź teraz”', () => {
    const note = async (requestPoll: boolean, org = ORG_A) => {
      const { data, error } = await admin.rpc('note_ksef_inbox_activity', {
        p_tenant_id: org, p_request_poll: requestPoll, p_min_gap_seconds: 300, p_pull_seconds: 900,
      });
      if (error) throw error;
      return (data as Array<{ status: string; retry_after_seconds: number; next_poll_at: string }>)[0];
    };

    it('żądanie: termin „teraz”, drugie w ciągu 5 min odbija się od warunku w bazie', async () => {
      await schedule(ORG_A, { next_poll_at: minutesAhead(300) });
      const first = await note(true);
      expect(first?.status).toBe('accepted');
      expect(Date.parse((await read(ORG_A)).next_poll_at as string)).toBeLessThanOrEqual(Date.now() + CLOCK_TOLERANCE_MS);

      const second = await note(true);
      expect(second?.status).toBe('too_soon');
      expect(second!.retry_after_seconds).toBeGreaterThan(280);
      expect(second!.retry_after_seconds).toBeLessThanOrEqual(300);
    });

    it('firma sprawdzona przed chwilą: za szybko, także bez wcześniejszego żądania', async () => {
      await schedule(ORG_A, { last_poll_finished_at: minutesAgo(2), next_poll_at: minutesAhead(13) });
      expect((await note(true))?.status).toBe('too_soon');
    });

    it('po 5 minutach znów można', async () => {
      await schedule(ORG_A, { nudged_at: minutesAgo(6), last_poll_finished_at: minutesAgo(6), next_poll_at: minutesAhead(9) });
      expect((await note(true))?.status).toBe('accepted');
    });

    it('zadanie już czeka: bez przesuwania terminu', async () => {
      const lease = minutesAhead(20);
      await schedule(ORG_A, { poll_lease_until: lease, next_poll_at: minutesAgo(1) });
      expect((await note(true))?.status).toBe('in_flight');
    });

    it('sama aktywność: znacznik i termin firmy zimnej najpóźniej za 15 minut, bez „teraz”', async () => {
      await schedule(ORG_A, { next_poll_at: minutesAhead(300), last_activity_at: null });
      await note(false);
      const row = await read(ORG_A);
      expect(Date.parse(row.last_activity_at as string)).toBeGreaterThan(Date.now() - 10_000);
      const next = Date.parse(row.next_poll_at as string);
      expect(next).toBeGreaterThan(Date.now() + 14 * 60_000);
      expect(next).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 1000);
    });

    it('firma uśpiona, w której ktoś zaczął pracować, wchodzi w rytm od razu', async () => {
      await schedule(ORG_A, { next_poll_at: minutesAhead(600), activity_tier: 'dormant' });
      await note(false);
      expect(Date.parse((await read(ORG_A)).next_poll_at as string)).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + CLOCK_TOLERANCE_MS);
    });

    it('sama aktywność nie przyspiesza firmy ze złym certyfikatem', async () => {
      const at = minutesAhead(600);
      await schedule(ORG_A, {
        next_poll_at: at, activity_tier: 'hot', consecutive_errors: 3, last_error_class: 'credentials', last_error_at: minutesAgo(1),
      });
      await note(false);
      const row = await read(ORG_A);
      expect(Date.parse(row.next_poll_at as string)).toBe(Date.parse(at));
      expect(Date.parse(row.last_activity_at as string)).toBeGreaterThan(Date.now() - 10_000);
    });

    it('sama aktywność nie cofa terminu firmy gorącej', async () => {
      const at = minutesAhead(3);
      await schedule(ORG_A, { next_poll_at: at });
      await note(false);
      expect(Date.parse((await read(ORG_A)).next_poll_at as string)).toBe(Date.parse(at));
    });

    it('firma bez KSeF: brak wiersza, brak wyniku', async () => {
      expect(await note(true, ORG_NO_CERT)).toBeUndefined();
    });
  });

  describe('stan przebiegu', () => {
    const state = async () => {
      const { data, error } = await admin.rpc('ksef_inbox_poll_state', {
        p_tenant_id: ORG_A,
        p_active_statuses: INBOX_ACTIVE_SUBSCRIPTION_STATUSES,
      });
      if (error) throw error;
      return (data as Array<Record<string, unknown>>)[0]!;
    };

    it('wygasła dzierżawa czyta się jak brak dzierżawy', async () => {
      await schedule(ORG_A, { poll_lease_until: minutesAgo(1) });
      expect((await state()).poll_lease_until).toBeNull();
      const lease = minutesAhead(5);
      await schedule(ORG_A, { poll_lease_until: lease });
      expect(Date.parse((await state()).poll_lease_until as string)).toBe(Date.parse(lease));
    });

    it('subskrypcja: brak = nieaktywna; próba i opłacona = aktywna; anulowana = nieaktywna', async () => {
      expect((await state()).subscription_active).toBe(false);
      const customer = 'cus_rls_harmonogram';
      await sql('UPDATE public.tenants SET stripe_customer_id = $1 WHERE id = $2', [customer, ORG_A]);
      try {
        const insert = (status: string) => sql(
          `INSERT INTO public.subscriptions (tenant_id, stripe_subscription_id, stripe_customer_id, stripe_price_id, status, plan)
           VALUES ($1, $2, $3, 'price_x', $4, 'monthly')`,
          [ORG_A, `sub_rls_${status}`, customer, status],
        );
        await insert('trialing');
        expect((await state()).subscription_active).toBe(true);
        await sql('UPDATE public.subscriptions SET status = $1 WHERE tenant_id = $2', ['canceled', ORG_A]);
        expect((await state()).subscription_active).toBe(false);
        await insert('active');
        expect((await state()).subscription_active).toBe(true);
      } finally {
        await sql('DELETE FROM public.subscriptions WHERE tenant_id = $1', [ORG_A]);
        await sql('UPDATE public.tenants SET stripe_customer_id = NULL WHERE id = $1', [ORG_A]);
      }
    });
  });

  describe('alarm względem harmonogramu', () => {
    /** Firma po ostatnim sukcesie sprzed `minutes` minut, na terminie wynikającym z poziomu. */
    async function firmAfter(org: string, tier: 'hot' | 'cold' | 'dormant', minutes: number, intervalMinutes: number) {
      const lastSuccess = minutesAgo(minutes);
      await schedule(org, {
        activity_tier: tier,
        last_success_at: lastSuccess,
        last_poll_finished_at: lastSuccess,
        next_poll_at: new Date(Date.parse(lastSuccess) + intervalMinutes * 60_000).toISOString(),
      });
    }

    it('cisza: same zera, a żywe firmy policzone', async () => {
      expect(await alarmCounts()).toMatchObject({ live: 4, overdue: 0, failing: 0, hwm_behind: 0, credentials: 0, unscheduled: 0 });
    });

    it('firma zimna po 5 h: bez alarmu', async () => {
      await firmAfter(ORG_A, 'cold', 300, 360);
      await sql(
        `INSERT INTO public.ksef_inbox_cursor (tenant_id, window_to, last_page_at) VALUES ($1, $2::timestamptz, $2::timestamptz)`,
        [ORG_A, minutesAgo(300)],
      );
      expect(await alarmCounts()).toMatchObject({ overdue: 0, failing: 0, hwm_behind: 0 });
    });

    it('firma gorąca po 2 h: alarm, bo termin minął ponad godzinę temu', async () => {
      await firmAfter(ORG_A, 'hot', 120, 15);
      expect(await alarmCounts()).toMatchObject({ overdue: 1 });
    });

    it('firma gorąca po 2 h z błędami KSeF (termin odsunięty): alarm z klasy „przebiegi padają”', async () => {
      await firmAfter(ORG_A, 'hot', 120, 15);
      await schedule(ORG_A, { next_poll_at: minutesAhead(5), consecutive_errors: 8, last_error_class: 'ksef', last_error_at: minutesAgo(1) });
      expect(await alarmCounts()).toMatchObject({ overdue: 0, failing: 1 });
    });

    it('firma zimna po 5 h z błędami KSeF: jeszcze bez alarmu', async () => {
      await firmAfter(ORG_A, 'cold', 300, 360);
      await schedule(ORG_A, { next_poll_at: minutesAhead(5), consecutive_errors: 8, last_error_class: 'ksef', last_error_at: minutesAgo(1) });
      expect(await alarmCounts()).toMatchObject({ failing: 0 });
    });

    it('zły certyfikat: nie „przebiegi padają”, tylko osobna liczba dla klienta', async () => {
      await firmAfter(ORG_A, 'hot', 600, 15);
      await schedule(ORG_A, { next_poll_at: minutesAhead(120), consecutive_errors: 5, last_error_class: 'credentials', last_error_at: minutesAgo(1) });
      expect(await alarmCounts()).toMatchObject({ overdue: 0, failing: 0, credentials: 1 });
    });

    it('przebiegi przechodzą, a HWM stoi ponad normę poziomu: zaległość po stronie MF', async () => {
      await sql(
        `INSERT INTO public.ksef_inbox_cursor (tenant_id, window_to, last_page_at) VALUES ($1, $2::timestamptz, now())`,
        [ORG_A, minutesAgo(7 * 60)],
      );
      expect(await alarmCounts()).toMatchObject({ hwm_behind: 1, overdue: 0 });
    });

    it('żywa firma bez wiersza harmonogramu: alarm, bo nikt jej nie odpytuje', async () => {
      await sql('DELETE FROM public.ksef_inbox_schedule WHERE tenant_id = $1', [ORG_D]);
      try {
        expect(await alarmCounts()).toMatchObject({ unscheduled: 1 });
      } finally {
        await sql(`INSERT INTO public.ksef_inbox_schedule (tenant_id, next_poll_at) VALUES ($1, now() + interval '1 hour')`, [ORG_D]);
      }
    });

    it('firmy usunięte, nieaktywne i z wygasłym certyfikatem nie budzą', async () => {
      for (const org of [ORG_DELETED, ORG_INACTIVE, ORG_EXPIRED]) {
        await schedule(org, { next_poll_at: minutesAgo(5000) });
      }
      expect(await alarmCounts()).toMatchObject({ overdue: 0 });
    });
  });
});
