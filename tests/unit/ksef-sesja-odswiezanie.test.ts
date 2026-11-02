import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KsefAuth, KsefAuthSession } from '@/lib/ksef/auth';

/**
 * Sesja 14 planu skalowania (KSEF-08): dawniej każde wygaśnięcie tokenu dostępu
 * (kilkanaście minut) oznaczało pełne logowanie XAdES: kilka żądań, podpis RSA,
 * 2-4 s czekania. Firma odpytywana co 15 minut logowała się przy każdym przebiegu.
 *
 * Teraz: odświeżenie przez refresh token (OpenAPI KSeF: `POST /auth/token/refresh`,
 * `Authorization: Bearer {refreshToken}`, odpowiedź tylko `accessToken`), pełne
 * logowanie dopiero po odrzuceniu. Tokeny żyją wyłącznie w pamięci procesu.
 */

const mocks = vi.hoisted(() => ({
  xades: vi.fn(),
  token: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/ksef/auth', () => ({ authenticateWithXades: mocks.xades }));
vi.mock('@/lib/ksef/auth-token', () => ({ authenticateWithToken: mocks.token }));
vi.mock('@/lib/supabase/admin-queries', () => ({ getTenantKsefCredentials: vi.fn() }));

import { KsefApiError } from '@/lib/ksef/client';
import { KSEF_SESSION_CACHE_MAX_ENTRIES, ksefSessionCache } from '@/lib/ksef/session-cache';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const NIP = '1234567890';

function xades(nip = NIP, cert = 'CERT_A'): KsefAuth {
  return { type: 'xades', nip, certificatePem: cert, privateKeyPem: 'KLUCZ' };
}

function session(accessToken: string, overrides: Partial<KsefAuthSession> = {}): KsefAuthSession {
  return {
    accessToken,
    refreshToken: `refresh-${accessToken}`,
    accessTokenExpiresAt: NOW + 15 * MIN,
    refreshTokenExpiresAt: NOW + 7 * 24 * 60 * MIN,
    nip: NIP,
    ...overrides,
  };
}

function refreshResponse(token: string, validUntilMs: number) {
  return new Response(
    JSON.stringify({ accessToken: { token, validUntil: new Date(validUntilMs).toISOString() } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function errorResponse(status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ message: 'atrapa' }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function refreshCalls() {
  return mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith('/auth/token/refresh'));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubEnv('KSEF_ENV', 'test');
  ksefSessionCache.invalidate(NIP, 'test');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('odświeżanie sesji KSeF', () => {
  it('token dostępu wygasa, refresh token ważny: jedno żądanie refresh, bez logowania XAdES', async () => {
    mocks.xades.mockResolvedValueOnce(session('pierwszy'));
    const auth = xades();
    await ksefSessionCache.getSession(auth, 'test');

    vi.mocked(Date.now).mockReturnValue(NOW + 11 * MIN);
    mocks.fetch.mockResolvedValueOnce(refreshResponse('drugi', NOW + 26 * MIN));
    const refreshed = await ksefSessionCache.getSession(auth, 'test');

    expect(mocks.xades).toHaveBeenCalledOnce();
    expect(refreshed.accessToken).toBe('drugi');
    expect(refreshed.accessTokenExpiresAt).toBe(NOW + 26 * MIN);
    // KSeF nie oddaje nowego refresh tokenu: stary działa dalej aż do swojego końca.
    expect(refreshed.refreshToken).toBe('refresh-pierwszy');
    expect(refreshed.refreshTokenExpiresAt).toBe(NOW + 7 * 24 * 60 * MIN);

    const [url, init] = refreshCalls()[0]!;
    expect(String(url)).toMatch(/\/auth\/token\/refresh$/);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer refresh-pierwszy');

    // Trzecie pytanie z nowym tokenem: bez żadnego żądania.
    await ksefSessionCache.getSession(auth, 'test');
    expect(refreshCalls()).toHaveLength(1);
  });

  it('firma zimna (6 h przerwy) dalej odświeża, bez XAdES', async () => {
    mocks.xades.mockResolvedValueOnce(session('pierwszy'));
    const auth = xades();
    await ksefSessionCache.getSession(auth, 'test');
    vi.mocked(Date.now).mockReturnValue(NOW + 360 * MIN);
    mocks.fetch.mockResolvedValueOnce(refreshResponse('po-6-h', NOW + 375 * MIN));
    await expect(ksefSessionCache.getSession(auth, 'test')).resolves.toMatchObject({ accessToken: 'po-6-h' });
    expect(mocks.xades).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 403])('KSeF odrzuca refresh (%i): dopiero wtedy pełne logowanie', async (status) => {
    mocks.xades.mockResolvedValueOnce(session('pierwszy')).mockResolvedValueOnce(session('nowa-sesja'));
    const auth = xades();
    await ksefSessionCache.getSession(auth, 'test');

    vi.mocked(Date.now).mockReturnValue(NOW + 11 * MIN);
    mocks.fetch.mockResolvedValueOnce(errorResponse(status));
    await expect(ksefSessionCache.getSession(auth, 'test')).resolves.toMatchObject({ accessToken: 'nowa-sesja' });
    expect(mocks.xades).toHaveBeenCalledTimes(2);
  });

  it.each([429, 500, 503])('KSeF nie odpowiada na refresh (%i): błąd idzie wyżej, bez logowania, sesja zostaje', async (status) => {
    mocks.xades.mockResolvedValueOnce(session('pierwszy'));
    const auth = xades();
    await ksefSessionCache.getSession(auth, 'test');

    vi.mocked(Date.now).mockReturnValue(NOW + 11 * MIN);
    mocks.fetch.mockResolvedValueOnce(errorResponse(status, { 'retry-after': '120' }));
    await expect(ksefSessionCache.getSession(auth, 'test')).rejects.toBeInstanceOf(KsefApiError);
    expect(mocks.xades).toHaveBeenCalledOnce();

    // Następny przebieg próbuje znów odświeżyć, nie logować.
    mocks.fetch.mockResolvedValueOnce(refreshResponse('udalo-sie', NOW + 26 * MIN));
    await expect(ksefSessionCache.getSession(auth, 'test')).resolves.toMatchObject({ accessToken: 'udalo-sie' });
    expect(mocks.xades).toHaveBeenCalledOnce();
  });

  it('refresh token wygasł: pełne logowanie, bez próby odświeżenia', async () => {
    mocks.xades
      .mockResolvedValueOnce(session('pierwszy', { refreshTokenExpiresAt: NOW + 20 * MIN }))
      .mockResolvedValueOnce(session('nowa-sesja'));
    const auth = xades();
    await ksefSessionCache.getSession(auth, 'test');

    vi.mocked(Date.now).mockReturnValue(NOW + 30 * MIN);
    await ksefSessionCache.getSession(auth, 'test');
    expect(refreshCalls()).toHaveLength(0);
    expect(mocks.xades).toHaveBeenCalledTimes(2);
  });

  it('nowy certyfikat: pełne logowanie, starego refresh tokenu nie używamy', async () => {
    mocks.xades.mockResolvedValueOnce(session('stary')).mockResolvedValueOnce(session('nowy-cert'));
    await ksefSessionCache.getSession(xades(NIP, 'CERT_A'), 'test');
    vi.mocked(Date.now).mockReturnValue(NOW + 11 * MIN);
    await expect(ksefSessionCache.getSession(xades(NIP, 'CERT_B'), 'test')).resolves.toMatchObject({ accessToken: 'nowy-cert' });
    expect(refreshCalls()).toHaveLength(0);
  });

  it('równoległe żądania tej samej firmy: jedno odświeżenie', async () => {
    mocks.xades.mockResolvedValueOnce(session('pierwszy'));
    const auth = xades();
    await ksefSessionCache.getSession(auth, 'test');

    vi.mocked(Date.now).mockReturnValue(NOW + 11 * MIN);
    let resolve!: (r: Response) => void;
    mocks.fetch.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
    const first = ksefSessionCache.getSession(auth, 'test');
    const second = ksefSessionCache.getSession(auth, 'test');
    resolve(refreshResponse('wspolny', NOW + 26 * MIN));
    const [a, b] = await Promise.all([first, second]);
    expect(a.accessToken).toBe('wspolny');
    expect(b).toBe(a);
    expect(refreshCalls()).toHaveLength(1);
  });

  it('invalidate po 401 z API: następne pytanie loguje od nowa, bez refresh', async () => {
    mocks.xades.mockResolvedValueOnce(session('pierwszy')).mockResolvedValueOnce(session('po-401'));
    const auth = xades();
    await ksefSessionCache.getSession(auth, 'test');
    ksefSessionCache.invalidate(NIP, 'test');
    await expect(ksefSessionCache.getSession(auth, 'test')).resolves.toMatchObject({ accessToken: 'po-401' });
    expect(refreshCalls()).toHaveLength(0);
  });

  it('pamięć ma sufit: najdłużej nieużywane sesje wypadają, reszta zostaje', async () => {
    mocks.xades.mockImplementation(async (auth: { nip: string }) => session(`s-${auth.nip}`, { nip: auth.nip }));
    const firstNip = '1000000000';
    await ksefSessionCache.getSession(xades(firstNip), 'test');
    for (let i = 1; i <= KSEF_SESSION_CACHE_MAX_ENTRIES; i += 1) {
      await ksefSessionCache.getSession(xades(String(1000000000 + i)), 'test');
    }
    expect(ksefSessionCache.size()).toBeLessThanOrEqual(KSEF_SESSION_CACHE_MAX_ENTRIES);
    const logins = mocks.xades.mock.calls.length;
    await ksefSessionCache.getSession(xades(firstNip), 'test');
    expect(mocks.xades.mock.calls.length).toBe(logins + 1);
    await ksefSessionCache.getSession(xades(String(1000000000 + KSEF_SESSION_CACHE_MAX_ENTRIES)), 'test');
    expect(mocks.xades.mock.calls.length).toBe(logins + 1);
    for (let i = 0; i <= KSEF_SESSION_CACHE_MAX_ENTRIES; i += 1) {
      ksefSessionCache.invalidate(String(1000000000 + i), 'test');
    }
  });
});
