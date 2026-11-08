/**
 * Centrum dowodzenia — dane błędów wysyłki (`/admin/centrum/bledy`) i prób
 * jednej faktury (karta `/admin/ksef/[id]`). Jedno miejsce składania źródeł
 * (brief C-22, §5): dziennik prób `ksef_send_attempts` (A5, 00150), bieżący
 * stan faktur, UPO i przebiegi cronów z `inngest_run_log`.
 *
 * Czyta kluczem serwisowym, dlatego każda funkcja najpierw `requireAdmin()`.
 * Błąd odczytu NIE jest pustą listą: każda część zwraca jawny problem, który
 * strona pokazuje nad wynikami (kontrakt F0: „błąd odczytu nie jest pustą
 * zdrową listą”).
 */

import 'server-only';

import { listLifecycleViolations } from '@/lib/admin/ksef-lifecycle';
import { requireAdmin } from '@/lib/auth/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';

import {
  INTERRUPTED_AFTER_MS,
  periodStart,
  stuckInvoices,
  WATCHED_CRONS,
  type AttemptRow,
  type AttemptStatus,
  type CronRun,
  type SendErrorFilters,
  type StuckInvoice,
} from './send-errors';

/**
 * Ile wierszy czytamy do grupowania. Nie więcej niż `max_rows` PostgREST
 * (1000 w `supabase/config.toml`; produkcja może mieć mniej) — obcięcie
 * wykrywamy po dokładnym liczniku (`count: 'exact'`), nie po długości listy.
 */
export const ATTEMPTS_SCAN_LIMIT = 1000;

const ATTEMPT_COLUMNS =
  'id, tenant_id, invoice_id, send_attempt_id, job_id, execution, ksef_environment, worker_sha, status, stage, result, error_code, error_class, error_message, ksef_http_status, ksef_code, retryable, started_at, finished_at';

type Embed<T> = T | T[] | null;
const first = <T>(e: Embed<T>): T | null => (Array.isArray(e) ? (e[0] ?? null) : e);

interface DbAttempt {
  id: string;
  tenant_id: string;
  invoice_id: string;
  send_attempt_id: string | null;
  job_id: string | null;
  execution: number | null;
  ksef_environment: string | null;
  worker_sha: string | null;
  status: AttemptStatus;
  stage: string | null;
  result: string | null;
  error_code: string | null;
  error_class: string | null;
  error_message: string | null;
  ksef_http_status: number | null;
  ksef_code: number | null;
  retryable: boolean | null;
  started_at: string;
  finished_at: string | null;
  tenants?: Embed<{ name: string | null }>;
  invoices?: Embed<{ internal_number: string | null; ksef_status: string | null; submitted_to_ksef_at?: string | null }>;
}

