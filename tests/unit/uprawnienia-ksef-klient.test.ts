import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as KlientUprawnien from '@/lib/ksef/uprawnienia';

/**
 * Krok 6.2, część 4: klient uprawnień KSeF 2.0 (`lib/ksef/uprawnienia.ts`).
 *
 * Prawdziwe: funkcje klienta, `ksefFetch` (adres TEST i PROD, nagłówki,
 * audyt), sprawdzenie odpowiedzi i klasyfikacja błędów. Zastąpione: HTTP
 * (atrapa `fetch`), sesja KSeF (logowanie to też HTTP), kolejka per NIP
 * i zapis audytu.
 *
 * Kształt żądań i odpowiedzi według specyfikacji OpenAPI TEST
 * (https://api-test.ksef.mf.gov.pl/docs/v2/openapi.json):
 *  - `POST /permissions/entities/grants` (`EntityPermissionsGrantRequest`):
 *    `subjectIdentifier` {type Nip, value 10 znaków}, `permissions`
 *    [{type InvoiceRead|InvoiceWrite, canDelegate}], `description` 5-256,
 *    `subjectDetails.fullName` 5-90; odpowiedź 202 `{"referenceNumber":"…"}` (36 znaków);
 *  - `GET /permissions/operations/{referenceNumber}`: 200 `{"status":{"code":…,"description":"…"}}`,
 *    410 gdy operacja wygasła (status jest dostępny 30 dni);
 *  - `POST /permissions/query/persons/grants?pageOffset=…&pageSize=…`
 *    (`queryType` PermissionsInCurrentContext, `authorizedIdentifier`, `permissionTypes`,
 *    `permissionState`): 200 `{"permissions":[…],"hasMore":…}`;
 *  - `DELETE /permissions/common/grants/{permissionId}`: 202 `{"referenceNumber":"…"}`;
 *  - błędy: 400 (21001, 21405), 401, 403, 429 z `Retry-After`.
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
/** Firma (kontekst sesji KSeF): fikcyjny NIP z konwencji repo. */
const AUTH = { type: 'token' as const, nip: '1234567890', token: 'a'.repeat(24) };
const SESJA = {
  accessToken: 'b'.repeat(24),
  refreshToken: 'c'.repeat(24),
  accessTokenExpiresAt: Date.now() + 3_600_000,
  refreshTokenExpiresAt: Date.now() + 86_400_000,
  nip: AUTH.nip,
};
const NIP_BIURA = '1111111111';
const NAZWA = 'Biuro Rachunkowe Testowe sp. z o.o.';
/** Numer operacji z przykładu specyfikacji (36 znaków). */
const NUMER = '20250626-EG-333C814000-C529F710D8-D2';
const ID_1 = '0c9a72e8-f344-457f-9c16-7c640eb60242';
const ID_2 = '1d8b61f7-e233-446e-8b05-6b530da51131';

const fetchMock = vi.fn();
const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const wyjatek = (kod: number, opis = 'Błąd walidacji danych wejściowych.') => ({
  exception: {
    exceptionDetailList: [{ exceptionCode: kod, exceptionDescription: opis, details: [] }],
    referenceNumber: '20261111-EE-0000000000-00',
    serviceCode: 'TEST',
    timestamp: '2026-11-11T10:00:00.000Z',
  },
});
const pozycja = (pola: Record<string, unknown> = {}) => ({
  id: ID_1,
  authorizedIdentifier: { type: 'Nip', value: NIP_BIURA },
  authorIdentifier: { type: 'Nip', value: AUTH.nip },
  permissionScope: 'InvoiceRead',
  description: 'Dostęp biura rachunkowego nadany w FaktWay',
  permissionState: 'Active',
  startDate: '2026-11-11T10:41:11+00:00',
  canDelegate: true,
  ...pola,
});

type Nadanie = Parameters<typeof KlientUprawnien.nadajUprawnieniaBiuru>[1];
type ZapytanieStanu = Parameters<typeof KlientUprawnien.stanOperacjiUprawnien>[1];
type ZapytanieListy = Parameters<typeof KlientUprawnien.aktywneUprawnieniaBiura>[1];
type Odebranie = Parameters<typeof KlientUprawnien.odbierzUprawnienieBiura>[1];

