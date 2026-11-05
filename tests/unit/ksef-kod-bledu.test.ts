import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * F-093 (audyt bloku 1): `KsefApiError.ksefCode` czytał
 * `body.exceptionDetailList`, a KSeF zwraca kody w `errors[].code`
 * (`application/problem+json`) albo w `exception.exceptionDetailList` —
 * getter dawał zawsze `null` (do Sentry z joba wysyłki szło `ksefCode: null`).
 *
 * Przy okazji: `ksefFetch` parsował JSON tylko dla `application/json`, więc
 * odpowiedź `application/problem+json` zostawała tekstem. Kody z tekstu czyta
 * od D-A4-1a `ksefErrorCodes` (dlatego 21184 z F-050 działało), ale getter
 * dawał dla tekstu `null`, a `KsefApiError.body` nie miało struktury.
 */

vi.mock('@/lib/ksef/session-cache', () => ({
  ksefSessionCache: { getSession: async () => ({ accessToken: 'token' }) },
}));
vi.mock('@/lib/ksef/rate-limiter', () => ({
  ksefRateLimiter: { enqueue: (_nip: string, fn: () => unknown) => fn() },
}));
vi.mock('@/lib/ksef/encryption', () => ({
  generateSessionEncryption: async () => ({ encryptedSymmetricKey: 'k', initializationVector: 'iv' }),
  encryptInvoiceXml: () => ({
    invoiceHash: 'h', invoiceSize: 1, encryptedInvoiceHash: 'eh', encryptedInvoiceSize: 1, encryptedInvoiceContent: 'c',
  }),
}));

import { KsefApiError, ksefErrorCodes, ksefFetch } from '@/lib/ksef/client';
import { classifyHistoryError, historyKsefErrorCodes } from '@/lib/ksef/history-sync/errors';
import { ksefErrorCodes as ksefErrorCodesFromSubmit, submitInvoice } from '@/lib/ksef/submit';
import type { KsefAuth } from '@/lib/ksef/auth';

const PROBLEM_21184 = {
  title: 'Bad Request',
  status: 400,
  errors: [{ code: 21184, description: 'Sesja tymczasowo niedostępna.' }],
};

/**
 * Odpowiedzi spoza schematu MF. Parser daje wtedy „brak kodu”, nigdy wyjątku:
 * `submit-invoice.ts` czyta `error.ksefCode` tuż przed `NonRetriableError`,
 * a `submit.ts` woła parser przy każdym HTTP 400 na wysyłkę pliku, więc
 * TypeError zamieniłby ostateczną odmowę w ponawianie.
 */
const MALFORMED: Array<[string, unknown]> = [
  ['errors jako obiekt pól', { errors: { pole: ['x'] } }],
  ['errors jako tekst', { errors: 'x' }],
  ['errors jako liczba', { errors: 5 }],
  ['errors: [null]', { errors: [null] }],
  ['errors: pozycja to tekst', { errors: ['x'] }],
  ['exception.exceptionDetailList jako obiekt', { exception: { exceptionDetailList: { a: 1 } } }],
  ['exception.exceptionDetailList: [null]', { exception: { exceptionDetailList: [null] } }],
  ['exception jako tekst', { exception: 'x' }],
  ['exception: null', { exception: null }],
  ['exceptionDetailList jako tekst', { exceptionDetailList: 'x' }],
  ['exceptionDetailList: [null]', { exceptionDetailList: [null] }],
  ['JSON w tekście: errors jako obiekt', JSON.stringify({ errors: { pole: ['x'] } })],
  ['JSON w tekście: tablica', '[1,2]'],
  ['JSON w tekście: null', 'null'],
  ['JSON w tekście: liczba', '5'],
];

/**
 * Wartości, które nie są kodem KSeF. Samo `Number()` robi z `null` i `''` zero
 * (w dzienniku `ksef_code=0`, w panelu błędów „HTTP 4000”), z `true` jedynkę,
 * a z `[21184]` prawdziwy kod.
 */
const NOT_A_CODE: Array<[string, unknown]> = [
  ['null', null],
  ['pusty tekst', ''],
  ['same spacje', '  '],
  ['zero', 0],
  ['tekst „0”', '0'],
  ['ujemny', -1],
  ['tekst „-1”', '-1'],
  ['ułamek', 1.5],
  ['tekst „1.5”', '1.5'],
  ['true', true],
  ['tablica z kodem', [21184]],
  ['obiekt', {}],
  ['tekst', 'abc'],
  ['zapis naukowy w tekście', '1e5'],
  ['zapis szesnastkowy w tekście', '0x10'],
  // `ksef_send_attempts.ksef_code` to integer: większa liczba wywaliłaby zapis wiersza.
  ['poza zakresem kolumny integer', 2_147_483_648],
  ['tekst poza zakresem kolumny integer', '2147483648'],
  ['poza bezpiecznym zakresem liczb', 1e30],
];

