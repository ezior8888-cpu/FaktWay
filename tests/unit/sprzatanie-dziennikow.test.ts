import { existsSync, readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

const s = vi.hoisted(() => ({ rpc: vi.fn() }));
const sentry = vi.hoisted(() => ({ addBreadcrumb: vi.fn(), captureMessage: vi.fn() }));

vi.mock('@sentry/nextjs', () => sentry);
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: s.rpc }) }));

import { cronMaxGapMs } from '@/lib/jobs/jobs-health';
import { CRON_JOBS } from '@/lib/jobs/queues';
import {
  LOG_PURGE_BATCH_LIMIT,
  LOG_PURGE_BUDGET_MS,
  LOG_PURGE_MAX_BATCHES,
  runCleanupAuditLogs,
} from '@/lib/jobs/runners/cleanup-audit-logs';

/**
 * Sesja 20 planu skalowania (DB-01 pkt 2, JOB-05, DBC-07, DB-09): runner
 * `cron.cleanup-audit-logs` woła trzy funkcje paczkowe z 00157 osobno, w pętli
 * aż do zera, z budżetem czasu i bezpiecznikiem postępu. Dziś woła jeden
 * `cleanup_old_audit_logs` — jeden DELETE wszystkich starych wierszy, który
 * przy milionach wierszy nie mieści się w 8 s PostgREST i nie usuwa nic.
 * Zachowanie na bazie: `tests/rls-sprzatanie-dziennikow.test.ts` (CI).
 */

const AUDIT = 'purge_audit_logs_batch';
const RUNS = 'purge_inngest_run_log_batch';
const HEALTH = 'purge_ksef_health_log_batch';
const STRIPE = 'prune_stripe_webhook_payloads';

type Args = Record<string, number>;
type RpcResult = { data: unknown; error: { message: string; code?: string } | null };

/** Atrapa: funkcja paczkowa usuwa min(zaległość, p_limit) i zwraca liczbę; `hooks` nadpisują odpowiedź. */
function fakeDatabase(backlog: Record<string, number>, hooks: Partial<Record<string, (args: Args) => RpcResult | undefined>> = {}) {
  const left = { ...backlog };
  s.rpc.mockReset().mockImplementation(async (fn: string, args: Args): Promise<RpcResult> => {
    const hooked = hooks[fn]?.(args);
    if (hooked) return hooked;
    if (fn === STRIPE) return { data: 0, error: null };
    if (!(fn in left)) return { data: null, error: { message: `brak funkcji ${fn}`, code: 'PGRST202' } };
    const n = Math.min(left[fn]!, args.p_limit!);
    left[fn]! -= n;
    return { data: n, error: null };
  });
  return left;
}

function calls(fn: string): Args[] {
  return s.rpc.mock.calls.filter(([name]) => name === fn).map(([, args]) => args as Args);
}

function context() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = { step: { run: async (_n: string, fn: () => unknown) => fn() }, logger, attempt: 0 } as unknown as JobContext;
  return { ctx, logger };
}