const KONTEKST = { tenantId: TENANT, env: 'test' as const };
/** Złe wartości w testach odmów idą przez `unknown`: klient sprawdza wejście sam. */
const nadanie = (pola: Record<string, unknown> = {}) =>
  ({
    ...KONTEKST,
    nip: NIP_BIURA,
    nazwa: NAZWA,
    uprawnienia: ['InvoiceRead', 'InvoiceWrite'],
    przekazanie: true,
    opis: `Dostęp biura rachunkowego ${NAZWA} nadany w FaktWay`,
    ...pola,
  }) as unknown as Nadanie;
const stan = (numer: string): ZapytanieStanu => ({ ...KONTEKST, numer });
const lista = (pola: Record<string, unknown> = {}) =>
  ({ ...KONTEKST, nip: NIP_BIURA, uprawnienia: ['InvoiceRead'], ...pola }) as unknown as ZapytanieListy;
const odebranie = (idUprawnienia: string): Odebranie => ({ ...KONTEKST, idUprawnienia });

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
  return import('@/lib/ksef/uprawnienia');
}

type Init = RequestInit & { headers: Record<string, string> };
const wywolanie = (n = 0) => fetchMock.mock.calls[n] as [string, Init];

describe('nadanie: POST /permissions/entities/grants', () => {
  it('KSeF TEST: adres testowy, token sesji, treść według EntityPermissionsGrantRequest; wynik to numer operacji', async () => {
    fetchMock.mockResolvedValue(json({ referenceNumber: NUMER }, 202));
    const { nadajUprawnieniaBiuru } = await klient();

    await expect(nadajUprawnieniaBiuru(AUTH, nadanie())).resolves.toBe(NUMER);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = wywolanie();
    expect(url).toBe('https://api-test.ksef.mf.gov.pl/v2/permissions/entities/grants');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${SESJA.accessToken}`);
    expect(JSON.parse(String(init.body))).toEqual({
      subjectIdentifier: { type: 'Nip', value: NIP_BIURA },
      permissions: [
        { type: 'InvoiceRead', canDelegate: true },
        { type: 'InvoiceWrite', canDelegate: true },
      ],
      description: `Dostęp biura rachunkowego ${NAZWA} nadany w FaktWay`,
      subjectDetails: { fullName: NAZWA },
    });
    expect(m.getSession).toHaveBeenCalledWith(AUTH, 'test');
  });

  it('bez przekazania pracownikom: canDelegate false', async () => {
    fetchMock.mockResolvedValue(json({ referenceNumber: NUMER }, 202));
    const { nadajUprawnieniaBiuru } = await klient();

    await nadajUprawnieniaBiuru(AUTH, nadanie({ uprawnienia: ['InvoiceRead'], przekazanie: false }));

    expect(JSON.parse(String(wywolanie()[1].body)).permissions).toEqual([{ type: 'InvoiceRead', canDelegate: false }]);
  });

  it('audyt wywołania: ksef.permissions.grant z NIP-em biura i uprawnieniami', async () => {
    fetchMock.mockResolvedValue(json({ referenceNumber: NUMER }, 202));
    const { nadajUprawnieniaBiuru } = await klient();

    await nadajUprawnieniaBiuru(AUTH, nadanie());

    await vi.waitFor(() => expect(m.audit).toHaveBeenCalledTimes(1));
    expect(m.audit.mock.calls[0]![0]).toMatchObject({
      action: 'ksef.permissions.grant',
      tenantId: TENANT,
      metadata: expect.objectContaining({
        subjectNip: NIP_BIURA,
        permissions: ['InvoiceRead', 'InvoiceWrite'],
        canDelegate: true,
        method: 'POST',
        path: '/permissions/entities/grants',
        httpStatus: 202,
      }),
    });
  });

  it('KSeF produkcyjny (KSEF_ENV=production): adres produkcyjny', async () => {
    vi.stubEnv('KSEF_ENV', 'production');
    fetchMock.mockResolvedValue(json({ referenceNumber: NUMER }, 202));
    const { nadajUprawnieniaBiuru } = await klient();

    await nadajUprawnieniaBiuru(AUTH, nadanie({ env: 'production' }));

    expect(wywolanie()[0]).toBe('https://api.ksef.mf.gov.pl/v2/permissions/entities/grants');
    expect(m.getSession).toHaveBeenCalledWith(AUTH, 'production');
  });

  it('środowisko inne niż KSEF_ENV aplikacji: odmowa bez logowania i bez żądania', async () => {
    const { nadajUprawnieniaBiuru } = await klient();

    await expect(nadajUprawnieniaBiuru(AUTH, nadanie({ env: 'production' }))).rejects.toThrow();

    expect(m.getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['NIP z błędną sumą kontrolną', { nip: '1234567890' }],
    ['NIP z prefiksem', { nip: 'PL1111111111' }],
    ['NIP biura równy NIP-owi firmy z sesji', { nip: AUTH.nip }],
    ['brak uprawnień', { uprawnienia: [] }],
    ['uprawnienie spoza zakresu', { uprawnienia: ['CredentialsManage'] }],
    ['powtórzone uprawnienie', { uprawnienia: ['InvoiceRead', 'InvoiceRead'] }],
    ['nazwa krótsza niż 5 znaków', { nazwa: 'Abc' }],
    ['nazwa dłuższa niż 90 znaków', { nazwa: 'B'.repeat(91) }],
    ['opis krótszy niż 5 znaków', { opis: 'abc' }],
    ['opis dłuższy niż 256 znaków', { opis: 'o'.repeat(257) }],
    ['przekazanie nie jako tak/nie', { przekazanie: 'tak' }],
  ])('%s: odmowa przed KSeF', async (_opis, pola) => {
    const { nadajUprawnieniaBiuru } = await klient();

    await expect(nadajUprawnieniaBiuru(AUTH, nadanie(pola))).rejects.toThrow();

    expect(m.getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['brak numeru', {}],
    ['numer krótszy niż 36 znaków', { referenceNumber: '20250626-EG-333C814000' }],
    ['numer z niedozwolonym znakiem', { referenceNumber: '20250626-EG-333C814000-C529F710D8/D2' }],
    ['numer nie jako napis', { referenceNumber: 20250626 }],
  ])('202 z odpowiedzią spoza schematu (%s): błąd odpowiedzi, nie numer', async (_opis, body) => {
    fetchMock.mockResolvedValue(json(body, 202));
    const { nadajUprawnieniaBiuru, NiepoprawnaOdpowiedzUprawnien } = await klient();

    await expect(nadajUprawnieniaBiuru(AUTH, nadanie())).rejects.toBeInstanceOf(NiepoprawnaOdpowiedzUprawnien);
  });
});

describe('stan operacji: GET /permissions/operations/{referenceNumber}', () => {
  it('adres z numerem operacji, wynik: kod, opis i szczegóły', async () => {
    fetchMock.mockResolvedValue(json({ status: { code: 200, description: 'Operacja zakończona sukcesem' } }, 200));
    const { stanOperacjiUprawnien } = await klient();

    await expect(stanOperacjiUprawnien(AUTH, stan(NUMER))).resolves.toEqual({
      kod: 200,
      opis: 'Operacja zakończona sukcesem',
      szczegoly: [],
    });
    const [url, init] = wywolanie();
    expect(url).toBe(`https://api-test.ksef.mf.gov.pl/v2/permissions/operations/${NUMER}`);
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(`Bearer ${SESJA.accessToken}`);
  });

  it('szczegóły z KSeF przechodzą jako lista napisów', async () => {
    fetchMock.mockResolvedValue(json({ status: { code: 450, description: 'Operacja niedozwolona', details: ['NIP 1111111111'] } }, 200));
    const { stanOperacjiUprawnien } = await klient();

    await expect(stanOperacjiUprawnien(AUTH, stan(NUMER))).resolves.toEqual({
      kod: 450,
      opis: 'Operacja niedozwolona',
      szczegoly: ['NIP 1111111111'],
    });
  });

  it.each([
    ['bez statusu', {}],
    ['kod nie jako liczba', { status: { code: '200', description: 'ok' } }],
    ['kod ułamkowy', { status: { code: 200.5, description: 'ok' } }],
    ['bez opisu', { status: { code: 200 } }],
  ])('odpowiedź spoza schematu (%s): błąd odpowiedzi', async (_opis, body) => {
    fetchMock.mockResolvedValue(json(body, 200));
    const { stanOperacjiUprawnien, NiepoprawnaOdpowiedzUprawnien } = await klient();

    await expect(stanOperacjiUprawnien(AUTH, stan(NUMER))).rejects.toBeInstanceOf(NiepoprawnaOdpowiedzUprawnien);
  });

  it('numer operacji spoza wzorca: odmowa przed KSeF', async () => {
    const { stanOperacjiUprawnien } = await klient();

    await expect(stanOperacjiUprawnien(AUTH, stan('../permissions/entities/grants'))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('410: operacja wygasła, błąd KSeF ze statusem 410', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ title: 'Gone', status: 410, detail: 'Operacja wygasła i nie jest już dostępna.' }), {
        status: 410,
        headers: { 'content-type': 'application/problem+json' },
      }),
    );
    const { stanOperacjiUprawnien } = await klient();
    const { KsefApiError } = await import('@/lib/ksef/client');

    const blad = await stanOperacjiUprawnien(AUTH, stan(NUMER)).catch((e: unknown) => e);
    expect(blad).toBeInstanceOf(KsefApiError);
    expect((blad as InstanceType<typeof KsefApiError>).status).toBe(410);
  });
});

