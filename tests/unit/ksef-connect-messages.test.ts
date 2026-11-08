import { describe, expect, it } from 'vitest';

import { KsefAuthRejectedError } from '@/lib/ksef/auth-errors';
import { KsefApiError } from '@/lib/ksef/client';
import { classifyKsefAuthFailure, describeFailureForLog, ksefFailureMessage } from '@/lib/ksef/connect-messages';
import { SUPPORT_EMAIL } from '@/lib/site';
import { CERTIFICATE_HEADER } from '../helpers/self-signed-cert';

/**
 * Recenzja #361, pkt 3: wyjątek spoza KSeF (nasz błąd, nie odpowiedź KSeF) nie może
 * obwiniać certyfikatu ani znikać bez śladu. Powód `internal_error` mówi klientowi, że to nie
 * wina plików, a log dostaje etap, klasę błędu i kod, nigdy treść wyjątku.
 */

const context = { nip: '1234567890', env: 'test' } as const;

describe('classifyKsefAuthFailure: odpowiedź KSeF kontra nasz błąd', () => {
  it.each([
    ['415', new KsefAuthRejectedError(415, 'Brak uprawnień', []), 'no_permission'],
    ['425', new KsefAuthRejectedError(425, 'Unieważniony', []), 'revoked'],
    ['460, certyfikat odwołany', new KsefAuthRejectedError(460, 'Błąd certyfikatu', ['Certyfikat odwołany']), 'revoked'],
    ['460, niezaufany łańcuch', new KsefAuthRejectedError(460, 'Błąd certyfikatu', ['Niezaufany łańcuch certyfikatów']), 'untrusted_issuer'],
    ['460, inny powód', new KsefAuthRejectedError(460, 'Błąd certyfikatu', []), 'invalid_certificate'],
    ['470', new KsefAuthRejectedError(470, 'Zablokowane', []), 'blocked'],
    ['500 w statusie uwierzytelnienia', new KsefAuthRejectedError(500, 'Błąd', []), 'unavailable'],
    ['nieznany kod odmowy (400)', new KsefAuthRejectedError(400, 'Nieznany', []), 'rejected'],
    ['HTTP 503', new KsefApiError(503, 'x', 'KSeF API POST /auth failed: 503'), 'unavailable'],
    ['HTTP 429', new KsefApiError(429, 'x', 'KSeF API 429'), 'unavailable'],
    ['HTTP 408 (nasz timeout żądania)', new KsefApiError(408, 'x', 'KSeF API timed out'), 'unavailable'],
    ['HTTP 400', new KsefApiError(400, 'x', 'KSeF API POST /auth failed: 400'), 'rejected'],
    ['HTTP 401', new KsefApiError(401, 'x', 'KSeF API POST /auth failed: 401'), 'rejected'],
    ['fetch failed', new TypeError('fetch failed'), 'unavailable'],
    ['ECONNRESET', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 'unavailable'],
    ['polling bez końca', new Error('KSeF auth polling timed out after 20 attempts'), 'unavailable'],
  ])('odpowiedź KSeF albo sieć (%s) zostaje przy swoim powodzie', (_name, error, reason) => {
    expect(classifyKsefAuthFailure(error)).toBe(reason);
  });

  it.each([
    ['nieobsługiwany rodzaj klucza do podpisu', new Error('Nieobsługiwany rodzaj klucza do podpisu KSeF (dozwolone: RSA 2048 i EC P-256)')],
    ['błąd biblioteki podpisu', new Error('xadesjs: nie udało się wygenerować elementu podpisu')],
    ['błąd w naszym kodzie', new TypeError("Cannot read properties of undefined (reading 'token')")],
    ['wyjątek bez klasy Error', 'coś poszło nie tak'],
    ['brak wyjątku', undefined],
    ['obiekt', { reason: 'x' }],
  ])('wyjątek spoza KSeF (%s) to internal_error, a nie "KSeF nie potwierdził certyfikatu"', (_name, error) => {
    expect(classifyKsefAuthFailure(error)).toBe('internal_error');
  });
});

