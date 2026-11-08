/**
 * D-A4-1: werdykt dla odpowiedzi 440 „duplikat”.
 * Wydzielony z `../submit-invoice.ts` bez zmiany logiki (plan usprawnień 3.7a).
 */
import { createHash } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { NonRetriableError, RetryAfterError } from '../../errors';
import { getTenantKsefCredentials } from '@/lib/supabase/admin-queries';
import { KsefApiError } from '@/lib/ksef/client';
import {
  checkInvoiceStatusByReference,
  downloadKsefInvoice,
  fetchKsefAcquisitionDate,
  KSEF_INVOICE_NOT_FOUND,
  KSEF_INVOICE_NOT_YET_AVAILABLE,
  type KsefInvoiceRejectedError,
  ksefErrorCodes,
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
import {
  archiveImportedKsefXml,
  decodeKsefXml,
  KsefXmlArchiveConflictError,
} from '@/lib/import/ksef-xml-archive';
import { ksefSessionCache } from '@/lib/ksef/session-cache';
import {
  findKsefSessionRow,
  findSubmissionPayloads,
  findTenantInvoiceByKsefNumber,
  markKsefAttemptDuplicatePending,
  markKsefSubmissionsNumberTaken,
  recordKsefAcceptedSession,
  recordKsefDuplicateCheck,
} from '@/lib/ksef/submission-log';
import { downloadInvoiceXml, invoiceXmlKey, invoiceXmlKeyFor, uploadInvoiceXml } from '@/lib/storage/r2';
import { KsefSendVerdictError, SEND_ERROR_CODES, type SendErrorCode } from '@/lib/ksef/send-error-codes';
import { getKsefRetryDelay, ksefRetryDelayFor } from '../../retry-schedule';
import type { SubmitOutcome, SubmitRunContext } from './shared';

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
export async function resolveDuplicate(ctx: SubmitRunContext, error: KsefInvoiceRejectedError): Promise<SubmitOutcome> {
  const { parsed, tenantId, invoiceId, invoice, nip, env, attempt, logger } = ctx;
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
}
