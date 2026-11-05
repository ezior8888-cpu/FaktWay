import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getRlsTestDatabaseUrl, getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Sesja 20 planu skalowania (00157): sprzątanie dzienników paczkami, na
 * prawdziwej bazie — prawdziwy wyzwalacz append-only `audit_logs` (00052),
 * prawdziwe uprawnienia ról i PostgREST z limitem czasu, przez który woła
 * runner `cron.cleanup-audit-logs`.
 *
 *   DB-01 — jeden DELETE wszystkich starych wierszy nie mieści się w 8 s
 *           PostgREST i nie usuwa nic; paczka usuwa najwyżej `p_limit`,
 *   DB-09 — `ksef_health_log` bez retencji, choć 00046 ją obiecuje (3 mies.),
 *   append-only — DELETE bez flagi dalej pada, także w tej samej
 *           transakcji zaraz po paczce (flaga nie przeżywa wywołania).
 *
 * Czerwień przed 00157 wynika wyłącznie z bazy: funkcji paczkowych nie ma
 * (PGRST202 przez PostgREST, 42883 przez `pg`).
 *
 * Dane: wiersze oznaczone `MARK` (audyt: `action`, przebiegi: `event_name`,
 * zdrowie KSeF: `error_short`), bez firmy. Funkcje usuwają stare wiersze
 * całej tabeli, więc `beforeEach` najpierw zdejmuje WSZYSTKIE wiersze starsze
 * niż retencja (baza testowa) — liczby zwracane przez paczkę są wtedy pewne.
 * Wiersze z `pg` piszemy jako `postgres` (z datą w przeszłości); RPC wołamy
 * przez PostgREST kluczem serwisowym, jak runner.
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim() &&
    process.env.RLS_TEST_DATABASE_URL?.trim(),
);
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const databaseUrl = hasDatabase ? getRlsTestDatabaseUrl() : '';
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : (null as unknown as SupabaseClient);

const MARK = 'test.sprzatanie_dziennikow';
const FUNCTIONS = [
  'purge_audit_logs_batch(integer, integer)',
  'purge_inngest_run_log_batch(integer)',
  'purge_ksef_health_log_batch(integer)',
] as const;

