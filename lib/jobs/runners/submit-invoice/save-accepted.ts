/**
 * Krok 4: zapis akceptacji faktury i historii wysyłki.
 * Wydzielony z `../submit-invoice.ts` bez zmiany logiki (plan usprawnień 3.7a).
 */
import * as Sentry from '@sentry/nextjs';
import { updateInvoiceStatus } from '@/lib/supabase/admin-queries';
import { closeKsefAttempt, markKsefSubmission, promoteKsefSubmissionIntent } from '@/lib/ksef/submission-log';
import { recordXmlDocument } from '@/lib/storage/xml-documents';
import type { SubmitOutcome, SubmitRunContext } from './shared';

/** Krok `save-ksef-number` (krok 4): zapis akceptacji i dopiski fail-soft. */
export async function saveAcceptedInvoice(ctx: SubmitRunContext, result: SubmitOutcome): Promise<void> {
  const { tenantId, invoiceId, env, logger } = ctx;
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
  // brak wiersza widać w Sentry. Bez wiersza PDF nie ma KODU I, a mail do
  // nabywcy odmawia: ścieżka operatora w runbooku ksef-error-codes.md.
  try {
    if (result.xmlSha256Hash) {
      await recordXmlDocument({
        tenantId,
        invoiceId,
        storagePath: result.xmlStoragePath,
        sha256Hash: result.xmlSha256Hash,
        sizeBytes: result.xmlSizeBytes,
        // Świeża wysyłka zapisała te bajty i wysłała je w tym przebiegu; pozostałe
        // drogi znają plik tylko z historii, więc porównują go z magazynem.
        verifyStoredBytes: result.via !== 'submit',
      });
    } else {
      // C-12: wpis `sent` bez skrótu (historia sprzed 01.10.2026). Skrót policzony
      // z obecnego pliku nie dowodzi, że to ten plik poszedł do KSeF.
      Sentry.captureMessage('KSeF: faktura przyjęta, a wpis wysyłki jest bez skrótu XML, bez wiersza xml_documents', {
        level: 'warning',
        tags: { area: 'ksef.xml-documents', kind: 'no-payload-hash' },
        extra: { tenantId, invoiceId, via: result.via },
      });
    }
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
}
