/**
 * Klasyfikacja błędów wysyłki do KSeF na kody z katalogu `ksef_error_codes`
 * (00131). Sam katalog (kody, klasy, auto-ponowienie) jest w czystym module
 * `send-error-classes.ts` (importowalnym w komponentach) i jest stąd
 * re-eksportowany; tu zostaje mapowanie wyjątków, które ciągnie klienta KSeF
 * i walidator XML.
 *
 * Klasa kodu decyduje o stanie faktury po wyczerpaniu prób i o wyjściach:
 *   - terminal   — błąd TREŚCI dokumentu (XSD, odrzucenie przez KSeF, strażnik
 *                  dokumentu): tylko powrót do szkicu i poprawa;
 *   - transient  — awaria, której zniknięcie nie wymaga zmiany dokumentu
 *                  (KSeF leży, limit, sesja, nasza baza): ponowienie,
 *                  część automatycznie (cron, PR 4);
 *   - hold       — hamulec operatora albo blokada rodzaju dokumentu:
 *                  ponowienie po zdjęciu hamulca;
 *   - reconcile  — nie wiadomo, czy KSeF ma fakturę: tylko operator;
 *   - setup      — brak/niezweryfikowany certyfikat: klient uzupełnia
 *                  ustawienia i wysyła ponownie.
 *
 * Zasada (W1 z rewizji 03.10.2026): na `terminal` mapuje się WYŁĄCZNIE błąd,
 * którego przyczyną jest treść dokumentu albo decyzja KSeF o treści. Błąd
 * po naszej stronie (PostgREST, klucz szyfrowania, sieć) nigdy nie udaje
 * odrzucenia przez KSeF.
 *
 * Klasyfikacja idzie po łańcuchu `cause` (runner opakowuje błędy w
 * `NonRetriableError`/`RetryAfterError`) i po znacznikach w treści, bo te
 * przechodzą przez każdy transport (pg-boss, logi, zdarzenia).
 */

import { KsefApiError } from '@/lib/ksef/client';
import { KsefInvoiceRejectedError } from '@/lib/ksef/submit';
import { KOR_HOLD, KSEF_PAUSED } from '@/lib/ksef/submission-holds';
import { InvoiceXmlSchemaError } from '@/lib/xml/validator';
import {
  isSendErrorCode,
  SEND_ERROR_CLASS,
  SEND_ERROR_CODES,
  type SendErrorClass,
  type SendErrorCode,
} from '@/lib/ksef/send-error-classes';

export {
  AUTO_REQUEUE_CODES,
  isAutoRequeueable,
  isContentRejection,
  isSendErrorCode,
  SEND_ERROR_CLASS,
  SEND_ERROR_CODES,
  sendErrorClassOf,
  type SendErrorClass,
  type SendErrorCode,
} from '@/lib/ksef/send-error-classes';

export interface ClassifiedSendError {
  code: SendErrorCode;
  class: SendErrorClass;
}

/**
 * Błąd, którego kod runner już rozstrzygnął (D-A4-1: werdykt po weryfikacji
 * cudzego 440). Klasyfikator bierze jego kod PRZED klasami KSeF z łańcucha
 * przyczyn — inaczej `KsefInvoiceRejectedError(440)` albo błąd HTTP pobrania
 * oryginału przesłoniłby werdykt (403 → KSEF_SESSION z automatem itd.).
 *
 * `cause` (L1a): błąd, z którego werdykt wynika (np. `KsefApiError` pobrania
 * oryginału po 440) — dziennik prób czyta z niego status HTTP. Klasyfikacji
 * nie zmienia: kod werdyktu wygrywa z całym łańcuchem (krok 0 w `codeFor`).
 */
export class KsefSendVerdictError extends Error {
  constructor(readonly code: SendErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'KsefSendVerdictError';
  }
}

export function classifySendError(error: unknown): ClassifiedSendError {
  const code = codeFor(error);
  return { code, class: SEND_ERROR_CLASS[code] };
}

