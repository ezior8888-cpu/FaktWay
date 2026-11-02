import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Plan skalowania 3000, sesja 1 (REQ-03, CAC-01, HOR-07, CPU-02).
 *
 * Baner KSeF odpytuje `/api/ksef/health` z każdej otwartej karty panelu.
 * Trasa nie zwraca danych firmy, a przechodziła pełną bramkę proxy:
 * `getClaims()` i weryfikację MFA. Przy kluczu HS256 każde z tych sprawdzeń
 * może iść do GoTrue przez sieć, czyli do 3 wywołań `/auth/v1/user` na takt.
 *
 * Test używa PRAWDZIWEGO klienta `@supabase/ssr` (opakowanego szpiegiem)
 * i liczy żądania do `/auth/v1/*` na atrapie `fetch`. Sesja w ciasteczku
 * ma token HS256 — najgorszy przypadek, w którym każde sprawdzenie idzie
 * do GoTrue.
 */

const mocks = vi.hoisted(() => ({ create: vi.fn(), flag: vi.fn() }));
vi.mock('@supabase/ssr', async (importOriginal) => {
  const real = await importOriginal<typeof import('@supabase/ssr')>();
  mocks.create.mockImplementation(real.createServerClient);
  return { ...real, createServerClient: mocks.create };
});
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: mocks.flag }));

import { isNoSessionPath, isPublicPath, updateSession } from '@/lib/supabase/middleware';

const SUPABASE_URL = 'https://fixture.supabase.test';
const COOKIE_NAME = 'sb-fixture-auth-token';
const userId = '22222222-2222-4222-8222-222222222222';

let authCalls: string[];

const b64url = (value: string) => Buffer.from(value).toString('base64url');

function sessionCookie(): string {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = [
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64url(JSON.stringify({
      sub: userId, aal: 'aal2', role: 'authenticated', aud: 'authenticated',
      iat: now, exp: now + 3600, session_id: 'fixture-session',
    })),
    b64url('fixture-signature'),
  ].join('.');
  const session = {
    access_token: accessToken, refresh_token: 'fixture-refresh', token_type: 'bearer',
    expires_in: 3600, expires_at: now + 3600,
    user: { id: userId, aud: 'authenticated', role: 'authenticated' },
  };
  return `${COOKIE_NAME}=base64-${b64url(JSON.stringify(session))}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  authCalls = [];
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fixture-anon-key');
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_MOBILE_PANEL', 'off');
  vi.stubEnv('NEXT_PUBLIC_MOBILE_PANEL_ALLOWLIST', '');
  mocks.flag.mockResolvedValue(false);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/auth/v1/')) {
      authCalls.push(new URL(url).pathname);
      return Response.json({
        id: userId, aud: 'authenticated', role: 'authenticated',
        factors: [{ id: 'fixture-factor', factor_type: 'totp', status: 'verified' }],
      });
    }
    throw new Error(`Nieoczekiwane żądanie w teście proxy: ${url}`);
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function request(path: string, withSession: boolean) {
  return new NextRequest('https://app.example.test' + path, {
    headers: withSession ? { cookie: sessionCookie() } : undefined,
  });
}

it('takt banera z ciasteczkiem sesji nie woła GoTrue i nie tworzy klienta Supabase', async () => {
  const response = await updateSession(request('/api/ksef/health', true));

  expect(authCalls).toEqual([]);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.flag).not.toHaveBeenCalled();
  // Przepuszczone do trasy, bez odświeżonego ciasteczka. Dopiero to pozwala
  // trasie ustawić Cache-Control z max-age: odpowiedź jest taka sama dla
  // każdego i nie niesie cudzej sesji.
  expect(response.headers.get('x-middleware-next')).toBe('1');
  expect(response.headers.get('set-cookie')).toBeNull();
});

it('takt banera bez sesji też przechodzi do trasy (zamiast 401)', async () => {
  const response = await updateSession(request('/api/ksef/health', false));

  expect(response.status).toBe(200);
  expect(response.headers.get('x-middleware-next')).toBe('1');
  expect(authCalls).toEqual([]);
});

it('ścieżka bez sesji jest też ścieżką publiczną', () => {
  expect(isNoSessionPath('/api/ksef/health')).toBe(true);
  expect(isPublicPath('/api/ksef/health')).toBe(true);
});

// Dokładna ścieżka, nie prefiks: sąsiednie trasy KSeF zwracają dane firmy.
it.each([
  '/api/ksef/health/',
  '/api/ksef/health/details',
  '/api/ksef/healthz',
  '/api/ksef/health.json',
  '/api/ksef',
  '/api/ksef/status',
])('trasa o podobnym prefiksie %s dalej wymaga sesji', async (path) => {
  expect(isNoSessionPath(path)).toBe(false);
  expect(isPublicPath(path)).toBe(false);

  const anonymous = await updateSession(request(path, false));
  expect(anonymous.status).toBe(401);
  expect(await anonymous.json()).toEqual({ error: 'not_authenticated' });

  // Z sesją pełna bramka: getClaims + getUser(token) + getClaims(token).
  // Sesja 8 planu skalowania ma to zmniejszyć do 1 — wtedy zmień świadomie.
  authCalls = [];
  const signedIn = await updateSession(request(path, true));
  expect(signedIn.status).toBe(200);
  expect(authCalls).toEqual(['/auth/v1/user', '/auth/v1/user', '/auth/v1/user']);
});
