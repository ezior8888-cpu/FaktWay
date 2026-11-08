/**
 * Centrum dowodzenia — błędy wysyłki (`/admin/centrum/bledy`). CZYSTY moduł:
 * filtry z adresu, status efektywny, odcisk wzorca, grupowanie w incydenty
 * i świeżość workera. Dane czyta `lib/admin/centrum/attempts.ts`.
 *
 * Źródło: dziennik prób `ksef_send_attempts` (A5, 00150) — wiersz na każde
 * wykonanie joba wysyłki i na każdą odmowę przed kolejką. Centrum tylko
 * czyta i tłumaczy (brief C-22, §1): stan faktur zmieniają akcje w
 * `/admin/ksef`.
 */

import { sendErrorClassOf, type SendErrorClass } from '@/lib/ksef/send-error-classes';

export const ERROR_PERIODS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
} as const;
export type ErrorPeriod = keyof typeof ERROR_PERIODS;
export const DEFAULT_PERIOD: ErrorPeriod = '7d';

/**
 * `errors` = porażki, odmowy przed kolejką i wykonania przerwane (worker
 * padł w trakcie). Oczekiwanie (`waiting`) nie jest błędem — osobny filtr.
 */
export const STATUS_FILTERS = ['errors', 'failed', 'refused', 'interrupted', 'waiting', 'all'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export interface SendErrorFilters {
  period: ErrorPeriod;
  status: StatusFilter;
  code: string | null;
  errorClass: string | null;
  stage: string | null;
}

/**
 * Wykonanie `started` bez wyniku dłużej niż dzierżawa wysyłki (15 min,
 * `KSEF_SEND_LEASE_SECONDS`) plus zapas — worker padł albo został zabity
 * w trakcie (deploy, OOM). To błąd, choć nikt nie zapisał jego kodu.
 */
export const INTERRUPTED_AFTER_MS = 20 * 60 * 1000;

export type AttemptStatus = 'started' | 'succeeded' | 'failed' | 'waiting' | 'refused';
export type EffectiveStatus = AttemptStatus | 'interrupted';

export const STATUS_LABELS: Record<EffectiveStatus, string> = {
  started: 'w toku',
  succeeded: 'sukces',
  failed: 'błąd',
  waiting: 'oczekiwanie',
  refused: 'odmowa przed kolejką',
  interrupted: 'przerwane (worker)',
};

export const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  errors: 'wszystkie błędy',
  failed: 'błędy wykonania',
  refused: 'odmowy przed kolejką',
  interrupted: 'przerwane',
  waiting: 'oczekiwania',
  all: 'wszystkie wykonania',
};

export const STAGE_LABELS: Record<string, string> = {
  start: 'zdarzenie',
  guard: 'stan i hamulce',
  offline: 'Offline24',
  credentials: 'poświadczenia',
  health: 'sonda KSeF',
  claim: 'przejęcie',
  reconcile: 'uzgodnienie',
  submit: 'wysyłka',
  xml: 'XML',
  ksef: 'odpowiedź KSeF',
  save: 'zapis numeru',
  finalize: 'po przyjęciu',
  enqueue: 'przed kolejką',
};

export const CLASS_LABELS: Record<SendErrorClass, string> = {
  terminal: 'treść',
  transient: 'przejściowy',
  hold: 'hamulec',
  reconcile: 'uzgodnienie',
  setup: 'ustawienia',
};

const CODE_RE = /^[A-Z][A-Z0-9_]{1,39}$/;
const STAGE_RE = /^[a-z]{2,32}$/;

function one(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim();
  return trimmed ? trimmed : null;
}

