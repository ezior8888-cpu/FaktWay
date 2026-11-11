/**
 * Obsługa joba wysyłki po wyczerpaniu prób (`onSubmitInvoiceExhausted`).
 * Wydzielona z `../submit-invoice.ts` bez zmiany logiki (plan usprawnień 3.7a).
 */
import { requireInvoiceTenant } from '../tenant-boundary';
import * as Sentry from '@sentry/nextjs';
import { SUPPORT_EMAIL } from '@/lib/site';
import type { JobContext } from '@/lib/jobs/registry';
import type { KsefEnvironment } from '@/types/ksef';
import { logAuditSystem } from '@/lib/audit/log-system';
import { invoiceSubmitRequested } from '../../events';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { createAdminClient } from '@/lib/supabase/server';
import { findKsefNumberTaken } from '@/lib/ksef/submission-log';
import { isOffline24Enabled } from '@/lib/ksef/offline24-policy';
import {
  classifySendError,
  isContentRejection,
  SEND_ERROR_CODES,
  sendVerdictIn,
  type SendErrorCode,
} from '@/lib/ksef/send-error-codes';
import { KsefInvoiceRejectedError } from '@/lib/ksef/submit';
import { KSEF_MAX_RETRIES } from '../../retry-schedule';
import {
  currentSubmissionState,
  isHeldRozSubmission,
  reconcileAcceptedOfflineQueue,
  reportRetiredExit,
} from './shared';

/** Znacznik `[KOD] ` na początku treści błędu — do zdjęcia przed zapisem `last_error`. */
const HOLD_MARKER = /^\[[A-Z_]+\] /;

/**
 * F-093-STATUS: odrzucenie w statusie (kod 400–499 poza 440) w łańcuchu
 * przyczyn błędu joba. Jego `customerMessage` z opisem i szczegółami KSeF
 * idzie do kanałów klienta (`last_error`, zdarzenie dla e-maila), nie do logu
 * ani audytu. 440 ma własne werdykty runnera.
 */
function statusRejectionIn(error: Error): KsefInvoiceRejectedError | null {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth += 1) {
    if (current instanceof KsefInvoiceRejectedError) return current.isDuplicate ? null : current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

const ROZ_RECONCILIATION_MESSAGE =
  'Wysyłka faktur rozliczeniowych do KSeF jest tymczasowo wstrzymana — po zdjęciu blokady tej faktury sami nie wyślemy (co dalej — na dole strony).';

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
      // F-093-STATUS: przy odrzuceniu w statusie komunikat błędu to sam status
      // (log, audyt). Klient dostaje na fakturę i w mailu opis i szczegóły
      // z KSeF jak dotąd: to jego faktura i jedyna wskazówka, co poprawić.
      // F-093-440: przy werdykcie 440 komunikat błędu to tekst operatora (log,
      // audyt). Klient dostaje na fakturę i w mailu tekst werdyktu jak dotąd,
      // z danymi pobranego oryginału: na nich decyduje, czy to ta sama sprzedaż.
      // Ten sam tekst = ten sam klucz idempotencji maila.
      const statusRejection = heldRoz ? null : statusRejectionIn(error);
      const verdictCarrier = heldRoz ? null : sendVerdictIn(error);
      const customerFailureMessage = statusRejection
        ? `${error.name}: ${statusRejection.customerMessage}`
        : verdictCarrier && failureMessage === verdictCarrier.message
          ? verdictCarrier.customerMessage
          : failureMessage;

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
              `${customerFailureMessage} (Offline24 ${offlineResult.reason})`,
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
            customerFailureMessage,
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
          // Kanały klienta: e-mail i powiadomienie „odrzucona”, karta FLO
          // (F-093-STATUS i F-093-440: tu tekst klienta, jak w `last_error`).
          error: customerFailureMessage,
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
