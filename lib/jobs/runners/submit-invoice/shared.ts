/**
 * Wspólne części joba wysyłki faktury do KSeF (`../submit-invoice.ts`): stałe,
 * typ wyniku, świeże odczyty stanu, hamulce i ślad szkicu wycofanego.
 * Wydzielone bez zmiany logiki (plan usprawnień 3.7a).
 */
import * as Sentry from '@sentry/nextjs';
import { NonRetriableError, RetryAfterError } from '../../errors';
import type { JobContext } from '@/lib/jobs/registry';
import type { KsefEnvironment } from '@/types/ksef';
import { invoiceSubmitRequested } from '../../events';
import { KsefCredentialsError } from '@/lib/supabase/admin-queries';
import { createAdminClient } from '@/lib/supabase/server';
import {
  heldErrorMessage,
  isCorrectionHeldForEnv,
  isCorrectionSubmission,
  isKsefSubmissionPaused,
  KOR_HOLD,
  KSEF_PAUSED,
} from '@/lib/ksef/submission-holds';
import { isRozSubmission } from '@/lib/ksef/roz-submission-hold';
import { SEND_ERROR_CODES } from '@/lib/ksef/send-error-codes';
import { getKsefRetryDelay } from '../../retry-schedule';

/**
 * Odpowiedź 440 „duplikat”, której NIE da się przypisać do naszej wcześniejszej
 * wysyłki tej faktury (inny numer sesji albo brak historii). KSeF wykrywa
 * duplikat po numerze faktury sprzedawcy, a ten numer mógł zostać użyty poza
 * FaktWay — przypięcie cudzego numeru KSeF byłoby błędnym zapisem prawnym.
 * Stan neutralny „do uzgodnienia” (jak wstrzymana ROZ), bez komunikatu
 * „odrzucona”. Znacznik w treści błędu, bo przechodzi przez oba backendy jobów.
 */
export const KSEF_DUPLICATE_RECONCILE = SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE;

/** Wynik wysyłki niezależnie od drogi: nowa wysyłka, uzgodnienie albo własny duplikat. */
export interface SubmitOutcome {
  ksefNumber: string;
  xmlStoragePath: string;
  /** Skrót pliku tej próby: z zapisu przy świeżej wysyłce, inaczej z historii wysyłek. Brak = wpis sprzed 01.10.2026. */
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

export function isStaleSubmission(attemptedAt: string | null | undefined): boolean {
  if (!attemptedAt) return false;
  const at = Date.parse(attemptedAt);
  return Number.isFinite(at) && Date.now() - at > KSEF_SUBMISSION_STALE_MS;
}

/** Fresh DB read outside Inngest steps, including the accepted status. */
export async function currentSubmissionState(
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

export function isHeldRozSubmission(
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
export async function assertSubmissionNotHeld(
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
export async function reconcileAcceptedOfflineQueue(
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
 * W1: błąd poświadczeń ≠ odrzucenie przez KSeF.
 *   - brak certyfikatu / NIP niezweryfikowany → bez ponowień (klient uzupełnia
 *     ustawienia; kod `NO_CERTIFICATE` / `NOT_VERIFIED`),
 *   - klucz szyfrowania / NIP z szyfrogramu → ponowienie z alarmem operatora
 *     (`CREDENTIALS_UNAVAILABLE`),
 *   - błąd odczytu bazy → zwykłe ponowienie wg harmonogramu (`INFRA`).
 * Do 03.10.2026 każdy z nich kończył fakturę jako „odrzucona przez KSeF”.
 */
export function credentialsFailure(
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
 * D-A4-1b-3 PR B (decyzje Bartosza 07.10.2026 (2), (3); spec §2.7.2): job
 * wraca do szkicu wycofanego — wpis `number_taken` (decyzja klienta albo
 * automatyczny „numer zajęty”). Numer ma w KSeF inna faktura (K), więc
 * każda wysyłka skończyłaby się 440. Wyjście bez zapisu: bez przejęcia,
 * bez `failed` (I7 wznowiłby wtedy pełną wysyłkę) i bez `invoice/submit.failed`.
 * Ślad: ostrzeżenie w logu i w Sentry (W3 — nic nie kończy się bez śladu).
 */
export function reportRetiredExit(
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
export interface RetiredOutcome {
  retired: true;
  originalKsefNumber: string | null;
}

/** Zwalidowane zdarzenie `invoice/submit.requested`. */
export type SubmitEventData = Parameters<typeof invoiceSubmitRequested.create>[0];

/**
 * Wspólny kontekst kroków `runSubmitInvoice` po walidacji zdarzenia
 * i środowiska. Zastępuje domknięcia z czasu, gdy kroki żyły w jednej
 * funkcji; `parsed` zostawia ciała kroków bez zmian (`parsed.data.…`).
 */
export interface SubmitRunContext {
  parsed: { data: SubmitEventData };
  tenantId: string;
  invoiceId: string;
  invoice: SubmitEventData['invoice'];
  nip: string;
  env: KsefEnvironment;
  attempt: number;
  logger: JobContext['logger'];
}