/** Filtry z `searchParams`; nieznane wartości wracają do domyślnych (bez wstrzyknięć do zapytania). */
export function parseSendErrorFilters(params: Record<string, string | string[] | undefined>): SendErrorFilters {
  const period = one(params.period);
  const status = one(params.status);
  const code = one(params.code);
  const errorClass = one(params.class);
  const stage = one(params.stage);
  return {
    // `Object.hasOwn`, nie `in` — `?period=toString` nie może przejść jako klucz prototypu.
    period: period && Object.hasOwn(ERROR_PERIODS, period) ? (period as ErrorPeriod) : DEFAULT_PERIOD,
    status: status && (STATUS_FILTERS as readonly string[]).includes(status) ? (status as StatusFilter) : 'errors',
    code: code && CODE_RE.test(code) ? code : null,
    errorClass: errorClass && Object.hasOwn(CLASS_LABELS, errorClass) ? errorClass : null,
    stage: stage && STAGE_RE.test(stage) && Object.hasOwn(STAGE_LABELS, stage) ? stage : null,
  };
}

export function periodStart(period: ErrorPeriod, now: Date): Date {
  return new Date(now.getTime() - ERROR_PERIODS[period]);
}

export interface AttemptRow {
  id: string;
  tenantId: string;
  tenantName: string | null;
  invoiceId: string;
  internalNumber: string | null;
  /** Bieżący `invoices.ksef_status` — czy błąd został potem odzyskany. */
  invoiceStatus: string | null;
  /** `invoices.submitted_to_ksef_at` — znacznik przejęcia; stary albo brak przy `sending` = utknęła (I2). */
  invoiceSubmittedAt: string | null;
  sendAttemptId: string | null;
  jobId: string | null;
  execution: number;
  environment: string | null;
  workerSha: string | null;
  status: AttemptStatus;
  stage: string;
  result: string | null;
  errorCode: string | null;
  errorClass: string | null;
  errorMessage: string | null;
  httpStatus: number | null;
  ksefCode: number | null;
  retryable: boolean | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Opis wiersza bez komunikatu: przerwane wykonanie nie zapisało błędu, więc mówimy, co wiemy. */
export function attemptMessage(row: Pick<AttemptRow, 'status' | 'stage' | 'startedAt' | 'finishedAt' | 'errorMessage'>, now: Date): string | null {
  if (row.errorMessage) return row.errorMessage;
  if (effectiveStatus(row, now) === 'interrupted') {
    return `Brak wyniku w dzienniku od ponad ${INTERRUPTED_AFTER_MS / 60_000} min na etapie „${STAGE_LABELS[row.stage] ?? row.stage}” — worker przerwany (deploy, OOM) albo nie udał się zapis wyniku do dziennika (Sentry: „dziennik prób wysyłki — zapis nieudany”). Bieżący stan faktury — kolumna „teraz”; faktura w „sending” ponad 30 min to „utknęła” (strażnik I2 tylko alarmuje — wtedy operator).`;
  }
  return null;
}

export function effectiveStatus(row: Pick<AttemptRow, 'status' | 'startedAt' | 'finishedAt'>, now: Date): EffectiveStatus {
  if (row.status !== 'started' || row.finishedAt) return row.status;
  const started = Date.parse(row.startedAt);
  return Number.isFinite(started) && now.getTime() - started > INTERRUPTED_AFTER_MS ? 'interrupted' : 'started';
}

const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Szablon komunikatu do odcisku: UUID, liczby, numery referencyjne i daty
 * zamienione na symbole — dwa błędy różniące się tylko numerem faktury
 * czy sesji dają ten sam wzorzec (brief C-22, §6.4).
 */
export function messageTemplate(message: string | null): string {
  if (!message) return '';
  return message
    .replace(UUID_G, '<uuid>')
    // Numer KSeF (NIP albo [NIP], data, 12 hex, 2 hex) — duplikaty 440 różnych faktur w jednym incydencie.
    .replace(/(?:\b\d{10}|\[NIP\])-\d{8}-[0-9A-F]{12}-[0-9A-F]{2}\b/gi, '<ksef>')
    .replace(/\b\d{8}-[A-Z]{2}-[0-9A-F]{10}-[0-9A-F]{10}-[0-9A-F]{2}\b/gi, '<ref>')
    .replace(/\d+/g, '<n>')
    .replace(/(<n>[-./: ]?)+<n>/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** Odcisk wzorca: status, kod, etap, HTTP, kod KSeF i szablon komunikatu. */
export function fingerprint(row: AttemptRow, now: Date): string {
  return [
    effectiveStatus(row, now),
    row.errorCode ?? '-',
    row.stage,
    row.httpStatus ?? '-',
    row.ksefCode ?? '-',
    messageTemplate(row.errorMessage),
  ].join('|');
}

/** Bieżący stan faktury po błędzie — skąd wiemy, czy automat ją odzyskał. */
export type RecoveryState = 'accepted' | 'open' | 'stuck' | 'in_progress' | 'draft' | 'unknown';

/** Warunek I2 strażnika (00148): `sending` bez znacznika przejęcia albo dłużej niż dzierżawa + 15 min. */
export const STUCK_SENDING_AFTER_MS = 30 * 60 * 1000;

export function recoveryState(
  invoiceStatus: string | null,
  submittedAt: string | null = null,
  now: Date = new Date(),
): RecoveryState {
  switch (invoiceStatus) {
    case 'accepted':
      return 'accepted';
    case 'failed':
    case 'rejected':
      return 'open';
    case 'sending': {
      // Nikt jej nie rozstrzygnie sam: onExhausted padł albo pg-boss wyczerpał retryLimit — operator.
      const at = submittedAt ? Date.parse(submittedAt) : NaN;
      return !Number.isFinite(at) || now.getTime() - at > STUCK_SENDING_AFTER_MS ? 'stuck' : 'in_progress';
    }
    case 'queued':
    case 'offline_queued':
      return 'in_progress';
    case 'draft':
      return 'draft';
    default:
      return 'unknown';
  }
}

export const RECOVERY_LABELS: Record<RecoveryState, string> = {
  accepted: 'przyjęte',
  open: 'nadal z błędem',
  stuck: 'utknęła w wysyłce (operator)',
  in_progress: 'w toku',
  draft: 'szkic',
  unknown: 'nieznany stan',
};

export interface SendErrorIncident {
  key: string;
  status: EffectiveStatus;
  errorCode: string | null;
  errorClass: string | null;
  stage: string;
  httpStatus: number | null;
  ksefCode: number | null;
  template: string;
  sampleMessage: string | null;
  sampleInvoiceId: string;
  count: number;
  invoices: number;
  tenants: number;
  firstAt: string;
  lastAt: string;
  /** Bieżący stan dotkniętych faktur (każda liczona raz). */
  recovery: Record<RecoveryState, number>;
}

/**
 * Wiersze → incydenty według odcisku. Każde wykonanie liczy się w `count`
 * (grupowanie nie kasuje prób); faktury i firmy liczone raz. Najliczniejsze
 * i najświeższe na górze.
 */
export function groupIncidents(rows: readonly AttemptRow[], now: Date): SendErrorIncident[] {
  const groups = new Map<string, { incident: SendErrorIncident; invoices: Map<string, RecoveryState>; tenants: Set<string> }>();
  for (const row of rows) {
    const key = fingerprint(row, now);
    let group = groups.get(key);
    if (!group) {
      group = {
        incident: {
          key,
          status: effectiveStatus(row, now),
          errorCode: row.errorCode,
          errorClass: row.errorClass ?? sendErrorClassOf(row.errorCode),
          stage: row.stage,
          httpStatus: row.httpStatus,
          ksefCode: row.ksefCode,
          template: messageTemplate(row.errorMessage),
          sampleMessage: attemptMessage(row, now),
          sampleInvoiceId: row.invoiceId,
          count: 0,
          invoices: 0,
          tenants: 0,
          firstAt: row.startedAt,
          lastAt: row.startedAt,
          recovery: { accepted: 0, open: 0, stuck: 0, in_progress: 0, draft: 0, unknown: 0 },
        },
        invoices: new Map(),
        tenants: new Set(),
      };
      groups.set(key, group);
    }
    const { incident } = group;
    incident.count += 1;
    if (row.startedAt < incident.firstAt) incident.firstAt = row.startedAt;
    if (row.startedAt > incident.lastAt) {
      incident.lastAt = row.startedAt;
      incident.sampleMessage = attemptMessage(row, now);
      incident.sampleInvoiceId = row.invoiceId;
    }
    group.invoices.set(row.invoiceId, recoveryState(row.invoiceStatus, row.invoiceSubmittedAt, now));
    group.tenants.add(row.tenantId);
  }
  const out: SendErrorIncident[] = [];
  for (const { incident, invoices, tenants } of groups.values()) {
    incident.invoices = invoices.size;
    incident.tenants = tenants.size;
    for (const state of invoices.values()) incident.recovery[state] += 1;
    out.push(incident);
  }
  return out.sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
}

/**
 * Faktury, które utknęły w wysyłce TERAZ — strażnik cyklu życia
 * (`ksef_lifecycle_violations()`, 00148), niezależnie od dziennika prób:
 * zgubione zlecenie (I1) nie zostawia w dzienniku żadnego wiersza.
 *   - I1: `queued` ponad 15 min bez zlecenia w pg-boss — cron cyklu życia
 *     (co 15 min) wycofuje do szkicu albo oznacza `ENQUEUE_LOST`;
 *   - I2: `sending` ponad dzierżawę + 15 min albo bez znacznika przejęcia —
 *     automat tylko alarmuje, rozstrzyga operator.
 * Pozostałe naruszenia (I3–I5, I9, I5D) nie są błędami wysyłki — `/admin/ksef`.
 */
export const STUCK_INVARIANTS = ['I1', 'I2'] as const;
export type StuckInvariant = (typeof STUCK_INVARIANTS)[number];

/**
 * I1 dłużej wg zegara strażnika (`updated_at`) = automat nie zadziałał:
 * 15 min do naruszenia I1 i dwa przebiegi crona cyklu życia (co 15 min,
 * `lib/jobs/queues.ts`) — jeden może trafić tuż przed progiem.
 */
export const STUCK_AUTOMAT_DEADLINE_MS = 45 * 60 * 1000;

export const STUCK_HINTS: Record<StuckInvariant, string> = {
  I1: 'Cron cyklu życia (co 15 min) wycofa ją do szkicu albo oznaczy ENQUEUE_LOST. Po 45 min wg zegara strażnika automat nie zadziałał: sprawdź chip „strażnik cyklu życia” wyżej i Sentry („Cykl życia: I1 nieobsłużone”). Karta faktury nie ma akcji dla queued; wyjście bez crona: scripts/ops/zwolnij-utknieta-wysylke.sh <id> — najpierw podgląd, potem --wykonaj (runbook hamulce-ksef.md, „Faktura utknęła w wysyłce”; skrypt uruchamia Bartosz).',
  I2: 'Automat tylko alarmuje. Wysyłka mogła dojść do KSeF — nie ponawiaj. Karta faktury nie ma akcji dla sending: sprawdź na niej znacznik przejęcia, dziennik prób i audyt. Gdy w pg-boss nie ma żywego zlecenia tej faktury: scripts/ops/zwolnij-utknieta-wysylke.sh <id> — najpierw podgląd, potem --wykonaj → failed RESULT_UNCERTAIN, dalej na karcie „Tylko uzgodnij” albo „Wyślij ponownie” (runbook hamulce-ksef.md, „Faktura utknęła w wysyłce”; skrypt uruchamia Bartosz).',
};

/** Wiersz naruszenia z numerem i firmą (`listLifecycleViolations`). */
export interface LifecycleViolationLike {
  invariant: string;
  invoiceId: string;
  tenantName: string | null;
  internalNumber: string | null;
  ksefStatus: string | null;
  detail: unknown;
}

export interface StuckInvoice {
  invariant: StuckInvariant;
  invoiceId: string;
  tenantName: string | null;
  internalNumber: string | null;
  ksefStatus: string | null;
  /**
   * Zegar strażnika: I1 — `updated_at` (ostatnia zmiana wiersza, np. zapis PDF;
   * nie zawsze wejście do kolejki), I2 — znacznik przejęcia; `null` — brak znacznika.
   */
  since: string | null;
  /** I1 po terminie automatu (albo bez daty) — cron cyklu życia nie zadziałał. */
  automatOverdue: boolean;
}

function detailTime(detail: unknown, key: string): string | null {
  const value = detail && typeof detail === 'object' ? (detail as Record<string, unknown>)[key] : null;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

const isStuckInvariant = (value: string): value is StuckInvariant =>
  (STUCK_INVARIANTS as readonly string[]).includes(value);

/** I1 i I2 z naruszeń strażnika; najpierw I1 od najstarszego (bez daty na górze), potem I2. */
export function stuckInvoices(violations: readonly LifecycleViolationLike[], now: Date): StuckInvoice[] {
  const out: StuckInvoice[] = [];
  for (const v of violations) {
    if (!isStuckInvariant(v.invariant)) continue;
    const since = detailTime(v.detail, v.invariant === 'I1' ? 'updated_at' : 'submitted_to_ksef_at');
    out.push({
      invariant: v.invariant,
      invoiceId: v.invoiceId,
      tenantName: v.tenantName,
      internalNumber: v.internalNumber,
      ksefStatus: v.ksefStatus,
      since,
      automatOverdue: v.invariant === 'I1' && (since === null || now.getTime() - Date.parse(since) > STUCK_AUTOMAT_DEADLINE_MS),
    });
  }
  const bySince = (a: StuckInvoice, b: StuckInvoice): number =>
    a.since === b.since ? 0 : a.since === null ? -1 : b.since === null ? 1 : Date.parse(a.since) - Date.parse(b.since);
  return out.sort((a, b) => STUCK_INVARIANTS.indexOf(a.invariant) - STUCK_INVARIANTS.indexOf(b.invariant) || bySince(a, b));
}

/**
 * Crony, bez których pusta lista błędów nic nie znaczy: worker mógł stanąć.
 * Budżet = termin kompletnego przebiegu z kontraktu F0 (contracts.md,
 * „Due i terminy cronów”).
 */
export const WATCHED_CRONS = [
  { queue: 'cron.ops-heartbeat', label: 'puls workera', budgetMs: 2 * 60 * 1000 },
  { queue: 'cron.critical-alerts-monitor', label: 'monitor alarmów', budgetMs: 10 * 60 * 1000 },
  { queue: 'cron.ksef-lifecycle-reconcile', label: 'strażnik cyklu życia', budgetMs: 30 * 60 * 1000 },
] as const;

/** Ostatni przebieg crona z `inngest_run_log`: kiedy i z jakim wynikiem. */
export interface CronRun {
  at: string;
  status: string;
}

export interface CronFreshness {
  queue: string;
  label: string;
  lastAt: string | null;
  ageMs: number | null;
  /** Brak przebiegu albo przebieg po terminie — worker mógł stanąć. */
  stale: boolean;
  /** Ostatni przebieg zakończył się błędem — cron działa, ale nie robi swojej pracy. */
  failing: boolean;
}

export function cronFreshness(
  lastRuns: ReadonlyMap<string, CronRun | null>,
  now: Date,
): CronFreshness[] {
  return WATCHED_CRONS.map((cron) => {
    const run = lastRuns.get(cron.queue) ?? null;
    const at = run ? Date.parse(run.at) : NaN;
    const ageMs = Number.isFinite(at) ? Math.max(0, now.getTime() - at) : null;
    return {
      queue: cron.queue,
      label: cron.label,
      lastAt: run?.at ?? null,
      ageMs,
      stale: ageMs === null || ageMs > cron.budgetMs,
      failing: run?.status === 'failed',
    };
  });
}