describe('aktywne uprawnienia biura: POST /permissions/query/persons/grants', () => {
  it('zapytanie w bieżącym kontekście o NIP biura, wybrane uprawnienia i stan Active; strona 0 po 100', async () => {
    fetchMock.mockResolvedValue(json({ permissions: [pozycja()], hasMore: false }, 200));
    const { aktywneUprawnieniaBiura } = await klient();

    await expect(
      aktywneUprawnieniaBiura(AUTH, lista({ uprawnienia: ['InvoiceRead', 'InvoiceWrite'] })),
    ).resolves.toEqual([{ id: ID_1, uprawnienie: 'InvoiceRead', przekazanie: true }]);

    const [url, init] = wywolanie();
    expect(url).toBe('https://api-test.ksef.mf.gov.pl/v2/permissions/query/persons/grants?pageOffset=0&pageSize=100');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      queryType: 'PermissionsInCurrentContext',
      authorizedIdentifier: { type: 'Nip', value: NIP_BIURA },
      permissionTypes: ['InvoiceRead', 'InvoiceWrite'],
      permissionState: 'Active',
    });
  });

  it('kolejne strony, dopóki hasMore', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ permissions: [pozycja()], hasMore: true }, 200))
      .mockResolvedValueOnce(json({ permissions: [pozycja({ id: ID_2, permissionScope: 'InvoiceWrite', canDelegate: false })], hasMore: false }, 200));
    const { aktywneUprawnieniaBiura } = await klient();

    const wynik = await aktywneUprawnieniaBiura(AUTH, lista({ uprawnienia: ['InvoiceRead', 'InvoiceWrite'] }));

    expect(wynik).toEqual([
      { id: ID_1, uprawnienie: 'InvoiceRead', przekazanie: true },
      { id: ID_2, uprawnienie: 'InvoiceWrite', przekazanie: false },
    ]);
    expect(wywolanie(1)[0]).toContain('pageOffset=1&pageSize=100');
  });

  it('pozycje innego podmiotu, nieaktywne i spoza zakresu są pomijane', async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          permissions: [
            pozycja({ authorizedIdentifier: { type: 'Nip', value: '2222222222' } }),
            pozycja({ authorizedIdentifier: { type: 'Pesel', value: '15062788702' } }),
            pozycja({ permissionState: 'Inactive' }),
            pozycja({ permissionScope: 'InvoiceWrite' }),
            pozycja({ permissionScope: 'CredentialsManage' }),
          ],
          hasMore: false,
        },
        200,
      ),
    );
    const { aktywneUprawnieniaBiura } = await klient();

    await expect(aktywneUprawnieniaBiura(AUTH, lista())).resolves.toEqual([]);
  });

  it.each([
    ['bez listy', { hasMore: false }],
    ['bez hasMore', { permissions: [] }],
    ['pasująca pozycja bez identyfikatora', { permissions: [pozycja({ id: undefined })], hasMore: false }],
    ['pasująca pozycja z identyfikatorem spoza 36 znaków', { permissions: [pozycja({ id: 'abc' })], hasMore: false }],
  ])('odpowiedź spoza schematu (%s): błąd odpowiedzi', async (_opis, body) => {
    fetchMock.mockResolvedValue(json(body, 200));
    const { aktywneUprawnieniaBiura, NiepoprawnaOdpowiedzUprawnien } = await klient();

    await expect(aktywneUprawnieniaBiura(AUTH, lista())).rejects.toBeInstanceOf(
      NiepoprawnaOdpowiedzUprawnien,
    );
  });

  it('więcej stron niż granica: błąd zamiast niepełnej listy', async () => {
    fetchMock.mockImplementation(async () => json({ permissions: [], hasMore: true }, 200));
    const { aktywneUprawnieniaBiura, NiepoprawnaOdpowiedzUprawnien } = await klient();

    await expect(aktywneUprawnieniaBiura(AUTH, lista())).rejects.toBeInstanceOf(
      NiepoprawnaOdpowiedzUprawnien,
    );
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(10);
  });
});