interface SqlRunner {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

interface TransactionalDb extends SqlRunner {
  withTransaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

let boss: PgBoss;

/** Wbudowany `Db` pg-boss: `executeSql` z puli i `withTransaction` na jednym połączeniu. */
function pgDb(): TransactionalDb {
  const db = boss.getDb() as unknown as Partial<TransactionalDb>;
  if (typeof db.executeSql !== 'function' || typeof db.withTransaction !== 'function') {
    throw new Error('pg-boss: Db bez executeSql/withTransaction — test wymaga wbudowanej puli pg-boss');
  }
  return db as TransactionalDb;
}

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await pgDb().executeSql(text, params);
  return rows as T[];
}

const ROLLBACK = Symbol('rollback');

/** Transakcja cofnięta zawsze (także po sukcesie `fn`); zwraca wynik albo błąd `fn`. */
async function rolledBack<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  let value: T | undefined;
  try {
    await pgDb().withTransaction(async (tx) => {
      value = await fn(tx);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e === ROLLBACK) return { value };
    return { error: e };
  }
  return { value };
}

function anonClient(): SupabaseClient {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Wpisy audytu `MARK` sprzed `monthsAgo` miesięcy (kolejne o sekundę starsze). */
async function auditRows(count: number, monthsAgo: number): Promise<void> {
  await sql(
    `INSERT INTO public.audit_logs (action, entity_type, created_at)
     SELECT $1::text, 'test', now() - make_interval(months => $2::int) - make_interval(secs => g)
       FROM generate_series(1, $3::int) AS g`,
    [MARK, monthsAgo, count],
  );
}

async function runLogRows(count: number, monthsAgo: number): Promise<void> {
  await sql(
    `INSERT INTO public.inngest_run_log (event_name, run_id, status, created_at)
     SELECT $1::text, 'test-' || g, 'succeeded', now() - make_interval(months => $2::int) - make_interval(secs => g)
       FROM generate_series(1, $3::int) AS g`,
    [MARK, monthsAgo, count],
  );
}

async function healthRows(count: number, monthsAgo: number): Promise<void> {
  await sql(
    `INSERT INTO public.ksef_health_log (env, level, error_short, recorded_at)
     SELECT 'demo', 'operational', $1::text, now() - make_interval(months => $2::int) - make_interval(secs => g)
       FROM generate_series(1, $3::int) AS g`,
    [MARK, monthsAgo, count],
  );
}

/** Liczba wierszy `MARK` starszych (`older`) albo młodszych niż `months` miesięcy. */
async function marked(table: 'audit_logs' | 'inngest_run_log' | 'ksef_health_log', months: number, older: boolean) {
  const text = {
    audit_logs: `SELECT count(*)::int AS n FROM public.audit_logs
                  WHERE action = $1::text AND (created_at < now() - make_interval(months => $2::int)) = $3::boolean`,
    inngest_run_log: `SELECT count(*)::int AS n FROM public.inngest_run_log
                       WHERE event_name = $1::text AND (created_at < now() - make_interval(months => $2::int)) = $3::boolean`,
    ksef_health_log: `SELECT count(*)::int AS n FROM public.ksef_health_log
                       WHERE error_short = $1::text AND (recorded_at < now() - make_interval(months => $2::int)) = $3::boolean`,
  }[table];
  const [row] = await sql<{ n: number }>(text, [MARK, months, older]);
  return row!.n;
}

/**
 * Baza testowa: zdejmuje wiersze `MARK` i WSZYSTKIE starsze niż retencja
 * (12 mies. audytu, 3 mies. telemetrii) — bez funkcji pod testem.
 */
async function cleanup(): Promise<void> {
  await pgDb().withTransaction(async (tx) => {
    await tx.executeSql("SELECT set_config('app.allow_audit_purge', 'true', true)");
    await tx.executeSql(
      `DELETE FROM public.audit_logs WHERE action = $1::text OR created_at < now() - make_interval(months => 12)`,
      [MARK],
    );
    await tx.executeSql(
      `DELETE FROM public.inngest_run_log WHERE event_name = $1::text OR created_at < now() - make_interval(months => 3)`,
      [MARK],
    );
    await tx.executeSql(
      `DELETE FROM public.ksef_health_log WHERE error_short = $1::text OR recorded_at < now() - make_interval(months => 3)`,
      [MARK],
    );
  });
}

describe.skipIf(!hasDatabase)('sprzątanie dzienników paczkami (00157, DB-01, DB-09)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    boss = new PgBoss({ connectionString: databaseUrl, schema: 'pgboss', schedule: false, supervise: false });
    await boss.start();
  }, 60_000);