describe('ksefFailureMessage: internal_error', () => {
  const message = ksefFailureMessage('internal_error', context);

  it('mówi, że to nie wina plików, że niczego nie zapisano i że można spróbować za chwilę', () => {
    expect(message).toMatch(/nie wina Twoich plików/);
    expect(message).toMatch(/Niczego nie zapisaliśmy/);
    expect(message).toMatch(/Spróbuj ponownie za chwilę/);
  });

  it('nie obwinia certyfikatu, nie podaje adresu pomocy (jeszcze nie istnieje) i nie ma długich myślników', () => {
    expect(message).not.toMatch(/nie potwierdził/);
    expect(message).not.toContain(SUPPORT_EMAIL);
    expect(message).not.toContain('@');
    expect(message).not.toMatch(/[—–]/);
  });
});

describe('describeFailureForLog: etap loguje się bez treści wyjątku', () => {
  const SECRET = 'SEKRET-hasło-Haslo-testowe-15-znakow';

  it('zwykły błąd: klasa i kod, bez komunikatu', () => {
    const log = describeFailureForLog(new TypeError(`Cannot read ${SECRET}`));
    expect(log).toEqual({ errorClass: 'TypeError', code: null });
    expect(JSON.stringify(log)).not.toContain(SECRET);
  });

  it('kod systemowy, kod HTTP i kod z przyczyny (fetch failed)', () => {
    expect(describeFailureForLog(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toEqual({ errorClass: 'Error', code: 'ECONNRESET' });
    expect(describeFailureForLog(new KsefApiError(503, { secret: SECRET } as never, 'KSeF API POST /auth failed: 503'))).toEqual({
      errorClass: 'KsefApiError',
      code: 503,
    });
    const fetchFailed = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) });
    expect(describeFailureForLog(fetchFailed)).toEqual({ errorClass: 'TypeError', code: 'ENOTFOUND' });
  });

  it('błąd z bazy (zwykły obiekt z PostgREST): nazwa i kod, bez message, details i hint', () => {
    const log = describeFailureForLog({ code: 'PGRST202', message: SECRET, details: SECRET, hint: SECRET });
    expect(log).toEqual({ errorClass: 'object', code: 'PGRST202' });
  });

  it('wartości, które nie są wyjątkiem, i podejrzane kody nie przechodzą do logu', () => {
    expect(describeFailureForLog(SECRET)).toEqual({ errorClass: 'string', code: null });
    expect(describeFailureForLog(undefined)).toEqual({ errorClass: 'undefined', code: null });
    expect(describeFailureForLog({ code: `kod ${SECRET} ze spacjami`, name: `Klasa ${SECRET}` })).toEqual({ errorClass: 'object', code: null });
  });

  it('odmowa KSeF: kod, opis i szczegóły z odpowiedzi KSeF', () => {
    const log = describeFailureForLog(
      new KsefAuthRejectedError(460, 'Uwierzytelnianie zakończone niepowodzeniem z powodu błędu certyfikatu', ['Certyfikat odwołany']),
    );
    expect(log).toEqual({
      errorClass: 'KsefAuthRejectedError',
      code: 460,
      description: 'Uwierzytelnianie zakończone niepowodzeniem z powodu błędu certyfikatu',
      details: ['Certyfikat odwołany'],
    });
  });

  it('opis odmowy jest skrócony, a długie ciągi i bloki PEM nie przechodzą do logu', () => {
    const body = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA'.repeat(8);
    const pem = `${CERTIFICATE_HEADER}\n${body}\n-----END CERTIFICATE-----`;
    const log = describeFailureForLog(
      new KsefAuthRejectedError(400, `Błąd ${pem} koniec ${'a'.repeat(500)}`, [body, 'szczegół 1', 'szczegół 2', 'szczegół 3', 'szczegół 4', 'szczegół 5', 'szczegół 6']),
    );
    const text = JSON.stringify(log);
    expect(text).not.toContain('MIIBIjANBgkq');
    expect(text).not.toContain('BEGIN');
    expect(text).not.toContain('a'.repeat(64));
    expect(log.description!.length).toBeLessThanOrEqual(200);
    expect(log.details).toHaveLength(5);
    expect(log.details!.every((detail) => detail.length <= 200)).toBe(true);
  });

  it('opis i szczegóły spoza tekstu nie wywracają logowania', () => {
    const odd = new KsefAuthRejectedError(400, undefined as never, null as never);
    expect(describeFailureForLog(odd)).toEqual({ errorClass: 'KsefAuthRejectedError', code: 400, description: '', details: [] });
  });
});