/** Kształty MF i atrap → wszystkie kody w kolejności (getter daje pierwszy). */
const SHAPES: Array<[string, unknown, number[]]> = [
  ['problem+json', { title: 'Bad Request', status: 400, errors: [{ code: 21405, description: 'Błąd walidacji.' }] }, [21405]],
  ['exception.exceptionDetailList', { exception: { serviceCode: 'x', exceptionDetailList: [{ exceptionCode: 21184, exceptionDescription: 'Sesja tymczasowo niedostępna.' }] } }, [21184]],
  ['atrapa: lista na wierzchu', { exceptionDetailList: [{ exceptionCode: 21001, exceptionDescription: 'Service temporarily unavailable' }] }, [21001]],
  ['kod jako tekst', { errors: [{ code: '21405' }] }, [21405]],
  ['tekst zamiast JSON', 'Bad Gateway', []],
  ['JSON w tekście (D-A4-1a)', JSON.stringify({ errors: [{ code: 440 }] }), [440]],
  ['JSON w tekście: starszy kształt', JSON.stringify({ exception: { exceptionDetailList: [{ exceptionCode: 21164 }] } }), [21164]],
  ['JSON bez kodów', { title: 'Bad Request', status: 400 }, []],
  ['trzy kształty naraz', { errors: [{ code: 21405 }], exception: { exceptionDetailList: [{ exceptionCode: 21184 }] }, exceptionDetailList: [{ exceptionCode: 21001 }] }, [21405, 21184, 21001]],
];