function toAttempt(row: DbAttempt): AttemptRow {
  const tenant = first(row.tenants ?? null);
  const invoice = first(row.invoices ?? null);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantName: tenant?.name ?? null,
    invoiceId: row.invoice_id,
    internalNumber: invoice?.internal_number ?? null,
    invoiceStatus: invoice?.ksef_status ?? null,
    invoiceSubmittedAt: invoice?.submitted_to_ksef_at ?? null,
    sendAttemptId: row.send_attempt_id,
    jobId: row.job_id,
    execution: row.execution ?? 0,
    environment: row.ksef_environment,
    workerSha: row.worker_sha,
    status: row.status,
    stage: row.stage ?? 'start',
    result: row.result,
    errorCode: row.error_code,
    errorClass: row.error_class,
    errorMessage: row.error_message,
    httpStatus: row.ksef_http_status,
    ksefCode: row.ksef_code,
    retryable: row.retryable,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Zapytanie `head` (sam licznik) o brakującą tabelę: PostgREST odpowiada 404
 * bez treści, więc supabase-js zwraca `error: null` i `count: null` — to nie
 * jest zero. Zamieniamy na błąd, żeby licznik pokazał „nie wiadomo”.
 */
function missingCount(status: number): { code: string; message: string } {
  return status === 404
    ? { code: 'PGRST205', message: 'brak tabeli' }
    : { code: 'NO_COUNT', message: `brak licznika w odpowiedzi (HTTP ${status})` };
}

/**
 * PGRST205 / 42P01: tabeli nie ma — migracja 00150 nie jest wgrana. Ten sam
 * komunikat bez prefiksu zapytania, żeby kilka zapytań dało jeden wpis.
 */
function describeProblem(what: string, error: { code?: string; message: string }): string {
  if (error.code === 'PGRST205' || error.code === '42P01') {
    return 'Brak tabeli ksef_send_attempts — migracja 00150 nie jest wgrana (albo PostgREST bez NOTIFY pgrst). Dziennik prób i liczniki są niedostępne.';
  }
  return `${what}: ${error.message}`;
}

type Client = ReturnType<typeof createAdminClient>;
/**
 * Metody filtrów PostgREST, których tu używamy — budowniczy supabase-js
 * zwraca z nich samego siebie. Opis strukturalny zamiast typu z `select`,
 * którego rozbiór kolumn TypeScript rozwija bez końca (TS2589).
 */
interface Filterable<T> {
  eq(column: string, value: string): T;
  gte(column: string, value: string): T;
  lt(column: string, value: string): T;
  is(column: string, value: null): T;
  or(filters: string): T;
}

/** Filtr statusu: `errors` = porażki, odmowy i przerwane (`started` starsze niż próg). */
function applyStatus<T extends Filterable<T>>(query: T, status: SendErrorFilters['status'], now: Date): T {
  const interruptedBefore = new Date(now.getTime() - INTERRUPTED_AFTER_MS).toISOString();
  switch (status) {
    case 'errors':
      return query.or(`status.in.(failed,refused),and(status.eq.started,finished_at.is.null,started_at.lt."${interruptedBefore}")`);
    case 'interrupted':
      return query.eq('status', 'started').is('finished_at', null).lt('started_at', interruptedBefore);
    case 'failed':
    case 'refused':
    case 'waiting':
      return query.eq('status', status);
    case 'all':
      return query;
  }
}

function applyFilters<T extends Filterable<T>>(query: T, filters: SendErrorFilters, from: string): T {
  let q = query.gte('started_at', from);
  if (filters.code) q = q.eq('error_code', filters.code);
  if (filters.errorClass) q = q.eq('error_class', filters.errorClass);
  if (filters.stage) q = q.eq('stage', filters.stage);
  return q;
}

export interface StatusCounts {
  succeeded: number | null;
  failed: number | null;
  refused: number | null;
  waiting: number | null;
  interrupted: number | null;
}

export interface UpoFailure {
  invoiceId: string;
  /** `failed` — pobranie odrzucone; `pending` — bez wyniku ponad godzinę (zapis po pobraniu padł, job wyczerpał próby). */
  status: string;
  internalNumber: string | null;
  tenantName: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

export interface SendErrorsView {
  filters: SendErrorFilters;
  from: string;
  now: string;
  rows: AttemptRow[];
  /** Ile wierszy pasuje do filtra (z licznika PostgREST); `rows` może mieć mniej. */
  matching: number | null;
  truncated: boolean;
  counts: StatusCounts;
  /** Najstarszy wiersz dziennika; `null` — dziennik pusty, `undefined` — odczyt nieudany. */
  ledgerSince: string | null | undefined;
  crons: Map<string, CronRun | null>;
  /** Faktury wychodzące z błędem TERAZ (`failed`/`rejected`), także sprzed dziennika. */
  invoicesWithErrorNow: number | null;
  upoFailures: UpoFailure[];
  upoFailuresTotal: number | null;
  /** Utknięte w wysyłce teraz (strażnik I1/I2), niezależnie od okresu i filtrów; `null` — odczyt nieudany. */
  stuckNow: StuckInvoice[] | null;
  problems: string[];
}

async function countStatus(
  client: Client,
  filters: SendErrorFilters,
  from: string,
  status: Exclude<SendErrorFilters['status'], 'errors' | 'all'> | 'succeeded',
  now: Date,
  problems: string[],
): Promise<number | null> {
  let query = client.from('ksef_send_attempts').select('id', { count: 'exact', head: true });
  query = applyFilters(query, filters, from);
  query = status === 'succeeded' ? query.eq('status', 'succeeded') : applyStatus(query, status, now);
  const { count, error, status: http } = await query;
  if (error || count === null) {
    problems.push(describeProblem(`Licznik „${status}”`, error ?? missingCount(http)));
    return null;
  }
  return count;
}

async function lastCronRuns(client: Client, problems: string[]): Promise<Map<string, CronRun | null>> {
  const out = new Map<string, CronRun | null>();
  await Promise.all(
    WATCHED_CRONS.map(async (cron) => {
      const { data, error } = await client
        .from('inngest_run_log')
        .select('created_at, status')
        .eq('event_name', cron.queue)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        problems.push(`Ostatni przebieg ${cron.queue}: ${error.message}`);
        out.set(cron.queue, null);
        return;
      }
      const run = data as { created_at: string; status: string } | null;
      out.set(cron.queue, run ? { at: run.created_at, status: run.status } : null);
    }),
  );
  return out;
}

export async function loadSendErrorsView(filters: SendErrorFilters, now: Date = new Date()): Promise<SendErrorsView> {
  await requireAdmin();
  const client = createAdminClient();
  const from = periodStart(filters.period, now).toISOString();
  const problems: string[] = [];

  const listQuery = async (): Promise<{ rows: AttemptRow[]; matching: number | null; truncated: boolean }> => {
    let query = client
      .from('ksef_send_attempts')
      .select(`${ATTEMPT_COLUMNS}, tenants(name), invoices(internal_number, ksef_status, submitted_to_ksef_at)`, { count: 'exact' });
    query = applyStatus(applyFilters(query, filters, from), filters.status, now);
    const { data, error, count } = await query.order('started_at', { ascending: false }).limit(ATTEMPTS_SCAN_LIMIT);
    if (error) {
      problems.push(describeProblem('Lista prób', error));
      return { rows: [], matching: null, truncated: false };
    }
    const rows = ((data ?? []) as DbAttempt[]).map(toAttempt);
    // Bez licznika nie wiemy, czy lista jest pełna — ostrożnie: obcięta, gdy doszła do limitu.
    const truncated = count === null ? rows.length >= ATTEMPTS_SCAN_LIMIT : count > rows.length;
    return { rows, matching: count, truncated };
  };

  const ledgerSince = async (): Promise<string | null | undefined> => {
    const { data, error } = await client
      .from('ksef_send_attempts')
      .select('started_at')
      .order('started_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) {
      problems.push(describeProblem('Początek dziennika', error));
      return undefined;
    }
    return (data as { started_at: string } | null)?.started_at ?? null;
  };

  const invoicesWithError = async (): Promise<number | null> => {
    const { count, error, status } = await client
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('direction', 'outgoing')
      .in('ksef_status', ['failed', 'rejected']);
    if (error || count === null) {
      problems.push(`Faktury z błędem: ${error?.message ?? missingCount(status).message}`);
      return null;
    }
    return count;
  };

  const upo = async (): Promise<{ list: UpoFailure[]; total: number | null }> => {
    // `pending` bez wyniku ponad godzinę też jest porażką: łańcuch ponowień joba UPO kończy się
    // dużo wcześniej, a błąd po pobraniu (magazyn, PDF, zapis) nie ustawia `failed` (brak onExhausted).
    const stalePending = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const { data, error, count } = await client
      .from('upo_receipts')
      .select('invoice_id, status, download_attempts, last_error, created_at, tenants(name), invoices(internal_number)', { count: 'exact' })
      .or(`status.eq.failed,and(status.eq.pending,created_at.lt."${stalePending}")`)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) {
      problems.push(`UPO: ${error.message}`);
      return { list: [], total: null };
    }
    type Row = {
      invoice_id: string; status: string; download_attempts: number | null; last_error: string | null; created_at: string;
      tenants?: Embed<{ name: string | null }>; invoices?: Embed<{ internal_number: string | null }>;
    };
    const list = ((data ?? []) as Row[]).map((r) => ({
      invoiceId: r.invoice_id,
      status: r.status,
      internalNumber: first(r.invoices ?? null)?.internal_number ?? null,
      tenantName: first(r.tenants ?? null)?.name ?? null,
      attempts: r.download_attempts ?? 0,
      lastError: r.last_error,
      createdAt: r.created_at,
    }));
    return { list, total: count ?? list.length };
  };

  const stuck = async (): Promise<StuckInvoice[] | null> => {
    try {
      return stuckInvoices(await listLifecycleViolations(), now);
    } catch (e) {
      problems.push(`Strażnik cyklu życia (I1/I2): ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  const [list, since, crons, withError, upoResult, stuckNow, succeeded, failed, refused, waiting, interrupted] = await Promise.all([
    listQuery(),
    ledgerSince(),
    lastCronRuns(client, problems),
    invoicesWithError(),
    upo(),
    stuck(),
    countStatus(client, filters, from, 'succeeded', now, problems),
    countStatus(client, filters, from, 'failed', now, problems),
    countStatus(client, filters, from, 'refused', now, problems),
    countStatus(client, filters, from, 'waiting', now, problems),
    countStatus(client, filters, from, 'interrupted', now, problems),
  ]);

  return {
    filters,
    from,
    now: now.toISOString(),
    rows: list.rows,
    matching: list.matching,
    truncated: list.truncated,
    counts: { succeeded, failed, refused, waiting, interrupted },
    ledgerSince: since,
    crons,
    invoicesWithErrorNow: withError,
    upoFailures: upoResult.list,
    upoFailuresTotal: upoResult.total,
    stuckNow,
    // Ten sam brak tabeli zgłasza kilka zapytań — jeden komunikat wystarczy.
    problems: [...new Set(problems)],
  };
}

/** Próby jednej faktury do karty `/admin/ksef/[id]` (od najnowszej); `total` — wszystkie, gdy lista obcięta. */
export async function listInvoiceAttempts(
  invoiceId: string,
  limit = 50,
): Promise<{ rows: AttemptRow[]; total: number | null; problem: string | null }> {
  await requireAdmin();
  const { data, error, count } = await createAdminClient()
    .from('ksef_send_attempts')
    .select(ATTEMPT_COLUMNS, { count: 'exact' })
    .eq('invoice_id', invoiceId)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) return { rows: [], total: null, problem: describeProblem('Dziennik prób', error) };
  return { rows: ((data ?? []) as DbAttempt[]).map(toAttempt), total: count, problem: null };
}
