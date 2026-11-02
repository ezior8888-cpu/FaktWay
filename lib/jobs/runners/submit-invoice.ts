import { createHash } from 'node:crypto';
import { assertJobIdentity, requireInvoiceTenant } from './tenant-boundary';
import * as Sentry from '@sentry/nextjs';
import { NonRetriableError, RetryAfterError } from '../errors';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { SUPPORT_EMAIL } from '@/lib/site';
import { IssueDatePassedError, issueDatePassedMessage } from '@/lib/ksef/special-issue-date';
import type { JobContext } from '@/lib/jobs/registry';
import type { KsefEnvironment } from '@/types/ksef';
import { ANALYTICS_EVENTS } from '@/lib/analytics/events';
import { trackServer } from '@/lib/analytics/server';
import { logAuditSystem } from '@/lib/audit/log-system';
import { invoiceSubmitRequested } from '../events';
import { submitInvoiceFullFlow } from '@/lib/ksef/submit-invoice-full';
import { assertSubmitReferences } from '@/lib/ksef/submit-reference-boundary';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import {
  KsefNotVerifiedError,
  requireKsefVerificationForBackgroundJob,
} from '@/lib/auth/ksef-verification-guard';
import {
  getTenantKsefCredentials,
  KsefCredentialsError,
  updateInvoiceStatus,
} from '@/lib/supabase/admin-queries';
import { createAdminClient } from '@/lib/supabase/server';
import { KsefApiError } from '@/lib/ksef/client';
import {
  checkInvoiceStatusByReference,
  downloadKsefInvoice,
  fetchKsefAcquisitionDate,
  KSEF_INVOICE_NOT_FOUND,
  KSEF_INVOICE_NOT_YET_AVAILABLE,
  KSEF_DUPLICATE_INVOICE,
  KSEF_SESSION_NOT_FOUND,
  KsefInvoiceRejectedError,
  ksefErrorCodes,
  listSessionInvoicesAfterClose,
  type SessionInvoiceSummary,
} from '@/lib/ksef/submit';
import {
  compareDuplicate,
  faktflowOriginalVerdictMessage,
  hexHashToBase64,
  knownNumberVerdictMessage,
  numberTakenMessage,
  operatorVerdictMessage,
  summarizeInvoiceXml,
} from '@/lib/ksef/duplicate-verdict';
import {
  KSEF_ORIGINAL_ALARM_KINDS,
  type DuplicateCheckReason,
  type KsefDuplicateCheck,
  type KsefOriginalImportGate,
} from '@/lib/ksef/duplicate-check';
import { evaluateOriginalGate } from '@/lib/ksef/duplicate-original-gate';
import { archiveImportedKsefXml, decodeKsefXml, KsefXmlArchiveConflictError } from '@/lib/import/ksef-xml-archive';
import { ksefSessionCache } from '@/lib/ksef/session-cache';
import {
  abandonKsefSubmissionIntent,
  closeKsefAttempt,
  findKsefNumberTaken,
  findKsefSessionRow,
  findOpenKsefSubmission,
  findOpenKsefSubmissionIntents,
  findSubmissionPayloads,
  findTenantInvoiceByKsefNumber,
  markKsefSubmission,
  markKsefAttemptDuplicatePending,
  markKsefSubmissionsNumberTaken,
  promoteKsefSubmissionIntent,
  recordKsefAcceptedSession,
  recordKsefDuplicateCheck,
  type KsefSubmissionIntent,
} from '@/lib/ksef/submission-log';
import { downloadInvoiceXml, invoiceXmlKey, invoiceXmlKeyFor, uploadInvoiceXml } from '@/lib/storage/r2';
import {
  heldErrorMessage,
  isCorrectionHeldForEnv,
  isCorrectionSubmission,
  isKsefSubmissionPaused,
  KOR_HOLD,
  KSEF_PAUSED,
} from '@/lib/ksef/submission-holds';
import { shouldUseOfflineMode } from '@/lib/ksef/health-check';
import { isOffline24Enabled } from '@/lib/ksef/offline24-policy';
import { recordXmlDocument } from '@/lib/storage/xml-documents';
import { InvoiceXmlSchemaError } from '@/lib/xml/validator';
import { isRozSubmission, ROZ_SUBMISSION_HOLD_MESSAGE } from '@/lib/ksef/roz-submission-hold';
import { addToOfflineQueue } from '@/lib/ksef/offline-queue';
import { InvoiceValidationError } from '@/lib/xml/fa3-generator';
import {
  classifySendError,
  isContentRejection,
  KsefSendVerdictError,
  SEND_ERROR_CODES,
  type SendErrorCode,
} from '@/lib/ksef/send-error-codes';
import { KSEF_SEND_MESSAGES } from '@/lib/invoices/ksef-send-policy';
import {
  getKsefRetryDelay,
  ksefRetryDelayFor,
  KSEF_MAX_RETRIES,
} from '../retry-schedule';

/**
 * Odpowiedź 440 „duplikat”, której NIE da się przypisać do naszej wcześniejszej
 * wysyłki tej faktury (inny numer sesji albo brak historii). KSeF wykrywa
 * duplikat po numerze faktury sprzedawcy, a ten numer mógł zostać użyty poza
 * FaktWay — przypięcie cudzego numeru KSeF byłoby błędnym zapisem prawnym.
 * Stan neutralny „do uzgodnienia” (jak wstrzymana ROZ), bez komunikatu
 * „odrzucona”. Znacznik w treści błędu, bo przechodzi przez oba backendy jobów.
 */
export const KSEF_DUPLICATE_RECONCILE = SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE;

/** Znacznik `[KOD] ` na początku treści błędu — do zdjęcia przed zapisem `last_error`. */
const HOLD_MARKER = /^\[[A-Z_]+\] /;

/** Wynik wysyłki niezależnie od drogi: nowa wysyłka, uzgodnienie albo własny duplikat. */
interface SubmitOutcome {
  ksefNumber: string;
  xmlStoragePath: string;
  /** Znane przy świeżej wysyłce; przy uzgodnieniu liczone z pliku w magazynie. */
  xmlSha256Hash?: string;
  xmlSizeBytes?: number;
  acquisitionTimestamp?: string;
  sessionReferenceNumber?: string;
  invoiceReferenceNumber?: string;
  /** Skąd wiemy o akceptacji — do audytu. */
  via: 'submit' | 'reference-reconcile' | 'own-duplicate' | 'verified-duplicate';
  /** D-A4-1: nasza próba odrzucona jako duplikat — zamykana po zapisie akceptacji. */
  duplicateAttempt?: { sessionReferenceNumber: string; invoiceReferenceNumber: string | null };
}

/**
 * Job wysyłki faktury do KSeF.
 *
 * Trigger: event 'invoice/submit.requested' (publikowany z Server Action
 * po kliknięciu "Wyślij do KSeF" w UI).
 *
 * Retry policy (Faza 23 sekcja 2):
 * - Custom backoff: 30s → 2min → 5min → 15min → 1h przez `RetryAfterError`.
 *   Override Inngest defaultu (10s/30s/1m/5m/15m), dający MF ponad godzinę
 *   na recovery po większej awarii.
 * - Błędy 5xx i 429 — retry z opóźnieniem.
 * - Błędy treści (XSD, odrzucenie przez KSeF) — `NonRetriableError`, po
 *   `onExhausted` faktura `rejected`; inne błędy bez ponowień (strażnik
 *   dokumentu, brak certyfikatu) kończą jako `failed` z kodem z katalogu
 *   `ksef_error_codes` (`lib/ksef/send-error-codes.ts`).
 *
 * Concurrency + throttle (Faza 23 sekcja 2):
 * - Per-tenant concurrency: max 100 równoległych submit'ów. Wyższy limit
 *   per-tenant (vs poprzednie 3 per-NIP) dla dużych tenantów z 1000+ fakturami
 *   miesięcznie; rate-limiter per-NIP wewnątrz KSeF clienta i tak zatrzyma
 *   nadmiar.
 * - Per-tenant throttle: 60 wysyłek/min — chroni MF przed zalaniem przy
 *   bulk import, nawet jeśli concurrency 100 da chwilowy spike.
 */

/**
 * Dzierżawa przejęcia wysyłki (AUD-10): dłuższa niż najdłuższa wysyłka
 * z odpytywaniem statusu; tyle samo co próg alarmu „faktura w sending”.
 */
export const KSEF_SEND_LEASE_SECONDS = 15 * 60;
/** Gdy wysyłkę trzyma inna próba — ponowienie po 5 min (wynik albo koniec dzierżawy). */
export const KSEF_SEND_CLAIM_RETRY_MS = 5 * 60 * 1000;
/**
 * Okno 48 h (I5): wpis `sent`, o którym KSeF po dwóch dobach odpowiada
 * błędem klienta (4xx poza 401/403), nie zostanie już rozstrzygnięty — KSeF
 * nie zna tej wysyłki. Zamykamy wpis jako `rejected` z kodem `STALE`
 * i wysyłamy od nowa; gdyby KSeF jednak miał ten plik, odpowie 440 z numerem
 * sesji, która jest w naszej historii — runner uzna własny duplikat.
 */
export const KSEF_SUBMISSION_STALE_MS = 48 * 60 * 60 * 1000;
export const KSEF_SUBMISSION_STALE_CODE = 'STALE';

/** Kod zamknięcia zamiaru, gdy KSeF nie ma pliku z tej próby w (zamkniętej) sesji. */
export const KSEF_INTENT_NOT_IN_SESSION_CODE = 'NOT_IN_SESSION';

/**
 * Plik tej próby wśród faktur sesji KSeF: ten sam skrót treści albo ten sam
 * numer faktury. Nasza sesja niesie jedną fakturę, więc dopasowanie po numerze
 * wystarcza, gdy skrótu nie ma (wpis bez `request_payload_hash`).
 */
function intentInvoiceInSession(
  found: SessionInvoiceSummary[],
  intent: KsefSubmissionIntent,
  internalNumber: string | undefined,
): SessionInvoiceSummary | null {
  const hash =
    intent.payloadHash && /^[0-9a-f]{64}$/i.test(intent.payloadHash)
      ? Buffer.from(intent.payloadHash, 'hex').toString('base64')
      : null;
  return (
    found.find(
      (f) => (hash !== null && f.invoiceHash === hash) || (Boolean(internalNumber) && f.invoiceNumber === internalNumber),
    ) ?? null
  );
}

function isStaleSubmission(attemptedAt: string | null | undefined): boolean {
  if (!attemptedAt) return false;
  const at = Date.parse(attemptedAt);
  return Number.isFinite(at) && Date.now() - at > KSEF_SUBMISSION_STALE_MS;
}

const ROZ_RECONCILIATION_MESSAGE =
  'Wysyłka faktur rozliczeniowych do KSeF jest tymczasowo wstrzymana — po zdjęciu blokady tej faktury sami nie wyślemy (co dalej — na dole strony).';

/** Fresh DB read outside Inngest steps, including the accepted status. */
async function currentSubmissionState(
  data: { invoiceId: string; tenantId: string },
): Promise<{
  direction: string | null;
  ksef_status: string | null;
  ksef_number: string | null;
  ksef_environment: string | null;
  invoice_type: string | null;
  invoice_kind: string | null;
}> {
  const { data: stored, error } = await (await createAdminClient())
    .from('invoices')
    .select('direction, ksef_status, ksef_number, ksef_environment, invoice_type, invoice_kind')
    .eq('id', data.invoiceId)
    .eq('tenant_id', data.tenantId)
    .maybeSingle();

  if (error || !stored) throw new Error('Nie można sprawdzić rodzaju faktury');

  return stored;
}

function isHeldRozSubmission(
  data: Parameters<typeof invoiceSubmitRequested.create>[0],
  stored: Awaited<ReturnType<typeof currentSubmissionState>>,
): boolean {
  return isRozSubmission({
    invoiceType: data.invoice.type,
    storedInvoiceType: stored.invoice_type,
    invoiceKind: stored.invoice_kind,
    finalData: data.finalData,
    finalAdvanceSettlementRows: data.finalAdvanceSettlementRows,
  });
}

