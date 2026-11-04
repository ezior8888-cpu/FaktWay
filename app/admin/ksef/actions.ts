'use server';

import { randomUUID } from 'node:crypto';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';

import { logAuditSystem } from '@/lib/audit/log-system';
import { requireAdmin } from '@/lib/auth/admin-guard';
import { sendInvoiceDuplicateDecisionEmail } from '@/lib/email/send';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import { describeKsefSendError, ksefSendTransactionStep, type KsefSendMode } from '@/lib/invoices/ksef-send-step';
import {
  OPEN_SUBMISSION_STATUSES,
  OPERATOR_DUPLICATE_MESSAGES,
  OPERATOR_MESSAGES,
  operatorDuplicateDecisionButton,
  operatorDuplicateRefusalReason,
  operatorReconcileRefusal,
  operatorRemindButton,
  operatorRequeueEventRefusal,
  operatorRequeueRefusal,
  type OperatorRefusal,
} from '@/lib/admin/ksef-operator-policy';
import { buildKsefRequeueEvent, KSEF_RESEND_SOURCE_COLUMNS, ksefResendFacts } from '@/lib/invoices/ksef-requeue-event';
import { describeResetError } from '@/lib/invoices/ksef-send-policy';
import { sendJobEvent } from '@/lib/jobs/enqueue';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { KSEF_ORIGINAL_ALARM_KINDS, parseDuplicateCheck, type OriginalRecheckKind } from '@/lib/ksef/duplicate-check';
import {
  DUPLICATE_DECISION_SQL_TEXTS,
  DUPLICATE_DECISION_TEXTS,
  decisionLabel,
  duplicateDecisionOptions,
  duplicateMarker,
  duplicateNoticeVariant,
  fillSqlText,
  ownHistoryInSubmissions,
  type DuplicateChoice,
  type DuplicateDecisionFacts,
  type DuplicateDecisionMode,
  type DuplicateDecisionView,
  type DuplicateNoticeVariant,
  type DuplicateOriginalOffer,
  type DuplicateRefusalDetail,
} from '@/lib/ksef/duplicate-decision';
import { loadDuplicateDecisionFacts } from '@/lib/ksef/duplicate-decision-facts';
import {
  duplicateNoticeKey,
  duplicateReleaseNoticeKey,
  findDuplicateNotices,
  recordDuplicateNotice,
} from '@/lib/ksef/duplicate-decision-notice';
import {
  callDecideKsefDuplicate,
  callDecideKsefDuplicateOriginal,
  callFlagKsefOriginalRecheck,
  callReleaseKsefOriginalReview,
  readDuplicateDecisionBlocker,
  type DecideKsefDuplicateOriginalResult,
  type DuplicateRpcError,
} from '@/lib/ksef/duplicate-decision-rpc';
import {
  originalDecisionAlarms,
  originalRecheckKindFor,
  prepareOriginalImport,
} from '@/lib/ksef/duplicate-original-import';
import type { KsefOriginalImportProjection } from '@/lib/ksef/duplicate-original-projection';
import { recordSendRefusal, type SendRefusalCode } from '@/lib/ksef/send-attempt-ledger';
import { isKsefSubmissionPaused } from '@/lib/ksef/submission-holds';
import { createAdminClient } from '@/lib/supabase/admin';
import { readTenantOwnerContact } from '@/lib/supabase/admin-queries';
import type { KsefEnvironment } from '@/types/ksef';

/**
 * Akcje operatora `/admin/ksef` (cykl życia faktury, PR 3c). Te same RPC
 * z 00131 co akcje klienta, ale z aktorem = operator i bez ograniczeń roli
 * w firmie. Każda akcja: `requireAdmin()` PRZED kluczem serwisowym, odczyt
 * wiersza, decyzja, zapis, audyt systemowy (`invoice.operator_*`).
 *
 * „Tylko uzgodnij” to `requeue_ksef_send(p_reconcile_only = true)` — runner
 * zaczyna od uzgodnienia po referencji, więc wymaga otwartego wpisu `sent`;
 * bez niego wysłałby fakturę od nowa, czego operator w tym trybie nie chce.
 *
 * Zdarzenie odtwarza `buildKsefRequeueEvent` z kopii na wierszu — także dla
 * KOR/ZAL/ROZ (A4b PR2a); decyzja jak przycisk (`operatorRequeueButton`,
 * `operatorReconcileButton`), z tymi samymi faktami.
 *
 * D-A4-1b-3 PR B: „Zapisz decyzję klienta” (RPC `decide_ksef_duplicate`
 * z `p_via = 'operator'`) i „Przypomnij klientowi” (e-mail, najwyżej raz na
 * 24 h) — ta sama polityka co przyciski (`duplicateDecisionOptions`, actor operator).
 *
 * D-A4-1b-3 PR C (00156): powód `faktflow-original` — „Zapisz decyzję klienta” przez
 * `decide_ksef_duplicate_original` (zapis faktury z KSeF albo decyzja po oddaniu), przegląd pliku
 * („Zapisz fakturę z KSeF w FaktWay”, `operatorReleaseOriginalReviewAction` — „Oddaj decyzję klientowi”).
 */

export type OperatorActionResult =
  | { success: true; message: string }
  | { success: false; error: string };

interface OperatorRow {
  id: string;
  tenant_id: string;
  direction: string | null;
  invoice_kind: string | null;
  issue_date: string | null;
  ksef_status: string | null;
  last_error_code: string | null;
  internal_number: string | null;
  fa3_data: unknown;
  special_data: unknown;
  tenants: { nip: string | null } | { nip: string | null }[] | null;
}

const OPERATOR_ROW_COLUMNS =
  `${KSEF_RESEND_SOURCE_COLUMNS}, id, tenant_id, direction, ksef_status, last_error_code, internal_number, tenants(nip)` as const;

async function loadRow(invoiceId: string): Promise<OperatorRow | null> {
  const { data, error } = await createAdminClient()
    .from('invoices')
    .select(OPERATOR_ROW_COLUMNS)
    .eq('id', invoiceId)
    .maybeSingle();
  if (error) throw new Error(`invoice lookup: ${error.message}`);
  return (data as unknown as OperatorRow | null) ?? null;
}

/** Decyzja „Wyślij ponownie” / „Tylko uzgodnij” razem ze zleceniem; odmowa jako dane (kod do dziennika prób). */
type OperatorRequeueDecision =
  | { ok: true; sendAttemptId: string }
  | { ok: false; refusal: OperatorRefusal };

/**
 * A5: każda odmowa po odczycie faktury zostawia wiersz `refused` / `enqueue`
 * w dzienniku prób (`ksef_send_attempts`, 00150) z operatorem w `user_id` —
 * jak odmowa klienta przed kolejką (`ksef-submit-enqueue.ts`). Zapis fail-open:
 * awaria dziennika nie zmienia odpowiedzi dla operatora.
 */