describe('odebranie: DELETE /permissions/common/grants/{permissionId}', () => {
  it('adres z identyfikatorem uprawnienia; wynik to numer operacji; audyt ksef.permissions.revoke', async () => {
    fetchMock.mockResolvedValue(json({ referenceNumber: NUMER }, 202));
    const { odbierzUprawnienieBiura } = await klient();

    await expect(odbierzUprawnienieBiura(AUTH, odebranie(ID_1))).resolves.toBe(NUMER);

    const [url, init] = wywolanie();
    expect(url).toBe(`https://api-test.ksef.mf.gov.pl/v2/permissions/common/grants/${ID_1}`);
    expect(init.method).toBe('DELETE');
    await vi.waitFor(() => expect(m.audit).toHaveBeenCalledTimes(1));
    expect(m.audit.mock.calls[0]![0]).toMatchObject({
      action: 'ksef.permissions.revoke',
      metadata: expect.objectContaining({ permissionId: ID_1, httpStatus: 202 }),
    });
  });

  it('identyfikator spoza wzorca: odmowa przed KSeF', async () => {
    const { odbierzUprawnienieBiura } = await klient();

    await expect(odbierzUprawnienieBiura(AUTH, odebranie('../../entities/grants'))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('błędy KSeF i sesji', () => {
  it('401: sesja wyrzucona z pamięci, błąd KSeF dalej', async () => {
    fetchMock.mockResolvedValue(json({ title: 'Unauthorized', status: 401 }, 401));
    const { nadajUprawnieniaBiuru } = await klient();
    const { KsefApiError } = await import('@/lib/ksef/client');

    await expect(nadajUprawnieniaBiuru(AUTH, nadanie())).rejects.toBeInstanceOf(KsefApiError);
    expect(m.invalidate).toHaveBeenCalledWith(AUTH.nip, 'test');
  });

  it('logowanie do KSeF nie powiodło się: błąd logowania, bez żądania uprawnień', async () => {
    m.getSession.mockRejectedValue(new Error('auth failed'));
    const { nadajUprawnieniaBiuru, BladLogowaniaUprawnien } = await klient();

    await expect(nadajUprawnieniaBiuru(AUTH, nadanie())).rejects.toBeInstanceOf(BladLogowaniaUprawnien);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('klasyfikacja: kod do bazy, czy techniczny i czy KSeF mógł przyjąć prośbę', async () => {
    const { klasyfikujBladUprawnien, BladLogowaniaUprawnien, NiepoprawnaOdpowiedzUprawnien } = await klient();
    const { KsefApiError } = await import('@/lib/ksef/client');
    const { KsefCredentialsError } = await import('@/lib/supabase/admin-queries');
    const siec = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });

    const przypadki: Array<[unknown, Record<string, unknown>]> = [
      [new KsefCredentialsError('missing', 'x'), { kod: 'credentials_missing', techniczny: false, niepewny: false }],
      [new KsefCredentialsError('not-verified', 'x'), { kod: 'credentials_missing', techniczny: false, niepewny: false }],
      [new KsefCredentialsError('tenant-read', 'x'), { kod: 'credentials_read', techniczny: true, niepewny: false }],
      [new KsefCredentialsError('decrypt', 'x'), { kod: 'credentials_internal', techniczny: true, niepewny: false }],
      [new BladLogowaniaUprawnien(new Error('x')), { kod: 'session', niepewny: false }],
      [new BladLogowaniaUprawnien(new KsefApiError(429, '', 'x', 60_000)), { kod: 'http_429', niepewny: false, retryAfterMs: 60_000 }],
      [new BladLogowaniaUprawnien(new KsefApiError(503, '', 'x')), { kod: 'http_5xx', niepewny: false }],
      [new BladLogowaniaUprawnien(siec), { kod: 'network', niepewny: false }],
      [new KsefApiError(401, '', 'x'), { kod: 'http_401', niepewny: false }],
      [new KsefApiError(403, '', 'x'), { kod: 'http_403', niepewny: false }],
      [new KsefApiError(429, '', 'x', 120_000), { kod: 'http_429', niepewny: false, retryAfterMs: 120_000 }],
      [new KsefApiError(400, wyjatek(21405), 'x'), { kod: 'ksef_21405', techniczny: true, niepewny: false }],
      [new KsefApiError(404, 'nie ma', 'x'), { kod: 'ksef_http_404', techniczny: true, niepewny: false }],
      [new KsefApiError(408, 'Request timeout', 'x'), { kod: 'timeout', niepewny: true }],
      [new KsefApiError(503, '', 'x'), { kod: 'http_5xx', niepewny: true }],
      [siec, { kod: 'network', niepewny: true }],
      [new NiepoprawnaOdpowiedzUprawnien('nadanie', '{}'), { kod: 'invalid_response', techniczny: true, niepewny: true }],
      [new Error('cokolwiek'), { kod: 'unknown', techniczny: true, niepewny: true }],
    ];
    for (const [blad, oczekiwane] of przypadki) {
      expect(klasyfikujBladUprawnien(blad), String(blad)).toMatchObject(oczekiwane);
    }
  });

  it('429 z Retry-After: błąd KSeF z czasem oczekiwania', async () => {
    fetchMock.mockResolvedValue(json({ status: { code: 429, description: 'Too Many Requests', details: [] } }, 429, { 'retry-after': '90' }));
    const { nadajUprawnieniaBiuru, klasyfikujBladUprawnien } = await klient();

    const blad = await nadajUprawnieniaBiuru(AUTH, nadanie()).catch((e: unknown) => e);

    expect(klasyfikujBladUprawnien(blad)).toMatchObject({ kod: 'http_429', retryAfterMs: 90_000 });
  });

  it('400 z kodem 21405 w problem+json: kod z odpowiedzi', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ title: 'Bad Request', status: 400, errors: [{ code: 21405, description: 'Błąd walidacji danych wejściowych.' }] }), {
        status: 400,
        headers: { 'content-type': 'application/problem+json' },
      }),
    );
    const { nadajUprawnieniaBiuru, klasyfikujBladUprawnien } = await klient();

    const blad = await nadajUprawnieniaBiuru(AUTH, nadanie()).catch((e: unknown) => e);

    expect(klasyfikujBladUprawnien(blad)).toMatchObject({ kod: 'ksef_21405' });
  });
});
