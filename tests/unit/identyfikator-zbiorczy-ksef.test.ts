import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 1.4, część 2: klient `POST /collective-identifiers` (KSeF 2.0).
 *
 * Prawdziwe: `wygenerujIdentyfikatorZbiorczy`, `ksefFetch` (adres TEST i PROD,
 * nagłówki, audyt), walidator odpowiedzi (format i CRC-8) i opis błędów dla
 * klienta. Zastąpione: HTTP (atrapa `fetch`), sesja KSeF (logowanie to też HTTP),
 * kolejka per NIP i zapis audytu.
 *
 * Kształt żądania i odpowiedzi według specyfikacji OpenAPI TEST
 * (https://api-test.ksef.mf.gov.pl/docs/v2/openapi.json):
 * `{"invoices":[{"ksefNumber":"…"}, …]}` (co najmniej 2), odpowiedź 201
 * `{"collectiveIdentifierNumber":"…"}`, błędy 400 z kodami 21001, 21405, 71001,
 * 71002, 71004 i 71005 oraz 401, 403 i 429. Kwot (`payment`) nie wysyłamy:
 * pole jest opcjonalne, a identyfikator ma wskazywać faktury.
 */

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  invalidate: vi.fn(),
  audit: vi.fn(async (_entry: unknown) => undefined),
}));

vi.mock('@/lib/ksef/session-cache', () => ({ ksefSessionCache: { getSession: m.getSession, invalidate: m.invalidate } }));
vi.mock('@/lib/ksef/rate-limiter', () => ({ ksefRateLimiter: { enqueue: (_nip: string, fn: () => unknown) => fn() } }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: m.audit }));

const TENANT = '0a0b0c0d-1111-4000-8000-000000000001';
/** Nabywca (kontekst sesji KSeF): fikcyjny NIP z konwencji repo. */
const AUTH = { type: 'token' as const, nip: '1234567890', token: 'a'.repeat(24) };
const SESJA = {
  accessToken: 'b'.repeat(24),
  refreshToken: 'c'.repeat(24),
  accessTokenExpiresAt: Date.now() + 3_600_000,
  refreshTokenExpiresAt: Date.now() + 86_400_000,
  nip: AUTH.nip,
};
/** Sprzedawca z wektora dokumentacji. */
const NIP_SPRZEDAWCY = '1111111111';
const WEKTOR = '1111111111-IZ202607-65ED02180000-E7';
const K1 = '1111111111-20261105-0A1B2C3D4E01-7A';
const K2 = '1111111111-20261106-0A1B2C3D4E02-7B';
const KONTEKST = {
  sprzedawca: 'Dostawca Testowy sp. z o.o.',
  faktury: [
    { numerFaktury: 'FV/1/11/2026', numerKsef: K1 },
    { numerFaktury: 'FV/2/11/2026', numerKsef: K2 },
  ],
};

const fetchMock = vi.fn();
const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const wyjatek = (kod: number, opis: string, details: string[] = []) => ({
  exception: {
    exceptionDetailList: [{ exceptionCode: kod, exceptionDescription: opis, details }],
    referenceNumber: '20261111-EE-0000000000-00',
    serviceCode: 'TEST',
    serviceCtx: 'srvTEMFC',
    serviceName: 'Collective identifiers',
    timestamp: '2026-11-11T10:00:00.000Z',
  },
});