/**
 * Hamulce (krok 5): korekty na KSeF produkcyjnym i globalny wyłącznik.
 * Rzuca neutralny NonRetriableError ze znacznikiem; odczyt wyłącznika jest
 * autorytatywny, więc awaria bazy kończy się ponowieniem, nie wysyłką.
 */
async function assertSubmissionNotHeld(
  data: Parameters<typeof invoiceSubmitRequested.create>[0],
  stored: Awaited<ReturnType<typeof currentSubmissionState>>,
  env: 'test' | 'demo' | 'production',
): Promise<void> {
  if (
    isCorrectionHeldForEnv(env) &&
    isCorrectionSubmission({
      invoiceType: data.invoice.type,
      storedInvoiceType: stored.invoice_type,
      invoiceKind: stored.invoice_kind,
      correctionData: data.correctionData,
    })
  ) {
    throw new NonRetriableError(heldErrorMessage(KOR_HOLD, stored.invoice_kind));
  }
  if (await isKsefSubmissionPaused()) {
    throw new NonRetriableError(heldErrorMessage(KSEF_PAUSED, stored.invoice_kind));
  }
}

/** Reconcile an accepted invoice even if the success event was lost. */
async function reconcileAcceptedOfflineQueue(
  data: Parameters<typeof invoiceSubmitRequested.create>[0],
  force = false,
): Promise<void> {
  if (!data.fromOfflineQueue && !force) return;
  const { error } = await (await createAdminClient())
    .from('ksef_offline_queue')
    .update({ status: 'sent', last_error: null })
    .eq('invoice_id', data.invoiceId)
    .eq('tenant_id', data.tenantId)
    .in('status', ['queued', 'sending', 'failed', 'expired']);
  if (error) throw new Error('Nie można uzgodnić zaakceptowanej faktury z kolejką Offline24');
}

/**
 * Zapis wyniku porażki (I4 z cyklu życia faktury): zawsze z kodem z katalogu
 * `ksef_error_codes` i ze zwolnionym przejęciem (`ksef_send_owner`), żeby
 * ponowienie przez `requeue_ksef_send` nie trafiło na cudzą dzierżawę.
 * Warunkowo — równoległa akceptacja innego workera wygrywa.
 */
async function markFailureUnlessAccepted(
  invoiceId: string,
  tenantId: string,
  status: 'failed' | 'rejected',
  lastError: string,
  code: SendErrorCode,
): Promise<boolean> {
  const { data: updated, error } = await (await createAdminClient())
    .from('invoices')
    .update({
      ksef_status: status,
      last_error: lastError,
      last_error_code: code,
      last_error_field: null,
      last_error_suggestion: null,
      ksef_send_owner: null,
    })
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .or('ksef_status.is.null,ksef_status.neq.accepted')
    .select('id')
    .maybeSingle();
  if (error) throw new Error('Nie można zapisać wyniku wysyłki faktury');
  return updated?.id === invoiceId;
}

/**
 * W1: błąd poświadczeń ≠ odrzucenie przez KSeF.
 *   - brak certyfikatu / NIP niezweryfikowany → bez ponowień (klient uzupełnia
 *     ustawienia; kod `NO_CERTIFICATE` / `NOT_VERIFIED`),
 *   - klucz szyfrowania / NIP z szyfrogramu → ponowienie z alarmem operatora
 *     (`CREDENTIALS_UNAVAILABLE`),
 *   - błąd odczytu bazy → zwykłe ponowienie wg harmonogramu (`INFRA`).
 * Do 03.10.2026 każdy z nich kończył fakturę jako „odrzucona przez KSeF”.
 */
