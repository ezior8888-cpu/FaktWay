import { describe, expect, it } from 'vitest';

import { NonRetriableError, RetryAfterError } from '@/lib/jobs/errors';
import { KsefApiError } from '@/lib/ksef/client';
import { KsefInvoiceRejectedError, KSEF_DUPLICATE_INVOICE, ksefErrorCodes } from '@/lib/ksef/submit';
import {
  AUTO_REQUEUE_CODES,
  classifySendError,
  SEND_ERROR_CLASS,
  SEND_ERROR_CODES,
} from '@/lib/ksef/send-error-codes';
import { KsefCredentialsError } from '@/lib/supabase/admin-queries';
import { KsefNotVerifiedError } from '@/lib/auth/ksef-verification-guard';
import { KSEF_PAUSED, KOR_HOLD, heldErrorMessage } from '@/lib/ksef/submission-holds';
import { ROZ_SUBMISSION_HOLD_MESSAGE } from '@/lib/ksef/roz-submission-hold';
import { InvoiceXmlSchemaError } from '@/lib/xml/validator';

/**
 * Cykl życia faktury, PR 2 (W1, W3, S1 z rewizji 03.10.2026): każdy błąd
 * wysyłki dostaje kod z katalogu `ksef_error_codes` (00131). Klasa kodu
 * decyduje o stanie faktury i o wyjściach: tylko błąd TREŚCI (terminal)
 * kończy jako `rejected`; błąd infrastruktury, sesji, limitu, hamulca albo
 * niepewny wynik nigdy nie udaje odrzucenia przez KSeF.
 */

const status = (code: number) => ({ code, description: 'Opis', details: ['x'] }) as never;

describe('ksefErrorCodes', () => {
  it('D-A4-1: kody z JSON-u w tekście (odpowiedź z błędnym nagłówkiem; problem+json parsuje już ksefFetch)', () => {
    expect(ksefErrorCodes(JSON.stringify({ errors: [{ code: 21165 }] }))).toEqual([21165]);
    expect(ksefErrorCodes(JSON.stringify({ exception: { exceptionDetailList: [{ exceptionCode: 21164 }] } }))).toEqual([21164]);
    expect(ksefErrorCodes('Bad gateway')).toEqual([]);
  });
});

