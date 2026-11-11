import * as Sentry from '@sentry/nextjs';

import type { JobContext } from '@/lib/jobs/registry';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import {
  bumpInboxBackfillAttempt,
  INBOX_BACKFILL_ATTEMPTS_FIELD,
  INBOX_PENDING_FLAG,
} from '@/lib/ksef/inbox-pending';
import { ksefPausedUntil } from '@/lib/ksef/rate-limit-pause';
import { createAdminClient } from '@/lib/supabase/admin';
import { findWaitingJobsByDataField } from '@/lib/jobs/pending-jobs';
import { queuesForEvent } from '@/lib/jobs/queues';
import type { KsefEnvironment } from '@/types/ksef';

import { inboxInvoiceReceivedAutoCategorize } from '../events';

/**
 * Cron `cron.inbox-backfill` (co 15 min): domyka faktury ze skrzynki, dla
 * których kategoryzacja kosztu i archiwum XML nie doszły do skutku (K2 z
 * rewizji 03.10.2026, także W11 — faktury odebrane przed PR #183 bez XML).
 *
 * Kandydat: faktura przychodząca ze skrzynki w bieżącym środowisku KSeF,
 * starsza niż `INBOX_BACKFILL_MIN_AGE_MS` (żeby nie ścigać się ze świeżym
 * zdarzeniem z odbioru), z zapalonym `fa3_data._pendingFullFetch` i poniżej
 * limitu prób. Dla każdej emitujemy to samo zdarzenie co odbiór skrzynki
 * (`inbox/invoice-received`) i dopiero potem zwiększamy licznik prób: błąd emisji
 * nie zużywa próby, a błąd zapisu licznika kończy się co najwyżej jedną dodatkową
 * emisją.
 *
 * Faktury, których zadanie jeszcze czeka w kolejce, pomijamy (sesja 17 planu
 * skalowania). `singletonKey` na kolejce `standard` nie deduplikuje (`lib/jobs/
 * enqueue.ts`), więc przy długiej kolejce cron dokładał zadanie co 15 minut
 * i zużywał wszystkie próby, zanim pierwsze ruszyło. Dubel, który i tak powstanie
 * (wyścig, błąd odczytu kolejki), kończy się jednym odczytem w `auto-categorize-inbox`.
 *
 * Faktury firm w pauzie po 429 z KSeF (L1a, `rate-limit-pause.ts`) też pomijamy,
 * bez emisji i bez zużycia próby. Archiwum XML w pauzie nie wysyła żądania
 * (wynik `rate_limited`), a cron co 15 min zużywałby próbę za próbą: pauza
 * dłuższa niż ok. 75–90 min wyczerpałaby `INBOX_BACKFILL_MAX_ATTEMPTS` i faktura
 * zostałaby bez XML na stałe. Pauza jest na (środowisko, NIP): środowisko to
 * skonfigurowane środowisko KSeF (tylko takie faktury cron bierze), NIP to
 * `tenants.nip` — ten sam, którym firma loguje się do KSeF
 * (`getTenantKsefCredentials`). Przebieg, który mimo to trafi w pauzę (pauza
 * zaczęła się po emisji), próbę oddaje `auto-categorize-inbox`.
 *
 * Po `INBOX_BACKFILL_MAX_ATTEMPTS` faktura wypada z automatu i trafia do
 * operatora (Sentry + log); `auto-categorize-inbox` kończy ją
 * `NonRetriableError` z przyczyną (np. brak waluty w metadanych).
 */

export const INBOX_BACKFILL_MIN_AGE_MS = 15 * 60 * 1000;
export const INBOX_BACKFILL_MAX_ATTEMPTS = 6;
/** Rozsądna paczka na przebieg — przy zaległości kolejne przebiegi dobiorą resztę. */
export const INBOX_BACKFILL_LIMIT = 200;
/** Firm na jedno zapytanie o NIP (`in.(…)` w adresie PostgREST), jak `TENANTS_PER_QUERY` historii. */
export const INBOX_BACKFILL_TENANTS_PER_QUERY = 100;

type PendingRow = { id: string; tenant_id: string; created_at: string; fa3_data: unknown };

/**
 * Firmy (spośród `tenantIds`) w pauzie po 429 w środowisku `env`. Pauzę czyta
 * `ksefPausedUntil` (pamięć procesu + Redis, nigdy nie rzuca); rzuca tylko
 * błąd odczytu NIP-ów z bazy.
 */