beforeEach(() => {
  sentry.addBreadcrumb.mockReset();
  sentry.captureMessage.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runner cron.cleanup-audit-logs: paczki do zera', () => {
  it('każda tabela osobno, w pętli aż funkcja zwróci 0; audyt z retencją 12 mies.; log z liczbami', async () => {
    fakeDatabase({ [AUDIT]: 45_000, [RUNS]: 25_000, [HEALTH]: 3 });
    const { ctx, logger } = context();

    const result = await runCleanupAuditLogs(ctx);

    expect(calls(AUDIT)).toEqual([
      { p_retention_months: 12, p_limit: LOG_PURGE_BATCH_LIMIT },
      { p_retention_months: 12, p_limit: LOG_PURGE_BATCH_LIMIT },
      { p_retention_months: 12, p_limit: LOG_PURGE_BATCH_LIMIT },
      { p_retention_months: 12, p_limit: LOG_PURGE_BATCH_LIMIT },
    ]);
    expect(calls(RUNS)).toHaveLength(3);
    expect(calls(HEALTH)).toEqual([{ p_limit: LOG_PURGE_BATCH_LIMIT }, { p_limit: LOG_PURGE_BATCH_LIMIT }]);
    // Stary jeden DELETE nie jest już wołany (funkcja zostaje w bazie do wdrożenia).
    expect(calls('cleanup_old_audit_logs')).toEqual([]);
    expect(calls(STRIPE)).toEqual([{ p_retention_days: 90 }]);

    expect(result.tables).toEqual({
      audit_logs: { deleted: 45_000, batches: 4, status: 'done' },
      inngest_run_log: { deleted: 25_000, batches: 3, status: 'done' },
      ksef_health_log: { deleted: 3, batches: 2, status: 'done' },
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('audit_logs 45000, inngest_run_log 25000, ksef_health_log 3'),
      expect.objectContaining({ deleted: { audit_logs: 45_000, inngest_run_log: 25_000, ksef_health_log: 3 } }),
    );
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('paczka = 20 000 wierszy, budżet = 10 min', () => {
    expect(LOG_PURGE_BATCH_LIMIT).toBe(20_000);
    expect(LOG_PURGE_BUDGET_MS).toBe(10 * 60_000);
  });

  it('budżet czasu: po 10 min przebieg kończy się bez błędu, reszta w kolejnym; mała tabela nie czeka na dużą', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T02:00:00.000Z'));
    // Każda paczka audytu „trwa” 61 s; zaległość większa niż zmieści się w budżecie.
    fakeDatabase({ [AUDIT]: 10_000_000, [RUNS]: 30_000, [HEALTH]: 5 }, {
      [AUDIT]: () => {
        vi.setSystemTime(Date.now() + 61_000);
        return undefined;
      },
    });
    const { ctx, logger } = context();

    const result = await runCleanupAuditLogs(ctx);

    const auditBatches = calls(AUDIT).length;
    expect(auditBatches).toBe(Math.ceil(LOG_PURGE_BUDGET_MS / 61_000));
    expect(result.tables.audit_logs).toEqual({ deleted: auditBatches * LOG_PURGE_BATCH_LIMIT, batches: auditBatches, status: 'budget' });
    expect(result.tables.inngest_run_log).toEqual({ deleted: 30_000, batches: 3, status: 'done' });
    expect(result.tables.ksef_health_log).toEqual({ deleted: 5, batches: 2, status: 'done' });
    expect(sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('budżet'),
      expect.objectContaining({ level: 'warning' }),
    );
    expect(logger.info).toHaveBeenCalled();
    expect(calls(STRIPE)).toHaveLength(1);
  });

  it('bezpiecznik postępu: tabela, która ciągle zwraca pełną paczkę, staje po LOG_PURGE_MAX_BATCHES', async () => {
    // Zegar stoi — bez bezpiecznika pętla nie miałaby końca.
    fakeDatabase({ [AUDIT]: Number.MAX_SAFE_INTEGER, [RUNS]: 0, [HEALTH]: 0 });
    const { ctx } = context();

    const result = await runCleanupAuditLogs(ctx);

    expect(calls(AUDIT)).toHaveLength(LOG_PURGE_MAX_BATCHES);
    expect(result.tables.audit_logs).toMatchObject({ batches: LOG_PURGE_MAX_BATCHES, status: 'cap' });
    expect(result.tables.inngest_run_log).toEqual({ deleted: 0, batches: 1, status: 'done' });
    expect(sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('bezpiecznik'),
      expect.objectContaining({ level: 'warning' }),
    );
  });
});

describe('runner cron.cleanup-audit-logs: niezależność tabel', () => {
  it('błąd jednej tabeli nie blokuje pozostałych ani retencji Stripe; job kończy się błędem z nazwą tabeli', async () => {
    fakeDatabase({ [RUNS]: 25_000, [HEALTH]: 7 }, {
      [AUDIT]: () => ({ data: null, error: { message: 'permission denied for function', code: '42501' } }),
    });
    const { ctx, logger } = context();

    await expect(runCleanupAuditLogs(ctx)).rejects.toThrow(/audit_logs.*42501/);

    expect(calls(AUDIT)).toHaveLength(1);
    expect(calls(RUNS)).toHaveLength(3);
    expect(calls(HEALTH)).toHaveLength(2);
    expect(calls(STRIPE)).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('audit_logs'), expect.anything());
    expect(logger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ deleted: { audit_logs: 0, inngest_run_log: 25_000, ksef_health_log: 7 } }),
    );
  });

  it('wyjątek klienta (sieć) w jednej tabeli — pozostałe idą dalej', async () => {
    fakeDatabase({ [AUDIT]: 3, [HEALTH]: 2 }, {
      [RUNS]: () => {
        throw new Error('fetch failed');
      },
    });
    const { ctx } = context();

    await expect(runCleanupAuditLogs(ctx)).rejects.toThrow(/inngest_run_log.*fetch failed/);

    expect(calls(AUDIT)).toHaveLength(2);
    expect(calls(HEALTH)).toHaveLength(2);
    expect(calls(STRIPE)).toHaveLength(1);
  });

  it('brak funkcji (kod wdrożony przed migracją 00157) — błąd każdej tabeli, czytelny dla operatora', async () => {
    fakeDatabase({});
    const { ctx } = context();

    await expect(runCleanupAuditLogs(ctx)).rejects.toThrow(/PGRST202.*00157/);

    expect(calls(AUDIT)).toHaveLength(1);
    expect(calls(RUNS)).toHaveLength(1);
    expect(calls(HEALTH)).toHaveLength(1);
  });

  it('nieoczekiwany wynik funkcji (nie liczba, więcej niż limit) → błąd tej tabeli, bez pętli bez końca', async () => {
    fakeDatabase({ [HEALTH]: 1 }, {
      [AUDIT]: () => ({ data: null, error: null }),
      [RUNS]: (args) => ({ data: args.p_limit! + 1, error: null }),
    });
    const { ctx } = context();

    await expect(runCleanupAuditLogs(ctx)).rejects.toThrow(/audit_logs[\s\S]*inngest_run_log/);

    expect(calls(AUDIT)).toHaveLength(1);
    expect(calls(RUNS)).toHaveLength(1);
    expect(calls(HEALTH)).toHaveLength(2);
  });

  it('limit czasu PostgREST (57014): paczka maleje o połowę zamiast stać; przy najmniejszej — błąd tabeli', async () => {
    let timeouts = 2;
    fakeDatabase({ [AUDIT]: 12_000, [RUNS]: 0, [HEALTH]: 0 }, {
      [AUDIT]: () => (timeouts-- > 0
        ? { data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } }
        : undefined),
    });
    const { ctx, logger } = context();

    const result = await runCleanupAuditLogs(ctx);

    expect(calls(AUDIT).map((a) => a.p_limit)).toEqual([20_000, 10_000, 5_000, 5_000, 5_000, 5_000]);
    expect(result.tables.audit_logs).toEqual({ deleted: 12_000, batches: 4, status: 'done' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('57014'), expect.anything());

    fakeDatabase({ [RUNS]: 0, [HEALTH]: 0 }, {
      [AUDIT]: () => ({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } }),
    });
    await expect(runCleanupAuditLogs(context().ctx)).rejects.toThrow(/audit_logs.*57014/);
    expect(calls(AUDIT).map((a) => a.p_limit)).toEqual([20_000, 10_000, 5_000, 2_500, 1_250, 1_000]);
  });
});

