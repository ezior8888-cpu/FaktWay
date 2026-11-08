import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KsefAuth, KsefAuthSession } from '@/lib/ksef/auth';

const mocks = vi.hoisted(() => ({
  xades: vi.fn(),
  token: vi.fn(),
  credentials: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/ksef/auth', () => ({ authenticateWithXades: mocks.xades }));
vi.mock('@/lib/ksef/auth-token', () => ({ authenticateWithToken: mocks.token }));
vi.mock('@/lib/supabase/admin-queries', () => ({
  getTenantKsefCredentials: mocks.credentials,
}));

import { ksefSessionCache } from '@/lib/ksef/session-cache';

const NOW = 1_700_000_000_000;
const NIP = '1234567890';

function xades(certificatePem: string, privateKeyPem: string): KsefAuth {
  return { type: 'xades', nip: NIP, certificatePem, privateKeyPem };
}

function token(value: string): KsefAuth {
  return { type: 'token', nip: NIP, token: value };
}

function session(accessToken: string, accessTokenExpiresAt = NOW + 60 * 60 * 1000): KsefAuthSession {
  return {
    accessToken,
    refreshToken: `refresh-${accessToken}`,
    accessTokenExpiresAt,
    refreshTokenExpiresAt: accessTokenExpiresAt + 60 * 60 * 1000,
    nip: NIP,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function refreshResponse(accessToken: string, validUntilMs: number): Response {
  return new Response(
    JSON.stringify({ accessToken: { token: accessToken, validUntil: new Date(validUntilMs).toISOString() } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function rejectedRefreshResponse(status: number): Response {
  return new Response(JSON.stringify({ message: 'atrapa odrzuconego refresh tokenu' }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function refreshCalls() {
  return mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith('/auth/token/refresh'));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  // Odświeżenie sesji idzie przez prawdziwe refreshKsefSession → ksefFetch →
  // globalny fetch. Bez atrapy test wysyłał POST /auth/token/refresh do KSeF
  // TEST i przechodził tylko dzięki temu, że KSeF odpowiadał 401. Żądanie bez
  // jawnej odpowiedzi w teście ma paść głośno, a nie wyjść do sieci.
  mocks.fetch.mockImplementation(async (url: unknown) => {
    throw new Error(`Test nie może iść do sieci: ${String(url)}`);
  });
  vi.stubGlobal('fetch', mocks.fetch);
  ksefSessionCache.invalidate(NIP, 'test');
  ksefSessionCache.invalidate(NIP, 'demo');
  ksefSessionCache.invalidate(NIP, 'production');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('KSeF session cache credential boundary', () => {
  it('reuses a session only for the same certificate and key, even with an unchanged NIP', async () => {
    const first = session('first-session');
    const second = session('second-session');
    const third = session('third-session');
    mocks.xades.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(third);

    const original = xades('CERT_A', 'PRIVATE_KEY_A');
    expect(await ksefSessionCache.getSession(original, 'test')).toBe(first);
    expect(await ksefSessionCache.getSession({ ...original }, 'test')).toBe(first);
    expect(await ksefSessionCache.getSession(xades('CERT_B', 'PRIVATE_KEY_A'), 'test')).toBe(second);
    expect(await ksefSessionCache.getSession(xades('CERT_B', 'PRIVATE_KEY_B'), 'test')).toBe(third);
    expect(mocks.xades).toHaveBeenCalledTimes(3);
  });

  it('re-authenticates after changing a KSeF token for the same NIP', async () => {
    const first = session('first-token-session');
    const second = session('second-token-session');
    mocks.token.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    expect(await ksefSessionCache.getSession(token('SECRET_TOKEN_A'), 'test')).toBe(first);
    expect(await ksefSessionCache.getSession(token('SECRET_TOKEN_A'), 'test')).toBe(first);
    expect(await ksefSessionCache.getSession(token('SECRET_TOKEN_B'), 'test')).toBe(second);
    expect(mocks.token).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a certificate session as a token session for the same NIP', async () => {
    const certificateSession = session('certificate-session');
    const tokenSession = session('token-session');
    mocks.xades.mockResolvedValue(certificateSession);
    mocks.token.mockResolvedValue(tokenSession);

    expect(await ksefSessionCache.getSession(xades('CERT_A', 'PRIVATE_KEY_A'), 'test')).toBe(certificateSession);
    expect(await ksefSessionCache.getSession(token('SECRET_TOKEN_A'), 'test')).toBe(tokenSession);
    expect(mocks.xades).toHaveBeenCalledOnce();
    expect(mocks.token).toHaveBeenCalledOnce();
  });

  it('isolates sessions by KSeF environment as well as NIP and credentials', async () => {
    const testSession = session('test-session');
    const prodSession = session('prod-session');
    mocks.xades.mockResolvedValueOnce(testSession).mockResolvedValueOnce(prodSession);
    const auth = xades('CERT_A', 'PRIVATE_KEY_A');

    expect(await ksefSessionCache.getSession(auth, 'test')).toBe(testSession);
    expect(await ksefSessionCache.getSession(auth, 'production')).toBe(prodSession);
    expect(await ksefSessionCache.getSession(auth, 'test')).toBe(testSession);
    expect(mocks.xades).toHaveBeenCalledTimes(2);
  });

  it('refreshes with the refresh token when the access token enters the five-minute expiry buffer', async () => {
    const first = session('nearly-expired', NOW + 5 * 60 * 1000 + 1000);
    mocks.xades.mockResolvedValueOnce(first);
    const auth = xades('CERT_A', 'PRIVATE_KEY_A');

    expect(await ksefSessionCache.getSession(auth, 'test')).toBe(first);
    vi.mocked(Date.now).mockReturnValue(NOW + 1000);
    expect(await ksefSessionCache.getSession(auth, 'test')).toBe(first);
    expect(mocks.fetch).not.toHaveBeenCalled();

    vi.mocked(Date.now).mockReturnValue(NOW + 1001);
    mocks.fetch.mockResolvedValueOnce(refreshResponse('refreshed', NOW + 20 * 60 * 1000));
    const refreshed = await ksefSessionCache.getSession(auth, 'test');

    expect(refreshed).toMatchObject({
      accessToken: 'refreshed',
      accessTokenExpiresAt: NOW + 20 * 60 * 1000,
      refreshToken: first.refreshToken,
      refreshTokenExpiresAt: first.refreshTokenExpiresAt,
    });
    expect(mocks.xades).toHaveBeenCalledOnce();
    expect(refreshCalls()).toHaveLength(1);
    const [, init] = refreshCalls()[0]!;
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${first.refreshToken}`);
  });

  it('falls back to a full XAdES login when KSeF rejects the refresh token inside the expiry buffer', async () => {
    const first = session('nearly-expired', NOW + 5 * 60 * 1000 + 1000);
    const second = session('after-rejected-refresh');
    mocks.xades.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const auth = xades('CERT_A', 'PRIVATE_KEY_A');

    expect(await ksefSessionCache.getSession(auth, 'test')).toBe(first);
    vi.mocked(Date.now).mockReturnValue(NOW + 1000);
    expect(await ksefSessionCache.getSession(auth, 'test')).toBe(first);
    expect(mocks.fetch).not.toHaveBeenCalled();

    vi.mocked(Date.now).mockReturnValue(NOW + 1001);
    mocks.fetch.mockResolvedValueOnce(rejectedRefreshResponse(401));
    expect(await ksefSessionCache.getSession(auth, 'test')).toBe(second);
    expect(refreshCalls()).toHaveLength(1);
    expect(mocks.xades).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent requests for matching credentials', async () => {
    const pending = deferred<KsefAuthSession>();
    mocks.xades.mockReturnValue(pending.promise);
    const auth = xades('CERT_A', 'PRIVATE_KEY_A');

    const first = ksefSessionCache.getSession(auth, 'test');
    const second = ksefSessionCache.getSession(auth, 'test');
    expect(mocks.xades).toHaveBeenCalledOnce();
    pending.resolve(session('shared-session'));
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
  });

  it('never joins an old pending auth flow after rotating credentials', async () => {
    const oldPending = deferred<KsefAuthSession>();
    const newPending = deferred<KsefAuthSession>();
    mocks.xades.mockReturnValueOnce(oldPending.promise).mockReturnValueOnce(newPending.promise);
    const oldAuth = xades('CERT_OLD', 'PRIVATE_KEY_OLD');
    const newAuth = xades('CERT_NEW', 'PRIVATE_KEY_NEW');

    const oldRequest = ksefSessionCache.getSession(oldAuth, 'test');
    const newRequest = ksefSessionCache.getSession(newAuth, 'test');
    expect(mocks.xades).toHaveBeenCalledTimes(2);

    const newSession = session('new-session');
    newPending.resolve(newSession);
    expect(await newRequest).toBe(newSession);
    oldPending.resolve(session('old-session'));
    await oldRequest;
    expect(await ksefSessionCache.getSession(newAuth, 'test')).toBe(newSession);
    expect(mocks.xades).toHaveBeenCalledTimes(2);
  });

  it('does not revive an invalidated in-flight session', async () => {
    const oldPending = deferred<KsefAuthSession>();
    const replacement = session('replacement-session');
    mocks.xades.mockReturnValueOnce(oldPending.promise).mockResolvedValueOnce(replacement);
    const auth = xades('CERT_A', 'PRIVATE_KEY_A');

    const oldRequest = ksefSessionCache.getSession(auth, 'test');
    ksefSessionCache.invalidate(NIP, 'test');
    expect(await ksefSessionCache.getSession(auth, 'test')).toBe(replacement);
    oldPending.resolve(session('invalidated-session'));
    await oldRequest;
    expect(await ksefSessionCache.getSession(auth, 'test')).toBe(replacement);
    expect(mocks.xades).toHaveBeenCalledTimes(2);
  });
});
