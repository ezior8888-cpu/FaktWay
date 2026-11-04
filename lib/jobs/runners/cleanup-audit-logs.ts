// Cron job: retencja dzienników paczkami (migracja 00157) — audit_logs po
// 12 miesiącach, inngest_run_log i ksef_health_log po 3 miesiącach — oraz
// surowe zdarzenia Stripe po 90 dniach.
//
// Faza 21 (sekcja 21.3) — bez tego audit_logs rosną w nieskończoność,
// w prior projektach widzieliśmy >5GB po roku produkcji. RODO retention dla
// faktur to 10 lat (tenants.retention_years), ale audit_logs to nie dane
// podatkowe, więc 12mc jest legalnie OK.
//
// Dlaczego paczkami (plan skalowania, sesja 20, DB-01): dawny jeden DELETE
// wszystkich starych wierszy szedł przez PostgREST, który ucina zapytanie po
// 8 s. Przy milionach wierszy transakcja się cofała i nie znikało nic. Teraz
// każda funkcja usuwa najwyżej LOG_PURGE_BATCH_LIMIT wierszy na wywołanie,
// a runner woła ją w pętli, aż zwróci 0.
//
// Kolejność: rundami, po jednej paczce z każdej tabeli, więc zaległość jednej
// nie zabiera budżetu pozostałym. Błąd tabeli zatrzymuje tylko ją; job kończy
// się błędem dopiero po pozostałych tabelach i po retencji Stripe.
//
// Trigger: codziennie o 03:00 PL. Zwykle przebieg usuwa jeden dzień wierszy;
// zaległość (np. po awarii) schodzi w kolejnych nocach, po
// LOG_PURGE_BUDGET_MS na przebieg.
//
// Ponowienie od zera jest bezpieczne: każda paczka to osobna transakcja
// z warunkiem daty, więc powtórka usuwa tylko to, co zostało. Kolejka ma
// 1 retry (package-a.ts), bo każde ponowienie to kolejny pełny budżet.

import * as Sentry from '@sentry/nextjs';

import type { JobContext } from '@/lib/jobs/registry';
import { createAdminClient } from '@/lib/supabase/admin';

const DEFAULT_RETENTION_MONTHS = 12;

/** Wierszy na jedno wywołanie funkcji (00157 przyjmuje 1–50 000). */
export const LOG_PURGE_BATCH_LIMIT = 20_000;
/** Najmniejsza paczka po zmniejszaniu przy limicie czasu PostgREST. */
const LOG_PURGE_MIN_BATCH_LIMIT = 1_000;
/** Budżet czasu sprzątania na przebieg; resztę bierze następna noc. */
export const LOG_PURGE_BUDGET_MS = 10 * 60_000;
/** Bezpiecznik postępu: najwyżej tyle paczek jednej tabeli na przebieg (20 mln wierszy). */
export const LOG_PURGE_MAX_BATCHES = 1_000;

/** `statement_timeout` — PostgREST uciął paczkę, transakcja cofnięta. */
const STATEMENT_TIMEOUT = '57014';

const LOG_PURGE_TARGETS = [
  { table: 'audit_logs', fn: 'purge_audit_logs_batch', args: { p_retention_months: DEFAULT_RETENTION_MONTHS } },
  { table: 'inngest_run_log', fn: 'purge_inngest_run_log_batch', args: {} },
  { table: 'ksef_health_log', fn: 'purge_ksef_health_log_batch', args: {} },
] as const;

type LogTable = (typeof LOG_PURGE_TARGETS)[number]['table'];

interface LogPurgeOutcome {
  deleted: number;
  batches: number;
  /** done = funkcja zwróciła 0; budget / cap = reszta w następnym przebiegu. */
  status: 'pending' | 'done' | 'budget' | 'cap' | 'error';
  error?: string;
}

type PurgeClient = ReturnType<typeof createAdminClient>;