describe('harmonogram', () => {
  it('cron.cleanup-audit-logs codziennie o 03:00 (Warszawa) — strażnik kolejek pilnuje przerwy 26 h', () => {
    const def = CRON_JOBS.find((c) => c.queue === 'cron.cleanup-audit-logs');
    expect(def).toEqual({ queue: 'cron.cleanup-audit-logs', cron: '0 3 * * *', tz: 'Europe/Warsaw' });
    expect(cronMaxGapMs(def!.cron)).toBe(26 * 3600_000);
  });
});

describe('migracja 00157 (tekst; zachowanie na bazie: rls-sprzatanie-dziennikow)', () => {
  const path = 'supabase/migrations/00157_log_purge_batches.sql';
  // Checkout na Windowsie (core.autocrlf) zapisuje migrację z CRLF.
  const sql = existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : '';
  const bodies = [...sql.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((m) => m[1]!);

  it('plik istnieje, nagłówek: przed wdrożeniem, addytywna', () => {
    expect(sql).not.toBe('');
    expect(sql).toMatch(/PRZED wdrożeniem/);
  });

  it.each([
    'purge_audit_logs_batch(integer, integer)',
    'purge_inngest_run_log_batch(integer)',
    'purge_ksef_health_log_batch(integer)',
  ])('%s: EXECUTE tylko service_role', (fn) => {
    expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO service_role;`);
  });

  it('paczki z btree (audit_logs, inngest_run_log) od najstarszych po indeksie; ksef_health_log (sam BRIN) bez sortowania', () => {
    const body = (table: string) => bodies.find((b) => b.includes(`FROM public.${table}\n`))!;
    // ORDER BY po kolumnie z btree nie sortuje — wymusza zejście indeksem. Bez niego przy
    // nieaktualnych statystykach planista wybiera skan całej tabeli albo BRIN.
    expect(body('audit_logs')).toMatch(/WHERE created_at < v_cutoff\s+ORDER BY created_at\s+LIMIT p_limit/);
    expect(body('inngest_run_log')).toMatch(/WHERE created_at < now\(\) - interval '3 months'\s+ORDER BY created_at\s+LIMIT p_limit/);
    expect(body('ksef_health_log')).not.toMatch(/ORDER\s+BY/i);
  });

  it('trzy funkcje SECURITY DEFINER ze stałym search_path; paczki po ctid z LIMIT', () => {
    expect(sql.match(/SECURITY DEFINER\s+SET search_path = public, pg_temp/g)).toHaveLength(3);
    // Plan z prawdziwym cutoffem przy każdym wywołaniu: plan ogólny (po 5 wywołaniach
    // na jednym połączeniu PostgREST) zgaduje 1/3 tabeli i wybiera skan całej tabeli.
    expect(sql.match(/SET search_path = public, pg_temp\s+SET plan_cache_mode = force_custom_plan/g)).toHaveLength(3);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(body).toMatch(/ctid = ANY \(ARRAY\(/);
      expect(body).toMatch(/LIMIT p_limit/);
    }
  });

  it('audit_logs: flaga append-only w każdej paczce lokalnie dla transakcji i przywrócona po paczce', () => {
    const audit = bodies.find((b) => b.includes('public.audit_logs'))!;
    expect(audit).toContain("set_config('app.allow_audit_purge', 'true', true)");
    expect(audit).toContain("set_config('app.allow_audit_purge', COALESCE(v_prev, ''), true)");
  });

  it('bez DROP, TRUNCATE i zmian danych poza ciałami funkcji; stara cleanup_old_audit_logs nietknięta', () => {
    const outsideBodies = sql.replace(/\$\$[\s\S]*?\$\$/g, '');
    expect(outsideBodies).not.toMatch(/\b(DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s+public\.)/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/FUNCTION public\.cleanup_old_audit_logs/);
  });

  it('btree po dacie dla audit_logs i inngest_run_log: BRIN po codziennym usuwaniu obejmuje całą tabelę', () => {
    // Zwolnione strony dostają nowe wiersze, a zakres BRIN tylko się poszerza — bez btree
    // ostatnie wywołanie (to, które zwraca 0) czytałoby całą tabelę, ponad 8 s przy GB.
    const outsideBodies = sql.replace(/\$\$[\s\S]*?\$\$/g, '');
    expect(outsideBodies).toContain('CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at\n  ON public.audit_logs (created_at);');
    expect(outsideBodies).toContain('CREATE INDEX IF NOT EXISTS idx_inngest_run_log_created_at\n  ON public.inngest_run_log (created_at);');
  });

  it('rejestr numerów: 00157 zajęte w tym PR, „następny wolny” dalej', () => {
    const registry = readFileSync('docs/koordynacja/CLAUDE-DO-CODEXA.md', 'utf8');
    expect(registry).toMatch(/^\| 00157 \| Claude \(plan skalowania 3000, sesja 20\) \|/m);
    const next = /^\| \*\*(\d{5})\*\* \| — \| następny wolny/m.exec(registry)?.[1];
    expect(Number(next)).toBeGreaterThan(157);
  });
});
