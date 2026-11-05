/**
 * Synchronizacja historii KSeF (decyzja Bartosza 22.10.2026) — zastępuje
 * Magiczny import. Dwa joby:
 *
 *   1. `cron.ksef-history-sync` (co 15 min) — zakłada strumienie firm
 *      z certyfikatem, zapisuje wygasły certyfikat, wybiera firmy z pracą
 *      i robi fan-out w limicie czasu slotów (`planFanOut`). Globalny
 *      bezpiecznik: ≥ 3 firmy z 429 w godzinie = bez fan-outu (alarm
 *      `ksef_history_rate_limited`).
 *   2. `ksef.history-sync.tenant` — przebieg jednej firmy pod dzierżawą:
 *      ponowne sprawdzenia (tylko baza) → sygnały ustępowania → zapytania
 *      o metadane (bieżąca sprzedaż, potem zaległość round-robin) → pobrania
 *      XML co ≥ 6 s → zapis stanu firmy.
 *
 * Inwarianty (szczegóły: docs/runbooks/synchronizacja-historii-ksef.md):
 *   - każda faktura z KSeF jest fakturą FaktWay / ze skrzynki albo wierszem
 *     dziennika z powodem; nic nie ginie po cichu, jedna zła faktura nie
 *     zatrzymuje kursora,
 *   - kursory ruszają się dopiero PO zapisie strony w dzienniku i CAS-em,
 *   - fakturę zapisuje wyłącznie silnik importu (`source: 'ksef_history'`,
 *     pochodzenie `ksef_import`); faktur FaktWay i przeniesionych plikiem
 *     synchronizacja nie zmienia,
 *   - zakupy z historii to archiwum: bez kosztów, KPiR i katalogów,
 *   - 429 = pauza firmy na pełny `Retry-After`, bez zużywania prób,
 *   - pg-boss bez ponowień (`maxRetries 0`) — ponowieniem jest następny cron;
 *     ponowienie od zera w dowolnym miejscu trafia w klucze tożsamości i CAS.
 *
 * NIE importuje ścieżki wysyłki (`lib/ksef/submit*`, `submit-invoice-full`,
 * `send-attempt-ledger`, runnery wysyłki) — strażnik OUTGOING_SINKS
 * (tests/unit/flo-architecture.test.ts) i tests/unit/ksef-historia-stale-czyste.test.ts.
 */

import * as Sentry from '@sentry/nextjs';

import { logAuditSystem } from '@/lib/audit/log-system';
import { parseFa3Xml } from '@/lib/import/fa3-parser';
import { processImportedInvoicesDetailed, type CatalogPolicy } from '@/lib/import/import-engine';
import {
  archiveImportedKsefXml,
  decodeKsefXml,
  KsefXmlArchiveConflictError,
} from '@/lib/import/ksef-xml-archive';
import type { KsefAuth } from '@/lib/ksef/auth';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { estimateRunSeconds, planFanOut, readYieldSignals, type FanOutCandidate } from '@/lib/ksef/history-sync/budget';
import {
  classifyDiscovered,
  classifyForProcessing,
  itemPatchFor,
  type ClassifyContext,
  type ProcessingOutcome,
} from '@/lib/ksef/history-sync/classify';
import {
  BLOCKED_RECHECK_MS,
  DOWNLOAD_SPACING_MS,
  FANOUT_SLOT_SECONDS,
  GLOBAL_429_TENANTS,
  ITEM_MAX_ATTEMPTS,
  KSEF_NOT_READY_RETRY_MS,
  LEASE_MS,
  MAX_ITEMS_PER_STREAM,
  RECHECK_LIMIT,
  RETIRED_RECHECK_MS,
  RUN_DEADLINE_MS,
} from '@/lib/ksef/history-sync/constants';
import {
  asHistoryClient,
  claimLease,
  countStreamItems,
  ensureIncomingStreams,
  ensureOutgoingStreams,
  KSEF_HISTORY_RECHECK_BLOCKED_REASONS,
  loadStreams,
  loadStreamsForTenants,
  readCounts,
  releaseLease,
  selectDownloadQueue,
  selectRecheckItems,
  updateBackfillCas,
  updateItemCas,
  updateLiveCas,
  updateStreamById,
  updateStreamCas,
  upsertItems,
  type HistoryClient,
  type KsefHistoryCountRow,
  type KsefHistoryEnvironment,
  type KsefHistoryItemPatch,
  type KsefHistoryItemRow,
  type KsefHistorySessionErrorCode,
  type KsefHistorySyncRow,
} from '@/lib/ksef/history-sync/db';
import { classifyHistoryError, unexpectedErrorDetail } from '@/lib/ksef/history-sync/errors';
import { downloadInvoiceXmlBytes, queryMetadataPage, type MetadataPage } from '@/lib/ksef/history-sync/query';
import {
  applyBackfillPage,
  applyLivePage,
  backfillWindow,
  historyBudget,
  historyFloorFor,
  initialIncomingStream,
  initialOutgoingStream,
  isLiveDue,
  liveWindow,
  lowerHistoryFloor,
  type HistoryDirection,
} from '@/lib/ksef/history-sync/windows';
import { ksefSessionCache } from '@/lib/ksef/session-cache';
import { forEachPageById } from '@/lib/pagination/keyset';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantKsefCredentials } from '@/lib/supabase/admin-queries';
import type { JobContext } from '@/lib/jobs/registry';

import { NonRetriableError } from '../errors';
import { ksefHistorySyncTenant } from '../events';