const everyShape = (value: unknown) => [
  { errors: [{ code: value }] },
  { exception: { exceptionDetailList: [{ exceptionCode: value }] } },
  { exceptionDetailList: [{ exceptionCode: value }] },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('odczyt kodu z danych spoza schematu MF', () => {
  // Kopia w `history-sync/errors.ts` ma działać tak samo, dopóki nie zniknie.
  describe.each([
    ['ksefErrorCodes', ksefErrorCodes],
    ['historyKsefErrorCodes (kopia)', historyKsefErrorCodes],
  ])('%s', (_name, parse) => {
    it.each(SHAPES)('kształt: %s', (_label, body, codes) => {
      expect(parse(body)).toEqual(codes);
    });

    it.each(MALFORMED)('%s — pusta lista, bez wyjątku', (_label, body) => {
      expect(parse(body)).toEqual([]);
    });

    it.each(NOT_A_CODE)('kod: %s — odrzucony w każdym kształcie', (_label, value) => {
      for (const body of everyShape(value)) expect(parse(body)).toEqual([]);
    });

    it('zła wartość nie przesłania dobrej', () => {
      expect(parse({ errors: [{ code: null }, null, { code: 21405 }] })).toEqual([21405]);
    });

    it('kod graniczny kolumny integer i kod jako tekst przechodzą', () => {
      expect(parse({ errors: [{ code: 2_147_483_647 }, { code: '21405' }] })).toEqual([2_147_483_647, 21405]);
    });
  });

  it.each(MALFORMED)('getter ksefCode: %s — null, bez wyjątku', (_label, body) => {
    expect(new KsefApiError(400, body as never, 'x').ksefCode).toBeNull();
  });

  it.each(NOT_A_CODE)('getter ksefCode: kod %s — null', (_label, value) => {
    for (const body of everyShape(value)) {
      expect(new KsefApiError(400, body as never, 'x').ksefCode).toBeNull();
    }
  });
});

describe('historia KSeF: błąd spoza schematu nie wywraca klasyfikacji', () => {
  const ctx = { phase: 'metadata', certificateExpiry: null, now: new Date('2026-11-04T12:00:00Z') } as const;
  const error = (body: unknown) =>
    new KsefApiError(400, body as never, 'KSeF API POST /invoices/query/metadata failed: 400');

  it.each([
    ['errors jako obiekt pól', { errors: { pole: ['x'] } }],
    ['code: null', { errors: [{ code: null }] }],
  ])('%s — skutek jak dla 400 bez kodu, szczegół „kody:-”', (_label, body) => {
    expect(classifyHistoryError(error(body), ctx)).toEqual({
      kind: 'session',
      code: 'internal',
      detail: 'HTTP 400 /invoices/query/metadata kody:-',
      invalidateSession: false,
    });
  });
});

describe('KsefApiError.ksefCode (F-093)', () => {
  it.each(SHAPES)('%s → pierwszy kod albo null', (_label, body, codes) => {
    const err = new KsefApiError(400, body as never, 'KSeF API POST /x failed: 400');
    expect(err.ksefCode).toBe(codes[0] ?? null);
  });

  it('kilka kodów — getter daje pierwszy, ksefErrorCodes wszystkie', () => {
    const body = { errors: [{ code: 21405 }, { code: 21184 }] };
    expect(new KsefApiError(400, body, 'x').ksefCode).toBe(21405);
    expect(ksefErrorCodes(body)).toEqual([21405, 21184]);
  });

  it('job wysyłki bierze ksefErrorCodes z submit — to ta sama funkcja co w kliencie', () => {
    expect(ksefErrorCodesFromSubmit).toBe(ksefErrorCodes);
  });
});

describe('ksefFetch: odpowiedź application/problem+json', () => {
  it.each([
    'application/problem+json',
    'application/problem+json; charset=utf-8',
    'Application/JSON; charset=utf-8',
    // Dwa nagłówki sklejone przez `Headers.get` — stary warunek `includes` je parsował.
    'application/json, application/json',
    'application/problem+json, application/problem+json',
  ])('%s — ciało błędu sparsowane, kod do odczytu', async (contentType) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(PROBLEM_21184), {
      status: 400,
      headers: { 'content-type': contentType },
    })));

    const err = await ksefFetch('/test', { env: 'test' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(KsefApiError);
    expect((err as KsefApiError).body).toEqual(PROBLEM_21184);
    expect((err as KsefApiError).ksefCode).toBe(21184);
  });

  it('inny typ treści zostaje tekstem — kod i tak czytelny z JSON-u w tekście (D-A4-1a)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"errors":[{"code":21184}]}', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    })));

    const err = await ksefFetch('/test', { env: 'test' }).catch((e: unknown) => e);

    // ksefFetch nie parsuje typu innego niż JSON…
    expect((err as KsefApiError).body).toBe('{"errors":[{"code":21184}]}');
    // …ale kod z JSON-u w tekście czyta ksefErrorCodes.
    expect((err as KsefApiError).ksefCode).toBe(21184);
  });

  it('odpowiedź 2xx ze zdublowanym nagłówkiem application/json — obiekt jak przed zmianą warunku', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ referenceNumber: 'SESJA-1' }), {
      status: 201,
      headers: { 'content-type': 'application/json, application/json' },
    })));

    await expect(ksefFetch('/sessions/online', { env: 'test', method: 'POST' })).resolves.toEqual({ referenceNumber: 'SESJA-1' });
  });

  // Pilnuje regresji prawdziwej ścieżki; przechodzi też na main, bo od D-A4-1a
  // kody z tekstu czyta `ksefErrorCodes`.
  it('21184 jako problem+json z prawdziwego ksefFetch — wysyłka ponawialna (F-050)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/sessions/online')) {
        return new Response(JSON.stringify({ referenceNumber: 'SESJA-1' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/invoices')) {
        return new Response(JSON.stringify(PROBLEM_21184), {
          status: 400,
          headers: { 'content-type': 'application/problem+json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const auth = { type: 'token', nip: '1234567890', token: 'x' } as unknown as KsefAuth;

    const err = await submitInvoice('<Faktura/>', auth, 'test').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(KsefApiError);
    expect((err as KsefApiError).isRetryable).toBe(true);
    expect((err as KsefApiError).message).toContain('21184');
  });

  it('400 spoza schematu MF z prawdziwego ksefFetch — ostateczna odmowa, nie TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/sessions/online')) {
        return new Response(JSON.stringify({ referenceNumber: 'SESJA-1' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/invoices')) {
        return new Response(JSON.stringify({ errors: { pole: ['x'] } }), {
          status: 400,
          headers: { 'content-type': 'application/problem+json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const auth = { type: 'token', nip: '1234567890', token: 'x' } as unknown as KsefAuth;

    const err = await submitInvoice('<Faktura/>', auth, 'test').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(KsefApiError);
    expect((err as KsefApiError).isRetryable).toBe(false);
    expect((err as KsefApiError).ksefCode).toBeNull();
  });
});