/** Błąd i jego przyczyny (`cause`), od wierzchu w dół; bez pętli. */
function chain(error: unknown): Error[] {
  const out: Error[] = [];
  let current: unknown = error;
  while (current instanceof Error && out.length < 8 && !out.includes(current)) {
    out.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}

type CredentialsLike = Error & { reason?: unknown };

function credentialsCode(reason: unknown): SendErrorCode {
  switch (reason) {
    case 'missing':
      return SEND_ERROR_CODES.NO_CERTIFICATE;
    case 'not-verified':
      return SEND_ERROR_CODES.NOT_VERIFIED;
    case 'tenant-read':
      return SEND_ERROR_CODES.INFRA;
    default:
      // decrypt, nip-mismatch, nieznany powód — konfiguracja po naszej stronie.
      return SEND_ERROR_CODES.CREDENTIALS_UNAVAILABLE;
  }
}

function httpCode(error: KsefApiError): SendErrorCode {
  if (error.status === 429) return SEND_ERROR_CODES.KSEF_RATE_LIMIT;
  if (error.status === 401 || error.status === 403) return SEND_ERROR_CODES.KSEF_SESSION;
  if (error.status === 408 || error.status >= 500) return SEND_ERROR_CODES.KSEF_UNAVAILABLE;
  return SEND_ERROR_CODES.KSEF_REJECTED;
}

function codeFor(error: unknown): SendErrorCode {
  const errors = chain(error);

  // 0. Kod rozstrzygnięty przez runner (werdykt) wygrywa z całym łańcuchem.
  for (const e of errors) {
    if (e instanceof KsefSendVerdictError || e.name === 'KsefSendVerdictError') {
      const code = (e as KsefSendVerdictError).code;
      if (isSendErrorCode(code)) return code;
    }
  }

  // 1. Konkretne klasy błędów gdziekolwiek w łańcuchu przyczyn.
  for (const e of errors) {
    if (e instanceof InvoiceXmlSchemaError || e.name === 'InvoiceXmlSchemaError') {
      return SEND_ERROR_CODES.XSD_INVALID;
    }
    if (e instanceof KsefInvoiceRejectedError || e.name === 'KsefInvoiceRejectedError') {
      const rejected = e as KsefInvoiceRejectedError;
      return rejected.isDuplicate
        ? SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE
        : SEND_ERROR_CODES.KSEF_REJECTED;
    }
    if (e instanceof KsefApiError || e.name === 'KsefApiError') {
      return httpCode(e as KsefApiError);
    }
    if (e.name === 'KsefCredentialsError') {
      return credentialsCode((e as CredentialsLike).reason);
    }
    if (e.name === 'KsefNotVerifiedError') {
      return SEND_ERROR_CODES.NOT_VERIFIED;
    }
  }

  // 2. Znaczniki i komunikaty w treści (hamulce, strażniki, oczekiwanie).
  for (const e of errors) {
    const m = e.message;
    // Każdy kod z katalogu może być znacznikiem `[KOD]` na początku treści
    // (np. `[RESULT_UNCERTAIN]` z trybu „tylko uzgodnij”).
    const marker = /^\[([A-Z_]+)\]/.exec(m);
    if (marker && isSendErrorCode(marker[1])) return marker[1];
    if (m.includes(`[${SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE}]`)) return SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE;
    if (m.includes(`[${KSEF_PAUSED}]`)) return SEND_ERROR_CODES.KSEF_PAUSED;
    if (m.includes(`[${KOR_HOLD}]`)) return SEND_ERROR_CODES.KOR_HOLD;
    if (m.includes('rozliczając')) return SEND_ERROR_CODES.ROZ_HOLD_RECONCILE;
    if (/walidacji schematu|schematem XSD/.test(m)) return SEND_ERROR_CODES.XSD_INVALID;
    if (m.startsWith('KSeF odrzucił fakturę')) return SEND_ERROR_CODES.KSEF_REJECTED;
    if (m.includes('environment does not match') || m.includes('environment requires')) return SEND_ERROR_CODES.ENV_MISMATCH;
    if (m.includes('Niepoprawny payload')) return SEND_ERROR_CODES.INVALID_EVENT;
    if (m.includes('nadal przetwarza') || m.includes('Uzgadnianie wcześniejszej wysyłki')) return SEND_ERROR_CODES.RESULT_UNCERTAIN;
    if (m.includes('manual reconciliation') || m.includes('requires reconciliation')) return SEND_ERROR_CODES.INVALID_DOCUMENT;
    if (m.includes('nie ma zweryfikowanego certyfikatu') || m.includes('not verified')) return SEND_ERROR_CODES.NOT_VERIFIED;
    if (m.includes('Faktura nie przeszła walidacji')) return SEND_ERROR_CODES.INVALID_DOCUMENT;
  }

  // 3. Nieznany błąd: „bez ponawiania” to decyzja o dokumencie, reszta to awaria.
  const top = errors[0];
  if (top && top.name === 'NonRetriableError') return SEND_ERROR_CODES.INVALID_DOCUMENT;
  return SEND_ERROR_CODES.INFRA;
}