type AdminClient = ReturnType<typeof createAdminClient>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR_MS = 3_600_000;
/** Ile pozycji kolejki czytamy na przebieg (część rozstrzyga się bez pobrania). */
const QUEUE_READ_FACTOR = 3;
/** Przebieg tylko z pracą w bazie (ponowne sprawdzenia) — najwyżej co godzinę. */
const DB_ONLY_RUN_INTERVAL_MS = HOUR_MS;
/** Zapytanie `in.(…)` po firmach — paczki jak w skrzynce. */
const TENANTS_PER_QUERY = 100;

interface TenantRow {
  id: string;
  nip: string;
  ksef_verified_at: string | null;
  ksef_certificate_expiry: string | null;
  business_started_on: string | null;
}

function certificateExpired(expiry: string | null | undefined, now: Date): boolean {
  if (!expiry) return false;
  const at = Date.parse(expiry);
  return Number.isFinite(at) && at < now.getTime();
}

/** Wygasły certyfikat: zapis kodu na wierszu sprzedaży (tylko gdy inny), CAS na `updated_at`. */
async function recordCertificateExpired(
  history: HistoryClient,
  stream: KsefHistorySyncRow | undefined,
  now: Date,
): Promise<boolean> {
  if (!stream || stream.last_error_code === 'certificate_expired') return false;
  const updated = await updateStreamCas(history, stream, {
    last_error_code: 'certificate_expired',
    last_error_detail: null,
    last_error_at: now.toISOString(),
  });
  return updated !== null;
}

/**
 * Nowy certyfikat wgrany (data ważności znana i w przyszłości): zapisany
 * `certificate_expired` jest nieaktualny — czyścimy go od razu, nie dopiero
 * po udanym przebiegu (ekran i alarm „stoi” widzą prawdziwy stan). CAS na
 * `updated_at`; przegrany wyścig = następny cykl.
 */