/** Rundy po jednej paczce z każdej tabeli, aż wszystkie zwrócą 0, budżet się skończy albo tabela padnie. */
async function purgeLogTables(
  supabase: PurgeClient,
  logger: JobContext['logger'],
  startedAt: number,
): Promise<Record<LogTable, LogPurgeOutcome>> {
  const state = LOG_PURGE_TARGETS.map((target) => ({
    target,
    limit: LOG_PURGE_BATCH_LIMIT,
    outcome: { deleted: 0, batches: 0, status: 'pending' } as LogPurgeOutcome,
  }));

  while (state.some((s) => s.outcome.status === 'pending')) {
    for (const s of state) {
      const { target, outcome } = s;
      if (outcome.status !== 'pending') continue;
      if (Date.now() - startedAt >= LOG_PURGE_BUDGET_MS) {
        outcome.status = 'budget';
        continue;
      }
      if (outcome.batches >= LOG_PURGE_MAX_BATCHES) {
        outcome.status = 'cap';
        continue;
      }

      let data: unknown;
      let error: { message: string; code?: string } | null;
      try {
        ({ data, error } = await supabase.rpc(target.fn, { ...target.args, p_limit: s.limit }));
      } catch (e) {
        data = null;
        error = { message: e instanceof Error ? e.message : String(e) };
      }

      if (error?.code === STATEMENT_TIMEOUT && s.limit > LOG_PURGE_MIN_BATCH_LIMIT) {
        // Paczka cofnięta w całości — mniejsza zmieści się w limicie czasu.
        s.limit = Math.max(LOG_PURGE_MIN_BATCH_LIMIT, Math.floor(s.limit / 2));
        logger.warn(`Sprzątanie ${target.table}: limit czasu (${STATEMENT_TIMEOUT}), paczka ${s.limit}`, {
          table: target.table,
          limit: s.limit,
        });
        continue;
      }
      if (error) {
        const hint = error.code === 'PGRST202' ? ' — czy migracja 00157 jest wgrana?' : '';
        outcome.status = 'error';
        outcome.error = `${error.code ? `${error.code}: ` : ''}${error.message}${hint}`;
        logger.error(`Sprzątanie ${target.table} przerwane — pozostałe tabele idą dalej`, { error: outcome.error });
        continue;
      }
      if (typeof data !== 'number' || !Number.isInteger(data) || data < 0 || data > s.limit) {
        outcome.status = 'error';
        outcome.error = `nieoczekiwany wynik ${target.fn}: ${JSON.stringify(data)}`;
        logger.error(`Sprzątanie ${target.table} przerwane — pozostałe tabele idą dalej`, { error: outcome.error });
        continue;
      }

      outcome.batches += 1;
      outcome.deleted += data;
      if (data === 0) outcome.status = 'done';
    }
  }

  return Object.fromEntries(state.map((s) => [s.target.table, s.outcome])) as Record<LogTable, LogPurgeOutcome>;
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-a.ts (kolejka cron.cleanup-audit-logs).
 */
export async function runCleanupAuditLogs({ step, logger }: JobContext) {
    const supabase = createAdminClient();
    const startedAt = Date.now();

    const tables = await step.run('purge-logs', () => purgeLogTables(supabase, logger, startedAt));
    const durationMs = Date.now() - startedAt;

    const entries = Object.entries(tables) as [LogTable, LogPurgeOutcome][];
    const deleted = Object.fromEntries(entries.map(([table, o]) => [table, o.deleted]));
    logger.info(
      `Sprzątanie dzienników: usunięto ${entries.map(([table, o]) => `${table} ${o.deleted}`).join(', ')} (${durationMs} ms)`,
      { deleted, tables, durationMs },
    );

    Sentry.addBreadcrumb({
      category: 'db.cleanup',
      level: 'info',
      message: 'log retention completed',
      data: { deleted, durationMs },
    });

    // Reszta czeka do jutra; przy stałym przekraczaniu dzienniki rosną szybciej, niż je sprzątamy.
    const unfinished = entries.filter(([, o]) => o.status === 'budget' || o.status === 'cap');
    if (unfinished.length > 0) {
      const reason = unfinished.some(([, o]) => o.status === 'cap') ? 'bezpiecznik postępu' : 'budżet czasu';
      Sentry.captureMessage(`Sprzątanie dzienników: ${reason}, reszta w następnym przebiegu`, {
        level: 'warning',
        extra: { tables, durationMs },
      });
    }

    // Retencja surowych zdarzeń Stripe: 90 dni od przetworzenia (AUD-81, B9).
    // Ten sam przebieg — bez osobnego crona.
    const stripePayloadsPruned = await step.run('prune-stripe-payloads', async () => {
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string,
        args: { p_retention_days: number },
      ) => Promise<{ data: number | null; error: { message: string } | null }>)('prune_stripe_webhook_payloads', {
        p_retention_days: STRIPE_PAYLOAD_RETENTION_DAYS,
      });
      if (error) throw new Error(`prune_stripe_webhook_payloads failed: ${error.message}`);
      return data ?? 0;
    });

    // Błąd tabeli kończy job błędem (ponowienie od zera jest bezpieczne), ale dopiero po pozostałych.
    const failed = entries.filter(([, o]) => o.status === 'error');
    if (failed.length > 0) {
      throw new Error(
        `Sprzątanie dzienników nieudane: ${failed.map(([table, o]) => `${table} (${o.error})`).join('; ')}`,
      );
    }

    return { tables, duration_ms: durationMs, stripe_payloads_pruned: stripePayloadsPruned };
}

/** Surowe zdarzenia Stripe po przetworzeniu (decyzja B9). */
const STRIPE_PAYLOAD_RETENTION_DAYS = 90;