const zadanie = (pola: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  env: 'test' as const,
  nipSprzedawcy: NIP_SPRZEDAWCY,
  numeryKsef: [K2, K1],
  ...pola,
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  m.getSession.mockReset();
  m.getSession.mockResolvedValue(SESJA);
  m.invalidate.mockReset();
  m.audit.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function klient() {
  return import('@/lib/ksef/identyfikator-zbiorczy');
}

describe('POST /collective-identifiers: żądanie i odpowiedź', () => {
  it('KSeF TEST: adres testowy, token sesji, numery KSeF bez powtórzeń i po kolei, bez kwot; wynik to identyfikator', async () => {
    fetchMock.mockResolvedValue(json({ collectiveIdentifierNumber: WEKTOR }, 201));
    const { wygenerujIdentyfikatorZbiorczy } = await klient();

    await expect(wygenerujIdentyfikatorZbiorczy(AUTH, zadanie())).resolves.toBe(WEKTOR);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://api-test.ksef.mf.gov.pl/v2/collective-identifiers');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${SESJA.accessToken}`);
    expect(JSON.parse(String(init.body))).toEqual({ invoices: [{ ksefNumber: K1 }, { ksefNumber: K2 }] });
    expect(m.getSession).toHaveBeenCalledWith(AUTH, 'test');
  });

  it('audyt wywołania: ksef.collective_identifier.generate z NIP sprzedawcy, liczbą i numerami faktur', async () => {
    fetchMock.mockResolvedValue(json({ collectiveIdentifierNumber: WEKTOR }, 201));
    const { wygenerujIdentyfikatorZbiorczy } = await klient();

    await wygenerujIdentyfikatorZbiorczy(AUTH, zadanie());

    await vi.waitFor(() => expect(m.audit).toHaveBeenCalledTimes(1));
    expect(m.audit.mock.calls[0]![0]).toMatchObject({
      action: 'ksef.collective_identifier.generate',
      tenantId: TENANT,
      metadata: expect.objectContaining({
        sellerNip: NIP_SPRZEDAWCY,
        invoiceCount: 2,
        ksefNumbers: [K1, K2],
        method: 'POST',
        path: '/collective-identifiers',
        httpStatus: 201,
      }),
    });
  });

  it('KSeF produkcyjny (KSEF_ENV=production): adres produkcyjny', async () => {
    vi.stubEnv('KSEF_ENV', 'production');
    fetchMock.mockResolvedValue(json({ collectiveIdentifierNumber: WEKTOR }, 201));
    const { wygenerujIdentyfikatorZbiorczy } = await klient();

    await wygenerujIdentyfikatorZbiorczy(AUTH, zadanie({ env: 'production' }));

    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.ksef.mf.gov.pl/v2/collective-identifiers');
    expect(m.getSession).toHaveBeenCalledWith(AUTH, 'production');
  });

  it('środowisko inne niż KSEF_ENV aplikacji: odmowa bez logowania i bez żądania', async () => {
    const { wygenerujIdentyfikatorZbiorczy } = await klient();

    await expect(wygenerujIdentyfikatorZbiorczy(AUTH, zadanie({ env: 'production' }))).rejects.toThrow();

    expect(m.getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['jedna faktura', { numeryKsef: [K1] }],
    ['powtórzony numer KSeF', { numeryKsef: [K1, K1] }],
    ['numer spoza wzorca KSeF', { numeryKsef: [K1, 'FV/2/11/2026'] }],
    ['ponad 500 faktur', { numeryKsef: Array.from({ length: 501 }, (_, i) => `1111111111-20261105-${String(i).padStart(12, '0')}-7A`) }],
    ['NIP sprzedawcy spoza 10 cyfr', { nipSprzedawcy: 'PL1111111111' }],
  ])('%s: odmowa przed KSeF', async (_opis, pola) => {
    const { wygenerujIdentyfikatorZbiorczy } = await klient();

    await expect(wygenerujIdentyfikatorZbiorczy(AUTH, zadanie(pola))).rejects.toThrow();

    expect(m.getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('odpowiedź 201 sprawdzana tym samym walidatorem', () => {
  it.each([
    ['zła suma kontrolna', { collectiveIdentifierNumber: '1111111111-IZ202607-65ED02180000-E8' }],
    ['atrapa MF z sumą FF', { collectiveIdentifierNumber: '9999999999-IZ202602-FFFFFFFFFFFF-FF' }],
    ['NIP inny niż sprzedawcy faktur', { collectiveIdentifierNumber: '1234567890-IZ202611-0A1B2C3D4E5F-A0' }],
    ['brak pola', { referenceNumber: '20261111-EE-0000000000-00' }],
    ['numer KSeF faktury zamiast identyfikatora', { collectiveIdentifierNumber: K1 }],
  ])('%s: identyfikator odrzucony, klient dostaje komunikat zamiast numeru', async (_opis, body) => {
    fetchMock.mockResolvedValue(json(body, 201));
    const { wygenerujIdentyfikatorZbiorczy, opiszBladIdentyfikatora } = await klient();

    const blad = await wygenerujIdentyfikatorZbiorczy(AUTH, zadanie()).then(() => null, (e: unknown) => e);

    expect(blad).not.toBeNull();
    const opis = opiszBladIdentyfikatora(blad, KONTEKST);
    expect(opis.kod).toBe('invalid_response');
    expect(opis.komunikat).toContain('nie pokazujemy');
    expect(opis.komunikat).toContain('osobnym przelewem');
  });
});

describe('błędy KSeF: komunikat dla klienta z dokumentem i tym, co zrobić', () => {
  async function opisBledu(odpowiedz: Response | Error) {
    if (odpowiedz instanceof Error) fetchMock.mockRejectedValue(odpowiedz);
    else fetchMock.mockResolvedValue(odpowiedz);
    const { wygenerujIdentyfikatorZbiorczy, opiszBladIdentyfikatora } = await klient();
    const blad = await wygenerujIdentyfikatorZbiorczy(AUTH, zadanie()).then(() => null, (e: unknown) => e);
    expect(blad).not.toBeNull();
    return opiszBladIdentyfikatora(blad, KONTEKST);
  }

  it('71001 z numerem w szczegółach: nazwa faktury, numer KSeF i Aplikacja Podatnika', async () => {
    const opis = await opisBledu(json(wyjatek(71001, 'Faktura nie istnieje.', [K2]), 400));
    expect(opis.kod).toBe('ksef_71001');
    expect(opis.komunikat).toContain('FV/2/11/2026');
    expect(opis.komunikat).toContain(K2);
    expect(opis.komunikat).toContain('Aplikacji Podatnika KSeF');
    expect(opis.komunikat).toContain('Dostawca Testowy sp. z o.o.');
  });

  it('71001 bez numeru w odpowiedzi: „jednej z faktur”', async () => {
    const opis = await opisBledu(json(wyjatek(71001, 'Faktura nie istnieje.'), 400));
    expect(opis.kod).toBe('ksef_71001');
    expect(opis.komunikat).toContain('jednej z faktur');
  });

  it('71002: limit 132 identyfikatorów na fakturę, zapłata osobnymi przelewami', async () => {
    const opis = await opisBledu(json(wyjatek(71002, 'Faktura osiągnęła maksymalną liczbę identyfikatorów.', [K1]), 400));
    expect(opis.kod).toBe('ksef_71002');
    expect(opis.komunikat).toContain('FV/1/11/2026');
    expect(opis.komunikat).toContain('132');
    expect(opis.komunikat).toContain('osobnym przelewem');
  });

  it('71004: różni sprzedawcy', async () => {
    const opis = await opisBledu(json(wyjatek(71004, 'Faktury mają różnych sprzedawców.'), 400));
    expect(opis.kod).toBe('ksef_71004');
    expect(opis.komunikat).toContain('różnych sprzedawców');
  });

  it('71005: powtórzony numer KSeF, odświeżenie strony', async () => {
    const opis = await opisBledu(json(wyjatek(71005, 'Powtórzony numer KSeF.'), 400));
    expect(opis.kod).toBe('ksef_71005');
    expect(opis.komunikat).toContain('Odśwież stronę');
  });

  it('21405 w kształcie problem+json: kod w komunikacie i pomoc FaktWay', async () => {
    const opis = await opisBledu(
      new Response(JSON.stringify({ title: 'Bad Request', status: 400, errors: [{ code: 21405, description: 'Błąd walidacji.' }] }), {
        status: 400,
        headers: { 'content-type': 'application/problem+json' },
      }),
    );
    expect(opis.kod).toBe('ksef_21405');
    expect(opis.komunikat).toContain('kod 21405');
    expect(opis.komunikat).toContain('pomocy FaktWay');
  });

  it('401: sesja z pamięci wyrzucona, klient może spróbować jeszcze raz', async () => {
    const opis = await opisBledu(json({ title: 'Unauthorized', status: 401 }, 401));
    expect(opis.kod).toBe('http_401');
    expect(m.invalidate).toHaveBeenCalledWith(AUTH.nip, 'test');
    expect(opis.komunikat).toContain('Spróbuj ponownie');
  });

  it('403: brak uprawnień w KSeF, które nadać i gdzie', async () => {
    const opis = await opisBledu(json({ title: 'Forbidden', status: 403 }, 403));
    expect(opis.kod).toBe('http_403');
    expect(opis.komunikat).toContain('CollectiveIdentifierManage');
    expect(opis.komunikat).toContain('Aplikacji Podatnika KSeF');
    expect(m.invalidate).not.toHaveBeenCalled();
  });

  it('429 z Retry-After: kiedy spróbować ponownie', async () => {
    const opis = await opisBledu(json({ status: 429 }, 429, { 'retry-after': '120' }));
    expect(opis.kod).toBe('http_429');
    expect(opis.komunikat).toContain('za 2 min');
  });

  it('503: KSeF niedostępny', async () => {
    const opis = await opisBledu(json(wyjatek(21001, 'Service temporarily unavailable'), 503));
    expect(opis.kod).toBe('http_5xx');
    expect(opis.komunikat).toContain('niedostępny');
  });

  it('brak odpowiedzi w 30 s: komunikat o czasie', async () => {
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    const opis = await opisBledu(abort);
    expect(opis.kod).toBe('timeout');
    expect(opis.komunikat).toContain('na czas');
  });

  it('przerwane połączenie', async () => {
    const opis = await opisBledu(new TypeError('fetch failed'));
    expect(opis.kod).toBe('network');
    expect(opis.komunikat).toContain('niedostępny');
  });

  it('logowanie do KSeF odrzucone: ustawienia KSeF, bez wywołania identyfikatora', async () => {
    const { KsefAuthRejectedError } = await import('@/lib/ksef/auth-errors');
    m.getSession.mockRejectedValue(new KsefAuthRejectedError(415, 'Brak uprawnień', []));
    const { wygenerujIdentyfikatorZbiorczy, opiszBladIdentyfikatora } = await klient();

    const blad = await wygenerujIdentyfikatorZbiorczy(AUTH, zadanie()).then(() => null, (e: unknown) => e);
    const opis = opiszBladIdentyfikatora(blad, KONTEKST);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(opis.kod).toBe('session');
    expect(opis.komunikat).toContain('Ustawieniach (zakładka KSeF)');
  });

  it('logowanie do KSeF trafiło na limit 429: komunikat o limicie, nie o certyfikacie', async () => {
    const { KsefApiError } = await import('@/lib/ksef/client');
    m.getSession.mockRejectedValue(new KsefApiError(429, '', 'KSeF API POST /auth/challenge failed: 429', 60_000));
    const { wygenerujIdentyfikatorZbiorczy, opiszBladIdentyfikatora } = await klient();

    const blad = await wygenerujIdentyfikatorZbiorczy(AUTH, zadanie()).then(() => null, (e: unknown) => e);

    expect(opiszBladIdentyfikatora(blad, KONTEKST)).toMatchObject({ kod: 'http_429' });
  });

  it.each([
    ['missing', 'credentials_missing', 'Podłącz KSeF'],
    ['not-verified', 'credentials_missing', 'Podłącz KSeF'],
    ['decrypt', 'credentials_internal', 'pomocy FaktWay'],
    ['nip-mismatch', 'credentials_internal', 'pomocy FaktWay'],
    ['tenant-read', 'credentials_read', 'Spróbuj ponownie'],
  ])('poświadczenia KSeF (%s): %s', async (powod, kod, tekst) => {
    const { KsefCredentialsError } = await import('@/lib/supabase/admin-queries');
    const { opiszBladIdentyfikatora } = await klient();
    const opis = opiszBladIdentyfikatora(new KsefCredentialsError(powod as 'missing', 'x'), KONTEKST);
    expect(opis.kod).toBe(kod);
    expect(opis.komunikat).toContain(tekst);
  });

  it('każdy komunikat nazywa dokument (faktury dostawcy), mówi, co zrobić, i nie ma długich myślników', async () => {
    const { opiszBladIdentyfikatora, NiepoprawnyIdentyfikatorZKsef } = await klient();
    const { KsefApiError } = await import('@/lib/ksef/client');
    const bledy: unknown[] = [
      new KsefApiError(400, wyjatek(71001, 'x'), 'x'),
      new KsefApiError(400, wyjatek(71002, 'x'), 'x'),
      new KsefApiError(400, wyjatek(71004, 'x'), 'x'),
      new KsefApiError(400, wyjatek(71005, 'x'), 'x'),
      new KsefApiError(400, wyjatek(21405, 'x'), 'x'),
      new KsefApiError(400, wyjatek(21001, 'x'), 'x'),
      new KsefApiError(401, '', 'x'),
      new KsefApiError(403, '', 'x'),
      new KsefApiError(429, '', 'x', null),
      new KsefApiError(408, 'Request timeout', 'x'),
      new KsefApiError(502, '', 'x'),
      new KsefApiError(404, '', 'x'),
      new NiepoprawnyIdentyfikatorZKsef('x', 'format'),
      new TypeError('fetch failed'),
      new Error('coś innego'),
    ];
    for (const blad of bledy) {
      const { komunikat } = opiszBladIdentyfikatora(blad, KONTEKST);
      expect(komunikat, komunikat).toMatch(/Dostawca Testowy sp\. z o\.o\.|faktur/);
      expect(komunikat, komunikat).toMatch(/Spróbuj|Sprawdź|Odśwież|zapłacić|Napisz|nadaje się|Podłącz/);
      expect(komunikat, komunikat).not.toMatch(/[—–]/);
    }
  });
});
