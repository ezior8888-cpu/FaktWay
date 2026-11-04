import type { Invoice } from '@/types/invoice';
import type { CorrectionInvoiceData, AdvanceInvoiceData, FinalInvoiceData } from '@/types/invoice-types';
import type { AdvanceInvoiceSettlementRow } from '@/lib/ksef/fa3-advance-generator';
import { generateCorrectionInvoiceXml } from '@/lib/ksef/fa3-correction-generator';
import {
  generateAdvanceInvoiceXml,
  generateFinalInvoiceXml,
} from '@/lib/ksef/fa3-advance-generator';
import { generateFA3Xml, InvoiceValidationError } from '@/lib/xml/fa3-generator';
import { claimXmlGeneratedAt } from '@/lib/ksef/xml-generated-at';
import { assertSpecialInvoiceData } from '@/lib/ksef/special-invoice-data';
import { isRozSubmission, ROZ_SUBMISSION_HOLD_MESSAGE } from '@/lib/ksef/roz-submission-hold';
import { assertSpecialIssueDateToday } from '@/lib/ksef/special-issue-date';
import { InvoiceXmlSchemaError, validateInvoiceXml } from '@/lib/xml/validator';
import { invoiceXmlExistsForId, uploadInvoiceXml } from '@/lib/storage/r2';

import {
  requireKsefVerificationForBackgroundJob,
} from '@/lib/auth/ksef-verification-guard';

import type { KsefAuth } from './auth';
import {
  abandonKsefSubmissionIntent,
  recordKsefSubmissionIntent,
  recordKsefSubmissionSent,
} from './submission-log';
import { submitInvoice } from './submit';
import { requireMatchingKsefEnvironment } from './claim-environment';

/**
 * FULL FLOW: od modelu domenowego faktury do numeru KSeF.
 *
 *   1. Generuj XML FA(3) (+ walidacja biznesowa: NIP/IBAN/arytmetyka)
 *   2. Waliduj XSD lokalnie (xmllint-wasm, offline)
 *   3. Upload XML do R2 PRZED wysyłką do KSeF
 *      - sukces KSeF → mamy archive
 *      - odrzucenie KSeF → mamy historię próby (wymogi audytowe, 10 lat)
 *   4. Wyślij do KSeF (enkrypcja + sesja online + polling statusu)
 *   5. Zwróć numer KSeF + metadane do zapisania w DB
 *
 * UPO NIE jest tutaj pobierane / uploadowane - zwracamy URL do pobrania,
 * consumer (Inngest job) decyduje kiedy fetch + uploadInvoiceUpo.
 */
export interface FullSubmitResult {
  ksefNumber: string;
  xmlStoragePath: string;
  xmlSha256Hash: string;
  xmlSizeBytes: number;
  /** ISO 8601 timestamp akceptacji; `undefined` jeśli KSeF nie zwrócił go w statusie. */
  acquisitionTimestamp?: string;
  /** Numer sesji KSeF — potrzebny do pobrania UPO (KSeF 2.0 trzyma je w zasobach sesji). */
  sessionReferenceNumber?: string;
  /** Numer referencyjny faktury w sesji — do zamknięcia wpisu w `ksef_submissions`. */
  invoiceReferenceNumber?: string;
}

