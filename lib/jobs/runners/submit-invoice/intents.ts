/**
 * A2: uzgodnienie zamiarów wysyłki bez numeru referencyjnego faktury.
 * Wydzielone z `../submit-invoice.ts` bez zmiany logiki (plan usprawnień 3.7a).
 */
import * as Sentry from '@sentry/nextjs';
import { RetryAfterError } from '../../errors';
import { getTenantKsefCredentials } from '@/lib/supabase/admin-queries';
import { KsefApiError } from '@/lib/ksef/client';
import {
  KSEF_SESSION_NOT_FOUND,
  ksefErrorCodes,
  listSessionInvoicesAfterClose,
  type SessionInvoiceSummary,
} from '@/lib/ksef/submit';
import { ksefSessionCache } from '@/lib/ksef/session-cache';
import {
  abandonKsefSubmissionIntent,
  findOpenKsefSubmissionIntents,
  promoteKsefSubmissionIntent,
  type KsefSubmissionIntent,
} from '@/lib/ksef/submission-log';
import { getKsefRetryDelay } from '../../retry-schedule';
import { isStaleSubmission, KSEF_INTENT_NOT_IN_SESSION_CODE, KSEF_SUBMISSION_STALE_CODE, type SubmitRunContext } from './shared';

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

/** Krok `resolve-submission-intents` (A2); opis przy wywołaniu w `../submit-invoice.ts`. */
export async function resolveSubmissionIntents(ctx: SubmitRunContext): Promise<void> {
  const { tenantId, invoiceId, invoice, env, attempt, logger } = ctx;
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
}
