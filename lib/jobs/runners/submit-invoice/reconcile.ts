/**
 * AUD-01, A2b: uzgodnienie wcześniejszej wysyłki po numerze referencyjnym.
 * Wydzielone z `../submit-invoice.ts` bez zmiany logiki (plan usprawnień 3.7a).
 */
import * as Sentry from '@sentry/nextjs';
import { NonRetriableError, RetryAfterError } from '../../errors';
import { getTenantKsefCredentials } from '@/lib/supabase/admin-queries';
import { createAdminClient } from '@/lib/supabase/server';
import { KsefApiError } from '@/lib/ksef/client';
import {
  checkInvoiceStatusByReference,
  KSEF_DUPLICATE_INVOICE,
  KsefInvoiceRejectedError,
} from '@/lib/ksef/submit';
import { hexHashToBase64 } from '@/lib/ksef/duplicate-verdict';
import { ksefSessionCache } from '@/lib/ksef/session-cache';
import { findOpenKsefSubmission, markKsefSubmission } from '@/lib/ksef/submission-log';
import { invoiceXmlKey } from '@/lib/storage/r2';
import { SEND_ERROR_CODES } from '@/lib/ksef/send-error-codes';
import { KSEF_SEND_MESSAGES } from '@/lib/invoices/ksef-send-policy';
import { getKsefRetryDelay } from '../../retry-schedule';
import { resolveDuplicate } from './duplicate';
import { isStaleSubmission, KSEF_SUBMISSION_STALE_CODE, type SubmitOutcome, type SubmitRunContext } from './shared';

// A2b: „tylko uzgodnij” bez otwartej wysyłki. Bez dowodu kontaktu z KSeF
// (00131/00136: numer KSeF albo wpis intent/sent/accepted/duplicate)
// KSeF nie ma tej faktury od nas — NOT_IN_KSEF z wyjściem dla klienta
// (wyślij ponownie / wróć do szkicu). Z dowodem — RESULT_UNCERTAIN dla
// operatora. Błąd odczytu dowodu = ponowienie, nie zgadywanie.
async function reconcileOnlyWithoutOpenSubmission(ctx: SubmitRunContext, uncertainMessage: string): Promise<Error> {
  const { tenantId, invoiceId, attempt, logger } = ctx;
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
}

/** Krok `reconcile-previous-submission` (AUD-01); opis przy wywołaniu w `../submit-invoice.ts`. */
export async function reconcilePreviousSubmission(ctx: SubmitRunContext): Promise<SubmitOutcome | null> {
  const { parsed, tenantId, invoiceId, invoice, env, attempt, logger } = ctx;
  const previous = await findOpenKsefSubmission(tenantId, invoiceId);
  if (!previous) {
    // Tryb „tylko uzgodnij” nie wysyła od nowa — bez wpisu `sent` nie ma czego uzgadniać.
    if (parsed.data.reconcileOnly) {
      throw await reconcileOnlyWithoutOpenSubmission(
        ctx,
        'Tryb „tylko uzgodnij”: brak otwartej wysyłki (wpisu sent) do uzgodnienia — faktura nie została wysłana ponownie.',
      );
    }
    return null;
  }
  // D-A4-1: KSeF odpowiedział już na tę próbę 440 — weryfikacja treści od
  // razu (stara sesja nie jest potrzebna; po 48 h KSeF może jej nie znać).
  if (previous.originalKsefNumber) {
    return await resolveDuplicate(ctx, new KsefInvoiceRejectedError(KSEF_DUPLICATE_INVOICE, {
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
      xmlSha256Hash: previous.payloadHash ?? undefined,
      sessionReferenceNumber: previous.sessionReferenceNumber,
      invoiceReferenceNumber: previous.invoiceReferenceNumber,
      via: 'reference-reconcile',
    };
  } catch (error) {
    if (error instanceof RetryAfterError) throw error;
    // D-A4-1: 440 przy uzgadnianiu (np. po timeoucie pollingu) — ta sama weryfikacja, bez wysyłki.
    if (error instanceof KsefInvoiceRejectedError && error.isDuplicate) {
      return await resolveDuplicate(ctx, error);
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
          ctx,
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
}