export async function submitInvoiceFullFlow(
  tenantId: string,
  invoiceId: string,
  invoice: Invoice,
  auth: KsefAuth,
  env?: 'test' | 'demo' | 'production',
  correctionData?: CorrectionInvoiceData | null,
  advanceData?: AdvanceInvoiceData | null,
  /** Dla ROZ — XML potrzebuje osobnego bloku rozliczenia z listą zaliczek. */
  finalPayload?:
    | { finalData: FinalInvoiceData; advanceSettlementRows: AdvanceInvoiceSettlementRow[] }
    | null,
  /**
   * `sendAttemptId` zdarzenia wysyłki — klucz XML per próba (D5). Ponowienie
   * tej samej próby trafia w ten sam klucz; nowe kolejkowanie dostaje nowy.
   * Brak (stare zdarzenia) = klucz historyczny per faktura.
   */
  sendAttemptId?: string | null,
): Promise<FullSubmitResult> {
  // Last backstop for direct callers and a ROZ that reaches this flow from an
  // older queue event. Stop before XML generation, archive upload or KSeF POST.
  if (isRozSubmission({
    invoiceType: invoice.type,
    finalData: finalPayload?.finalData,
    finalAdvanceSettlementRows: finalPayload?.advanceSettlementRows,
  })) {
    throw new InvoiceValidationError([ROZ_SUBMISSION_HOLD_MESSAGE]);
  }

  const configuredEnv = requireMatchingKsefEnvironment(env);
  await requireKsefVerificationForBackgroundJob(tenantId);

  // 0. Korekta/zaliczka/rozliczenie bez swoich danych zbudowałyby się jako
  //    zwykła faktura z RodzajFaktury=KOR/ZAL/ROZ — XSD to przepuszcza.
  assertSpecialInvoiceData(invoice.type, { correctionData, advanceData, finalPayload });

  // 1. Generuj XML (faktura VAT albo faktura korygująca FA(3)).
  //    `DataWytworzeniaFa` z pierwszej próby — ponowienie buduje ten sam plik
  //    (AUD-46), więc archiwum i skrót odpowiadają temu, co ma KSeF.
  const generatedAt = await claimXmlGeneratedAt(tenantId, invoiceId);
  const xml =
    correctionData != null
      ? generateCorrectionInvoiceXml(correctionData, { generatedAt })
      : advanceData != null
        ? generateAdvanceInvoiceXml(advanceData, { generatedAt })
      : finalPayload != null && finalPayload.advanceSettlementRows.length > 0
        ? generateFinalInvoiceXml(finalPayload.finalData, finalPayload.advanceSettlementRows, { generatedAt })
        : generateFA3Xml(invoice, { generatedAt });

  // 2. Waliduj XSD - jeśli XML się nie zgadza ze schematem FA(3), KSeF i tak
  //    by go odrzucił. Robimy to lokalnie żeby nie palić sesji KSeF
  //    (limit otwartych sesji per podmiot + czas dostępu do API).
  const validation = await validateInvoiceXml(xml);
  if (!validation.valid) {
    throw new InvoiceXmlSchemaError(
      validation.errors.map((e) => `Linia ${e.line}: ${e.message}`),
    );
  }

  // 3. Upload do R2 PRZED wysyłką do KSeF.
  //    - sukces KSeF → mamy archive z SHA-256 integrity check
  //    - odrzucenie KSeF → też mamy historię próby (audit / retry)
  //
  //    Idempotency dwuwarstwowa, oparta o deterministyczny generator FA(3):
  //      a) HEAD przed PUT — przy retry wykrywamy istnienie obiektu i wyłączamy
  //         `IfNoneMatch: '*'`, żeby drugi PUT nie wracał `PreconditionFailed`
  //         w środku flow (a wtedy `submit-to-ksef` retryowałby w nieskończoność).
  //      b) `IfNoneMatch: '*'` na pierwszym wgraniu — gwarantuje, że dwa
  //         równoczesne calle z różnych instancji nie nadpiszą się nawzajem.
  //      c) Obsługa `PreconditionFailed` w `r2.uploadXmlDocument` — gdyby a) i b)
  //         zawiodły jednocześnie (np. klient_już-uploadował, my retryujemy
  //         z `immutable=true`), traktujemy to jako sukces idempotentny.
  const attemptId = sendAttemptId ?? null;
  // Data w `P_1` dokumentu specjalnego (z jego danych, jak generator); zwykła faktura — bez sprawdzenia (B1/B2).
  const specialIssueDate = correctionData?.issueDate ?? advanceData?.issueDate ?? finalPayload?.finalData.issueDate;
  const alreadyUploaded = await invoiceXmlExistsForId(
    tenantId,
    invoiceId,
    invoice.issueDate,
    attemptId,
  );

  const uploadResult = await uploadInvoiceXml(
    tenantId,
    invoiceId,
    invoice.issueDate,
    xml,
    { immutable: !alreadyUploaded, attemptId },
  );

  // 4. Wysyłka do KSeF (rate-limited, z enkrypcją i auto-close sesji).
  //    `auditContext` propaguje się do każdego `ksefFetch` w środku — dzięki
  //    temu każdy request do MF wpisuje się do `audit_logs` (Faza 23 sekcja 3).
  //    Numery referencyjne zapisujemy zaraz po przyjęciu pliku — od tej chwili
  //    ponowienie uzgadnia status zamiast wysyłać fakturę drugi raz (AUD-01).
  //    Wcześniej, przed samym plikiem, zamiar z numerem sesji (A2): gdy
  //    odpowiedź na wysyłkę zginie, ponowienie zapyta KSeF o tę sesję.
  const submitResult = await submitInvoice(
    xml,
    auth,
    configuredEnv,
    { tenantId, invoiceId },
    {
      onSessionOpened: async ({ sessionReferenceNumber }) => {
        // 00147: dokument specjalny tylko w dniu wystawienia — drugie sprawdzenie
        // tuż przed plikiem i przed zamiarem (uwierzytelnienie i sesja trwają
        // do kilkudziesięciu sekund). Błąd = bez wysyłki, sesja zamykana.
        if (specialIssueDate !== undefined) assertSpecialIssueDateToday(specialIssueDate);
        await recordKsefSubmissionIntent({
          tenantId,
          invoiceId,
          sessionReferenceNumber,
          payloadHash: uploadResult.sha256Hash,
          xmlStoragePath: uploadResult.storagePath,
        });
      },
      onInvoiceNotAccepted: ({ sessionReferenceNumber }, error) =>
        abandonKsefSubmissionIntent({
          tenantId,
          invoiceId,
          sessionReferenceNumber,
          errorCode: String(error.status),
          errorMessage: `KSeF nie przyjął pliku: ${error.message}`,
        }),
      onInvoiceSent: (references) =>
        recordKsefSubmissionSent({
          tenantId,
          invoiceId,
          references,
          payloadHash: uploadResult.sha256Hash,
          // D5: wpis `sent` zna plik, który poszedł do KSeF — uzgodnienie po
          // referencji wskazuje ten plik, nie klucz wyliczony od nowa.
          xmlStoragePath: uploadResult.storagePath,
        }),
    },
  );

  return {
    ksefNumber: submitResult.ksefNumber,
    xmlStoragePath: uploadResult.storagePath,
    xmlSha256Hash: uploadResult.sha256Hash,
    xmlSizeBytes: uploadResult.sizeBytes,
    acquisitionTimestamp: submitResult.acquisitionTimestamp,
    sessionReferenceNumber: submitResult.sessionReferenceNumber,
    invoiceReferenceNumber: submitResult.invoiceReferenceNumber,
  };
}