function credentialsFailure(
  e: unknown,
  ctx: { tenantId: string; invoiceId: string; attempt: number },
): Error {
  if (e instanceof KsefCredentialsError) {
    switch (e.reason) {
      case 'missing':
      case 'not-verified':
        return new NonRetriableError(`Nie można użyć credentials KSeF: ${e.message}`, { cause: e });
      case 'decrypt':
      case 'nip-mismatch':
        Sentry.captureMessage('Poświadczenia KSeF firmy nie nadają się do użycia — sprawdź klucz szyfrowania', {
          level: 'error',
          tags: { job: 'submit-invoice', kind: 'credentials' },
          extra: { ...ctx, reason: e.reason },
        });
        return new RetryAfterError(
          `Poświadczenia KSeF chwilowo niedostępne: ${e.message}`,
          getKsefRetryDelay(ctx.attempt),
          { cause: e },
        );
      default:
        return e;
    }
  }
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * S1: rozstrzygnięcie w statusie (odrzucenie, duplikat) zamyka otwarty wpis
 * `ksef_submissions` tej wysyłki. Bez tego każda kolejna próba „uzgadniała”
 * zakończoną sesję, a `ksef_has_contact_evidence` liczyła ją jako kontakt.
 * Fail-soft: wpis to historia, nie decyzja o fakturze.
 */
async function closeOpenSubmission(
  tenantId: string,
  invoiceId: string,
  status: 'rejected' | 'duplicate',
  error: KsefInvoiceRejectedError,
  logger: JobContext['logger'],
): Promise<void> {
  try {
    const open = await findOpenKsefSubmission(tenantId, invoiceId);
    if (!open) return;
    await markKsefSubmission({
      tenantId,
      invoiceId,
      invoiceReferenceNumber: open.invoiceReferenceNumber,
      status,
      errorCode: String(error.code),
      errorMessage: error.message,
    });
  } catch (e) {
    logger.warn('Nie zamknięto wpisu historii wysyłki KSeF po rozstrzygnięciu', {
      invoiceId,
      status,
      error: e instanceof Error ? e.message : String(e),
    });
    Sentry.captureException(e, { tags: { area: 'ksef.submission-log' }, extra: { invoiceId, status } });
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Identyfikatory z surowego payloadu — żeby zły payload nie zostawił faktury bez śladu (W3). */
function rawIds(data: unknown): { invoiceId: string; tenantId: string } | null {
  if (typeof data !== 'object' || data === null) return null;
  const { invoiceId, tenantId } = data as { invoiceId?: unknown; tenantId?: unknown };
  if (typeof invoiceId !== 'string' || typeof tenantId !== 'string') return null;
  if (!UUID_RE.test(invoiceId) || !UUID_RE.test(tenantId)) return null;
  return { invoiceId, tenantId };
}

/**
 * Alarm operatora dla porażek bez wyjątku w Sentry: `ignoreErrors` filtruje
 * `NonRetriableError`, a te ścieżki kończą się zwykłym `return`.
 */
function alertReconcile(message: string, extra: Record<string, unknown>): void {
  Sentry.captureMessage(message, {
    level: 'error',
    tags: { job: 'submit-invoice', kind: 'reconcile' },
    extra,
  });
}

/**
 * D-A4-1b-3 PR B (decyzje Bartosza 07.10.2026 (2), (3); spec §2.7.2): job
 * wraca do szkicu wycofanego — wpis `number_taken` (decyzja klienta albo
 * automatyczny „numer zajęty”). Numer ma w KSeF inna faktura (K), więc
 * każda wysyłka skończyłaby się 440. Wyjście bez zapisu: bez przejęcia,
 * bez `failed` (I7 wznowiłby wtedy pełną wysyłkę) i bez `invoice/submit.failed`.
 * Ślad: ostrzeżenie w logu i w Sentry (W3 — nic nie kończy się bez śladu).
 */
function reportRetiredExit(
  logger: JobContext['logger'],
  where: 'run' | 'claim' | 'exhausted' | 'exhausted-invalid-payload',
  extra: { tenantId: string; invoiceId: string; originalKsefNumber: string | null; reconcileOnly: boolean },
): void {
  logger.warn('Szkic wycofany (numer zajęty w KSeF) — job kończy się bez wysyłki i bez zapisu', { ...extra, where });
  Sentry.captureMessage('KSeF: zlecenie wysyłki szkicu wycofanego (numer zajęty) — zakończone bez zapisu', {
    level: 'warning',
    tags: { job: 'submit-invoice', kind: 'retired-number-taken' },
    extra: { ...extra, where },
  });
}

/** Wynik joba na szkicu wycofanym (spec §2.7.2). */
interface RetiredOutcome {
  retired: true;
  originalKsefNumber: string | null;
}

/**
 * Obsługa po wyczerpaniu prób (Etap 7) — pg-boss `onExhausted`.
 *
 * Jedna klasyfikacja: `classifySendError` (katalog `ksef_error_codes`, 00131).
 * Klasa kodu wyznacza stan końcowy:
 *   - terminal + odrzucenie treści (XSD, KSeF)  → `rejected`,
 *   - terminal (strażnik dokumentu)             → `failed`, bez ponowień,
 *   - transient                                 → Offline24 (tylko KSeF TEST,
 *     dokument zwykły, certyfikat) albo `failed` — cron cyklu życia ponawia,
 *   - hold / reconcile                          → `failed` „do uzgodnienia”,
 *   - setup                                     → `failed`, klient uzupełnia
 *     ustawienia KSeF.
 * Każdy zapis niesie kod i zwalnia przejęcie (I4). Nic nie kończy się cichym
 * `return` bez śladu w bazie albo w Sentry (W3).
 */
export async function onSubmitInvoiceExhausted(
  error: Error,
  data: Parameters<typeof invoiceSubmitRequested.create>[0],
  { step, logger }: JobContext,
) {
      const parsed = invoiceSubmitRequested.safeParse(data);
      if (!parsed.success) {
        const ids = rawIds(data);
        logger.error('KSeF submit event invalid; invoice requires reconciliation', {
          reason: 'invalid-payload',
          ...ids,
        });
        alertReconcile('KSeF submit event invalid — invoice marked INVALID_EVENT', {
          ...ids,
          issues: parsed.error.issues.slice(0, 3),
        });
        if (!ids) return { handled: false as const, reason: 'invalid-payload' as const };
        const state = await currentSubmissionState(ids);
        if (state.direction !== 'outgoing' || state.ksef_status === 'accepted') {
          return { handled: false as const, reason: 'invalid-payload' as const };
        }
        // D-A4-1b-3 PR B: szkic wycofany zostaje szkicem — bez INVALID_EVENT.
        if (state.ksef_status === 'draft') {
          const taken = await findKsefNumberTaken(ids.tenantId, ids.invoiceId);
          if (taken) {
            reportRetiredExit(logger, 'exhausted-invalid-payload', {
              ...ids,
              originalKsefNumber: taken.originalKsefNumber,
              reconcileOnly: (data as { reconcileOnly?: unknown } | null)?.reconcileOnly === true,
            });
            return { handled: false as const, reason: 'retired-number-taken' as const };
          }
        }
        const marked = await step.run('mark-as-failed-invalid-event', () =>
          markFailureUnlessAccepted(
            ids.invoiceId,
            ids.tenantId,
            'failed',
            'Zdarzenie wysyłki jest niekompletne — wymaga uzgodnienia przez operatora.',
            SEND_ERROR_CODES.INVALID_EVENT,
          ));
        return marked
          ? { handled: true as const, finalStatus: 'failed' as const, reason: 'invalid-payload' as const }
          : { handled: false as const, reason: 'invalid-payload' as const };
      }
      const { tenantId, invoiceId, nip, invoice } = parsed.data;
      await requireInvoiceTenant(invoiceId, tenantId);
      const fromOfflineQueue = Boolean(data.fromOfflineQueue);
      const current = await currentSubmissionState(parsed.data);
      // Faktura przychodząca nie jest wysyłana — zdarzenie o niej to błąd albo
      // podróbka; stanu nie zmieniamy (#71, Codex), ale operator ma wiedzieć.
      if (current.direction === 'incoming') {
        logger.error('KSeF submit failure callback targets an incoming invoice; no invoice state changed', {
          invoiceId,
        });
        alertReconcile('KSeF submit failure callback targets an incoming invoice', { tenantId, invoiceId });
        return { handled: false as const, reason: 'invoice-direction-mismatch' as const };
      }
      if (current.ksef_status === 'accepted') {
        if (current.ksef_number && current.ksef_environment === parsed.data.environment) {
          await reconcileAcceptedOfflineQueue(parsed.data, true);
          return { handled: true as const, alreadyAccepted: true as const, ksefNumber: current.ksef_number };
        }
        logger.error('KSeF accepted invoice was not changed by failed submit callback; manual reconciliation required', {
          invoiceId,
          eventEnvironment: parsed.data.environment,
          storedEnvironment: current.ksef_environment ?? null,
        });
        alertReconcile('KSeF accepted invoice from another environment hit the failure callback', {
          tenantId,
          invoiceId,
          eventEnvironment: parsed.data.environment,
          storedEnvironment: current.ksef_environment ?? null,
        });
        return { handled: false as const, reason: 'accepted-reconciliation' as const };
      }
      // D-A4-1b-3 PR B (§2.7.2): szkic wycofany (wpis `number_taken`) — przed
      // ENV_MISMATCH i każdą klasą porażki: bez zapisu `failed` (wyzwalacz 00148
      // i tak by go odrzucił) i bez `invoice/submit.failed`.
      if (current.ksef_status === 'draft') {
        const taken = await findKsefNumberTaken(tenantId, invoiceId);
        if (taken) {
          reportRetiredExit(logger, 'exhausted', {
            tenantId,
            invoiceId,
            originalKsefNumber: taken.originalKsefNumber,
            reconcileOnly: parsed.data.reconcileOnly === true,
          });
          return { handled: false as const, reason: 'retired-number-taken' as const };
        }
      }
      // Zdarzenie z innego środowiska KSeF niż skonfigurowane (#63, Codex):
      // faktura dostaje kod `ENV_MISMATCH` zamiast zostać w `queued`/`sending`
      // na zawsze (W3). Klasa terminal (D-A4-2, 00143): ponowienie wysłałoby
      // fakturę w bieżącym środowisku, więc klient wraca do szkicu i decyduje.
      const configuredEnv = configuredKsefEnvironment();
      if (parsed.data.environment !== configuredEnv) {
        logger.error('KSeF submit event environment mismatch; invoice requires reconciliation', {
          tenantId,
          invoiceId,
          eventEnvironment: parsed.data.environment,
          configuredEnvironment: configuredEnv,
        });
        alertReconcile('KSeF submit event environment mismatch — invoice marked ENV_MISMATCH', {
          tenantId,
          invoiceId,
          eventEnvironment: parsed.data.environment,
          configuredEnvironment: configuredEnv,
        });
        // Wcześniejsza próba tego zdarzenia mogła dotrzeć do KSeF (otwarty
        // wpis z A2) — wtedy komunikat nie może mówić „nie wysłaliśmy” ani
        // kierować do szkicu (RPC odmówi). Błąd odczytu = ostrożny wariant.
        const contacted = await step.run('env-mismatch-contact-evidence', async () => {
          const { data, error } = await (await createAdminClient()).rpc('ksef_has_contact_evidence', {
            p_invoice_id: invoiceId,
            p_tenant_id: tenantId,
          });
          return error ? true : data !== false;
        });
        const marked = await step.run('mark-as-failed-env-mismatch', () =>
          markFailureUnlessAccepted(
            invoiceId,
            tenantId,
            'failed',
            envMismatchMessage(parsed.data.environment, configuredEnv, contacted),
            SEND_ERROR_CODES.ENV_MISMATCH,
          ));
        return marked
          ? { handled: true as const, finalStatus: 'failed' as const, reason: 'environment-mismatch' as const }
          : { handled: false as const, reason: 'environment-mismatch' as const };
      }

      // Klasyfikacja — jedno miejsce (W1, S1): błąd po naszej stronie nigdy
      // nie udaje odrzucenia przez KSeF. Blokada ROZ wynika ze stanu w bazie,
      // nie z treści błędu.
      const heldRoz = isHeldRozSubmission(parsed.data, current);
      const classified = heldRoz
        ? { code: SEND_ERROR_CODES.ROZ_HOLD_RECONCILE, class: 'hold' as const }
        : classifySendError(error);
      const { code } = classified;
      // Hamulec, blokada albo niepewny wynik: stan „do uzgodnienia” — bez
      // komunikatu „odrzucona”, bez Offline24.
      const reconcileHold = classified.class === 'hold' || classified.class === 'reconcile';
      // `rejected` TYLKO dla błędu treści potwierdzonego przez XSD albo KSeF.
      const isBusinessRejection = classified.class === 'terminal' && isContentRejection(code);
      // Ponowienie ma sens (awaria, limit, sesja) — jedyna droga do Offline24.
      const isTransientFailure = classified.class === 'transient';
      const failureMessage = heldRoz
        ? ROZ_RECONCILIATION_MESSAGE
        : HOLD_MARKER.test(error.message)
          ? error.message.replace(HOLD_MARKER, '')
          : `${error.name}: ${error.message}`;

      logger.error('Job wysyłki padł — klasyfikacja błędu', {
        tenantId,
        invoiceId,
        nip,
        internalNumber: invoice.internalNumber,
        errorName: error.name,
        errorMessage: error.message,
        code,
        errorClass: classified.class,
        heldRoz,
        isBusinessRejection,
        isTransientFailure,
        fromOfflineQueue,
      });

      let finalStatus: 'rejected' | 'failed' | 'offline_queued' = isBusinessRejection
        ? 'rejected'
        : 'failed';
      let marked = true;

      if (isTransientFailure && !fromOfflineQueue) {
        // Faza 23 sekcja 3: po wyczerpaniu ponowień z błędem przejściowym →
        // parking w Offline24 (`addToOfflineQueue` ustawia `offline_queued`).
        // QR II wymaga odrębnego certyfikatu KSeF typu Offline; kolejka nie
        // zapisuje kodów na podstawie certyfikatu uwierzytelniania.
        const offlineResult = await step.run('try-offline-queue', async () => {
          // AUD-14: na produkcji nie parkujemy — `failed` z kodem, ponawia cron.
          const ksefEnv = (process.env.KSEF_ENV as KsefEnvironment | undefined) ?? 'test';
          if (!isOffline24Enabled(ksefEnv)) {
            return { queued: false as const, reason: 'offline24-wylaczony-na-produkcji' as const };
          }
          // Offline24 zapisuje tylko id faktury — korekty, zaliczki i ROZ nie
          // da się z niego odtworzyć (#63, Codex).
          if (current.invoice_kind !== 'regular') {
            return { queued: false as const, reason: 'dokument-specjalny' as const };
          }
          try {
            const { getTenantKsefCredentials } = await import('@/lib/supabase/admin-queries');
            const { addToOfflineQueue } = await import('@/lib/ksef/offline-queue');

            const creds = await getTenantKsefCredentials(tenantId);
            // Offline24 QR wymaga PEM certyfikatu — token auth (dev/test)
            // nie ma takiego. W tym przypadku jedziemy klasycznym 'failed'.
            if (creds.type !== 'xades') {
              return {
                queued: false as const,
                reason: 'token-auth-no-cert' as const,
              };
            }

            await addToOfflineQueue({
              tenantId,
              invoiceId,
              // Best-effort: jeśli ostatni błąd to 503, traktujemy jako MF outage
              // (deadline 7 dni zamiast 24h zgodnie ze spec Fazy 11).
              isMfOutage: error.message.includes('503') || error.message.includes('MF'),
            });

            return { queued: true as const };
          } catch (e) {
            return {
              queued: false as const,
              reason: 'offline-queue-error' as const,
              errorMessage: e instanceof Error ? e.message : 'unknown',
            };
          }
        });

        if (offlineResult.queued) {
          finalStatus = 'offline_queued';
          logger.info('Faktura zaparkowana w Offline24 queue po wyczerpaniu retries', {
            tenantId,
            invoiceId,
            attempts: KSEF_MAX_RETRIES + 1,
          });
        } else {
          marked = await step.run('mark-as-failed', () =>
            markFailureUnlessAccepted(
              invoiceId,
              tenantId,
              'failed',
              `${failureMessage} (Offline24 ${offlineResult.reason})`,
              code,
            ));
        }
      } else {
        // Jeden warunkowy zapis dla: odrzucenia treści (`rejected`), strażnika
        // dokumentu, hamulców i blokad, braku certyfikatu oraz powrotu
        // z Offline24 (`failed`). Równoległa akceptacja innego workera wygrywa.
        const stepName = heldRoz
          ? 'mark-as-failed-roz-hold'
          : reconcileHold
            ? 'mark-as-neutral-hold'
            : fromOfflineQueue
              ? 'mark-as-failed-from-offline'
              : isBusinessRejection
                ? 'mark-as-rejected'
                : 'mark-as-failed';
        marked = await step.run(stepName, () =>
          markFailureUnlessAccepted(
            invoiceId,
            tenantId,
            isBusinessRejection ? 'rejected' : 'failed',
            failureMessage,
            code,
          ));
      }

      // Inny worker mógł przyjąć fakturę po którymkolwiek zapisie wyżej —
      // bieżący stan w bazie wygrywa z nieaktualną klasyfikacją porażki.
      const afterWrite = await currentSubmissionState(parsed.data);
      if (afterWrite.ksef_status === 'accepted' && afterWrite.ksef_number) {
        await reconcileAcceptedOfflineQueue(parsed.data, true);
        return { handled: true as const, alreadyAccepted: true as const, ksefNumber: afterWrite.ksef_number };
      }
      if (!marked) {
        throw new Error('Nie można potwierdzić stanu faktury po nieudanej wysyłce');
      }

      await step.run('audit-submit-failed', async () => {
        await logAuditSystem({
          action: 'invoice.submit_failed',
          tenantId,
          userId: null,
          entityType: 'invoice',
          entityId: invoiceId,
          metadata: {
            internalNumber: invoice.internalNumber,
            finalStatus,
            errorCode: code,
            errorClass: classified.class,
            isBusinessRejection,
            wasFromOfflineQueue: fromOfflineQueue,
            error: failureMessage,
          },
        });
      });

      // An older worker may have completed KSeF after our conditional update.
      // This fresh read avoids a stale failure event in that common race;
      // consumers still verify current state because acceptance can happen later.
      const latest = await currentSubmissionState(parsed.data);
      if (latest.ksef_status === 'accepted' && latest.ksef_number) {
        await reconcileAcceptedOfflineQueue(parsed.data, true);
        return { handled: true as const, alreadyAccepted: true as const, ksefNumber: latest.ksef_number };
      }

      await step.sendEvent('emit-failure', {
        name: 'invoice/submit.failed',
        data: {
          invoiceId,
          tenantId,
          error: failureMessage,
          errorCode: code,
          environment: parsed.data.environment,
          fromOfflineQueue: data.fromOfflineQueue,
          offlineQueueId: parsed.data.offlineQueueId,
          // Bez tego kolejka Offline24 przywracała odrzuconą fakturę do
          // 'queued' i ponawiała ją do upływu terminu. Wszystko poza błędem
          // przejściowym zamyka stary wpis Offline24 (#63).
          terminal: !isTransientFailure,
          manualReconciliationRequired: reconcileHold,
        },
      });

      return { handled: true as const, finalStatus, fromOfflineQueue };
}

/**
 * D-A4-2: komunikat dla klienta przy `ENV_MISMATCH` — gdzie zlecono wysyłkę,
 * jakie środowisko jest teraz i co zrobić. Bez dowodu kontaktu: szkic
 * i decyzja klienta. Z dowodem (wcześniejsza próba mogła dotrzeć do KSeF):
 * nie wystawiać ponownie — szkic zablokowany, sprawdza pomoc FaktWay (decyzja 07.10.2026).
 */
function envMismatchMessage(
  eventEnvironment: string,
  configuredEnvironment: string | null,
  contacted: boolean,
): string {
  const what = configuredEnvironment
    ? `Tej wysyłki nie wykonaliśmy: zlecono ją w środowisku KSeF „${eventEnvironment}”, a obecne to „${configuredEnvironment}”.`
    : `Tej wysyłki nie wykonaliśmy: środowisko KSeF po stronie FaktWay nie jest poprawnie ustawione (zlecenie: „${eventEnvironment}”). Zajmujemy się tym.`;
  if (contacted) {
    return `${what} Wcześniejsza próba wysyłki tej faktury mogła dotrzeć do KSeF — nie wystawiaj jej ponownie i napisz do pomocy FaktWay (${SUPPORT_EMAIL}) — sprawdzimy ją w KSeF.`;
  }
  return configuredEnvironment
    ? `${what} Wróć do szkicu i zdecyduj, czy wysłać fakturę w obecnym środowisku.`
    : `${what} Potem wróć do szkicu i wyślij fakturę ponownie.`;
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-d.ts
 */
export async function runSubmitInvoice(
  data: Parameters<typeof invoiceSubmitRequested.create>[0],
  { step, logger, attempt }: JobContext,
) {
    // Runtime walidacja Zod — bramka między event store a transakcją KSeF.
    // Zła paczka (np. brak NIP-u po replay'u eventu ze starego kodu) zostaje
    // odrzucona PRZED jakąkolwiek operacją w DB / R2 / KSeF. NonRetriableError
    // zatrzymuje retry i woła `onFailure`, który oznacza fakturę jako rejected.
    const parsed = invoiceSubmitRequested.safeParse(data);
    if (!parsed.success) {
      throw new NonRetriableError(
        `Niepoprawny payload eventu invoice/submit.requested: ${parsed.error.message}`,
        { cause: parsed.error },
      );
    }
    const { tenantId, invoiceId, invoice, nip } = parsed.data;
    // Zdarzenie musi pochodzić z tego samego środowiska KSeF, które jest
    // skonfigurowane — inaczej faktura trafiłaby do innego KSeF (#63, Codex).
    const env = configuredKsefEnvironment();
    if (!env || parsed.data.environment !== env) {
      throw new NonRetriableError('KSeF submit event environment does not match configured environment');
    }
    // Automatyczny Offline24 wstrzymany (decyzja 02.10.2026, #71): zdarzenie
    // z kolejki offline to stary wpis — tylko ręczne uzgodnienie.
    if (parsed.data.fromOfflineQueue) {
      throw new NonRetriableError('Offline24 automatic replay requires manual reconciliation');
    }
    await requireInvoiceTenant(invoiceId, tenantId);
    const fromOfflineQueue = Boolean(parsed.data.fromOfflineQueue);
    if (fromOfflineQueue) {
      assertJobIdentity(parsed.data.offlineQueueId, tenantId);
      const { data: queueRow, error: queueError } = await (await createAdminClient())
        .from('ksef_offline_queue')
        .select('id')
        .eq('id', parsed.data.offlineQueueId!)
        .eq('tenant_id', tenantId)
        .eq('invoice_id', invoiceId)
        .eq('ksef_environment', env)
        .eq('status', 'sending')
        .maybeSingle();
      if (queueError || !queueRow) {
        throw new NonRetriableError('Offline24 queue reference requires reconciliation');
      }
    }

    // IDEMPOTENCJA (audyt przedlaunchowy): backstop przeciw podwójnej wysyłce.
    // Gdyby ten sam event przyszedł dwa razy (double-click „Wyślij", replay
    // eventu, równoległy enqueue z dwóch instancji), NIE wysyłamy faktury do
    // KSeF drugi raz — jeśli ma już numer KSeF i status 'accepted', zwracamy
    // istniejący wynik. To uzupełnia: deterministyczny generator FA(3) (ten sam
    // XML), idempotencję R2 (HEAD + IfNoneMatch) oraz unikalność numeru P_2 po
    // stronie MF. Trzy niezależne warstwy ochrony przed duplikatem w KSeF.
    const alreadyDone = await step.run('idempotency-guard', async () => {
      const supabase = await createAdminClient();
      const { data, error } = await supabase
        .from('invoices')
        .select('ksef_status, ksef_number, ksef_environment')
        .eq('id', invoiceId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (error || !data) throw new Error('Nie można sprawdzić statusu faktury');
      return data;
    });
    if (alreadyDone?.ksef_status === 'accepted' && alreadyDone.ksef_number &&
        alreadyDone.ksef_environment === env) {
      logger.info('Faktura już zaakceptowana w KSeF — pomijam ponowną wysyłkę', {
        invoiceId,
        ksefNumber: alreadyDone.ksef_number,
      });
      await reconcileAcceptedOfflineQueue(parsed.data);
      return {
        alreadyAccepted: true as const,
        ksefNumber: alreadyDone.ksef_number,
      };
    }

    // Fresh, non-memoized read: an older Inngest idempotency step can be
    // restored after deployment. Check the stored kind as well as the event.
    const current = await currentSubmissionState(parsed.data);
    if (current.direction === 'incoming') {
      throw new NonRetriableError('KSeF incoming invoice requires manual reconciliation');
    }
    if (current.ksef_status === 'accepted' && current.ksef_environment !== env) {
      logger.error('KSeF accepted invoice environment requires manual reconciliation', {
        invoiceId,
        environment: env,
        storedEnvironment: current.ksef_environment ?? null,
      });
      throw new NonRetriableError('KSeF accepted invoice environment requires manual reconciliation');
    }
    if (current.ksef_status === 'accepted' && current.ksef_number) {
      await reconcileAcceptedOfflineQueue(parsed.data);
      return { alreadyAccepted: true as const, ksefNumber: current.ksef_number };
    }
    // D-A4-1b-3 PR B (§2.7.2): szkic wycofany (wpis `number_taken`) — przed
    // blokadą ROZ i hamulcami. Inaczej stare zlecenie pod hamulcem skończyłoby
    // się `failed KSEF_PAUSED`, a I7 wznowiłby potem pełną wysyłkę (440).
    // Błąd odczytu rzuca zwykły Error — ponowienie, nic nie wysłane.
    if (current.ksef_status === 'draft') {
      const taken = await findKsefNumberTaken(tenantId, invoiceId);
      if (taken) {
        reportRetiredExit(logger, 'run', {
          tenantId,
          invoiceId,
          originalKsefNumber: taken.originalKsefNumber,
          reconcileOnly: parsed.data.reconcileOnly === true,
        });
        return { retired: true as const, originalKsefNumber: taken.originalKsefNumber };
      }
    }
    if (isHeldRozSubmission(parsed.data, current)) {
      throw new NonRetriableError(ROZ_SUBMISSION_HOLD_MESSAGE);
    }
    // Przed sondą zdrowia i Offline24 — wstrzymanej faktury nie wolno też zaparkować.
    await assertSubmissionNotHeld(parsed.data, current, env);

    // Odwołania dokumentu specjalnego (rodzic korekty, zaliczki ROZ) muszą
    // wskazywać faktury tej firmy przyjęte w tym środowisku KSeF (#63, Codex).
    const documentKind = await assertSubmitReferences({
      supabase: await createAdminClient(),
      tenantId,
      invoiceId,
      invoice,
      environment: env,
      correctionData: parsed.data.correctionData,
      advanceData: parsed.data.advanceData,
      finalData: parsed.data.finalData,
      finalAdvanceSettlementRows: parsed.data.finalAdvanceSettlementRows,
      // A4b PR2a: przed uzgodnieniem bez porównania z bieżącym profilem firmy —
      // tylko gdy będzie co uzgadniać. Granica przed POST sprawdza go zawsze.
      skipLiveTenantSeller: async () => parsed.data.reconcileOnly === true
        || (await findOpenKsefSubmission(tenantId, invoiceId)) !== null
        || (await findOpenKsefSubmissionIntents(tenantId, invoiceId)).length > 0,
    });

    logger.info('Rozpoczynam wysyłkę faktury', {
      tenantId,
      invoiceId,
      nip,
      internalNumber: invoice.internalNumber,
      fromOfflineQueue,
      attempt,
    });

    // Re-emisja po odebraniu z kolejki offline — nie blokuj kolejną sondą zdrowia KSeF,
    // tylko idź klasyczną ścieżką online submit.
    // AUD-14: na KSeF produkcyjnym bez automatycznego Offline24
    // (`offline24-policy.ts`) — gdy KSeF nie odpowiada, zadziała zwykłe
    // ponowienie po sondzie zdrowia przed wysyłką.
    if (!fromOfflineQueue && isOffline24Enabled(env)) {
      const health = await step.run('check-ksef-health', async () =>
        shouldUseOfflineMode(env),
      );

      if (health.offline) {
        if (documentKind !== 'regular') {
          throw new RetryAfterError(
            'KSeF unavailable; special invoice cannot be replayed from Offline24',
            getKsefRetryDelay(attempt),
          );
        }
        const redirected = await step.run(
          'try-redirect-offline-queue',
          async (): Promise<boolean> => {
            try {
              await requireKsefVerificationForBackgroundJob(tenantId);
            } catch (e) {
              if (e instanceof KsefNotVerifiedError) {
                throw new NonRetriableError(
                  'Organizacja nie ma zweryfikowanego certyfikatu KSeF — tryb offline nie jest dostępny.',
                  { cause: e },
                );
              }
              throw e;
            }

            const creds = await getTenantKsefCredentials(tenantId);
            if (creds.type !== 'xades') {
              logger.warn('KSeF offline — pomijam kolejkę offline (brak PEM / token)', {
                tenantId,
                invoiceId,
                authType: creds.type,
              });
              return false;
            }

            const current = await currentSubmissionState(parsed.data);
            if ((current.ksef_status === 'accepted' && current.ksef_number) ||
                isHeldRozSubmission(parsed.data, current)) {
              throw new NonRetriableError(ROZ_SUBMISSION_HOLD_MESSAGE);
            }
            await addToOfflineQueue({
              tenantId,
              invoiceId,
              isMfOutage: health.isMfOutage,
            });
            return true;
          },
        );

        if (redirected) {
          await step.run('audit-redirect-offline', async () => {
            await logAuditSystem({
              action: 'invoice.submit_redirected_offline',
              tenantId,
              entityType: 'invoice',
              entityId: invoiceId,
              metadata: {
                reason: health.reason,
                isMfOutage: health.isMfOutage,
                internalNumber: invoice.internalNumber,
              },
            });
          });

          logger.info('KSeF niedostępny — faktura przekierowana do trybu Offline24', {
            invoiceId,
            reason: health.reason,
          });

          return {
            redirected: 'offline',
            reason: health.reason,
            isMfOutage: health.isMfOutage,
          };
        }
      }
    }

    // Krok 1: walidacja credentials PRZED `sending` — brak certyfikatu kończy
    // bez ponowień (`failed NO_CERTIFICATE`), błąd bazy albo klucza jest
    // ponawiany (W1) — zanim status przejdzie na `sending`.
    //
    // UWAGA SECOPS: ten step CELOWO zwraca tylko `{ type, nip }` zamiast
    // pełnych credentials. Inngest serializuje return-value każdego `step.run`
    // do swojego event store'u (memoization na potrzeby retry) — gdybyśmy
    // wracali pełny `KsefAuth`, odszyfrowany PEM klucza prywatnego XAdES /
    // long-lived token KSeF lądował-by w cudzej bazie z retencją >1d.
    // Faktyczne credentials wczytujemy ponownie wewnątrz kroku `submit-to-ksef`
    // (świeży decrypt z naszej DB, bez serializacji do Inngest).
    await step.run('load-credentials-meta', async () => {
      try {
        const c = await getTenantKsefCredentials(tenantId);
        return { type: c.type, nip: c.nip };
      } catch (e) {
        throw credentialsFailure(e, { tenantId, invoiceId, attempt });
      }
    });

    await step.run('verify-ksef-claimed', async () => {
      try {
        await requireKsefVerificationForBackgroundJob(tenantId);
      } catch (e) {
        if (e instanceof KsefNotVerifiedError) {
          throw new NonRetriableError(
            'Organizacja nie ma zweryfikowanego certyfikatu KSeF (Ustawienia → KSeF). Wysyłka do KSeF jest zablokowana.',
            { cause: e },
          );
        }
        throw e;
      }
    });

    // Krok 1.5: pre-flight check KSeF health (Faza 23 sekcja 1+2).
    // Jeśli health monitor wcześniej zaobserwował `down` (3+ consecutive
    // failures lub HTTP 503 z MF), nie spalamy retry-budgetu na zapowiedzianą
    // porażkę — od razu rzucamy RetryAfterError z naszego schedule'a.
    //
    // Dla `attempt === 0` skip — pierwsza próba zawsze powinna sięgnąć
    // KSeF, żeby zweryfikować że monitor nie był stale (TTL Redis 90s).
    if (attempt > 0) {
      const { isKsefHealthy } = await import('@/lib/ksef/health-status');
      const healthy = await step.run('health-check', () => isKsefHealthy(env));
      if (!healthy) {
        const delay = getKsefRetryDelay(attempt);
        logger.warn('KSeF zgłaszany jako down — odkładam próbę', {
          tenantId,
          invoiceId,
          attempt,
          retryAfter: delay,
        });
        throw new RetryAfterError(
          'KSeF health monitor zgłasza down — odkładam wysyłkę',
          delay,
        );
      }
    }

    // Krok 2: przejęcie wysyłki (AUD-10, 00124) — `sending` z wyłącznością.
    // Wygrywa, gdy faktura jest wolna, gdy trzyma ją ta sama próba (ponowienie
    // tego samego zdarzenia) albo gdy dzierżawa innej próby wygasła. Ponowienie
    // najpierw uzgadnia poprzednią wysyłkę po numerze referencyjnym (C-18).
    const claimed = await step.run('mark-as-sending', async (): Promise<boolean | RetiredOutcome> => {
      const { data, error: claimError } = await (await createAdminClient()).rpc('claim_ksef_send', {
        p_invoice_id: invoiceId,
        p_tenant_id: tenantId,
        p_owner: parsed.data.sendAttemptId ?? null,
        p_lease_seconds: KSEF_SEND_LEASE_SECONDS,
      });
      if (claimError) {
        // D-A4-1b-3 PR B (§2.7.2, wyścig): decyzja klienta zapadła między
        // odczytem stanu a przejęciem — wyzwalacz c_guard_ksef_retired_draft
        // (00148) odmawia P0001. Szkic wycofany kończy job bez zapisu;
        // inna odmowa (albo błąd odczytu historii) — zwykłe ponowienie.
        if (claimError.code === 'P0001') {
          const taken = await findKsefNumberTaken(tenantId, invoiceId);
          if (taken) return { retired: true, originalKsefNumber: taken.originalKsefNumber };
        }
        throw new Error('Nie można przejąć wysyłki faktury');
      }
      return typeof data === 'string' && data.length > 0;
    });
    if (typeof claimed === 'object' && claimed !== null && claimed.retired) {
      reportRetiredExit(logger, 'claim', {
        tenantId,
        invoiceId,
        originalKsefNumber: claimed.originalKsefNumber,
        reconcileOnly: parsed.data.reconcileOnly === true,
      });
      return { retired: true as const, originalKsefNumber: claimed.originalKsefNumber };
    }
    // Starsze punkty kontrolne Inngest zapisały tu `undefined` — tylko jawne
    // `false` oznacza, że wysyłkę trzyma inna próba.
    if (claimed === false) {
      const latest = await currentSubmissionState(parsed.data);
      if (latest.ksef_status === 'accepted' && latest.ksef_number) {
        await reconcileAcceptedOfflineQueue(parsed.data);
        return { alreadyAccepted: true as const, ksefNumber: latest.ksef_number };
      }
      logger.warn('Wysyłkę faktury prowadzi inna próba — czekam na jej wynik albo koniec dzierżawy', {
        invoiceId,
        attempt,
      });
      // S22: to oczekiwanie, nie porażka — nie zużywa próby z `maxRetries`.
      throw new RetryAfterError(
        'Wysyłkę tej faktury prowadzi inna próba — ponowię po jej wyniku',
        KSEF_SEND_CLAIM_RETRY_MS,
        { countsAsAttempt: false },
      );
    }

    await step.run('audit-start', async () => {
      await logAuditSystem({
        action: 'invoice.submit_requested',
        tenantId,
        entityType: 'invoice',
        entityId: invoiceId,
        metadata: { attempt: attempt + 1, maxAttempts: KSEF_MAX_RETRIES + 1 },
      });
    });

    // Krok 3: pełny flow (generuj XML → waliduj XSD → R2 → KSeF).
    // Credentials wczytujemy świeżo wewnątrz tego step.run — return value
    // tego stepu jest stripowany przez `submitInvoiceFullFlow` do meta-danych
    // wyniku (ksefNumber, hash, path), więc nic wrażliwego nie wycieka do
    // Inngest store'u.
    //
    // Ten step ma własny retry — błąd sieciowy retryuje TYLKO jego, nie
    // wcześniejszych (status w DB już 'sending'). Przy retry credentials
    // wczytamy ponownie z DB — koszt: jeden dodatkowy SELECT + decrypt,
    // zysk: brak wycieku PEM-a do zewnętrznego storage'u.
    // Krok 2.5 (AUD-01): jeśli wcześniejsza próba dotarła do KSeF (mamy jej
    // numery referencyjne), pytamy o status TEJ wysyłki zamiast wysyłać fakturę
    // drugi raz. Bez tego timeout pollingu, 5xx albo padnięty worker kończyły
    // się ponowną wysyłką, odpowiedzią 440 i fałszywym „odrzucona”.
    // Krok 2.4 (A2): zamiar wysyłki bez numeru referencyjnego faktury — KSeF
    // mógł przyjąć plik, a odpowiedź nie dotarła (timeout, padnięty worker,
    // błąd zapisu). Zamykamy tamtą sesję i pytamy KSeF o jej faktury: plik
    // jest → wpis `sent` i zwykłe uzgodnienie po referencji niżej; sesja
    // pusta → zamiar porzucony i wysyłka od nowa. Każda niepewność to
    // ponowienie uzgadniania, nigdy druga wysyłka.
    await step.run('resolve-submission-intents', async () => {
      const intents = await findOpenKsefSubmissionIntents(tenantId, invoiceId);
      if (intents.length === 0) return;
      const credentials = await getTenantKsefCredentials(tenantId);
      for (const intent of intents) {
        const base = { tenantId, invoiceId, sessionReferenceNumber: intent.sessionReferenceNumber };
        let found: SessionInvoiceSummary[];
        try {
          found = await listSessionInvoicesAfterClose(intent.sessionReferenceNumber, credentials, env, {
            tenantId,
            invoiceId,
          });
        } catch (error) {
          if (error instanceof KsefApiError && error.status === 401) {
            ksefSessionCache.invalidate(credentials.nip, env);
          }
          // KSeF nie zna sesji sprzed ponad 48 h — jak STALE dla wpisu `sent`:
          // ślad zostaje, wysyłka idzie od nowa, a gdyby KSeF jednak miał plik,
          // 440 wskaże tę sesję z historii (własny duplikat).
          if (
            error instanceof KsefApiError &&
            ksefErrorCodes(error.body).includes(KSEF_SESSION_NOT_FOUND) &&
            isStaleSubmission(intent.attemptedAt)
          ) {
            await abandonKsefSubmissionIntent({
              ...base,
              errorCode: KSEF_SUBMISSION_STALE_CODE,
              errorMessage: `KSeF nie zna sesji sprzed ponad 48 h (HTTP ${error.status}): ${error.message}`,
            });
            continue;
          }
          throw new RetryAfterError(
            `Uzgadnianie zamiaru wysyłki KSeF nieudane: ${error instanceof Error ? error.message : 'nieznany błąd'}`,
            getKsefRetryDelay(attempt),
            { cause: error instanceof Error ? error : undefined },
          );
        }
        const ours = intentInvoiceInSession(found, intent, invoice.internalNumber);
        if (ours) {
          await promoteKsefSubmissionIntent({ ...base, invoiceReferenceNumber: ours.referenceNumber });
          logger.warn('Zamiar wysyłki rozstrzygnięty: KSeF ma plik z wcześniejszej próby — uzgadniam zamiast wysyłać', {
            invoiceId,
            session: intent.sessionReferenceNumber,
            statusCode: ours.statusCode,
          });
          continue;
        }
        if (found.length > 0) {
          // Nasza sesja niesie jedną fakturę — inna treść i numer to sygnał dla operatora.
          Sentry.captureMessage('KSeF: sesja zamiaru ma faktury inne niż oczekiwana', {
            level: 'warning',
            tags: { job: 'submit-invoice', kind: 'intent-mismatch' },
            extra: { tenantId, invoiceId, session: intent.sessionReferenceNumber, count: found.length },
          });
        }
        await abandonKsefSubmissionIntent({
          ...base,
          errorCode: KSEF_INTENT_NOT_IN_SESSION_CODE,
          errorMessage: 'KSeF nie ma pliku z tej próby w zamkniętej sesji — wysyłka od nowa.',
        });
      }
    });

    // A2b: „tylko uzgodnij” bez otwartej wysyłki. Bez dowodu kontaktu z KSeF
    // (00131/00136: numer KSeF albo wpis intent/sent/accepted/duplicate)
    // KSeF nie ma tej faktury od nas — NOT_IN_KSEF z wyjściem dla klienta
    // (wyślij ponownie / wróć do szkicu). Z dowodem — RESULT_UNCERTAIN dla
    // operatora. Błąd odczytu dowodu = ponowienie, nie zgadywanie.
    const reconcileOnlyWithoutOpenSubmission = async (uncertainMessage: string): Promise<Error> => {
      const { data, error } = await (await createAdminClient()).rpc('ksef_has_contact_evidence', {
        p_invoice_id: invoiceId,
        p_tenant_id: tenantId,
      });
      if (error) {
        return new RetryAfterError('Nie można sprawdzić dowodu kontaktu z KSeF — ponowię uzgadnianie', getKsefRetryDelay(attempt));
      }
      if (data === true) {
        return new NonRetriableError(`[${SEND_ERROR_CODES.RESULT_UNCERTAIN}] ${uncertainMessage}`);
      }
      logger.warn('Tylko uzgodnij: KSeF nie ma tej faktury — NOT_IN_KSEF', { invoiceId, detail: uncertainMessage });
      return new NonRetriableError(`[${SEND_ERROR_CODES.NOT_IN_KSEF}] ${KSEF_SEND_MESSAGES.notInKsef}`);
    };

    // D-A4-1: odpowiedź 440 „duplikat” — jedna ścieżka dla nowej wysyłki
    // i dla uzgadniania po referencji (także zamiaru z A2). KSeF ma już fakturę
    // tej firmy o tym numerze; rozstrzygamy, czyja to treść:
    //   1. sesja oryginału jest w historii tej faktury i ma ten sam skrót → nasza;
    //   2. pobieramy oryginał i porównujemy z naszymi plikami: identyczny → nasza
    //      (`accepted` z numerem oryginału); z FaktWay albo ta sama treść
    //      z innego programu → operator; inny program, inna treść →
    //      KSEF_NUMBER_TAKEN (klient wystawia z nowym numerem);
    //   3. numer KSeF oryginału ma inna faktura sprzedaży firmy w FaktWay (Y) →
    //      bez przyjęcia numeru, `known-number` z danymi pobranego oryginału
    //      (D-A4-1b-3 PR B: decyzja klienta przy braku własnej historii).
    // Wpis naszej próby dostaje znacznik 440 (numer i sesja oryginału) i zostaje
    // OTWARTY do werdyktu: jest dowodem kontaktu, a ponowienie (cron I5, „Tylko
    // uzgodnij”) weryfikuje treść od nowa — bez drugiej wysyłki i bez STALE.
    // Zamykamy go dopiero werdyktem: „numer zajęty” (number_taken) albo
    // zapisem akceptacji (krok save-ksef-number).
    const resolveDuplicate = async (error: KsefInvoiceRejectedError): Promise<SubmitOutcome> => {
      const original = error.originalKsefNumber;
      const originalSession = error.originalSessionReferenceNumber;
      const ourSession = error.ourSessionReferenceNumber;
      const verdict = (code: SendErrorCode, message: string) =>
        new NonRetriableError(`[${code}] ${message}`, { cause: new KsefSendVerdictError(code, message) });
      const pending = (message: string, delay: number | string) =>
        new RetryAfterError(message, delay, {
          cause: new KsefSendVerdictError(SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE, message),
        });
      const alertOperator = (kind: string, extra: Record<string, unknown> = {}) =>
        Sentry.captureMessage('KSeF: duplikat 440 do uzgodnienia przez operatora', {
          level: 'warning',
          tags: { job: 'submit-invoice', kind: `ksef-duplicate-${kind}` },
          extra: { tenantId, invoiceId, originalKsefNumber: original, originalSessionReferenceNumber: originalSession, ...extra },
        });
      // Data nadania numeru oryginałowi (art. 106na: wystawienie i otrzymanie).
      // Własna sesja — status po referencji (bez uprawnienia InvoiceRead);
      // inaczej metadane po numerze KSeF. Brak daty nie cofa werdyktu — alarm.
      const originalAcquisition = async (ownInvoiceReference: string | null): Promise<string | undefined> => {
        try {
          const credentials = await getTenantKsefCredentials(tenantId);
          if (originalSession && ownInvoiceReference) {
            const status = await checkInvoiceStatusByReference(
              { sessionReferenceNumber: originalSession, invoiceReferenceNumber: ownInvoiceReference },
              credentials,
              env,
              { tenantId, invoiceId },
            );
            if (status.state === 'accepted' && status.acquisitionTimestamp) return status.acquisitionTimestamp;
          }
          return (await fetchKsefAcquisitionDate(original!, credentials, env, { tenantId, invoiceId })) ?? undefined;
        } catch (e) {
          logger.warn('Nie ustalono daty przyjęcia oryginału duplikatu', {
            invoiceId,
            ksefNumber: original,
            error: e instanceof Error ? e.message : String(e),
          });
          return undefined;
        }
      };
      const accept = async (
        via: 'own-duplicate' | 'verified-duplicate',
        xmlStoragePath: string | null,
        sha256Hex: string | null,
        ownInvoiceReference: string | null = null,
      ): Promise<SubmitOutcome> => {
        logger.warn('Duplikat 440 rozstrzygnięty jako nasza faktura', { invoiceId, ksefNumber: original, via });
        const acquisitionTimestamp = await originalAcquisition(ownInvoiceReference);
        if (!acquisitionTimestamp) {
          Sentry.captureMessage('KSeF: brak daty przyjęcia oryginału przy przyjęciu numeru z duplikatu', {
            level: 'warning',
            tags: { job: 'submit-invoice', kind: 'ksef-duplicate-no-date' },
            extra: { tenantId, invoiceId, originalKsefNumber: original, via },
          });
        }
        return {
          ksefNumber: original!,
          acquisitionTimestamp,
          xmlStoragePath: xmlStoragePath ?? invoiceXmlKey(tenantId, invoiceId, invoice.issueDate),
          xmlSha256Hash: sha256Hex ?? undefined,
          sessionReferenceNumber: originalSession ?? undefined,
          duplicateAttempt: ourSession
            ? { sessionReferenceNumber: ourSession, invoiceReferenceNumber: error.ourInvoiceReferenceNumber }
            : undefined,
          via,
        };
      };
      const recordOriginalSession = async (xmlStoragePath: string | null, sha256Hex: string | null) => {
        // Sesja oryginału z numerem KSeF — ponowienia UPO znajdą ją w historii.
        if (!originalSession) return;
        await recordKsefAcceptedSession({
          tenantId,
          invoiceId,
          sessionReferenceNumber: originalSession,
          ksefNumber: original!,
          xmlStoragePath,
          payloadHash: sha256Hex,
        });
      };

      // D-A4-1b-3 (00144): dane oryginału na otwartym wpisie ze znacznikiem 440,
      // zanim faktura zostanie „do uzgodnienia” — na nich klient zdecyduje
      // („ta sama sprzedaż” / „inna”), a operator widzi je na karcie faktury.
      const recordCheck = (reason: DuplicateCheckReason, data: Partial<KsefDuplicateCheck> = {}) =>
        recordKsefDuplicateCheck({
          tenantId,
          invoiceId,
          originalKsefNumber: original!,
          check: {
            sha256: null,
            archivePath: null,
            sizeBytes: null,
            summary: null,
            sameContentExceptHeader: null,
            ownHistory: null,
            acquiredAt: null,
            httpStatus: null,
            knownInvoice: null,
            recheck: null,
            ...data,
            v: 1,
            env,
            checkedAt: new Date().toISOString(),
            reason,
          },
        });

      if (!original) {
        throw pending(
          'KSeF zgłosił duplikat faktury bez numeru oryginału — nie można sprawdzić, czyja to treść. Do uzgodnienia; nie wystawiaj faktury ponownie.',
          getKsefRetryDelay(attempt),
        );
      }

      // 0. Znacznik 440 na otwartym wpisie próby (fail-closed: bez niego nie weryfikujemy).
      if (ourSession) {
        await markKsefAttemptDuplicatePending({
          tenantId,
          invoiceId,
          sessionReferenceNumber: ourSession,
          invoiceReferenceNumber: error.ourInvoiceReferenceNumber,
          originalKsefNumber: original,
          originalSessionReferenceNumber: originalSession,
        });
      }

      // 1. Własna sesja z tym samym plikiem — bez pobierania.
      const originalSessionRow = originalSession ? await findKsefSessionRow(tenantId, invoiceId, originalSession) : null;
      if (originalSession) {
        const sessionRow = originalSessionRow;
        const sessionHash = hexHashToBase64(sessionRow?.requestPayloadHash);
        if (sessionRow && sessionHash && error.ourInvoiceHash && sessionHash === error.ourInvoiceHash) {
          await recordOriginalSession(sessionRow.xmlStoragePath, sessionRow.requestPayloadHash);
          return accept('own-duplicate', sessionRow.xmlStoragePath, sessionRow.requestPayloadHash, sessionRow.invoiceReferenceNumber);
        }
      }

      // 2. Numer KSeF oryginału zna już inna faktura sprzedaży tej firmy (Y, np.
      // import historii). D-A4-1b-3 PR B (decyzja Bartosza 07.10.2026 (1)): werdykt
      // nie kończy się tu — pobieramy, archiwizujemy i opisujemy K z tą samą
      // obsługą błędów co pozostałe powody (klient zdecyduje, widząc dane K
      // i odnośnik do Y). Pomijamy tylko przyjęcie numeru: Y ma już K, a druga
      // faktura z tym samym numerem KSeF to podwójna sprzedaż w JPK
      // (`idx_invoices_ksef_number_unique` nie jest unikalny, 00004).
      const known = await findTenantInvoiceByKsefNumber(tenantId, original, invoiceId);

      // 3. Oryginał z KSeF.
      const credentials = await getTenantKsefCredentials(tenantId);
      let originalBytes: Buffer;
      try {
        originalBytes = await downloadKsefInvoice(original, credentials, env, { tenantId, invoiceId });
      } catch (downloadError) {
        const api = downloadError instanceof KsefApiError ? downloadError : null;
        if (api?.status === 401) ksefSessionCache.invalidate(credentials.nip, env);
        const codes = api ? ksefErrorCodes(api.body) : [];
        const httpLabel = api ? `HTTP ${api.status}` : 'błąd sieci';
        const unverified =
          `KSeF ma już fakturę o tym numerze (numer KSeF ${original}), ale nie udało się pobrać jej treści do porównania (${httpLabel}` +
          `${api?.status === 403 ? ' — token KSeF bez uprawnienia InvoiceRead' : ''}). Do uzgodnienia; nie wystawiaj faktury ponownie.`;
        // 21164 tuż po przyjęciu oryginału też bywa chwilowe — w obrębie ponowień joba.
        const transient = !api || api.isRetryable || api.status === 401 ||
          codes.includes(KSEF_INVOICE_NOT_YET_AVAILABLE) || codes.includes(KSEF_INVOICE_NOT_FOUND);
        await recordCheck(transient ? 'download-pending' : 'download-refused', {
          httpStatus: api?.status ?? null,
          knownInvoice: known,
        });
        if (transient) throw pending(unverified, ksefRetryDelayFor(downloadError, attempt));
        // 403 (token bez InvoiceRead) i inne 4xx: operator. Wpis zostaje otwarty
        // ze znacznikiem 440 — „Tylko uzgodnij” i cron I5 powtórzą weryfikację.
        alertOperator('download-refused', { status: api?.status, otherInvoice: known?.internalNumber ?? null });
        throw verdict(SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE, unverified);
      }
      const originalSha256Hex = createHash('sha256').update(originalBytes).digest('hex');
      const originalData = {
        sha256: originalSha256Hex,
        sizeBytes: originalBytes.length,
        summary: summarizeInvoiceXml(originalBytes.toString('utf8')),
      };

      // 4. Werdykt po treści. Bieżący plik zgodny bajt w bajt — bez dalszych odczytów.
      const attemptRow = ourSession ? await findKsefSessionRow(tenantId, invoiceId, ourSession) : null;
      const currentHash = error.ourInvoiceHash ?? hexHashToBase64(attemptRow?.requestPayloadHash);
      const originalHash = Buffer.from(originalSha256Hex, 'hex').toString('base64');
      // Przy znanym numerze bez przyjęcia (Y ma już K) — dalej do zapisu dla klienta.
      if (!known && currentHash && currentHash === originalHash) {
        const path = attemptRow?.xmlStoragePath
          ?? invoiceXmlKeyFor({ tenantId, invoiceId, issueDate: invoice.issueDate, attemptId: parsed.data.sendAttemptId ?? null });
        await recordOriginalSession(path, originalSha256Hex);
        return accept('verified-duplicate', path, originalSha256Hex);
      }
      // Dalej potrzebny bieżący plik (treść poza nagłówkiem). Chwilowy błąd
      // magazynu = ponowienie, nie werdykt; brak pliku (wpis sprzed 00134) = operator.
      let ourXml: string | null = null;
      if (attemptRow?.xmlStoragePath && attemptRow.requestPayloadHash) {
        try {
          ourXml = await downloadInvoiceXml(attemptRow.xmlStoragePath, attemptRow.requestPayloadHash, tenantId);
        } catch (readError) {
          await recordCheck('storage-pending', { ...originalData, knownInvoice: known });
          throw pending(
            `KSeF ma już fakturę o tym numerze (numer KSeF ${original}); nie udało się odczytać naszego pliku do porównania ` +
              `(${readError instanceof Error ? readError.message : 'magazyn'}). Do uzgodnienia; nie wystawiaj faktury ponownie.`,
            getKsefRetryDelay(attempt),
          );
        }
      }
      const payloads = await findSubmissionPayloads(tenantId, invoiceId);
      const cmp = compareDuplicate({
        originalBytes,
        currentHashBase64: currentHash,
        earlierHashesBase64: payloads.map((p) => hexHashToBase64(p.hash)),
        ourXml,
      });
      if (!known && cmp.verdict === 'identical') {
        // Wcześniejsza próba o tej samej treści: jej plik, a gdy wpis go nie zna
        // (sprzed 00134) — archiwum pobranego oryginału (KOD I liczy skrót z niego).
        let path = payloads.find((p) => hexHashToBase64(p.hash) === cmp.matchedHash)?.xmlStoragePath ?? null;
        if (!path) {
          const stored = await uploadInvoiceXml(tenantId, invoiceId, invoice.issueDate, originalBytes.toString('utf8'), {
            attemptId: `ksef-${originalSha256Hex.slice(0, 40)}`,
            immutable: false,
          });
          path = stored.storagePath;
        }
        await recordOriginalSession(path, originalSha256Hex);
        return accept('verified-duplicate', path, originalSha256Hex);
      }
      if (known || cmp.verdict === 'operator' || !ourXml) {
        // Bez naszego pliku nie wolno orzec „numer zajęty” (mogłaby to być ta sama sprzedaż).
        // Znany numer KSeF wygrywa z faktflow-original i same-content-other-program.
        const reason: DuplicateCheckReason = known
          ? 'known-number'
          : cmp.verdict === 'operator' && cmp.reason ? cmp.reason : 'no-own-file';
        // Przy znanym numerze `ownHistory` = „K może być naszą wysyłką tego
        // dokumentu”: sesja K w historii, bajty K = plik którejś próby albo
        // bieżący plik (`identical`). Wtedy klient nie decyduje (00148).
        const ownHistory = Boolean(originalSessionRow)
          || payloads.some((p) => p.hash.toLowerCase() === originalSha256Hex)
          || (known !== null && cmp.verdict === 'identical');
        // Bajty oryginału pod kluczem importu historii (ten sam obiekt zobaczy
        // Magiczny import) — z nich zapis oryginału po decyzji klienta.
        let archivePath: string;
        try {
          archivePath = (await archiveImportedKsefXml(tenantId, original, originalBytes)).storagePath;
        } catch (archiveError) {
          if (archiveError instanceof KsefXmlArchiveConflictError) {
            await recordCheck('archive-conflict', { ...originalData, ownHistory, knownInvoice: known });
            alertOperator('archive-conflict');
            throw verdict(
              SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE,
              `KSeF ma już fakturę o tym numerze (numer KSeF ${original}), a w archiwum FaktWay jest pod tym numerem inny plik — ` +
                'do uzgodnienia przez operatora; nie wystawiaj faktury ponownie.',
            );
          }
          await recordCheck('archive-pending', { ...originalData, ownHistory, knownInvoice: known });
          throw pending(
            `KSeF ma już fakturę o tym numerze (numer KSeF ${original}); nie udało się zapisać jej pliku w archiwum ` +
              `(${archiveError instanceof Error ? archiveError.message : 'magazyn'}). Do uzgodnienia; nie wystawiaj faktury ponownie.`,
            getKsefRetryDelay(attempt),
          );
        }
        // D-A4-1b-3 PR C (5.1): plik z oznaczeniem FaktWay — brama pochodzenia na
        // zarchiwizowanych bajtach. `importable`: klient zapisze oryginał sam;
        // `review`: przegląd operatora (I5R). Czysta i deterministyczna (nigdy nie
        // rzuca), więc ponowienie od zera zapisuje tę samą ocenę. NIP firmy ze
        // zdarzenia (F3) — reguła `seller`.
        const importGate: KsefOriginalImportGate | null = reason === 'faktflow-original'
          ? evaluateOriginalGate({
            xml: decodeKsefXml(originalBytes),
            ksefNumber: original,
            internalNumber: invoice.internalNumber ?? '',
            tenantNip: nip,
          }).gate
          : null;
        await recordCheck(reason, {
          ...originalData,
          summary: cmp.summary,
          archivePath,
          sameContentExceptHeader: ourXml ? cmp.sameContentExceptHeader : null,
          ownHistory,
          knownInvoice: known,
          acquiredAt: (await originalAcquisition(originalSessionRow?.invoiceReferenceNumber ?? null)) ?? null,
          // Klucz tylko przy faktflow-original — inne powody zostają bez bramy (brak klucza, nie `undefined`).
          ...(importGate ? { importGate } : {}),
        });
        // Alarm `ksef-duplicate-known-number` zostaje — operator sprawdza Y w każdym przypadku.
        alertOperator(reason, {
          sameContentExceptHeader: cmp.sameContentExceptHeader,
          ...(known ? { otherInvoice: known.internalNumber, ownHistory } : {}),
          ...(importGate ? { importGate: { kind: importGate.kind, problems: importGate.problems } } : {}),
        });
        if (importGate?.kind === 'review') {
          // Odcisk [kind, faktura]: ponowienie (cron I5, „Tylko uzgodnij”) nie mnoży zgłoszeń (5.11).
          // Marka w treści: FaktWay (spec 5.1 ma tu jeszcze starą nazwę sprzed zmiany marki — nazwa-produktu.test.ts).
          Sentry.captureMessage('KSeF: plik z oznaczeniem FaktWay do przeglądu operatora', {
            level: 'warning',
            tags: { job: 'submit-invoice', area: 'ksef.duplicate-decision', kind: KSEF_ORIGINAL_ALARM_KINDS.provenanceReview },
            fingerprint: [KSEF_ORIGINAL_ALARM_KINDS.provenanceReview, invoiceId],
            extra: { tenantId, invoiceId, originalKsefNumber: original, problems: importGate.problems },
          });
        }
        throw verdict(
          SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE,
          known
            ? knownNumberVerdictMessage(original, known, ownHistory)
            : importGate
              // Bez „operatora” i bez obietnicy decyzji (reguła 07.10.2026) — tekst trafia też do e-maila i karty FLO.
              ? faktflowOriginalVerdictMessage(original, importGate.kind)
              : cmp.verdict === 'operator'
                ? operatorVerdictMessage(original, cmp)
                : `KSeF ma już fakturę o tym numerze (numer KSeF ${original}) spoza FaktWay, a historia wysyłki nie ma naszego pliku do porównania treści. Do uzgodnienia przez operatora; nie wystawiaj faktury ponownie.`,
        );
      }
      // Oryginał z innego programu o innej treści: numer zajęty. Wszystkie wpisy
      // duplikatu tej faktury przestają być dowodem kontaktu (fail-closed).
      await markKsefSubmissionsNumberTaken({ tenantId, invoiceId, originalKsefNumber: original });
      throw verdict(
        SEND_ERROR_CODES.KSEF_NUMBER_TAKEN,
        numberTakenMessage(invoice.internalNumber ?? '', original, cmp.summary),
      );
    };

    const reconciled = await step.run('reconcile-previous-submission', async (): Promise<SubmitOutcome | null> => {
      const previous = await findOpenKsefSubmission(tenantId, invoiceId);
      if (!previous) {
        // Tryb „tylko uzgodnij” nie wysyła od nowa — bez wpisu `sent` nie ma czego uzgadniać.
        if (parsed.data.reconcileOnly) {
          throw await reconcileOnlyWithoutOpenSubmission(
            'Tryb „tylko uzgodnij”: brak otwartej wysyłki (wpisu sent) do uzgodnienia — faktura nie została wysłana ponownie.',
          );
        }
        return null;
      }
      // D-A4-1: KSeF odpowiedział już na tę próbę 440 — weryfikacja treści od
      // razu (stara sesja nie jest potrzebna; po 48 h KSeF może jej nie znać).
      if (previous.originalKsefNumber) {
        return await resolveDuplicate(new KsefInvoiceRejectedError(KSEF_DUPLICATE_INVOICE, {
          code: KSEF_DUPLICATE_INVOICE,
          description: 'Duplikat faktury (odpowiedź zapisana w historii wysyłki)',
          details: [],
          extensions: {
            originalKsefNumber: previous.originalKsefNumber,
            originalSessionReferenceNumber: previous.originalSessionReferenceNumber ?? undefined,
          },
        }, {
          invoiceHash: hexHashToBase64(previous.payloadHash),
          sessionReferenceNumber: previous.sessionReferenceNumber,
          invoiceReferenceNumber: previous.invoiceReferenceNumber,
        }));
      }
      const credentials = await getTenantKsefCredentials(tenantId);
      try {
        const status = await checkInvoiceStatusByReference(previous, credentials, env, {
          tenantId,
          invoiceId,
        });
        if (status.state === 'processing') {
          // S22: oczekiwanie na wynik KSeF nie zużywa próby.
          throw new RetryAfterError(
            'KSeF nadal przetwarza wcześniejszą wysyłkę tej faktury — czekam zamiast wysyłać ponownie',
            getKsefRetryDelay(attempt),
            { countsAsAttempt: false },
          );
        }
        return {
          ksefNumber: status.ksefNumber,
          acquisitionTimestamp: status.acquisitionTimestamp,
          // D5: plik tej właśnie próby; klucz historyczny tylko dla wpisów sprzed 00134.
          xmlStoragePath: previous.xmlStoragePath ?? invoiceXmlKey(tenantId, invoiceId, invoice.issueDate),
          sessionReferenceNumber: previous.sessionReferenceNumber,
          invoiceReferenceNumber: previous.invoiceReferenceNumber,
          via: 'reference-reconcile',
        };
      } catch (error) {
        if (error instanceof RetryAfterError) throw error;
        // D-A4-1: 440 przy uzgadnianiu (np. po timeoucie pollingu) — ta sama weryfikacja, bez wysyłki.
        if (error instanceof KsefInvoiceRejectedError && error.isDuplicate) {
          return await resolveDuplicate(error);
        }
        if (error instanceof KsefInvoiceRejectedError && !error.isDuplicate) {
          await markKsefSubmission({
            tenantId,
            invoiceId,
            invoiceReferenceNumber: previous.invoiceReferenceNumber,
            status: 'rejected',
            errorCode: String(error.code),
            errorMessage: error.message,
          });
          throw new NonRetriableError(error.message, { cause: error });
        }
        if (error instanceof KsefApiError && error.status === 401) {
          ksefSessionCache.invalidate(credentials.nip, env);
        }
        // Okno 48 h (I5): KSeF odpowiada błędem klienta o wysyłce sprzed dwóch
        // dób — wpis nie zostanie rozstrzygnięty. Zamykamy go jako STALE
        // (ślad w historii i audycie) i wysyłamy od nowa; w trybie „tylko
        // uzgodnij” kończymy bez wysyłki.
        if (
          error instanceof KsefApiError &&
          !error.isRetryable &&
          error.status !== 401 &&
          error.status !== 403 &&
          isStaleSubmission(previous.attemptedAt)
        ) {
          await markKsefSubmission({
            tenantId,
            invoiceId,
            invoiceReferenceNumber: previous.invoiceReferenceNumber,
            status: 'rejected',
            errorCode: KSEF_SUBMISSION_STALE_CODE,
            errorMessage: `KSeF nie zna wysyłki sprzed ponad 48 h (HTTP ${error.status}): ${error.message}`,
          });
          logger.warn('Zalegający wpis sent zamknięty jako STALE — KSeF nie zna tej wysyłki', {
            invoiceId,
            attemptedAt: previous.attemptedAt,
            status: error.status,
            reconcileOnly: Boolean(parsed.data.reconcileOnly),
          });
          Sentry.captureMessage('KSeF: zalegający wpis sent zamknięty jako STALE', {
            level: 'warning',
            tags: { job: 'submit-invoice', kind: 'stale-submission' },
            extra: { tenantId, invoiceId, attemptedAt: previous.attemptedAt, status: error.status },
          });
          if (parsed.data.reconcileOnly) {
            throw await reconcileOnlyWithoutOpenSubmission(
              `Tryb „tylko uzgodnij”: KSeF nie zna wysyłki sprzed ponad 48 h (HTTP ${error.status}) — wpis zamknięty jako STALE, faktura nie została wysłana ponownie.`,
            );
          }
          return null;
        }
        // Awaria łącza albo KSeF: ponawiamy UZGADNIANIE, nigdy wysyłkę.
        throw new RetryAfterError(
          `Uzgadnianie wcześniejszej wysyłki KSeF nieudane: ${error instanceof Error ? error.message : 'nieznany błąd'}`,
          getKsefRetryDelay(attempt),
          { cause: error instanceof Error ? error : undefined },
        );
      }
    });

    const result: SubmitOutcome = reconciled ?? await step.run('submit-to-ksef', async (): Promise<SubmitOutcome> => {
      const current = await currentSubmissionState(parsed.data);
      if ((current.ksef_status === 'accepted' && current.ksef_number) ||
          isHeldRozSubmission(parsed.data, current)) {
        throw new NonRetriableError(ROZ_SUBMISSION_HOLD_MESSAGE);
      }
      // Ponownie tuż przed wysyłką: wyłącznik mógł zostać włączony między krokami.
      await assertSubmissionNotHeld(parsed.data, current, env);
      const documentKind = await assertSubmitReferences({
        supabase: await createAdminClient(),
        tenantId,
        invoiceId,
        invoice,
        environment: env,
        correctionData: parsed.data.correctionData,
        advanceData: parsed.data.advanceData,
        finalData: parsed.data.finalData,
        finalAdvanceSettlementRows: parsed.data.finalAdvanceSettlementRows,
      });
      // Decyzja Bartosza 06.10.2026 (00147): KOR/ZAL/ROZ tylko w dniu wystawienia.
      // Ponowienie pg-boss albo oczekiwanie na przejęcie może przenieść POST za
      // północ — w KSeF dokument wystawia się w dniu wysyłki. Tu, przed
      // `submitInvoiceFullFlow`: uzgodnienie (wyżej) nie wysyła, więc działa dalej.
      // Drugie sprawdzenie — w haku sesji tuż przed plikiem (`IssueDatePassedError`).
      // Zwykła faktura bez zmian (B1/B2); do zdjęcia, gdy B2 obejmie wszystkie rodzaje.
      if (documentKind !== 'regular') {
        const today = todayInWarsaw();
        if (invoice.issueDate !== today) {
          throw new NonRetriableError(issueDatePassedMessage(invoice.issueDate, today));
        }
      }
      const credentials = await getTenantKsefCredentials(tenantId);

      try {
        // Po refaktorze na zodEvent korzystamy z `parsed.data` (zwalidowanego),
        // a nie z surowego `data` — typy są pewne, bez `as` casta.
        const finalPayload =
          parsed.data.finalData &&
          parsed.data.finalAdvanceSettlementRows &&
          parsed.data.finalAdvanceSettlementRows.length > 0
            ? {
                finalData: parsed.data.finalData,
                advanceSettlementRows: parsed.data.finalAdvanceSettlementRows,
              }
            : null;

        const submitted = await submitInvoiceFullFlow(
          tenantId,
          invoiceId,
          invoice,
          credentials,
          env,
          parsed.data.correctionData ?? null,
          parsed.data.advanceData ?? null,
          finalPayload,
          // D5: klucz XML per próba — ponowienie tej samej próby trafia w ten sam plik.
          parsed.data.sendAttemptId ?? null,
        );
        return { ...submitted, via: 'submit' };
      } catch (error) {
        // Północ wypadła po bezpieczniku wyżej, przed plikiem (hak sesji) — pliku
        // nie wysłano; ponowienie dałoby tę samą odmowę.
        if (error instanceof IssueDatePassedError) {
          throw new NonRetriableError(error.message, { cause: error });
        }
        if (error instanceof KsefNotVerifiedError) {
          throw new NonRetriableError(
            'Organizacja nie ma zweryfikowanego certyfikatu KSeF (Ustawienia → KSeF). Wysyłka do KSeF jest zablokowana.',
            { cause: error },
          );
        }
        // Nie-retry-owalne: walidacja biznesowa i odrzucenie przez KSeF.
        // Bez NonRetriableError Inngest zrobiłby 4 bezsensowne próby.
        if (error instanceof InvoiceValidationError) {
          throw new NonRetriableError(
            `Faktura nie przeszła walidacji: ${error.message}`,
            { cause: error },
          );
        }
        // AUD-13: KSeF nigdy nie przyjmie XML-a niezgodnego z XSD — ponowienia
        // i Offline24 tylko odsuwały komunikat o błędzie o kilka dni.
        if (error instanceof InvoiceXmlSchemaError) {
          throw new NonRetriableError(
            `Faktura nie przeszła walidacji schematu FA(3): ${error.errors.slice(0, 3).join('; ')}`,
            { cause: error },
          );
        }
        // 401: wygasła sesja z pamięci podręcznej — to nie odrzucenie faktury.
        // Ponowienie zacznie od uzgodnienia, jeśli plik zdążył dotrzeć do KSeF.
        if (error instanceof KsefApiError && error.status === 401) {
          ksefSessionCache.invalidate(credentials.nip, env);
          throw new RetryAfterError(
            'Sesja KSeF wygasła — ponowię z nową sesją',
            getKsefRetryDelay(attempt),
            { cause: error },
          );
        }
        if (error instanceof KsefApiError && !error.isRetryable) {
          Sentry.captureException(error, {
            tags: { job: 'submit-invoice', kind: 'ksef-rejection' },
            extra: { tenantId, invoiceId, ksefCode: error.ksefCode, status: error.status },
          });
          throw new NonRetriableError(
            `KSeF odrzucił fakturę (HTTP ${error.status}): ${error.message}`,
            { cause: error },
          );
        }
        // Odrzucenie w STATUSIE faktury (HTTP 200, kod ≥ 400) — ta sama decyzja
        // o treści co wyżej. Wcześniej leciało jako zwykły Error: 5 ponownych
        // wysyłek, potem Offline24. Przy 440 (duplikat) faktura już JEST w KSeF.
        if (error instanceof KsefInvoiceRejectedError && error.isDuplicate) {
          // 440: KSeF ma już fakturę o tym numerze — werdykt po treści (D-A4-1).
          return await resolveDuplicate(error);
        }
        if (error instanceof KsefInvoiceRejectedError) {
          // Odrzucenie w statusie zamyka wpis historii tej wysyłki (S1).
          await closeOpenSubmission(tenantId, invoiceId, 'rejected', error, logger);
          Sentry.captureException(error, {
            tags: {
              job: 'submit-invoice',
              kind: error.isDuplicate ? 'ksef-duplicate' : 'ksef-rejection',
            },
            extra: {
              tenantId,
              invoiceId,
              ksefStatusCode: error.code,
              originalKsefNumber: error.originalKsefNumber,
            },
          });
          throw new NonRetriableError(error.message, { cause: error });
        }
        // Retry-owalne — 5xx, 429, timeout, ECONNRESET. Zamiast pozwolić
        // Inngestowi użyć defaultowego exponential backoff (10s/30s/1m/5m/15m),
        // rzucamy `RetryAfterError` z naszym custom schedule:
        // 30s → 2min → 5min → 15min → 1h (Faza 23 sekcja 2).
        //
        // KsefApiError 429 może mieć `Retry-After` header — jeśli MF mówi
        // nam konkretnie ile czekać, słuchamy (AUD-92). Inaczej harmonogram.
        const customDelay = ksefRetryDelayFor(error, attempt);
        const isKsefApi = error instanceof KsefApiError;
        const errorLabel = isKsefApi
          ? `KSeF HTTP ${error.status}: ${error.message}`
          : error instanceof Error
            ? `${error.name}: ${error.message}`
            : 'Nieznany błąd';

        logger.warn('Retry-owalny błąd KSeF — planuję ponowną próbę', {
          tenantId,
          invoiceId,
          attempt,
          maxRetries: KSEF_MAX_RETRIES,
          retryAfter: customDelay,
          errorLabel,
        });

        Sentry.addBreadcrumb({
          category: 'ksef.submit',
          level: 'warning',
          message: 'KSeF retry scheduled',
          data: { tenantId, invoiceId, attempt, retryAfter: customDelay, errorLabel },
        });

        throw new RetryAfterError(errorLabel, customDelay, {
          cause: error instanceof Error ? error : undefined,
        });
      }
    });

    // Krok 4: zapisz numer KSeF i timestamp akceptacji do bazy.
    await step.run('save-ksef-number', async () => {
      await updateInvoiceStatus(invoiceId, {
        ksef_status: 'accepted',
        ksef_number: result.ksefNumber,
        ksef_environment: env,
        ksef_accepted_at: result.acquisitionTimestamp,
        xml_storage_path: result.xmlStoragePath,
        last_error: null,
        last_error_code: null,
        last_error_field: null,
        last_error_suggestion: null,
      }, tenantId);

      // D-A4-1: nasza próba odrzucona jako duplikat własnej faktury — zamykamy
      // ją dopiero teraz, po zapisie akceptacji (restart wcześniej = ponowna
      // weryfikacja po znaczniku 440, bez drugiej wysyłki). Fail-soft.
      if (result.duplicateAttempt) {
        try {
          await closeKsefAttempt({
            tenantId,
            invoiceId,
            sessionReferenceNumber: result.duplicateAttempt.sessionReferenceNumber,
            invoiceReferenceNumber: result.duplicateAttempt.invoiceReferenceNumber,
            status: 'duplicate',
            errorCode: '440',
            errorMessage: `Duplikat własnej faktury — przyjęty numer oryginału ${result.ksefNumber}`,
          });
        } catch (e) {
          logger.warn('Nie zamknięto wpisu próby odrzuconej jako duplikat', {
            invoiceId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Historia prób: wpis zamykamy po zapisie akceptacji. Fail-soft — błąd tu
      // nie może cofnąć akceptacji ani zablokować zdarzenia UPO niżej.
      if (result.invoiceReferenceNumber) {
        try {
          // A2: zamiar tej sesji, którego awans do `sent` nie zdążył się zapisać.
          if (result.sessionReferenceNumber) {
            await promoteKsefSubmissionIntent({
              tenantId,
              invoiceId,
              sessionReferenceNumber: result.sessionReferenceNumber,
              invoiceReferenceNumber: result.invoiceReferenceNumber,
            });
          }
          await markKsefSubmission({
            tenantId,
            invoiceId,
            invoiceReferenceNumber: result.invoiceReferenceNumber,
            status: 'accepted',
            ksefNumber: result.ksefNumber,
          });
        } catch (e) {
          logger.warn('Nie zamknięto wpisu historii wysyłki KSeF', {
            invoiceId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // AUD-12: wiersz xml_documents (PDF z kodem KOD I, „Pobierz XML”, portal
      // księgowej). Fail-soft jak historia wysyłki — akceptacji nie cofamy,
      // brak wiersza widać w Sentry.
      try {
        await recordXmlDocument({
          tenantId,
          invoiceId,
          storagePath: result.xmlStoragePath,
          sha256Hash: result.xmlSha256Hash,
          sizeBytes: result.xmlSizeBytes,
        });
      } catch (e) {
        logger.error('Nie zapisano xml_documents dla przyjętej faktury', {
          invoiceId,
          error: e instanceof Error ? e.message : String(e),
        });
        Sentry.captureException(e, { tags: { area: 'ksef.xml-documents' }, extra: { invoiceId } });
      }

      // Faza 22: faktura zaakceptowana → dashboard KPI się zmieniają.
      // Czyścimy cache żeby user widział świeży count zamiast czekać na 5min TTL.
      const { invalidateTenantDashboard } = await import('@/lib/cache/invalidation');
      await invalidateTenantDashboard(tenantId);
    });

    await step.run('analytics-invoice-accepted', async () => {
      await trackServer({
        distinctId: tenantId,
        event: ANALYTICS_EVENTS.invoiceAccepted,
        properties: {
          ksef_env: env,
          internal_number: invoice.internalNumber ?? null,
        },
      });
    });

    await step.sendEvent('trigger-upo-download', {
      name: 'invoice/upo.requested',
      // Limit „3 naraz per NIP” w pg-boss działa tylko z grupą (AUD-92).
      groupId: nip,
      data: {
        invoiceId,
        tenantId,
        // `nip` powędruje do `downloadUpoJob` jako klucz concurrency
        // (`{ key: 'data.nip', limit: 3 }`) — limit per-tenant zapobiega
        // zalaniu KSeF /upo żądaniami z jednego podmiotu.
        nip,
        ksefNumber: result.ksefNumber,
        environment: env,
        // KSeF 2.0 trzyma UPO w zasobach sesji (AUD-17).
        sessionReferenceNumber: result.sessionReferenceNumber,
      },
    });

    await step.run('audit-success', async () => {
      await logAuditSystem({
        action: 'invoice.submit_succeeded',
        tenantId,
        entityType: 'invoice',
        entityId: invoiceId,
        metadata: { ksefNumber: result.ksefNumber, via: result.via },
      });
    });

    await step.sendEvent('emit-success', {
      name: 'invoice/submit.succeeded',
      data: {
        invoiceId,
        tenantId,
        ksefNumber: result.ksefNumber,
        environment: env,
        fromOfflineQueue: data.fromOfflineQueue,
        offlineQueueId: parsed.data.offlineQueueId,
      },
    });

    logger.info('Faktura wysłana', {
      invoiceId,
      ksefNumber: result.ksefNumber,
    });

    return {
      success: true,
      ksefNumber: result.ksefNumber,
    };
}