async function pausedTenantIds(
  supabase: ReturnType<typeof createAdminClient>,
  env: KsefEnvironment,
  tenantIds: string[],
): Promise<Set<string>> {
  const paused = new Set<string>();
  for (let i = 0; i < tenantIds.length; i += INBOX_BACKFILL_TENANTS_PER_QUERY) {
    const part = tenantIds.slice(i, i + INBOX_BACKFILL_TENANTS_PER_QUERY);
    const { data, error } = await supabase.from('tenants').select('id, nip').in('id', part);
    if (error) throw new Error(`Skrzynka: nie można odczytać NIP-ów firm: ${error.message}`);
    const tenants = (data ?? []) as Array<{ id: string; nip: string | null }>;
    // Równolegle: przy awarii Redisa każdy odczyt czeka do swojego limitu czasu.
    const until = await Promise.all(tenants.map((t) => (t.nip ? ksefPausedUntil(env, t.nip) : null)));
    tenants.forEach((t, index) => {
      if (until[index] !== null) paused.add(t.id);
    });
  }
  return paused;
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-d.ts (kolejka cron.inbox-backfill).
 */
export async function runInboxBackfill({ step, logger }: JobContext) {
  const env = requireConfiguredKsefEnvironment();
  const cutoffIso = new Date(Date.now() - INBOX_BACKFILL_MIN_AGE_MS).toISOString();
  const supabase = createAdminClient();
  const pendingFlag = `fa3_data->>${INBOX_PENDING_FLAG}`;
  const attemptsField = `fa3_data->>${INBOX_BACKFILL_ATTEMPTS_FIELD}`;

  const pending = await step.run('find-pending', async (): Promise<PendingRow[]> => {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, tenant_id, created_at, fa3_data')
      .eq('direction', 'incoming')
      .eq('origin', 'ksef_inbox')
      .eq('ksef_status', 'accepted')
      .eq('ksef_environment', env)
      .eq(pendingFlag, 'true')
      // Porównanie tekstowe JSON-a: licznik nigdy nie przekracza
      // INBOX_BACKFILL_MAX_ATTEMPTS (jedna cyfra), więc `lt` na tekście jest poprawne.
      .or(`${attemptsField}.is.null,${attemptsField}.lt.${INBOX_BACKFILL_MAX_ATTEMPTS}`)
      .lt('created_at', cutoffIso)
      .order('created_at', { ascending: true })
      .limit(INBOX_BACKFILL_LIMIT);
    if (error) throw new Error(`Skrzynka: nie można odczytać faktur do uzupełnienia: ${error.message}`);
    return (data ?? []) as PendingRow[];
  });

  const toEmit = await step.run('skip-waiting', async (): Promise<PendingRow[]> => {
    if (pending.length === 0) return pending;
    try {
      const waiting = await findWaitingJobsByDataField(
        queuesForEvent(inboxInvoiceReceivedAutoCategorize.name)[0]!,
        'invoiceId',
        pending.map((row) => row.id),
      );
      return pending.filter((row) => !waiting.has(row.id));
    } catch (e) {
      // Bez odczytu kolejki emitujemy jak dawniej: dubel to tylko jeden odczyt.
      logger.warn('Skrzynka: nie udało się sprawdzić czekających zadań, cron wysyła wszystkie', {
        error: e instanceof Error ? e.message : String(e),
      });
      return pending;
    }
  });

  const { ready, paused } = await step.run('skip-paused', async (): Promise<{ ready: PendingRow[]; paused: number }> => {
    if (toEmit.length === 0) return { ready: toEmit, paused: 0 };
    try {
      const pausedTenants = await pausedTenantIds(supabase, env, [...new Set(toEmit.map((row) => row.tenant_id))]);
      const notPaused = toEmit.filter((row) => !pausedTenants.has(row.tenant_id));
      return { ready: notPaused, paused: toEmit.length - notPaused.length };
    } catch (e) {
      // Bez NIP-ów emitujemy jak dawniej: archiwum w pauzie skończy się
      // `rate_limited` bez żądania do KSeF, a próbę odda `auto-categorize-inbox`.
      logger.warn('Skrzynka: nie udało się sprawdzić pauzy firm po 429, cron wysyła wszystkie', {
        error: e instanceof Error ? e.message : String(e),
      });
      return { ready: toEmit, paused: 0 };
    }
  });

  if (ready.length > 0) {
    await step.sendEvent(
      'backfill-auto-categorize',
      ready.map((row) => ({
        ...inboxInvoiceReceivedAutoCategorize.create({
          invoiceId: row.id,
          tenantId: row.tenant_id,
          environment: env,
        }),
        singletonKey: row.id,
      })),
    );

    await step.run('bump-attempts', async () => {
      for (const row of ready) {
        await bumpInboxBackfillAttempt(supabase, row);
      }
    });
  }

  const exhausted = await step.run('count-exhausted', async (): Promise<number> => {
    const { count, error } = await supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('direction', 'incoming')
      .eq('origin', 'ksef_inbox')
      .eq('ksef_status', 'accepted')
      .eq('ksef_environment', env)
      .eq(pendingFlag, 'true')
      .filter(attemptsField, 'gte', String(INBOX_BACKFILL_MAX_ATTEMPTS));
    if (error || typeof count !== 'number') {
      throw new Error(`Skrzynka: nie można policzyć faktur po wyczerpaniu prób: ${error?.message ?? 'brak liczby'}`);
    }
    return count;
  });

  if (exhausted > 0) {
    logger.error('Skrzynka: faktury bez kosztu lub XML po wyczerpaniu prób uzupełnienia — wymagają operatora', {
      exhausted,
      maxAttempts: INBOX_BACKFILL_MAX_ATTEMPTS,
    });
    Sentry.captureMessage('Skrzynka KSeF: faktury bez kategoryzacji po wyczerpaniu prób uzupełnienia', {
      level: 'error',
      tags: { job: 'inbox-backfill' },
      extra: { exhausted, maxAttempts: INBOX_BACKFILL_MAX_ATTEMPTS },
    });
  }

  logger.info('Skrzynka: uzupełnianie kategoryzacji', {
    scanned: pending.length,
    emitted: ready.length,
    paused,
    exhausted,
  });

  return { scanned: pending.length, emitted: ready.length, paused, exhausted };
}