async function clearRenewedCertificate(history: HistoryClient, stream: KsefHistorySyncRow): Promise<boolean> {
  const updated = await updateStreamCas(history, stream, {
    last_error_code: null,
    last_error_detail: null,
    last_error_at: null,
    consecutive_failures: 0,
  });
  return updated !== null;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function backfillEligible(stream: KsefHistorySyncRow | undefined, now: Date): stream is KsefHistorySyncRow {
  if (!stream || stream.backfill_completed_at || stream.backfill_issue === 'capacity') return false;
  if (stream.backfill_issue === 'internal' && stream.backfill_issue_at
      && now.getTime() - Date.parse(stream.backfill_issue_at) < HOUR_MS) return false;
  return true;
}

function sumCounts(rows: KsefHistoryCountRow[], tenantId: string, pick: (row: KsefHistoryCountRow) => boolean): number {
  return rows.filter((r) => r.tenant_id === tenantId && pick(r)).reduce((acc, r) => acc + (Number(r.item_count) || 0), 0);
}

// ═══════════════════════════════════════════════════════════════
// CRON: strumienie, wybór firm, fan-out
// ═══════════════════════════════════════════════════════════════

export interface KsefHistoryCronResult {
  breaker: boolean;
  tenants: number;
  created: number;
  enqueued: number;
  deferredByCap: number;
  certificateExpired: number;
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-d.ts (kolejka cron.ksef-history-sync).
 */
export async function runKsefHistorySync({ step, logger }: JobContext): Promise<KsefHistoryCronResult> {
  const env = requireConfiguredKsefEnvironment();
  const now = new Date();
  const admin = createAdminClient();
  const history = asHistoryClient(admin);
  const result: KsefHistoryCronResult = {
    breaker: false, tenants: 0, created: 0, enqueued: 0, deferredByCap: 0, certificateExpired: 0,
  };

  // 1. Globalny bezpiecznik: wiele firm z 429 naraz = KSeF ogranicza nasz adres.
  const rateLimited = await step.run('global-breaker', async () => {
    const { count, error } = await history
      .from('ksef_history_sync')
      .select('id', { count: 'exact', head: true })
      .eq('environment', env)
      .eq('direction', 'outgoing')
      .gt('rate_limited_at', new Date(now.getTime() - HOUR_MS).toISOString());
    if (error || typeof count !== 'number') throw new Error(`Historia KSeF: odczyt bezpiecznika: ${error?.message ?? 'brak liczby'}`);
    return count;
  });
  if (rateLimited >= GLOBAL_429_TENANTS) {
    logger.warn('Historia KSeF: globalny bezpiecznik 429 — bez fan-outu w tym cyklu', { rateLimited });
    return { ...result, breaker: true };
  }

  // 2.–6. Firmy (certyfikat, NIP zweryfikowany w tym środowisku, aktywne,
  // nieusunięte) stronami po kluczu (sesja 27 planu skalowania, JOB-11).
  // Dawniej jedno zapytanie oddawało najwyżej 1000 firm (PGRST_DB_MAX_ROWS),
  // a strumienie i liczniki czytane dla całego środowiska były ucięte jeszcze
  // wcześniej — firmy po cichu wypadały z cyklu. Strumienie, kursory skrzynki
  // i liczniki czytamy dla BIEŻĄCEJ strony firm (paczki `in.(…)` w db.ts),
  // a plan fan-outu (sloty, kolejność po `lastRunAt`, zlecenia w kolejce) jest
  // globalny — liczymy go raz, po wszystkich stronach.
  const candidates: Array<FanOutCandidate & { nip: string }> = [];
  const budget = historyBudget(now);
  // Czas slotów zajęty przez zlecenia poprzednich cykli, które jeszcze nie
  // ruszyły — nowy fan-out mieści się w reszcie, więc przekroczenie szacunku
  // nie narasta z cyklu na cykl (próg „zaległe” heartbeatu).
  let inFlightSeconds = 0;
  await forEachPageById<TenantRow>(
    'Historia KSeF: odczyt firm',
    (afterId, limit) => step.run('list-tenants', async () => {
      let query = admin
        .from('tenants')
        .select('id, nip, ksef_verified_at, ksef_certificate_expiry, business_started_on')
        .not('ksef_credentials_encrypted', 'is', null)
        .not('ksef_verified_at', 'is', null)
        .eq('ksef_verified_environment', env)
        .is('deleted_at', null)
        .eq('is_active', true);
      if (afterId) query = query.gt('id', afterId);
      return query.order('id', { ascending: true }).limit(limit);
    }),
    async (tenants) => {
      result.tenants += tenants.length;
      const tenantIds = tenants.map((t) => t.id);

      // 3. Strumienie sprzedaży (ON CONFLICT DO NOTHING).
      result.created += await step.run('ensure-outgoing-streams', () => ensureOutgoingStreams(history, env,
        tenants.map((t) => ({ tenantId: t.id, initial: initialOutgoingStream(now, historyFloorFor(t.business_started_on)) }))));

      // 4. Strumienie zakupów — dopiero gdy skrzynka ma HWM (granica U).
      let streams = await step.run('load-streams', () => loadStreamsForTenants(history, env, tenantIds));
      const withoutIncoming = tenants.filter((t) => !streams.some((s) => s.tenant_id === t.id && s.direction === 'incoming'));
      if (withoutIncoming.length > 0) {
        result.created += await step.run('ensure-incoming-streams', async () => {
          const rows: Array<{ tenantId: string; initial: ReturnType<typeof initialIncomingStream> }> = [];
          for (const part of chunks(withoutIncoming, TENANTS_PER_QUERY)) {
            const { data, error } = await admin
              .from('ksef_inbox_cursor')
              .select('tenant_id, window_to')
              .in('tenant_id', part.map((t) => t.id));
            if (error) throw new Error(`Historia KSeF: odczyt kursora skrzynki: ${error.message}`);
            const hwmByTenant = new Map(((data ?? []) as Array<{ tenant_id: string; window_to: string | null }>)
              .map((r) => [r.tenant_id, r.window_to] as const));
            for (const tenant of part) {
              const hwm = hwmByTenant.get(tenant.id);
              if (!hwm) continue;
              rows.push({ tenantId: tenant.id, initial: initialIncomingStream(now, historyFloorFor(tenant.business_started_on), hwm) });
            }
          }
          return ensureIncomingStreams(history, env, rows);
        });
        streams = await step.run('reload-streams', () => loadStreamsForTenants(history, env, tenantIds));
      }

      // 5. Liczniki do szacunku przebiegu.
      const counts = await step.run('read-counts', () => readCounts(history, env, ['pending', 'deferred', 'blocked', 'skipped'], tenantIds));

      // 6. Wybór firm z pracą.
      for (const tenant of tenants) {
        const outgoing = streams.find((s) => s.tenant_id === tenant.id && s.direction === 'outgoing');
        const incoming = streams.find((s) => s.tenant_id === tenant.id && s.direction === 'incoming');
        if (!outgoing) continue;
        if (certificateExpired(tenant.ksef_certificate_expiry, now)) {
          if (await step.run('record-certificate-expired', () => recordCertificateExpired(history, outgoing, now))) {
            result.certificateExpired += 1;
          }
          continue;
        }
        if (outgoing.last_error_code === 'certificate_expired' && tenant.ksef_certificate_expiry) {
          await step.run('clear-renewed-certificate', () => clearRenewedCertificate(history, outgoing));
        }
        const nowMs = now.getTime();
        if (outgoing.client_paused_at) continue;
        if (outgoing.paused_until && Date.parse(outgoing.paused_until) > nowMs) continue;
        if (outgoing.lease_until && Date.parse(outgoing.lease_until) > nowMs) continue;
        const enqueuedMs = outgoing.last_enqueued_at ? Date.parse(outgoing.last_enqueued_at) : null;
        const runMs = outgoing.last_run_at ? Date.parse(outgoing.last_run_at) : null;
        const waitingInQueue = enqueuedMs !== null && (runMs === null || runMs < enqueuedMs) && enqueuedMs >= nowMs - HOUR_MS;

        const liveDue = isLiveDue(outgoing.live_checked_at, now) && liveWindow(outgoing, now) !== null;
        // Niższy początek historii (poprawiona data rozpoczęcia) otwiera zaległość —
        // obniża go przebieg firmy pod dzierżawą, cron tylko go zleca.
        const floor = historyFloorFor(tenant.business_started_on);
        const backfillOpen = [outgoing, incoming]
          .filter((s) => backfillEligible(s, now) || (s !== undefined && lowerHistoryFloor(s, floor) !== null)).length;
        const metadataCalls = Math.min(budget.metadata, (liveDue ? 1 : 0) + backfillOpen);
        const pending = sumCounts(counts, tenant.id, (r) => r.status === 'pending');
        // Pobrania idą PO odkrywaniu w tym samym przebiegu: przy otwartej
        // zaległości zapytanie zapełnia kolejkę, więc szacujemy pełny budżet
        // pobrań, nie stan kolejki sprzed przebiegu (poprawka po przeglądzie,
        // decyzja Bartosza 22.10.2026). Firma tylko z bieżącą sprzedażą — kolejka.
        const downloads = backfillOpen > 0 && metadataCalls > 0
          ? budget.downloads
          : Math.min(budget.downloads, pending);
        const estimateSeconds = estimateRunSeconds({ metadataCalls, downloads });
        if (waitingInQueue) {
          inFlightSeconds += estimateSeconds;
          continue;
        }
        const recheckable = sumCounts(counts, tenant.id, (r) => r.status === 'deferred'
          || (r.status === 'blocked' && (KSEF_HISTORY_RECHECK_BLOCKED_REASONS as readonly string[]).includes(r.reason_code ?? ''))
          || (r.status === 'skipped' && r.reason_code === 'retired_draft'));
        const dbWork = recheckable > 0 && (runMs === null || runMs < nowMs - DB_ONLY_RUN_INTERVAL_MS);
        if (metadataCalls === 0 && downloads === 0 && !dbWork) continue;
        candidates.push({
          tenantId: tenant.id,
          nip: tenant.nip,
          lastRunAt: outgoing.last_run_at,
          estimateSeconds,
        });
      }
    },
  );
  if (result.tenants === 0) return result;

  // 7. Fan-out w limicie slotów (najdawniej obsłużone pierwsze), pomniejszonym
  // o zlecenia wciąż czekające w kolejce.
  const { planned, deferred } = planFanOut(candidates, Math.max(0, FANOUT_SLOT_SECONDS - inFlightSeconds));
  result.deferredByCap = deferred.length;
  const sent: string[] = [];
  for (const candidate of planned) {
    try {
      // `groupId` = NIP: jeden przebieg na NIP w pg-boss (jak skrzynka, AUD-91).
      await step.sendEvent('fan-out-history-sync', {
        ...ksefHistorySyncTenant.create({ tenantId: candidate.tenantId, nip: candidate.nip, environment: env }),
        groupId: candidate.nip,
      });
      sent.push(candidate.tenantId);
    } catch (error) {
      logger.error('Historia KSeF: nie wysłano przebiegu firmy — spróbujemy w następnym cyklu', {
        tenantId: candidate.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      Sentry.captureException(error, { tags: { job: 'ksef-history-sync', step: 'fan-out' } });
    }
  }
  if (sent.length > 0) {
    await step.run('mark-enqueued', async () => {
      for (const part of chunks(sent, TENANTS_PER_QUERY)) {
        const { error } = await history
          .from('ksef_history_sync')
          .update({ last_enqueued_at: now.toISOString() })
          .eq('environment', env)
          .eq('direction', 'outgoing')
          .in('tenant_id', part);
        if (error) throw new Error(`Historia KSeF: zapis znacznika kolejki: ${error.message}`);
      }
    });
  }
  result.enqueued = sent.length;
  logger.info('Historia KSeF: cykl', { ...result });
  return result;
}

// ═══════════════════════════════════════════════════════════════
// PRZEBIEG FIRMY
// ═══════════════════════════════════════════════════════════════

type KsefHistorySyncTenantData = Parameters<typeof ksefHistorySyncTenant.create>[0];

type StopReason =
  | { kind: 'pause'; pauseMs: number; detail: string }
  | { kind: 'session'; code: KsefHistorySessionErrorCode; detail: string };

interface RunState {
  /** Udane wywołania KSeF (metadane i pobrania). */
  succeeded: number;
  transient: number;
  stop: StopReason | null;
  downloads: number;
  downloaded: string[];
  imported: number;
  rechecked: number;
}

export type KsefHistoryTenantResult =
  | { skipped: 'tenant-state' | 'leased-or-paused' }
  | { yielded: string[] }
  | {
      rechecked: number;
      succeededCalls: number;
      downloads: number;
      imported: number;
      stopped: StopReason['kind'] | null;
    };

interface TenantState {
  id: string;
  nip: string;
  ksef_verified_at: string | null;
  ksef_verified_environment: string | null;
  ksef_certificate_expiry: string | null;
  deleted_at: string | null;
  is_active: boolean | null;
  has_ksef_credentials: boolean | null;
  business_started_on: string | null;
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-d.ts (kolejka ksef.history-sync.tenant).
 */
export async function runKsefHistorySyncTenant(
  data: KsefHistorySyncTenantData,
  { step, logger }: JobContext,
): Promise<KsefHistoryTenantResult> {
  const startedAt = Date.now();
  const env = requireConfiguredKsefEnvironment();
  if (data.environment !== env) {
    throw new NonRetriableError('KSeF history sync event environment does not match configured environment');
  }
  if (typeof data.tenantId !== 'string' || !UUID_RE.test(data.tenantId)) {
    throw new NonRetriableError('Niepoprawna tożsamość zadania');
  }
  const tenantId = data.tenantId;
  const now = new Date();
  const admin = createAdminClient();
  const history = asHistoryClient(admin);

  // 1. Firma nadal kwalifikuje się do synchronizacji (zdarzenie może być stare).
  const tenant = await step.run('read-tenant', async () => {
    const { data: row, error } = await admin
      .from('tenants')
      .select('id, nip, ksef_verified_at, ksef_verified_environment, ksef_certificate_expiry, deleted_at, is_active, has_ksef_credentials, business_started_on')
      .eq('id', tenantId)
      .maybeSingle();
    if (error) throw new Error(`Historia KSeF: odczyt firmy: ${error.message}`);
    return (row as TenantState | null) ?? null;
  });
  if (!tenant || tenant.nip !== data.nip || !tenant.ksef_verified_at || tenant.ksef_verified_environment !== env
      || tenant.deleted_at || tenant.is_active !== true || !tenant.has_ksef_credentials) {
    return { skipped: 'tenant-state' };
  }
  if (certificateExpired(tenant.ksef_certificate_expiry, now)) {
    await step.run('record-certificate-expired', async () => {
      const streams = await loadStreams(history, env, tenantId);
      return recordCertificateExpired(history, streams.find((s) => s.direction === 'outgoing'), now);
    });
    return { skipped: 'tenant-state' };
  }

  // 2. Dzierżawa na wierszu sprzedaży (pauza klienta i pauza po 429 ją blokują).
  const leased = await step.run('claim-lease', () => claimLease(history, tenantId, env, now, LEASE_MS));
  if (!leased) return { skipped: 'leased-or-paused' };

  try {
    return await runLeased({ step, logger }, { history, admin, env, tenant, leased, now, startedAt });
  } catch (error) {
    // Nieoczekiwany błąd (nasz kod, baza): `internal` dla operatora, Sentry,
    // dalej w górę (log przebiegu). Bez ponowień — następny cron.
    try {
      await updateStreamById(history, leased.id, {
        last_error_code: 'internal',
        last_error_detail: unexpectedErrorDetail(error),
        last_error_at: new Date().toISOString(),
        consecutive_failures: leased.consecutive_failures + 1,
      });
    } catch (recordError) {
      logger.error('Historia KSeF: nie zapisano błędu przebiegu', recordError);
    }
    Sentry.captureException(error, { tags: { job: 'ksef-history-sync-tenant' }, extra: { tenantId } });
    throw error;
  } finally {
    try {
      await releaseLease(history, leased);
    } catch (releaseError) {
      // Dzierżawa wygaśnie sama po LEASE_MS.
      logger.error('Historia KSeF: nie zwolniono dzierżawy', releaseError);
    }
  }
}

interface LeasedRun {
  history: HistoryClient;
  admin: AdminClient;
  env: KsefHistoryEnvironment;
  tenant: TenantState;
  leased: KsefHistorySyncRow;
  now: Date;
  startedAt: number;
}

async function runLeased(
  { step, logger }: Pick<JobContext, 'step' | 'logger'>,
  run: LeasedRun,
): Promise<KsefHistoryTenantResult> {
  const { history, admin, env, tenant, leased, now, startedAt } = run;
  const tenantId = tenant.id;
  const state: RunState = { succeeded: 0, transient: 0, stop: null, downloads: 0, downloaded: [], imported: 0, rechecked: 0 };

  const streams = await step.run('load-tenant-streams', () => loadStreams(history, env, tenantId));
  const byDirection = new Map<HistoryDirection, KsefHistorySyncRow>();
  for (const s of streams) byDirection.set(s.direction, s);
  if (!byDirection.has('outgoing')) byDirection.set('outgoing', leased);

  // 2b. Niższy początek historii (właściciel poprawił datę rozpoczęcia na
  // wcześniejszą): pod dzierżawą, CAS-em na kursorze — bez wyścigu z odkrywaniem.
  await step.run('lower-history-floor', async () => {
    const floor = historyFloorFor(tenant.business_started_on);
    for (const s of [...byDirection.values()]) {
      const patch = lowerHistoryFloor(s, floor);
      if (!patch) continue;
      const updated = await updateBackfillCas(history, s, patch);
      if (updated) {
        byDirection.set(s.direction, updated);
        logger.info('Historia KSeF: niższy początek historii — zaległość poszerzona', {
          tenantId, direction: s.direction, from: s.history_floor, to: patch.history_floor,
        });
      }
    }
  });
  const ctxFor = (stream: KsefHistorySyncRow): ClassifyContext => ({
    admin, tenantId, environment: env, direction: stream.direction, streamId: stream.id,
  });
  const applyItem = async (item: KsefHistoryItemRow, patch: KsefHistoryItemPatch): Promise<boolean> => {
    const ok = await updateItemCas(history, item, patch);
    if (!ok) logger.warn('Historia KSeF: pozycja zmieniła się w międzyczasie — następny przebieg', { tenantId });
    return ok;
  };

  // 3. Ponowne sprawdzenia (tylko baza, najdawniej sprawdzane pierwsze).
  await step.run('recheck-items', async () => {
    const items = await selectRecheckItems(history, tenantId, env, now, {
      blockedRecheckMs: BLOCKED_RECHECK_MS, retiredRecheckMs: RETIRED_RECHECK_MS, limit: RECHECK_LIMIT,
    });
    for (const item of items) {
      const stream = byDirection.get(item.direction);
      if (!stream) continue;
      const outcome = await classifyForProcessing(ctxFor(stream), item);
      await applyItem(item, itemPatchFor(item, outcome, now));
      state.rechecked += 1;
    }
  });

  // 4. Budżet i ustępowanie skrzynce i wysyłce.
  const budget = historyBudget(now);
  const signals = await step.run('yield-signals', () => readYieldSignals(admin, tenantId, now));
  if (signals.yieldAll) {
    logger.info('Historia KSeF: ustępujemy — bez wywołań KSeF w tym przebiegu', { tenantId, reasons: signals.reasons });
    return { yielded: signals.reasons };
  }
  if (signals.yieldDownloads) budget.downloads = 0;

  // 5. Czy jest praca dla KSeF?
  const outgoing = byDirection.get('outgoing')!;
  const liveDue = isLiveDue(outgoing.live_checked_at, now) && liveWindow(outgoing, now) !== null;
  const backfillCandidates = (['outgoing', 'incoming'] as const)
    .map((d) => byDirection.get(d))
    .filter((s): s is KsefHistorySyncRow => backfillEligible(s, now))
    .sort((a, b) => {
      const at = a.backfill_progress_at ? Date.parse(a.backfill_progress_at) : Number.NEGATIVE_INFINITY;
      const bt = b.backfill_progress_at ? Date.parse(b.backfill_progress_at) : Number.NEGATIVE_INFINITY;
      if (at !== bt) return at - bt;
      return a.direction === 'outgoing' ? -1 : 1;
    });
  const initialQueue = budget.downloads > 0
    ? await selectDownloadQueue(history, tenantId, env, now, budget.downloads * QUEUE_READ_FACTOR)
    : [];
  if (!liveDue && backfillCandidates.length === 0 && initialQueue.length === 0) {
    return { rechecked: state.rechecked, succeededCalls: 0, downloads: 0, imported: 0, stopped: null };
  }

  // 6. Poświadczenia i sesja KSeF.
  const deadlinePassed = () => Date.now() - startedAt >= RUN_DEADLINE_MS;
  const handleCallError = (error: unknown, phase: 'session' | 'metadata' | 'download', auth: KsefAuth | null) => {
    const outcome = classifyHistoryError(error, { phase, certificateExpiry: tenant.ksef_certificate_expiry, now });
    if (!outcome) throw error;
    switch (outcome.kind) {
      case 'pause':
        state.stop = { kind: 'pause', pauseMs: outcome.pauseMs, detail: outcome.detail };
        return outcome;
      case 'session':
        if (outcome.invalidateSession && auth) ksefSessionCache.invalidate(auth.nip, env);
        state.stop = { kind: 'session', code: outcome.code, detail: outcome.detail };
        return outcome;
      case 'transient':
        state.transient += 1;
        if (state.transient >= 2) state.stop = { kind: 'session', code: 'ksef_unavailable', detail: outcome.detail };
        return outcome;
      default:
        return outcome;
    }
  };

  let auth: KsefAuth | null = null;
  try {
    auth = await step.run('open-session', async () => {
      const credentials = await getTenantKsefCredentials(tenantId);
      await ksefSessionCache.getSession(credentials, env);
      return credentials;
    });
  } catch (error) {
    handleCallError(error, 'session', null);
    if (!state.stop && state.transient > 0) {
      // Jeden błąd przejściowy przy otwarciu sesji — koniec przebiegu bez
      // zapisu błędu; następny cron spróbuje. Długi przestój łapie alarm „stoi”.
      logger.warn('Historia KSeF: KSeF nie odpowiedział przy otwarciu sesji', { tenantId });
    }
  }

  // 7. Odkrywanie: bieżąca sprzedaż, potem zaległość round-robin (≤ 1 zapytanie na strumień).
  if (auth) {
    const sessionAuth = auth;
    await step.run('discovery', async () => {
      let metadataLeft = budget.metadata;
      if (liveDue && metadataLeft > 0 && !deadlinePassed()) {
        metadataLeft -= 1;
        const updated = await liveCall(run, ctxFor, byDirection.get('outgoing')!, sessionAuth, state, handleCallError, logger);
        if (updated) byDirection.set('outgoing', updated);
      }
      for (const candidate of backfillCandidates) {
        if (metadataLeft <= 0 || state.stop || deadlinePassed()) break;
        const stream = byDirection.get(candidate.direction) ?? candidate;
        const used = await backfillCall(run, ctxFor, stream, sessionAuth, state, handleCallError, logger);
        if (used.called) metadataLeft -= 1;
        if (used.updated) byDirection.set(stream.direction, used.updated);
      }
    });

    // 8. Pobrania XML — po odkrywaniu (nowe pozycje), co ≥ 6 s, do terminu 90 s.
    if (!state.stop && budget.downloads > 0) {
      await step.run('downloads', async () => {
        const queue = await selectDownloadQueue(history, tenantId, env, now, budget.downloads * QUEUE_READ_FACTOR);
        for (const item of queue) {
          if (state.stop || state.downloads >= budget.downloads || deadlinePassed()) break;
          const stream = byDirection.get(item.direction);
          if (!stream) continue;
          const ctx = ctxFor(stream);
          // Klasyfikacja tuż przed pobraniem — stan lokalny mógł się zmienić.
          const outcome = await classifyForProcessing(ctx, item);
          if (outcome.action !== 'download') {
            await applyItem(item, itemPatchFor(item, outcome, now));
            continue;
          }
          if (state.downloads > 0) {
            await step.sleep('history-download-spacing', DOWNLOAD_SPACING_MS);
            if (deadlinePassed()) break;
          }
          state.downloads += 1;
          await processDownload(run, ctx, stream, item, outcome.repair, sessionAuth, state, handleCallError, applyItem);
        }
      });
    }

    if (state.downloaded.length > 0) {
      await logAuditSystem({
        action: 'ksef.history.download',
        tenantId,
        userId: null,
        entityType: 'ksef_history',
        entityId: leased.id,
        metadata: { environment: env, count: state.downloaded.length, ksefNumbers: state.downloaded.slice(0, 10) },
      });
    }
  }

  // 9. Stan firmy.
  await step.run('finalize', async () => {
    const at = new Date().toISOString();
    if (state.stop?.kind === 'pause') {
      await updateStreamById(history, leased.id, {
        paused_until: new Date(Date.now() + state.stop.pauseMs).toISOString(),
        rate_limited_at: at,
        rate_limit_hits: leased.rate_limit_hits + 1,
      });
      logger.warn('Historia KSeF: 429 — pauza firmy', { tenantId, pauseMs: state.stop.pauseMs });
    } else if (state.stop?.kind === 'session') {
      await updateStreamById(history, leased.id, {
        last_error_code: state.stop.code,
        last_error_detail: state.stop.detail.slice(0, 300),
        last_error_at: at,
        consecutive_failures: leased.consecutive_failures + 1,
      });
      logger.warn('Historia KSeF: błąd firmy', { tenantId, code: state.stop.code });
    } else if (state.succeeded > 0) {
      await updateStreamById(history, leased.id, {
        last_success_at: at,
        last_error_code: null,
        last_error_detail: null,
        last_error_at: null,
        consecutive_failures: 0,
        rate_limit_hits: 0,
      });
    }
  });

  return {
    rechecked: state.rechecked,
    succeededCalls: state.succeeded,
    downloads: state.downloads,
    imported: state.imported,
    stopped: state.stop?.kind ?? null,
  };
}

type CallErrorHandler = (
  error: unknown,
  phase: 'session' | 'metadata' | 'download',
  auth: KsefAuth | null,
) => ReturnType<typeof classifyHistoryError>;

type Logger = JobContext['logger'];

async function liveCall(
  run: LeasedRun,
  ctxFor: (s: KsefHistorySyncRow) => ClassifyContext,
  stream: KsefHistorySyncRow,
  auth: KsefAuth,
  state: RunState,
  handleCallError: CallErrorHandler,
  logger: Logger,
): Promise<KsefHistorySyncRow | null> {
  const window = liveWindow(stream, run.now);
  if (!window) return null;
  let page: MetadataPage;
  try {
    page = await queryMetadataPage(auth, {
      subjectType: 'subject1', from: window.from, to: window.to, pageOffset: window.pageOffset,
      env: run.env, tenantId: run.tenant.id,
    });
  } catch (error) {
    handleCallError(error, 'metadata', auth);
    return null;
  }
  state.succeeded += 1;
  // Najpierw dziennik, potem kursor (ponowienie zapyta o tę samą stronę).
  const rows = await classifyDiscovered(ctxFor(stream), page.invoices, run.now);
  await upsertItems(run.history, rows);
  const at = run.now.toISOString();
  const step = applyLivePage(stream, window, page);
  const patch: Partial<KsefHistorySyncRow> = step.kind === 'advance'
    ? { ...step.next, live_checked_at: at, live_issue: null, live_issue_at: null }
    : { live_checked_at: at, live_issue: step.issue, live_issue_at: at };
  if (step.kind === 'issue' && step.issue === 'internal') {
    Sentry.captureMessage('Historia KSeF: okno bieżące nie do zawężenia', { level: 'warning', extra: { tenantId: run.tenant.id } });
  }
  const updated = await updateLiveCas(run.history, stream, patch);
  if (!updated) logger.warn('Historia KSeF: kursor bieżący zmienił się w międzyczasie', { tenantId: run.tenant.id });
  return updated;
}

async function backfillCall(
  run: LeasedRun,
  ctxFor: (s: KsefHistorySyncRow) => ClassifyContext,
  stream: KsefHistorySyncRow,
  auth: KsefAuth,
  state: RunState,
  handleCallError: CallErrorHandler,
  logger: Logger,
): Promise<{ called: boolean; updated: KsefHistorySyncRow | null }> {
  const at = run.now.toISOString();
  // Limit dziennika na strumień — bez wywołania KSeF; klient i operator wiedzą.
  if (await countStreamItems(run.history, run.tenant.id, run.env, stream.direction) >= MAX_ITEMS_PER_STREAM) {
    const updated = await updateBackfillCas(run.history, stream, { backfill_issue: 'capacity', backfill_issue_at: at });
    return { called: false, updated };
  }
  const window = backfillWindow(stream);
  if (!window) return { called: false, updated: null };
  let page: MetadataPage;
  try {
    page = await queryMetadataPage(auth, {
      subjectType: stream.direction === 'outgoing' ? 'subject1' : 'subject2',
      from: window.from, to: window.to, pageOffset: window.pageOffset,
      env: run.env, tenantId: run.tenant.id,
    });
  } catch (error) {
    handleCallError(error, 'metadata', auth);
    return { called: true, updated: null };
  }
  state.succeeded += 1;
  const rows = await classifyDiscovered(ctxFor(stream), page.invoices, run.now);
  await upsertItems(run.history, rows);
  const step = applyBackfillPage(stream, page, run.now);
  let patch: Partial<KsefHistorySyncRow>;
  if (step.kind === 'advance') {
    patch = { ...step.next, backfill_progress_at: at, backfill_issue: null, backfill_issue_at: null };
  } else if (step.issue === 'waiting_for_ksef') {
    patch = { backfill_progress_at: at, backfill_issue: 'waiting_for_ksef', backfill_issue_at: at };
  } else {
    // Bez postępu: alarm „zaległość stoi” po dobie, ponowienie za godzinę.
    patch = { backfill_issue: 'internal', backfill_issue_at: at };
    Sentry.captureMessage('Historia KSeF: okno zaległości nie do zawężenia', { level: 'warning', extra: { tenantId: run.tenant.id } });
  }
  const updated = await updateBackfillCas(run.history, stream, patch);
  if (!updated) logger.warn('Historia KSeF: kursor zaległości zmienił się w międzyczasie', { tenantId: run.tenant.id });
  return { called: true, updated };
}

function catalogPolicyFor(direction: HistoryDirection, repair: boolean): { contractors: CatalogPolicy; products: CatalogPolicy } {
  // Zakupy z historii to archiwum (bez katalogów); naprawa treści niczego nie dopisuje.
  if (repair || direction === 'incoming') return { contractors: 'skip', products: 'skip' };
  return { contractors: 'insert-only', products: 'insert-only' };
}

async function processDownload(
  run: LeasedRun,
  ctx: ClassifyContext,
  stream: KsefHistorySyncRow,
  item: KsefHistoryItemRow,
  repair: boolean,
  auth: KsefAuth,
  state: RunState,
  handleCallError: CallErrorHandler,
  applyItem: (item: KsefHistoryItemRow, patch: KsefHistoryItemPatch) => Promise<boolean>,
): Promise<void> {
  const { now, env } = run;
  const at = now.toISOString();
  const n = item.ksef_number;
  const block = (outcome: Extract<ProcessingOutcome, { action: 'block' }>) =>
    applyItem(item, itemPatchFor(item, outcome, now));

  // a) pobranie
  let bytes: Buffer;
  try {
    bytes = await downloadInvoiceXmlBytes(auth, n, env);
  } catch (error) {
    const outcome = handleCallError(error, 'download', auth);
    if (!outcome) return;
    if (outcome.kind === 'not_ready') {
      // Bez liczenia próby; naprawa zostaje naprawą.
      await applyItem(item, {
        reason_code: item.reason_code === 'repair_content' ? 'repair_content' : 'ksef_not_ready',
        next_attempt_at: new Date(now.getTime() + KSEF_NOT_READY_RETRY_MS).toISOString(),
      });
      return;
    }
    if (outcome.kind === 'item_error') {
      const attempts = item.attempts + 1;
      await applyItem(item, attempts >= ITEM_MAX_ATTEMPTS
        ? { status: 'blocked', reason_code: 'download_failed', attempts, detail: outcome.detail, resolved_at: at, next_attempt_at: null }
        : { attempts, detail: outcome.detail, next_attempt_at: new Date(now.getTime() + attempts * HOUR_MS).toISOString() });
      return;
    }
    if (outcome.kind === 'transient') {
      await applyItem(item, {
        attempts: item.attempts + 1,
        detail: outcome.detail,
        next_attempt_at: new Date(now.getTime() + KSEF_NOT_READY_RETRY_MS).toISOString(),
      });
    }
    // pause / session — stan firmy w `finalize`, pozycja bez zmian.
    return;
  }
  state.succeeded += 1;
  state.downloaded.push(n);

  // b) archiwum oryginału (klucz deterministyczny, zapis tylko gdy brak)
  let xmlArchive;
  try {
    xmlArchive = await archiveImportedKsefXml(run.tenant.id, n, bytes);
  } catch (error) {
    if (error instanceof KsefXmlArchiveConflictError) {
      await block({ action: 'block', reason: 'archive_conflict', invoiceId: item.invoice_id });
      return;
    }
    throw error;
  }

  // c) odczyt FA(3)
  let parsed;
  try {
    parsed = parseFa3Xml(decodeKsefXml(bytes), { ksefNumber: n });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await block(message.startsWith('faktura w walucie')
      ? { action: 'block', reason: 'currency_not_supported', invoiceId: item.invoice_id }
      : { action: 'block', reason: 'parse_failed', invoiceId: item.invoice_id, detail: message.slice(0, 300) });
    return;
  }

  // d) plik = metadane (numer faktury i data wystawienia)
  if (parsed.invoiceNumber.trim() !== item.invoice_number.trim() || parsed.issueDate !== item.issue_date) {
    await block({ action: 'block', reason: 'metadata_mismatch', invoiceId: item.invoice_id,
      detail: `plik: ${parsed.invoiceNumber.trim().slice(0, 60)} ${parsed.issueDate}` });
    return;
  }

  // e) zapis przez silnik importu (jedyna ścieżka zapisu faktury)
  const result = await processImportedInvoicesDetailed({
    tenantId: run.tenant.id,
    importJobId: stream.id,
    source: 'ksef_history',
    invoiceDirection: stream.direction,
    invoiceKsefStatus: 'accepted',
    ksefEnvironment: env,
    catalogPolicy: catalogPolicyFor(stream.direction, repair),
    invoices: [{
      ...parsed,
      xmlArchive,
      // IMP-ACC: chwila nadania numeru w KSeF; pusty napis = ostrzeżenie silnika.
      ksefAcceptedAt: item.acquisition_at ?? item.permanent_storage_at ?? '',
    }],
  });

  const savedInvoiceId = async (): Promise<string | null> => {
    const { data: saved, error } = await run.admin
      .from('invoices')
      .select('id')
      .eq('tenant_id', run.tenant.id)
      .eq('direction', stream.direction)
      .eq('ksef_number', n)
      .eq('ksef_environment', env)
      .maybeSingle();
    if (error) throw new Error(`Historia KSeF: odczyt zapisanej faktury: ${error.message}`);
    return (saved as { id: string } | null)?.id ?? null;
  };
  const importedPatch = async (): Promise<KsefHistoryItemPatch> => ({
    status: 'imported',
    reason_code: result.held.length > 0 ? 'jpk_note' : null,
    detail: result.held[0]?.slice(0, 300) ?? null,
    invoice_id: await savedInvoiceId(),
    resolved_at: at,
    next_attempt_at: null,
  });
  // Naprawa dawnego importu (`repair_content`) — `repaired`, nie liczy się do
  // pobranych. Uzupełnienie NIEPEŁNEGO zapisu tego strumienia (tryb naprawy
  // bez `repair_content`) to pierwsze pobranie tej faktury — zwykłe `imported`.
  const legacyRepair = repair && item.reason_code === 'repair_content';

  if (result.invoicesImported >= 1) {
    await applyItem(item, await importedPatch());
    state.imported += 1;
    return;
  }
  if (repair && result.invoicesFailed === 0) {
    if (legacyRepair) {
      await applyItem(item, {
        status: 'imported', reason_code: 'repaired', detail: null, invoice_id: item.invoice_id, resolved_at: at, next_attempt_at: null,
      });
      return;
    }
    await applyItem(item, await importedPatch());
    state.imported += 1;
    return;
  }

  // Ani zapisane, ani naprawione: najpierw ponowna klasyfikacja (wyścig z inną
  // ścieżką), dopiero potem próba się liczy.
  const again = await classifyForProcessing(ctx, item);
  if (again.action !== 'download') {
    await applyItem(item, itemPatchFor(item, again, now));
    return;
  }
  const attempts = item.attempts + 1;
  const detail = (result.warnings[0] ?? 'silnik importu nie zapisał faktury').slice(0, 300);
  await applyItem(item, attempts >= ITEM_MAX_ATTEMPTS
    ? { status: 'blocked', reason_code: legacyRepair ? 'repair_failed' : 'save_failed', attempts, detail, resolved_at: at, next_attempt_at: null }
    : { attempts, detail, next_attempt_at: new Date(now.getTime() + attempts * HOUR_MS).toISOString() });
}
