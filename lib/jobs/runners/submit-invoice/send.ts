/**
 * Krok 3: wysyłka faktury do KSeF i mapowanie błędów na ponowienia.
 * Wydzielona z `../submit-invoice.ts` bez zmiany logiki (plan usprawnień 3.7a).
 */
import * as Sentry from '@sentry/nextjs';
import { NonRetriableError, RetryAfterError } from '../../errors';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { IssueDatePassedError, issueDatePassedMessage } from '@/lib/ksef/special-issue-date';
import type { JobContext } from '@/lib/jobs/registry';
import { submitInvoiceFullFlow } from '@/lib/ksef/submit-invoice-full';
import { assertSubmitReferences } from '@/lib/ksef/submit-reference-boundary';
import { KsefNotVerifiedError } from '@/lib/auth/ksef-verification-guard';
import { getTenantKsefCredentials } from '@/lib/supabase/admin-queries';
import { createAdminClient } from '@/lib/supabase/server';
import { KsefApiError } from '@/lib/ksef/client';
import { KsefInvoiceRejectedError } from '@/lib/ksef/submit';
import { ksefSessionCache } from '@/lib/ksef/session-cache';
import { findOpenKsefSubmission, markKsefSubmission } from '@/lib/ksef/submission-log';
import { XmlArchiveConflictError } from '@/lib/storage/xml-archive-conflict';
import { InvoiceXmlSchemaError } from '@/lib/xml/validator';
import { ROZ_SUBMISSION_HOLD_MESSAGE } from '@/lib/ksef/roz-submission-hold';
import { InvoiceValidationError } from '@/lib/xml/fa3-generator';
import { KsefSendVerdictError, SEND_ERROR_CODES } from '@/lib/ksef/send-error-codes';
import { KSEF_SEND_MESSAGES } from '@/lib/invoices/ksef-send-policy';
import { getKsefRetryDelay, ksefRetryDelayMsFor, KSEF_MAX_RETRIES } from '../../retry-schedule';
import { resolveDuplicate } from './duplicate';
import {
  assertSubmissionNotHeld,
  currentSubmissionState,
  isHeldRozSubmission,
  type SubmitOutcome,
  type SubmitRunContext,
} from './shared';
import { isKsefRateLimit, rateLimitPause } from './rate-limit';

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

/** Krok `submit-to-ksef`; opis przy wywołaniu w `../submit-invoice.ts`. */
export async function submitToKsef(ctx: SubmitRunContext): Promise<SubmitOutcome> {
  const { parsed, tenantId, invoiceId, invoice, env, attempt, logger } = ctx;
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
    // C-12: pod kluczem tej próby leży inny plik, a do KSeF nic jeszcze nie
    // poszło (zapis jest przed sesją, a próba z kontaktem idzie uzgodnieniem).
    // Ponowienie dałoby ten sam konflikt; nowe kolejkowanie (cron I6 albo
    // „Wyślij ponownie”) dostaje nowy `sendAttemptId`, więc i nowy klucz.
    if (error instanceof XmlArchiveConflictError) {
      Sentry.captureMessage('KSeF: pod kluczem próby jest inny plik XML, bez nadpisania, nowa próba', {
        level: 'warning',
        tags: { job: 'submit-invoice', kind: 'xml-archive-conflict' },
        extra: { tenantId, invoiceId, storagePath: error.storagePath },
      });
      const code = SEND_ERROR_CODES.INFRA;
      throw new NonRetriableError(`[${code}] ${KSEF_SEND_MESSAGES.xmlArchiveConflict}`, {
        cause: new KsefSendVerdictError(code, KSEF_SEND_MESSAGES.xmlArchiveConflict),
      });
    }
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
    // L1a: 429 (odpowiedź MF albo lokalna pauza firmy) — pauza firmy na
    // pełny `Retry-After`, bez zużycia próby, z przejęciem zwolnionym.
    // Bezpieczne przy ponowieniu: plik, który zdążył dotrzeć do KSeF, ma
    // zamiar albo wpis `sent` (A2), więc po pauzie idzie uzgodnienie, nie
    // druga wysyłka; po przyjęciu pliku czeka tylko odpytywanie.
    if (isKsefRateLimit(error)) {
      throw await rateLimitPause(ctx, error, credentials.nip, 'Pauza firmy po 429 z KSeF: wysyłka po jej końcu');
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
      return await resolveDuplicate(ctx, error);
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
    // Retry-owalne — 5xx, timeout, ECONNRESET (429 obsłużony wyżej jako
    // pauza firmy). `RetryAfterError` z naszym harmonogramem:
    // 30s → 2min → 5min → 15min → 1h (Faza 23 sekcja 2).
    //
    // Odpowiedź z `Retry-After` (np. 503) — jeśli MF mówi nam konkretnie,
    // ile czekać, słuchamy (AUD-92), najwyżej godzinę (faktura jest w
    // `sending`). Inaczej harmonogram z rozrzutem (L1a).
    const customDelay = ksefRetryDelayMsFor(error, attempt, invoiceId);
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
}