describe('katalog kodów błędu wysyłki', () => {
  it('każdy kod ma klasę z zamkniętej listy, a auto-ponowienie dotyczy tylko klasy transient', () => {
    const classes = new Set(['terminal', 'transient', 'hold', 'reconcile', 'setup']);
    for (const code of Object.values(SEND_ERROR_CODES)) {
      expect(classes.has(SEND_ERROR_CLASS[code]), code).toBe(true);
    }
    for (const code of AUTO_REQUEUE_CODES) {
      expect(SEND_ERROR_CLASS[code]).toBe('transient');
    }
    expect(AUTO_REQUEUE_CODES).toEqual(expect.arrayContaining(['KSEF_UNAVAILABLE', 'KSEF_RATE_LIMIT', 'KSEF_SESSION', 'INFRA']));
    expect(AUTO_REQUEUE_CODES).not.toContain('CREDENTIALS_UNAVAILABLE');
    // A2b: KSeF nie ma faktury — klient decyduje (B2: data wystawienia), automat nie wysyła.
    expect(SEND_ERROR_CLASS['NOT_IN_KSEF' as keyof typeof SEND_ERROR_CLASS]).toBe('transient');
    expect(AUTO_REQUEUE_CODES).not.toContain('NOT_IN_KSEF');
  });

  it.each([
    ['XSD lokalnie', new InvoiceXmlSchemaError(['P_7 za długie']), 'XSD_INVALID'],
    ['XSD opakowane w NonRetriable (jak w runnerze)', new NonRetriableError('Faktura nie przeszła walidacji schematu FA(3): P_7', { cause: new InvoiceXmlSchemaError(['P_7']) }), 'XSD_INVALID'],
    ['odrzucenie w statusie 450', new KsefInvoiceRejectedError(450, status(450)), 'KSEF_REJECTED'],
    ['duplikat 440 cudzy (znacznik)', new NonRetriableError('[KSEF_DUPLICATE_RECONCILE] KSeF ma już fakturę o tym numerze'), 'KSEF_DUPLICATE_RECONCILE'],
    ['duplikat 440 bez znacznika', new KsefInvoiceRejectedError(KSEF_DUPLICATE_INVOICE, status(440)), 'KSEF_DUPLICATE_RECONCILE'],
    ['HTTP 400', new KsefApiError(400, 'x', 'Bad request'), 'KSEF_REJECTED'],
    ['HTTP 401', new KsefApiError(401, 'x', 'Unauthorized'), 'KSEF_SESSION'],
    ['HTTP 403', new KsefApiError(403, 'x', 'Forbidden'), 'KSEF_SESSION'],
    ['HTTP 408', new KsefApiError(408, 'x', 'Timeout'), 'KSEF_UNAVAILABLE'],
    ['HTTP 429', new KsefApiError(429, 'x', 'Too many', 30_000), 'KSEF_RATE_LIMIT'],
    ['HTTP 503', new KsefApiError(503, 'x', 'Unavailable'), 'KSEF_UNAVAILABLE'],
    ['RetryAfterError z przyczyną 503 (po wyczerpaniu ponowień)', new RetryAfterError('KSeF HTTP 503', '2m', { cause: new KsefApiError(503, 'x', 'x') }), 'KSEF_UNAVAILABLE'],
    ['hamulec operatora', new NonRetriableError(heldErrorMessage(KSEF_PAUSED)), 'KSEF_PAUSED'],
    ['blokada korekt', new NonRetriableError(heldErrorMessage(KOR_HOLD)), 'KOR_HOLD'],
    ['blokada ROZ', new NonRetriableError(ROZ_SUBMISSION_HOLD_MESSAGE), 'ROZ_HOLD_RECONCILE'],
    ['brak certyfikatu', new KsefCredentialsError('missing', 'brak'), 'NO_CERTIFICATE'],
    ['NIP niezweryfikowany (credentials)', new KsefCredentialsError('not-verified', 'x'), 'NOT_VERIFIED'],
    ['NIP niezweryfikowany (strażnik)', new KsefNotVerifiedError(), 'NOT_VERIFIED'],
    ['brak klucza po rotacji', new KsefCredentialsError('decrypt', 'brak klucza'), 'CREDENTIALS_UNAVAILABLE'],
    ['NIP z szyfrogramu ≠ NIP firmy', new KsefCredentialsError('nip-mismatch', 'x'), 'CREDENTIALS_UNAVAILABLE'],
    ['błąd odczytu firmy (PostgREST)', new KsefCredentialsError('tenant-read', 'TypeError: fetch failed'), 'INFRA'],
    ['opakowany błąd odczytu firmy', new Error('Nie można użyć credentials KSeF', { cause: new KsefCredentialsError('tenant-read', 'x') }), 'INFRA'],
    ['niezgodne środowisko zdarzenia', new NonRetriableError('KSeF submit event environment does not match configured environment'), 'ENV_MISMATCH'],
    ['zły payload zdarzenia', new NonRetriableError('Niepoprawny payload eventu invoice/submit.requested: nip'), 'INVALID_EVENT'],
    ['strażnik treści dokumentu', new NonRetriableError('KSeF document kind or source requires manual reconciliation'), 'INVALID_DOCUMENT'],
    ['KSeF nadal przetwarza (po wyczerpaniu)', new RetryAfterError('KSeF nadal przetwarza wcześniejszą wysyłkę tej faktury — czekam zamiast wysyłać ponownie', '5m'), 'RESULT_UNCERTAIN'],
    ['uzgadnianie nieudane', new RetryAfterError('Uzgadnianie wcześniejszej wysyłki KSeF nieudane: ECONNRESET', '5m'), 'RESULT_UNCERTAIN'],
    ['znacznik [RESULT_UNCERTAIN] (tryb „tylko uzgodnij”)', new NonRetriableError('[RESULT_UNCERTAIN] Tryb „tylko uzgodnij”: brak wpisu sent'), 'RESULT_UNCERTAIN'],
    ['znacznik spoza katalogu nie jest kodem', new NonRetriableError('[COS_INNEGO] tekst'), 'INVALID_DOCUMENT'],
    ['nieznany zwykły błąd', new Error('ECONNRESET'), 'INFRA'],
    ['nieznany NonRetriable', new NonRetriableError('coś nowego'), 'INVALID_DOCUMENT'],
  ])('%s → %s', (_label, error, code) => {
    expect(classifySendError(error).code).toBe(code);
  });

  it('klasa wynika z kodu: odrzucenie treści to terminal, 503 to transient, hamulec to hold', () => {
    expect(classifySendError(new KsefInvoiceRejectedError(450, status(450))).class).toBe('terminal');
    expect(classifySendError(new KsefApiError(503, 'x', 'x')).class).toBe('transient');
    expect(classifySendError(new NonRetriableError(heldErrorMessage(KSEF_PAUSED))).class).toBe('hold');
    expect(classifySendError(new NonRetriableError('[KSEF_DUPLICATE_RECONCILE] x')).class).toBe('reconcile');
    expect(classifySendError(new KsefCredentialsError('missing', 'x')).class).toBe('setup');
  });
});