  beforeEach(cleanup, 60_000);

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await boss.stop({ graceful: false, close: true });
  }, 60_000);

  describe('audit_logs (12 mies., minimum 6)', () => {
    it('paczka usuwa najwyżej p_limit wierszy starszych niż cutoff; młodszych nie rusza; na końcu 0', async () => {
      await auditRows(5, 13);
      await auditRows(2, 11);
      await auditRows(1, 0);

      const first = await admin.rpc('purge_audit_logs_batch', { p_retention_months: 12, p_limit: 2 });
      expect(first.error).toBeNull();
      expect(first.data).toBe(2);
      expect(await marked('audit_logs', 12, true)).toBe(3);

      const second = await admin.rpc('purge_audit_logs_batch', { p_retention_months: 12, p_limit: 10 });
      expect(second.error).toBeNull();
      expect(second.data).toBe(3);

      const last = await admin.rpc('purge_audit_logs_batch', { p_retention_months: 12, p_limit: 10 });
      expect(last.error).toBeNull();
      expect(last.data).toBe(0);

      expect(await marked('audit_logs', 12, true)).toBe(0);
      expect(await marked('audit_logs', 12, false)).toBe(3);
    });

    it('domyślna paczka (20 000) przechodzi przez PostgREST w limicie czasu; reszta w kolejnej', async () => {
      await auditRows(20_005, 13);

      const started = Date.now();
      const full = await admin.rpc('purge_audit_logs_batch', { p_retention_months: 12 });
      const elapsed = Date.now() - started;
      expect(full.error).toBeNull();
      expect(full.data).toBe(20_000);
      // Limit `statement_timeout` PostgREST na produkcji to 8 s — paczka musi mieścić się z zapasem.
      expect(elapsed).toBeLessThan(8_000);

      const rest = await admin.rpc('purge_audit_logs_batch', { p_retention_months: 12 });
      expect(rest.error).toBeNull();
      expect(rest.data).toBe(5);
      expect(await marked('audit_logs', 12, true)).toBe(0);
    });

    it('retencja krótsza niż 6 mies. albo limit spoza 1–50 000 → błąd, nic nie znika', async () => {
      await auditRows(3, 13);

      for (const args of [
        { p_retention_months: 5, p_limit: 10 },
        { p_retention_months: 12, p_limit: 0 },
        { p_retention_months: 12, p_limit: 50_001 },
        { p_retention_months: 12, p_limit: null },
        { p_retention_months: null, p_limit: 10 },
      ]) {
        const { data, error } = await admin.rpc('purge_audit_logs_batch', args);
        expect(error?.code, JSON.stringify(args)).toBe('22023');
        expect(data).toBeNull();
      }
      expect(await marked('audit_logs', 12, true)).toBe(3);
    });

    it('append-only: DELETE i UPDATE bez flagi dalej padają — przez PostgREST i w tej samej transakcji po paczce', async () => {
      await auditRows(1, 13);
      await auditRows(1, 1);
      const [young] = await sql<{ id: string }>(
        `SELECT id FROM public.audit_logs
          WHERE action = $1::text AND created_at > now() - make_interval(months => 12) LIMIT 1`,
        [MARK],
      );

      const viaRest = await admin.from('audit_logs').delete().eq('id', young!.id);
      expect(viaRest.error?.message).toContain('append-only');

      const sameTx = await rolledBack(async (tx) => {
        await tx.executeSql('SET LOCAL ROLE service_role');
        const { rows } = await tx.executeSql('SELECT public.purge_audit_logs_batch(12, 10) AS n');
        expect(rows[0]?.n).toBe(1);
        const { rows: flag } = await tx.executeSql("SELECT current_setting('app.allow_audit_purge', true) AS v");
        expect(flag[0]?.v).not.toBe('true');
        await tx.executeSql('DELETE FROM public.audit_logs WHERE id = $1::uuid', [young!.id]);
      });
      expect(String((sameTx.error as Error | undefined)?.message)).toContain('append-only');

      const update = await rolledBack(async (tx) => {
        await tx.executeSql('SELECT public.purge_audit_logs_batch(12, 10)');
        await tx.executeSql("UPDATE public.audit_logs SET action = 'zmienione' WHERE id = $1::uuid", [young!.id]);
      });
      expect(String((update.error as Error | undefined)?.message)).toContain('append-only');

      // Flaga ustawiona wcześniej przez wołającego (np. anonimizacja RODO) wraca po paczce.
      const kept = await rolledBack(async (tx) => {
        await tx.executeSql("SELECT set_config('app.allow_audit_purge', 'true', true)");
        await tx.executeSql('SELECT public.purge_audit_logs_batch(12, 10)');
        const { rows } = await tx.executeSql("SELECT current_setting('app.allow_audit_purge', true) AS v");
        return rows[0]?.v;
      });
      expect(kept.error).toBeUndefined();
      expect(kept.value).toBe('true');

      expect(await marked('audit_logs', 12, false)).toBe(1);
    });
  });

  describe('telemetria (3 mies.)', () => {
    it('inngest_run_log: paczka po created_at, najwyżej p_limit, młodszych nie rusza', async () => {
      await runLogRows(3, 4);
      await runLogRows(1, 2);

      const first = await admin.rpc('purge_inngest_run_log_batch', { p_limit: 2 });
      expect(first.error).toBeNull();
      expect(first.data).toBe(2);
      const second = await admin.rpc('purge_inngest_run_log_batch', { p_limit: 2 });
      expect(second.data).toBe(1);
      const last = await admin.rpc('purge_inngest_run_log_batch', {});
      expect(last.error).toBeNull();
      expect(last.data).toBe(0);

      expect(await marked('inngest_run_log', 3, true)).toBe(0);
      expect(await marked('inngest_run_log', 3, false)).toBe(1);
    });

    it('ksef_health_log: paczka po recorded_at (retencja z 00046), najwyżej p_limit, młodszych nie rusza', async () => {
      await healthRows(3, 4);
      await healthRows(1, 2);

      const first = await admin.rpc('purge_ksef_health_log_batch', { p_limit: 2 });
      expect(first.error).toBeNull();
      expect(first.data).toBe(2);
      const second = await admin.rpc('purge_ksef_health_log_batch', { p_limit: 2 });
      expect(second.data).toBe(1);
      const last = await admin.rpc('purge_ksef_health_log_batch', {});
      expect(last.error).toBeNull();
      expect(last.data).toBe(0);

      expect(await marked('ksef_health_log', 3, true)).toBe(0);
      expect(await marked('ksef_health_log', 3, false)).toBe(1);
    });

    it.each([
      ['purge_inngest_run_log_batch', 0],
      ['purge_inngest_run_log_batch', 50_001],
      ['purge_ksef_health_log_batch', 0],
      ['purge_ksef_health_log_batch', 50_001],
    ])('%s: limit %s → błąd 22023', async (fn, limit) => {
      const { error } = await admin.rpc(fn, { p_limit: limit });
      expect(error?.code).toBe('22023');
    });
  });

  describe('uprawnienia', () => {
    it.each([
      ['purge_audit_logs_batch', { p_retention_months: 12, p_limit: 1 }],
      ['purge_inngest_run_log_batch', { p_limit: 1 }],
      ['purge_ksef_health_log_batch', { p_limit: 1 }],
    ])('anon nie wywoła %s przez PostgREST', async (fn, args) => {
      const { error } = await anonClient().rpc(fn, args);
      expect(error?.code).toBe('42501');
    });

    it.each(FUNCTIONS)('%s: EXECUTE tylko service_role (nie anon, nie authenticated)', async (fn) => {
      const [row] = await sql<{ anon: boolean; authenticated: boolean; service: boolean }>(
        `SELECT has_function_privilege('anon', $1::text, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', $1::text, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', $1::text, 'EXECUTE') AS service`,
        [`public.${fn}`],
      );
      expect(row).toEqual({ anon: false, authenticated: false, service: true });
    });

    it('zalogowany (rola authenticated) nie wywoła paczki — 42501', async () => {
      const { error } = await rolledBack(async (tx) => {
        await tx.executeSql('SET LOCAL ROLE authenticated');
        await tx.executeSql('SELECT public.purge_audit_logs_batch(12, 1)');
      });
      expect((error as { code?: string } | undefined)?.code).toBe('42501');
    });

    it('SECURITY DEFINER ze stałym search_path; stara cleanup_old_audit_logs zostaje do wdrożenia', async () => {
      const rows = await sql<{ name: string; definer: boolean; config: string[] | null }>(
        `SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS config
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname = ANY($1::text[])
          ORDER BY p.proname`,
        [['purge_audit_logs_batch', 'purge_inngest_run_log_batch', 'purge_ksef_health_log_batch', 'cleanup_old_audit_logs']],
      );
      expect(rows.map((r) => r.name)).toEqual([
        'cleanup_old_audit_logs',
        'purge_audit_logs_batch',
        'purge_inngest_run_log_batch',
        'purge_ksef_health_log_batch',
      ]);
      for (const r of rows) {
        expect(r.definer, r.name).toBe(true);
        expect((r.config ?? []).some((c) => c.startsWith('search_path=')), r.name).toBe(true);
        if (r.name !== 'cleanup_old_audit_logs') expect(r.config, r.name).toContain('plan_cache_mode=force_custom_plan');
      }
    });

    it('btree po dacie dla audit_logs i inngest_run_log — ważny, pierwsza kolumna to data', async () => {
      const rows = await sql<{ name: string; valid: boolean; method: string; first: string }>(
        `SELECT c.relname AS name, i.indisvalid AS valid, am.amname AS method, a.attname AS first
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_am am ON am.oid = c.relam
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
          WHERE c.relname = ANY($1::text[])
          ORDER BY c.relname`,
        [['idx_audit_logs_created_at', 'idx_inngest_run_log_created_at']],
      );
      expect(rows).toEqual([
        { name: 'idx_audit_logs_created_at', valid: true, method: 'btree', first: 'created_at' },
        { name: 'idx_inngest_run_log_created_at', valid: true, method: 'btree', first: 'created_at' },
      ]);
    });
  });
});