export async function operatorRequeueAction(
  invoiceId: string,
  options: { reconcileOnly: boolean },
): Promise<OperatorActionResult> {
  const admin = await requireAdmin();
  const row = await loadRow(invoiceId);
  if (!row) return { success: false, error: OPERATOR_MESSAGES.notFound };
  const refusal = (code: SendRefusalCode, message: string) =>
    recordSendRefusal({ tenantId: row.tenant_id, invoiceId: row.id, userId: admin.userId, code, message });

  let decision: OperatorRequeueDecision;
  try {
    decision = await decideOperatorRequeue(row, admin.userId, options);
  } catch (e) {
    await refusal('ENQUEUE_ERROR', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    throw e;
  }
  if (!decision.ok) {
    await refusal(decision.refusal.code, decision.refusal.reason);
    return { success: false, error: decision.refusal.reason };
  }

  await logAuditSystem({
    action: options.reconcileOnly ? 'invoice.operator_reconcile' : 'invoice.operator_requeue',
    tenantId: row.tenant_id,
    userId: admin.userId,
    entityType: 'invoice',
    entityId: row.id,
    metadata: {
      operator: admin.email,
      internalNumber: row.internal_number,
      previousStatus: row.ksef_status,
      previousCode: row.last_error_code,
      sendAttemptId: decision.sendAttemptId,
    },
  });
  revalidateViews(row.id);
  return { success: true, message: options.reconcileOnly ? OPERATOR_MESSAGES.reconcileQueued : OPERATOR_MESSAGES.requeued };
}

async function decideOperatorRequeue(
  row: OperatorRow,
  actorUserId: string,
  options: { reconcileOnly: boolean },
): Promise<OperatorRequeueDecision> {
  const environment = configuredKsefEnvironment();
  const facts = ksefResendFacts(row, environment);
  const common = {
    direction: row.direction, status: row.ksef_status, invoiceKind: row.invoice_kind,
    facts, environmentKnown: environment !== null,
  };

  // Ta sama decyzja co przycisk (A4): klasa, środowisko, dane z kopii, rodzaj, data (decyzja b).
  let refused: OperatorRefusal | null;
  if (options.reconcileOnly) {
    const { data: open, error } = await createAdminClient()
      .from('ksef_submissions')
      .select('id')
      .eq('invoice_id', row.id)
      .eq('tenant_id', row.tenant_id)
      .in('status', [...OPEN_SUBMISSION_STATUSES])
      .limit(1);
    if (error) throw new Error(`ksef_submissions: ${error.message}`);
    refused = operatorReconcileRefusal({ ...common, openSent: (open ?? []).length > 0 });
  } else {
    refused = operatorRequeueRefusal({ ...common, errorCode: row.last_error_code });
  }
  if (refused) return { ok: false, refusal: refused };
  if (!environment) return { ok: false, refusal: { code: 'ENV_UNKNOWN', reason: OPERATOR_MESSAGES.envUnknown } };

  // Hamulec operatora — fail-closed, jak przy kolejkowaniu z akcji klienta.
  try {
    if (await isKsefSubmissionPaused()) {
      return { ok: false, refusal: { code: 'KSEF_PAUSED', reason: OPERATOR_MESSAGES.paused } };
    }
  } catch {
    return { ok: false, refusal: { code: 'PAUSE_UNKNOWN', reason: OPERATOR_MESSAGES.pausedUnknown } };
  }

  // Zdarzenie z kopii na wierszu — ta sama definicja co cron (A4b PR2a).
  const built = buildKsefRequeueEvent(row, environment, randomUUID(), { reconcileOnly: options.reconcileOnly });
  if (!built.ok) return { ok: false, refusal: operatorRequeueEventRefusal(built.reason, row.invoice_kind) };
  const mode: KsefSendMode = { kind: 'requeue', actorUserId, reconcileOnly: options.reconcileOnly };

  try {
    await sendJobEvent(
      built.event,
      { inTransaction: ksefSendTransactionStep(mode, { invoiceId: row.id, tenantId: row.tenant_id, attemptId: built.sendAttemptId }) },
    );
  } catch (e) {
    return { ok: false, refusal: { code: 'ENQUEUE_REFUSED', reason: describeKsefSendError(e, mode) } };
  }
  return { ok: true, sendAttemptId: built.sendAttemptId };
}

export async function operatorResetAction(invoiceId: string): Promise<OperatorActionResult> {
  const admin = await requireAdmin();
  const row = await loadRow(invoiceId);
  if (!row) return { success: false, error: OPERATOR_MESSAGES.notFound };
  if (row.direction !== 'outgoing') return { success: false, error: OPERATOR_MESSAGES.incoming };

  const { error } = await createAdminClient().rpc('reset_ksef_send', {
    p_invoice_id: row.id,
    p_tenant_id: row.tenant_id,
    p_actor_user_id: admin.userId,
  });
  if (error) return { success: false, error: describeResetError(error) };

  await logAuditSystem({
    action: 'invoice.operator_reset',
    tenantId: row.tenant_id,
    userId: admin.userId,
    entityType: 'invoice',
    entityId: row.id,
    metadata: {
      operator: admin.email,
      internalNumber: row.internal_number,
      previousStatus: row.ksef_status,
      previousCode: row.last_error_code,
    },
  });
  revalidateViews(row.id);
  return { success: true, message: OPERATOR_MESSAGES.reset };
}

/** Wejście „Zapisz decyzję klienta” (decyzja przekazana przez klienta). */
export type OperatorDecideDuplicateInput = {
  choice: DuplicateChoice;
  /** Skąd decyzja: kanał, data, osoba (co najmniej 10 znaków). */
  note: string;
  /** K i SHA-256 danych oryginału pokazanych operatorowi (wiązanie). */
  originalKsefNumber: string;
  originalSha256: string;
  /** Klient potwierdził „Rozumiem skutki” (decyzja 7 — sprawdzane na serwerze). */
  confirmed: boolean;
  /**
   * PR C (INV-8, T7): to, co pokazała karta operatora — tryb, oferta i środowisko KSeF serwera. Akcja
   * porównuje je ze świeżym stanem i przy rozjeździe odpowiada `DUPLICATE_DECISION_TEXTS.STALE`
   * (bez odczytu archiwum, RPC, znacznika i alarmów). Komponent karty (`operator-duplicate-decision.tsx`)
   * wysyła je ZAWSZE przy powodzie `faktflow-original` (oferta niepusta) — dla takiej karty brak któregokolwiek
   * to `STALE` (fail-closed). Karta powodu PR B (`no-own-file`, `known-number`; 9-argumentowe RPC) nie niesie
   * `mode` ani `offer` (`null` = brak), a `env` jest wtedy opcjonalne. W typie zostają opcjonalne, bo stan
   * bez oferty karty (wczesny powrót z widoku `decided`) i testy PR B budują wejście bez nich.
   */
  mode?: DuplicateDecisionMode | null;
  offer?: DuplicateOriginalOffer | null;
  env?: KsefEnvironment | null;
};

/** Minimalna długość notatki operatora (RPC sprawdza to samo: 22023 NOTE). */
const OPERATOR_NOTE_MIN_LENGTH = 10;

/** Fakty i widok decyzji klienta (actor operator) — klucz serwisowy, filtr firmy z wiersza. */
async function loadDuplicateDecision(row: OperatorRow): Promise<{
  facts: DuplicateDecisionFacts;
  view: DuplicateDecisionView;
}> {
  // PR C (5.4): przy znaczniku `faktflow-original` ładowarka czyta też blokadę SQL (`facts.sqlBlocker`) —
  // kluczem serwisowym; błąd odczytu daje `state-unknown` (fail-closed), nie wyjątek.
  const facts = await loadDuplicateDecisionFacts(createAdminClient(), row.tenant_id, row.id, undefined, { sqlBlocker: 'admin' });
  const view = duplicateDecisionOptions({
    facts,
    actor: 'operator',
    canManage: false,
    environment: configuredKsefEnvironment(),
    now: new Date(),
  });
  return { facts, view };
}

const choiceLabel = (choice: DuplicateChoice): string => (choice === 'same_sale' ? 'ta sama sprzedaż' : 'inna sprzedaż');

/** NIP firmy z wiersza (osadzenie `tenants` jako obiekt albo tablica); `null` — firma bez NIP. */
function tenantNipOf(row: OperatorRow): string | null {
  const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
  const nip = tenant?.nip?.trim();
  return nip ? nip : null;
}

/**
 * Alarm Sentry zapisu oryginału (5.11): `level: 'warning'`, `tags.area = 'ksef.duplicate-decision'`,
 * odcisk `[kind, invoiceId]` — jedno zgłoszenie na fakturę, także przy ponowieniu od zera.
 * `detail` (np. `import-mismatch:number`, `archive-missing`) idzie do tagu.
 */
function reportOriginalAlarm(
  kind: keyof typeof KSEF_ORIGINAL_ALARM_KINDS,
  message: string,
  context: { tenantId: string; invoiceId: string; detail?: string | null; extra?: Record<string, unknown> },
): void {
  const tag = KSEF_ORIGINAL_ALARM_KINDS[kind];
  Sentry.captureMessage(message, {
    level: 'warning',
    tags: { area: 'ksef.duplicate-decision', kind: tag, ...(context.detail ? { detail: context.detail } : {}) },
    fingerprint: [tag, context.invoiceId],
    extra: { tenantId: context.tenantId, invoiceId: context.invoiceId, ...(context.extra ?? {}) },
  });
}

/** Kontekst błędu RPC decyzji: kogo i co oznaczyć („sprawdź ponownie”, INV-25) i do czego odnieść tekst. */
interface DecideErrorContext {
  tenantId: string;
  invoiceId: string;
  choice: DuplicateChoice;
  actorUserId: string;
  originalKsefNumber: string;
  originalSha256: string;
  /** Wartości do tekstów odmowy z blokady SQL (`known-now`, `cross-tenant`, `payments`…). */
  refusalDetail: DuplicateRefusalDetail;
}

/**
 * Odmowa bazy mimo zgody lustra TS (`import-mismatch:*` P0001 albo `import-projection:*` 22023): trwały
 * znacznik „sprawdź ponownie” (INV-25, `flag_ksef_original_recheck` nigdy nie rzuca) i alarm
 * `ksef-duplicate-import-refused` z tagiem `detail` — rozjazd lustra 4.8 to praca Bartosza (runbook
 * „Zapis oryginału odmówiony”).
 *
 * Zwraca `true`, gdy stan zmienił się od kliknięcia (`flag_*`: `stale` / `not-pending`, np. decyzja operatora
 * w międzyczasie): nic nie oznaczono, więc ani alarmu, ani tekstu o błędzie programu — wołający daje `STALE`.
 */
async function refuseImportByDatabase(
  context: DecideErrorContext,
  kind: Extract<OriginalRecheckKind, 'import-mismatch' | 'import-projection'>,
  detail: string,
): Promise<boolean> {
  const flagged = await callFlagKsefOriginalRecheck(createAdminClient(), {
    invoiceId: context.invoiceId,
    tenantId: context.tenantId,
    actorUserId: context.actorUserId,
    originalKsefNumber: context.originalKsefNumber,
    originalSha256: context.originalSha256,
    kind,
  });
  if (isRecheckFlagStale(flagged)) return true;
  reportOriginalAlarm('importRefused', 'KSeF: baza odmówiła zapisu oryginału mimo zgody lustra programu', {
    tenantId: context.tenantId,
    invoiceId: context.invoiceId,
    detail,
    extra: { choice: context.choice, originalKsefNumber: context.originalKsefNumber, actor: 'operator' },
  });
  return false;
}

/** `flag_ksef_original_recheck` nic nie oznaczył, bo stan zmienił się od kliknięcia (`stale` / `not-pending`). */
function isRecheckFlagStale(result: Awaited<ReturnType<typeof callFlagKsefOriginalRecheck>>): boolean {
  return result?.reason === 'stale' || result?.reason === 'not-pending';
}

/** Kody blokady z `DETAIL` odmowy `decide_ksef_duplicate_original` — wyścig: stan zmienił się od odczytu karty. */
const RACE_BLOCKER_DETAILS: readonly string[] = ['known-now', 'cross-tenant', 'recheck-needed', 'provenance-review'];

/**
 * Błąd RPC `decide_ksef_duplicate` / `decide_ksef_duplicate_original` → tekst dla operatora (jak akcja klienta
 * `decideKsefDuplicateAction`, przegląd PR B #3). Nie tekst resetu — ta akcja nie przywraca szkicu.
 *  - P0001 — odmowa z bazy napisana dla człowieka (np. wpłata niewidoczna w `paid_amount`, decyzja zapisana
 *    równolegle: ALREADY) — bez zmian; PR C: z `DETAIL` — `import-mismatch:*` (znacznik + alarm, tekst
 *    `importMismatch`), kody blokady (wyścig → tekst operatora z 6.6), `mode`/`offer`/`choice`/`already`
 *    (tekst bazy, bez Sentry);
 *  - P0002 — faktura nie tej firmy;
 *  - 22023 z tekstem NOTE — baza policzyła notatkę krócej niż akcja; PR C: `import-projection:*` (znacznik
 *    + alarm, tekst `importProgram` — błąd programu);
 *  - reszta (22023 argumentów, 42501, XX000 „Unknown … blocker”, transport) to rozjazd TS↔SQL albo awaria —
 *    ogólny tekst decyzji i Sentry.
 */
async function describeOperatorDecideError(error: DuplicateRpcError, context: DecideErrorContext): Promise<string> {
  const details = typeof error.details === 'string' ? error.details : '';
  if (error.code === 'P0001') {
    const mismatch = /^import-mismatch:(.+)$/.exec(details);
    if (mismatch) {
      if (await refuseImportByDatabase(context, 'import-mismatch', details)) return DUPLICATE_DECISION_TEXTS.STALE;
      return OPERATOR_DUPLICATE_MESSAGES.importMismatch(mismatch[1]!);
    }
    if (RACE_BLOCKER_DETAILS.includes(details)) return operatorDuplicateRefusalReason(details, context.refusalDetail);
    if (error.message) return error.message;
  }
  if (error.code === 'P0002') return OPERATOR_MESSAGES.notFound;
  if (error.code === '22023') {
    if (error.message === DUPLICATE_DECISION_SQL_TEXTS.NOTE.template) return OPERATOR_DUPLICATE_MESSAGES.noteError;
    const projection = /^import-projection:(.+)$/.exec(details);
    if (projection) {
      if (await refuseImportByDatabase(context, 'import-projection', details)) return DUPLICATE_DECISION_TEXTS.STALE;
      return OPERATOR_DUPLICATE_MESSAGES.importProgram(projection[1]!);
    }
  }
  Sentry.captureException(new Error(`decide_ksef_duplicate (operator): błąd bazy ${error.code || 'bez kodu'}`), {
    tags: { area: 'ksef.duplicate-decision', kind: 'operator-decision' },
    extra: {
      tenantId: context.tenantId, invoiceId: context.invoiceId, choice: context.choice,
      code: error.code ?? null, message: error.message ?? null,
    },
  });
  return DUPLICATE_DECISION_TEXTS.GENERIC;
}

/** Komunikat sukcesu: zapis oryginału (`successRecord` / `successImport`) albo decyzja bez zapisu (`success`). */
function decisionSuccessMessage(args: {
  mode: DuplicateDecisionMode | null;
  offer: DuplicateOriginalOffer | null;
  choice: DuplicateChoice;
  nrK: string;
}): string {
  if (args.mode !== 'import') return OPERATOR_DUPLICATE_MESSAGES.success(args.choice);
  return decisionLabel(args.offer, args.choice) === 'record'
    ? OPERATOR_DUPLICATE_MESSAGES.successRecord(args.nrK)
    : OPERATOR_DUPLICATE_MESSAGES.successImport(args.choice, args.nrK);
}

/**
 * Odmowa suchego przebiegu zapisu oryginału (5.6 krok 9; kontrakt I6/M8): `archive-*`, `gate-drift` i `not-buildable`
 * przy `pair`/`record` oznaczają fakturę do ponownego sprawdzenia (`flag_ksef_original_recheck`, INV-25) i zgłaszają alarm
 * `ksef-duplicate-recheck` — przy KAŻDEJ ofercie zapisu, także `review-*` (ponowne sprawdzenie odbudowuje archiwum).
 * `not-buildable` przy `review-*` nie oznacza niczego: I5R jest trwałym sygnałem, a operator ma tekst `notBuildable`.
 * `not-buildable` przy `pair`/`record` (brama mówiła „importable”) to błąd programu: znacznik, alarm i tekst
 * `notBuildableProgram` (nie `notBuildable`, który odsyła do ofert przeglądu).
 * Gdy `flag_*` odpowie `stale` / `not-pending` (stan zmienił się od kliknięcia), nic nie zostało oznaczone:
 * `STALE` bez alarmu i bez tekstu „sprawdź ponownie”.
 * `read-failed` (chwilowy błąd magazynu) — bez znacznika, tylko Sentry.
 */
async function refusePreparedImport(args: {
  row: OperatorRow;
  actorUserId: string;
  offer: DuplicateOriginalOffer;
  originalKsefNumber: string;
  originalSha256: string;
  archivePath: string | null;
  failure: Extract<Awaited<ReturnType<typeof prepareOriginalImport>>, { ok: false }>;
}): Promise<OperatorActionResult> {
  const { row, failure, offer } = args;
  const M = OPERATOR_DUPLICATE_MESSAGES;
  const path = args.archivePath ?? '(brak)';

  if (failure.kind === 'read-failed') {
    Sentry.captureException(failure.cause ?? new Error('prepareOriginalImport: odczyt archiwum nieudany'), {
      tags: { area: 'ksef.duplicate-decision', kind: 'operator-archive-read' },
      extra: { tenantId: row.tenant_id, invoiceId: row.id, archivePath: args.archivePath },
    });
    return { success: false, error: M.archiveReadFailed(path) };
  }
  const reviewOffer = offer === 'review-pair' || offer === 'review-record';
  if (failure.kind === 'not-buildable' && reviewOffer) {
    return { success: false, error: M.notBuildable(failure.detail ?? 'brak szczegółów') };
  }

  const kind = originalRecheckKindFor(failure);
  if (kind !== null) {
    const flagged = await callFlagKsefOriginalRecheck(createAdminClient(), {
      invoiceId: row.id,
      tenantId: row.tenant_id,
      actorUserId: args.actorUserId,
      originalKsefNumber: args.originalKsefNumber,
      originalSha256: args.originalSha256,
      kind,
    });
    if (isRecheckFlagStale(flagged)) return { success: false, error: DUPLICATE_DECISION_TEXTS.STALE };
    reportOriginalAlarm('recheck', 'KSeF: zapis oryginału odmówiony w chwili zapisu — faktura do ponownego sprawdzenia', {
      tenantId: row.tenant_id,
      invoiceId: row.id,
      // Tag `detail`: rodzaj znacznika (+ problem bramy / kod 4.8 przy `not-buildable`); opis zmiany bramy idzie do `extra`.
      detail: failure.kind === 'not-buildable' && failure.detail ? `${kind}:${failure.detail}` : kind,
      extra: { offer, recheckKind: kind, detail: failure.detail ?? null, actor: 'operator' },
    });
    revalidateViews(row.id);
  }
  switch (failure.kind) {
    case 'archive-missing':
      return { success: false, error: M.archive(path, 'missing') };
    case 'archive-mismatch':
      return { success: false, error: M.archive(path, 'mismatch') };
    case 'gate-drift':
      return { success: false, error: M.gateDrift };
    default:
      // `not-buildable` przy `pair` / `record`: oferty przeglądu wróciły wyżej.
      return { success: false, error: M.notBuildableProgram(failure.detail ?? 'brak szczegółów') };
  }
}

/**
 * „Zapisz decyzję klienta” (D-A4-1b-3 PR B, spec §2.6.4; decyzje Bartosza
 * 04.10 i 07.10.2026 (7)). Operator zapisuje decyzję przekazaną przez klienta —
 * nie decyduje sam. Kolejność: `requireAdmin()` przed kluczem serwisowym →
 * fakty i polityka (te same reguły co RPC) → notatka → wiązanie z danymi
 * pokazanymi operatorowi → „Rozumiem skutki” klienta → RPC. RPC zapisuje
 * stan i swój audyt; akcja dopisuje `invoice.operator_duplicate_decision`
 * tylko przy nowej decyzji (`already_decided` false).
 * Ponowienie (podwójne kliknięcie): RPC odpowiada `already_decided` bez zapisów.
 *
 * PR C (00156, spec v3 5.6): powód `faktflow-original` — oferty `pair` / `record` / `released` oraz, w przeglądzie
 * pliku (I5R, T8), `review-pair` / `review-record` („Zapisz fakturę z KSeF w FaktWay”, widok `review`):
 *  - wiązanie z kartą (INV-8): K, SHA-256, a przy ofercie — tryb, oferta i środowisko (`STALE` bez skutków);
 *  - `view.choices` (`record` → tylko „ta sama”), „Rozumiem skutki” wg `needsConfirmation`;
 *  - tryb `import`: suchy przebieg `prepareOriginalImport` (archiwum, brama, projekcja — tylko odczyty), potem
 *    `decide_ksef_duplicate_original` z projekcją; odmowa przebiegu → patrz `refusePreparedImport`;
 *  - tryb `no-import` (`released`): RPC bez odczytu archiwum, `p_import` NULL;
 *  - alarmy ze stanu bazy (`originalDecisionAlarms`) na KAŻDEJ ścieżce sukcesu z faktura K (nowa decyzja,
 *    `already_decided`, wczesny widok `decided`).
 * Ponowienie od zera: odczyty bez skutków; `flag_*` drugi raz → `already`; RPC decyzji jest idempotentne
 * (`already_decided` z tym samym K); alarmy mają odcisk `[kind, X]`; audyt tylko przy nowej decyzji.
 */
export async function operatorDecideDuplicateAction(
  invoiceId: string,
  input: OperatorDecideDuplicateInput,
): Promise<OperatorActionResult> {
  const admin = await requireAdmin();
  const row = await loadRow(invoiceId);
  if (!row) return { success: false, error: OPERATOR_MESSAGES.notFound };
  if (input.choice !== 'same_sale' && input.choice !== 'other_sale') {
    return { success: false, error: DUPLICATE_DECISION_TEXTS.GENERIC };
  }

  const { facts, view } = await loadDuplicateDecision(row);
  const adminClient = createAdminClient();
  if (view.kind === 'decided') {
    // Zapisana wcześniej (zgubiona odpowiedź) — ta sama decyzja to sukces bez RPC i audytu (z alarmami ze stanu bazy).
    const importedId = view.importedInvoiceId ?? null;
    if (view.choice === input.choice && view.originalKsefNumber === input.originalKsefNumber) {
      if (importedId) await originalDecisionAlarms(adminClient, { tenantId: row.tenant_id, invoiceId: row.id, importedInvoiceId: importedId });
      return {
        success: true,
        message: decisionSuccessMessage({
          mode: view.mode ?? null,
          offer: view.offer ?? null,
          choice: view.choice,
          nrK: view.retiredInternalNumber ?? row.internal_number ?? '(bez numeru)',
        }),
      };
    }
    if (importedId) {
      return {
        success: false,
        error: fillSqlText(
          DUPLICATE_DECISION_SQL_TEXTS.ALREADY_IMPORTED.template,
          view.retiredInternalNumber ?? row.internal_number ?? '(bez numeru)',
          DUPLICATE_DECISION_TEXTS.FAKTFLOW.IMPORTED_CARD_CHOICE[decisionLabel(view.offer ?? null, view.choice)],
        ),
      };
    }
    return {
      success: false,
      error: fillSqlText(DUPLICATE_DECISION_SQL_TEXTS.ALREADY.template, row.internal_number ?? '(bez numeru)', choiceLabel(view.choice)),
    };
  }
  // Widok `review` (przegląd pliku) ma własne przyciski; reszta odmów ma powód z polityki.
  if (view.kind !== 'decidable' && view.kind !== 'review') {
    return { success: false, error: operatorDuplicateDecisionButton(view).reason ?? OPERATOR_DUPLICATE_MESSAGES.notPending };
  }
  const environment = configuredKsefEnvironment();
  if (!environment) return { success: false, error: OPERATOR_MESSAGES.envUnknown };

  const note = (input.note ?? '').trim();
  // Znaki (punkty kodowe) jak `length()` w bazie — nie jednostki UTF-16 (emoji to dwie).
  if ([...note].length < OPERATOR_NOTE_MIN_LENGTH) return { success: false, error: OPERATOR_DUPLICATE_MESSAGES.noteError };
  if (view.originalKsefNumber !== input.originalKsefNumber || view.originalSha256 !== input.originalSha256) {
    return { success: false, error: DUPLICATE_DECISION_TEXTS.STALE };
  }

  // INV-8 (T7): tryb, oferta i środowisko karty muszą być te same co w świeżym widoku. Widok powodu PR B ma
  // `mode = offer = null` (9-argumentowe RPC); przy ofercie `env` karty musi być środowiskiem serwera.
  const viewOffer: DuplicateOriginalOffer | null = view.offer ?? null;
  const viewMode: DuplicateDecisionMode | null = view.kind === 'review' ? 'import' : view.mode ?? null;
  if ((input.mode ?? null) !== viewMode || (input.offer ?? null) !== viewOffer) {
    return { success: false, error: DUPLICATE_DECISION_TEXTS.STALE };
  }
  if (viewOffer !== null ? input.env !== environment : input.env != null && input.env !== environment) {
    return { success: false, error: DUPLICATE_DECISION_TEXTS.STALE };
  }

  const nr = row.internal_number ?? '(bez numeru)';
  const choices: readonly DuplicateChoice[] = view.choices ?? ['same_sale', 'other_sale'];
  if (!choices.includes(input.choice)) {
    return { success: false, error: fillSqlText(DUPLICATE_DECISION_SQL_TEXTS.CHOICE.template, nr) };
  }
  if (view.needsConfirmation[input.choice] && !input.confirmed) {
    return { success: false, error: OPERATOR_DUPLICATE_MESSAGES.confirmMissing };
  }

  const baseArgs = {
    invoiceId: row.id,
    tenantId: row.tenant_id,
    actorUserId: admin.userId,
    choice: input.choice,
    via: 'operator' as const,
    originalKsefNumber: view.originalKsefNumber,
    originalSha256: view.originalSha256,
    env: environment,
    note,
  };
  let reply: { data: DecideKsefDuplicateOriginalResult | null; error: DuplicateRpcError | null };
  if (viewOffer === null) {
    // Powód PR B: 9-argumentowe RPC bez zmian.
    reply = await callDecideKsefDuplicate(adminClient, baseArgs);
  } else {
    if (viewMode === null) return { success: false, error: OPERATOR_DUPLICATE_MESSAGES.stateUnknown };
    let importPayload: KsefOriginalImportProjection | null = null;
    if (viewMode === 'import') {
      // Suchy przebieg (tylko odczyty): archiwum, brama, projekcja K i lustro 4.8.
      const marker = duplicateMarker(facts.submissions);
      const check = parseDuplicateCheck(marker?.original_check);
      const nip = tenantNipOf(row);
      if (!check) return { success: false, error: OPERATOR_DUPLICATE_MESSAGES.stateUnknown };
      if (!nip) return { success: false, error: OPERATOR_MESSAGES.noNip };
      const prepared = await prepareOriginalImport({
        tenantId: row.tenant_id,
        internalNumber: row.internal_number ?? '',
        tenantNip: nip,
        offer: viewOffer,
        check,
        ksefNumber: view.originalKsefNumber,
        env: environment,
        now: new Date(),
      });
      if (!prepared.ok) {
        return refusePreparedImport({
          row,
          actorUserId: admin.userId,
          offer: viewOffer,
          originalKsefNumber: view.originalKsefNumber,
          originalSha256: view.originalSha256,
          archivePath: check.archivePath,
          failure: prepared,
        });
      }
      importPayload = prepared.projection;
    }
    reply = await callDecideKsefDuplicateOriginal(adminClient, { ...baseArgs, mode: viewMode, offer: viewOffer, importPayload });
  }

  const { data, error } = reply;
  if (error) {
    return {
      success: false,
      error: await describeOperatorDecideError(error, {
        tenantId: row.tenant_id,
        invoiceId: row.id,
        choice: input.choice,
        actorUserId: admin.userId,
        originalKsefNumber: view.originalKsefNumber,
        originalSha256: view.originalSha256,
        refusalDetail: refusalDetailFromFacts(facts),
      }),
    };
  }

  const importedId = viewOffer !== null ? data?.imported_invoice_id ?? null : null;
  const resultOffer = viewOffer !== null ? data?.offer ?? viewOffer : null;
  const resultMode = viewOffer !== null ? data?.mode ?? viewMode : null;
  if (data?.already_decided !== true) {
    await logAuditSystem({
      action: 'invoice.operator_duplicate_decision',
      tenantId: row.tenant_id,
      userId: admin.userId,
      entityType: 'invoice',
      entityId: row.id,
      metadata: {
        operator: admin.email,
        internalNumber: row.internal_number,
        choice: input.choice,
        note,
        originalKsefNumber: view.originalKsefNumber,
        reason: data?.reason ?? (view.kind === 'decidable' ? view.reason : 'faktflow-original'),
        // PR C: zapis oryginału — tryb, oferta i K (PR B: bez tych kluczy).
        ...(viewOffer !== null ? { mode: resultMode, offer: resultOffer, importedInvoiceId: importedId } : {}),
      },
    });
  }
  revalidateViews(row.id);
  if (importedId) await originalDecisionAlarms(adminClient, { tenantId: row.tenant_id, invoiceId: row.id, importedInvoiceId: importedId });
  return {
    success: true,
    message: decisionSuccessMessage({
      mode: resultMode,
      offer: resultOffer,
      choice: input.choice,
      nrK: data?.retired_internal_number ?? row.internal_number ?? '(bez numeru)',
    }),
  };
}

/** Wejście „Oddaj decyzję klientowi (plik nie z FaktWay)”. */
export type OperatorReleaseOriginalReviewInput = {
  /** K i SHA-256 pliku pokazanego operatorowi w przeglądzie (wiązanie). */
  originalKsefNumber: string;
  originalSha256: string;
  /** Co operator sprawdził w pliku i dlaczego to nie plik z FaktWay (co najmniej 10 znaków). */
  note: string;
};

/** Komunikat 22023 z `release_ksef_original_review` (00156, krok 1) dla notatki spoza 10–1000 znaków; reszta 22023 to zły id, SHA albo środowisko. */
const RELEASE_NOTE_SQL_MESSAGE = 'KSeF original release requires a note of 10 to 1000 characters';

/**
 * Błąd RPC `release_ksef_original_review` → tekst operatora (6.6). Odmowy P0001 niosą KOD w komunikacie
 * (`release:*`), a `release:not-review` — kod blokady w `DETAIL` (`payments`, `recheck-needed`, `none`…). XX000
 * („oddanie nie zadziałało”, baza wycofała zapis) → `releaseFailed` + alarm `ksef-duplicate-release-failed`.
 */
function describeOperatorReleaseError(
  error: DuplicateRpcError,
  context: { tenantId: string; invoiceId: string; refusalDetail: DuplicateRefusalDetail },
): string {
  const M = OPERATOR_DUPLICATE_MESSAGES;
  if (error.code === 'P0001') {
    switch (error.message) {
      case 'release:not-review':
        return operatorDuplicateRefusalReason(error.details ?? 'none', context.refusalDetail);
      case 'release:stale':
        return M.releaseStale;
      case 'release:env':
        return operatorDuplicateRefusalReason('env', context.refusalDetail);
      case 'release:own-file':
        return M.reviewRecordOnly;
      case 'release:no-gate':
        return M.releaseNoGate;
      default:
        break;
    }
  }
  if (error.code === 'P0002') return OPERATOR_MESSAGES.notFound;
  // Tylko notatka to błąd operatora; inny 22023 (id, SHA, środowisko) to rozjazd programu → Sentry i tekst ogólny.
  if (error.code === '22023' && error.message === RELEASE_NOTE_SQL_MESSAGE) return M.noteError;
  if (error.code === 'XX000') {
    reportOriginalAlarm('releaseFailed', 'KSeF: oddanie decyzji klientowi nie zadziałało (stan po zapisie niezgodny)', {
      tenantId: context.tenantId,
      invoiceId: context.invoiceId,
      extra: { code: error.code, message: error.message ?? null },
    });
    return M.releaseFailed;
  }
  Sentry.captureException(new Error(`release_ksef_original_review: błąd bazy ${error.code || 'bez kodu'}`), {
    tags: { area: 'ksef.duplicate-decision', kind: 'operator-release' },
    extra: { tenantId: context.tenantId, invoiceId: context.invoiceId, code: error.code ?? null, message: error.message ?? null },
  });
  return DUPLICATE_DECISION_TEXTS.GENERIC;
}

/**
 * „Oddaj decyzję klientowi (plik nie z FaktWay)” (PR C, T8, spec v3 5.6 i 6.6): operator przejrzał plik z oznaczeniem
 * FaktWay (widok `review`, `review-pair`) i uznał, że nie powstał w FaktWay — oddaje decyzję klientowi jak przy fakturze
 * z innego programu (oferta `released`, tryb `no-import`; K nie jest zapisywana). Kolejność: `requireAdmin()` → widok
 * `review` z `releasable` (inaczej `reviewRecordOnly` albo `releaseNotReview`) albo, po zatwierdzonym oddaniu, widok
 * `released` (ponowienie do RPC: `already_released`) → środowisko → wiązanie z plikiem
 * (K, SHA-256) → notatka → RPC `release_ksef_original_review` → audyt `invoice.operator_original_release` (tylko nowe
 * oddanie) → e-mail do klienta „sprawdziliśmy plik — zdecyduj” (wariant `released`, `reminder: false`, BEZ reguły 24 h).
 *
 * Ponowienie od zera: RPC po commicie odpowiada `already_released` z tym samym `release_at` (bez zapisu i audytu);
 * e-mail ma klucz `…/oddanie-{release_at}` — przy `already_released` brak śladu rodziny `decision` od `release_at` oznacza
 * zgubioną odpowiedź albo nieudany e-mail, więc wysyłka idzie z TYM SAMYM kluczem (Resend deduplikuje 24 h); ślad jest →
 * bez wysyłki. Błąd e-maila albo śladu nie cofa oddania (`releaseSentNoEmail`; „Przypomnij klientowi” wyśle ponownie).
 */
export async function operatorReleaseOriginalReviewAction(
  invoiceId: string,
  input: OperatorReleaseOriginalReviewInput,
): Promise<OperatorActionResult> {
  const admin = await requireAdmin();
  const row = await loadRow(invoiceId);
  if (!row) return { success: false, error: OPERATOR_MESSAGES.notFound };

  const { facts, view: fresh } = await loadDuplicateDecision(row);
  const M = OPERATOR_DUPLICATE_MESSAGES;
  // Po zatwierdzonym oddaniu baza nie ma już przeglądu: znacznik niesie `importGate.release`, blokada SQL jest NULL,
  // więc widok to `decidable` z ofertą `released`. Takie ponowne kliknięcie (zgubiona odpowiedź, INV-21, spec 5.13
  // wiersz 7) MUSI dojść do RPC — ono odpowiada `already_released` z zapisanym `release_at`, a e-mail wychodzi z tym
  // samym kluczem `…/oddanie-{release_at}`. Wiązanie z plikiem (K, SHA) i notatka zostają.
  const view = fresh.kind === 'review' || (fresh.kind === 'decidable' && fresh.offer === 'released') ? fresh : null;
  if (view === null) {
    // Odmowa polityki (blokada SQL, środowisko…) ma własny powód; reszta — stan zmienił się od otwarcia karty.
    return { success: false, error: fresh.kind === 'refused' ? operatorDuplicateDecisionButton(fresh).reason ?? M.releaseNotReview : M.releaseNotReview };
  }
  if (view.kind === 'review' && !view.releasable) return { success: false, error: M.reviewRecordOnly };
  const environment = configuredKsefEnvironment();
  if (!environment) return { success: false, error: OPERATOR_MESSAGES.envUnknown };
  if (view.originalKsefNumber !== input.originalKsefNumber || view.originalSha256 !== input.originalSha256) {
    return { success: false, error: M.releaseStale };
  }
  const note = (input.note ?? '').trim();
  // Znaki (punkty kodowe) jak `length()` w bazie; RPC sprawdza też górną granicę (1000).
  if ([...note].length < OPERATOR_NOTE_MIN_LENGTH) return { success: false, error: M.noteError };

  const { data, error } = await callReleaseKsefOriginalReview(createAdminClient(), {
    invoiceId: row.id,
    tenantId: row.tenant_id,
    actorUserId: admin.userId,
    originalKsefNumber: view.originalKsefNumber,
    originalSha256: view.originalSha256,
    env: environment,
    note,
  });
  if (error) {
    return {
      success: false,
      error: describeOperatorReleaseError(error, { tenantId: row.tenant_id, invoiceId: row.id, refusalDetail: refusalDetailFromFacts(facts) }),
    };
  }
  if (!data) {
    // Odpowiedź bez błędu i bez danych to rozjazd z bazą — jak „oddanie nie zadziałało”.
    reportOriginalAlarm('releaseFailed', 'KSeF: oddanie decyzji klientowi bez odpowiedzi bazy', { tenantId: row.tenant_id, invoiceId: row.id });
    return { success: false, error: M.releaseFailed };
  }

  if (!data.already_released) {
    await logAuditSystem({
      action: 'invoice.operator_original_release',
      tenantId: row.tenant_id,
      userId: admin.userId,
      entityType: 'invoice',
      entityId: row.id,
      metadata: {
        operator: admin.email,
        internalNumber: row.internal_number,
        note,
        originalKsefNumber: view.originalKsefNumber,
        originalSha256: view.originalSha256,
        // Nowe oddanie zawsze wychodzi z przeglądu; widok `released` daje `already_released` (bez audytu).
        problems: view.kind === 'review' ? view.problems : null,
        releaseAt: data.release_at,
      },
    });
  }
  revalidateViews(row.id);

  const k = view.originalKsefNumber;
  if (data.already_released) {
    // Ślad rodziny `decision` od `release_at` = e-mail po oddaniu już poszedł (zgubiona odpowiedź, podwójne kliknięcie).
    let lastAt: string | null;
    try {
      ({ lastAt } = await findDuplicateNotices(row.tenant_id, row.id, k, 'decision'));
    } catch (e) {
      Sentry.captureException(e, { tags: { area: 'ksef.duplicate-decision', kind: 'release-notice-read' }, extra: { invoiceId: row.id } });
      return { success: false, error: M.releaseSentNoEmail('nie udało się odczytać śladu powiadomień') };
    }
    if (lastAt !== null && Date.parse(lastAt) >= Date.parse(data.release_at)) {
      return { success: true, message: M.releaseAlreadyEmailed(formatWarsawDateTime(lastAt)) };
    }
  }

  const sent = await sendOperatorDuplicateNotice({
    row,
    admin,
    ksefNumber: k,
    variant: 'released',
    reminder: false,
    idempotencyKey: duplicateReleaseNoticeKey(row.id, k, data.release_at),
    reminderCount: null,
    sentryPrefix: 'release-notice',
  });
  if (!sent.ok) {
    return {
      success: false,
      error: sent.stage === 'record' ? M.releaseSentNotRecorded : M.releaseSentNoEmail(sent.reason),
    };
  }
  return { success: true, message: M.releaseSuccess(sent.email) };
}

/** Wartości do tekstu odmowy z blokady SQL (widok `decidable` nie niesie `detail`). */
function refusalDetailFromFacts(facts: DuplicateDecisionFacts): DuplicateRefusalDetail {
  const marker = duplicateMarker(facts.submissions);
  const check = marker && typeof marker.original_check === 'object' && marker.original_check !== null
    ? (marker.original_check as Record<string, unknown>)
    : null;
  const paid = facts.invoice?.paid_amount;
  const paidAmount = typeof paid === 'number' ? paid : typeof paid === 'string' && paid.trim() !== '' ? Number(paid) : null;
  // PR C: rodzaj i czas znacznika „sprawdź ponownie” (tekst `recheckPending`) z poprawnie sparsowanego znacznika.
  const recheckNeeded = parseDuplicateCheck(check)?.recheckNeeded;
  return {
    originalKsefNumber: marker?.original_ksef_number ?? null,
    reason: typeof check?.reason === 'string' ? check.reason : null,
    checkEnv: typeof check?.env === 'string' ? check.env : null,
    environment: configuredKsefEnvironment(),
    paidAmount: paidAmount !== null && Number.isFinite(paidAmount) ? paidAmount : null,
    knownInvoiceNumber: check?.reason === 'known-number' ? facts.knownInvoice?.internalNumber ?? 'bez numeru' : null,
    recheckKind: recheckNeeded?.kind ?? null,
    recheckAt: recheckNeeded?.at ?? null,
  };
}

/**
 * E-mail do właściciela firmy o decyzji (wspólny dla „Przypomnij klientowi” i e-maila po oddaniu decyzji):
 * adres ścisłym odczytem (błąd bazy albo GoTrue to nie „firma nie ma adresu”), wysyłka z kluczem Resend,
 * ślad w `audit_logs` po dostarczeniu (`recordDuplicateNotice`, z wariantem). Nie rzuca: wynik opisuje, na którym
 * etapie przerwano — wołający dobiera tekst (PR B: `remind*`, PR C: `release*`). Alarmy Sentry mają `sentryPrefix`.
 */
async function sendOperatorDuplicateNotice(input: {
  row: OperatorRow;
  admin: { userId: string; email: string };
  ksefNumber: string;
  variant: DuplicateNoticeVariant;
  reminder: boolean;
  idempotencyKey: string;
  /** Numer przypomnienia (liczba śladów przed kliknięciem); `null` — e-mail po oddaniu decyzji. */
  reminderCount: number | null;
  sentryPrefix: 'reminder' | 'release-notice';
}): Promise<
  | { ok: true; email: string }
  | { ok: false; stage: 'owner-read' | 'no-email' | 'send' | 'record'; reason: string }
> {
  const { row, admin, sentryPrefix } = input;
  const tags = (suffix: string) => ({ area: 'ksef.duplicate-decision', kind: suffix ? `${sentryPrefix}-${suffix}` : sentryPrefix });

  // Wariant ścisły (przegląd PR B #1/#4): chwilowy błąd bazy albo GoTrue to nie
  // „firma nie ma adresu” — operator ponawia, a nie szuka innego kanału.
  let email: string | null;
  try {
    ({ email } = await readTenantOwnerContact(row.tenant_id));
  } catch (e) {
    Sentry.captureException(e, { tags: tags('owner-read'), extra: { invoiceId: row.id } });
    return { ok: false, stage: 'owner-read', reason: 'nie udało się odczytać adresu e-mail właściciela' };
  }
  if (!email) return { ok: false, stage: 'no-email', reason: 'firma nie ma adresu e-mail właściciela' };

  let sent: Awaited<ReturnType<typeof sendInvoiceDuplicateDecisionEmail>>;
  try {
    sent = await sendInvoiceDuplicateDecisionEmail(
      email,
      {
        invoiceId: row.id,
        invoiceNumber: row.internal_number ?? 'bez numeru',
        ksefNumber: input.ksefNumber,
        reminder: input.reminder,
        variant: input.variant,
      },
      { idempotencyKey: input.idempotencyKey },
    );
  } catch (e) {
    Sentry.captureException(e, { tags: tags(''), extra: { invoiceId: row.id } });
    return { ok: false, stage: 'send', reason: 'Resend' };
  }
  if (!sent.sent) return { ok: false, stage: 'send', reason: sent.reason ?? 'nieznany powód' };

  try {
    await recordDuplicateNotice({
      tenantId: row.tenant_id,
      invoiceId: row.id,
      ksefNumber: input.ksefNumber,
      via: 'operator',
      idempotencyKey: input.idempotencyKey,
      emailed: true,
      pushSent: 0,
      reminder: input.reminderCount,
      operatorEmail: admin.email,
      userId: admin.userId,
      variant: input.variant,
    });
  } catch (e) {
    Sentry.captureException(e, { tags: tags('record'), extra: { invoiceId: row.id } });
    return { ok: false, stage: 'record', reason: 'ślad niezapisany' };
  }
  return { ok: true, email };
}

/**
 * „Przypomnij klientowi” (D-A4-1b-3 PR B, spec §2.6.4; decyzje Bartosza
 * 07.10.2026 (5), (12)): ponowny e-mail „Faktura … czeka na Twoją decyzję”,
 * najwyżej raz na 24 h. Blokada z bazy jest autorytatywna (wiersze `payments`).
 * Klucz Resend `…/przypomnienie-{n}` (n = liczba śladów przed kliknięciem):
 * podwójne kliknięcie przed zapisem śladu trafia w ten sam klucz, po zapisie
 * odmawia reguła 24 h. Bez pusha — tylko e-mail.
 *
 * PR C (spec v3 5.6): wariant e-maila (`pair` / `record` / `released`) z tej samej oferty co panel
 * (`duplicateNoticeVariant`, własna historia z faktów); w przeglądzie pliku — odmowa `remindReview`
 * (klient nie zdecyduje, dopóki operator nie przejrzy pliku), przy `recheck-needed` — `recheckPending`.
 * Reguła 24 h i numer przypomnienia liczą ślady rodziny `decision` (ślad „sprawdzamy” jej nie blokuje).
 */
export async function operatorRemindDuplicateDecisionAction(invoiceId: string): Promise<OperatorActionResult> {
  const admin = await requireAdmin();
  const row = await loadRow(invoiceId);
  if (!row) return { success: false, error: OPERATOR_MESSAGES.notFound };

  const { facts, view } = await loadDuplicateDecision(row);
  if (view.kind === 'review') return { success: false, error: OPERATOR_DUPLICATE_MESSAGES.remindReview };
  const decide = operatorDuplicateDecisionButton(view);
  if (view.kind !== 'decidable' || !decide.enabled) {
    return { success: false, error: decide.reason ?? OPERATOR_DUPLICATE_MESSAGES.notPending };
  }
  // Blokada przy `faktflow-original` jest już w faktach (ładowarka); powody PR B czytamy tu — autorytatywnie.
  const blocker = facts.sqlBlocker !== undefined
    ? facts.sqlBlocker
    : await readDuplicateDecisionBlocker(createAdminClient(), row.id, row.tenant_id);
  if (blocker) return { success: false, error: operatorDuplicateRefusalReason(blocker, refusalDetailFromFacts(facts)) };

  const k = view.originalKsefNumber;
  const marker = duplicateMarker(facts.submissions);
  const variant = marker
    ? duplicateNoticeVariant(marker.original_check, ownHistoryInSubmissions(facts.submissions, marker), blocker)
    : null;
  // Widok `decidable` przy blokadzie NULL daje `pair` / `record` / `released`; inaczej stan niespójny — nie wysyłamy.
  if (variant === null || variant === 'review') return { success: false, error: OPERATOR_DUPLICATE_MESSAGES.stateUnknown };

  const notices = await findDuplicateNotices(row.tenant_id, row.id, k);
  const remind = operatorRemindButton(decide, notices, new Date());
  if (!remind.enabled) return { success: false, error: remind.reason ?? OPERATOR_DUPLICATE_MESSAGES.notPending };

  const sent = await sendOperatorDuplicateNotice({
    row,
    admin,
    ksefNumber: k,
    variant,
    reminder: true,
    idempotencyKey: duplicateNoticeKey(row.id, k, notices.count),
    reminderCount: notices.count,
    sentryPrefix: 'reminder',
  });
  if (!sent.ok) {
    switch (sent.stage) {
      case 'owner-read':
        return { success: false, error: OPERATOR_DUPLICATE_MESSAGES.remindReadFailed };
      case 'no-email':
        return { success: false, error: OPERATOR_DUPLICATE_MESSAGES.remindNoEmail };
      case 'send':
        return { success: false, error: OPERATOR_DUPLICATE_MESSAGES.remindNotSent(sent.reason) };
      case 'record':
        return { success: false, error: OPERATOR_DUPLICATE_MESSAGES.remindSentNotRecorded };
    }
  }
  revalidateViews(row.id);
  return { success: true, message: OPERATOR_DUPLICATE_MESSAGES.remindSuccess(sent.email) };
}

function revalidateViews(invoiceId: string): void {
  revalidatePath('/admin/ksef');
  revalidatePath(`/admin/ksef/${invoiceId}`);
  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoiceId}`);
}
