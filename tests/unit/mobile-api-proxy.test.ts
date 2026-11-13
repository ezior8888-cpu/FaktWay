import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Etap M6 planu aplikacji mobilnej (sekcja 4.3): API aplikacji na telefon.
 *
 * `/api/mobile/…` uwierzytelnia każda trasa sama, tokenem sesji Supabase
 * z nagłówka `Authorization: Bearer` (`lib/mobile-api/auth.ts`). Proxy nie
 * buduje dla nich klienta Supabase z ciasteczek: sesja przeglądarki nie
 * otwiera tam niczego (żadnego ryzyka CSRF), nie jest odświeżana, a proxy nie
 * odpowiada 401 „not_authenticated”, zanim trasa sprawdzi token telefonu.
 *
 * Przepuszczony jest TYLKO prefiks `/api/mobile` (dokładnie albo z `/`).
 * Sąsiednie adresy zostają za bramką sesji.
 */

const mocks = vi.hoisted(() => ({ create: vi.fn(), maintenance: vi.fn() }));
vi.mock('@supabase/ssr', async (importOriginal) => {
  const real = await importOriginal<typeof import('@supabase/ssr')>();
  mocks.create.mockImplementation(real.createServerClient);
  return { ...real, createServerClient: mocks.create };
});
vi.mock('@/lib/feature-flags/maintenance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/feature-flags/maintenance')>()),
  isMaintenanceMode: mocks.maintenance,
}));

import { isMobileApiPath, isPublicPath, updateSession } from '@/lib/supabase/middleware';

const SUPABASE_URL = 'https://fixture.supabase.test';
const COOKIE_NAME = 'sb-fixture-auth-token';
const userId = '22222222-2222-4222-8222-222222222222';

const MOBILE_PATHS = [
  '/api/mobile',
  '/api/mobile/v1',
  '/api/mobile/v1/konto',
  '/api/mobile/v1/sesja',
] as const;

const GATED_PATHS = [
  '/api/mobilex',
  '/api/mobile-old',
  '/api/mobil/v1/konto',
  '/api/mobiles/v1/konto',
  '/api/v1mobile',
  '/api',
] as const;

const b64url = (value: string) => Buffer.from(value).toString('base64url');

function sessionCookie(): string {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now - 60;
  const token = [
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64url(JSON.stringify({ sub: userId, aal: 'aal1', role: 'authenticated', aud: 'authenticated', iat: now - 3600, exp: expiresAt })),
    b64url('fixture-signature'),
  ].join('.');
  const session = {
    access_token: token, refresh_token: 'fixture-refresh', token_type: 'bearer',
    expires_in: -60, expires_at: expiresAt, user: { id: userId, aud: 'authenticated', role: 'authenticated' },
  };
  return `${COOKIE_NAME}=base64-${b64url(JSON.stringify(session))}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fixture-anon-key');
  mocks.maintenance.mockResolvedValue(false);
  // Każde wyjście do GoTrue albo PostgREST w tym teście to błąd.
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'no session' }, { status: 401 })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function request(path: string, withCookie: boolean) {
  return new NextRequest(`https://app.example.test${path}`, {
    headers: {
      authorization: 'Bearer fixture.token.telefonu',
      ...(withCookie ? { cookie: sessionCookie() } : {}),
    },
  });
}

describe('API aplikacji mobilnej przechodzi przez proxy bez sesji z ciasteczek', () => {
  describe.each(MOBILE_PATHS)('%s', (path) => {
    it.each([true, false])('z ciasteczkiem sesji: %s; bez klienta Supabase, bez Set-Cookie, do trasy', async (withCookie) => {
      expect(isMobileApiPath(path)).toBe(true);
      expect(isPublicPath(path)).toBe(true);

      const response = await updateSession(request(path, withCookie));

      expect(mocks.create).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      // Przerwę techniczną sprawdza trasa (`authenticateMobileRequest`), nie proxy.
      expect(mocks.maintenance).not.toHaveBeenCalled();
      expect(response.headers.get('x-middleware-next')).toBe('1');
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.status).toBe(200);
    });
  });
});

describe('sąsiednie adresy zostają za bramką sesji', () => {
  it.each(GATED_PATHS)('%s bez sesji: 401 z proxy, mimo nagłówka Bearer', async (path) => {
    expect(isMobileApiPath(path)).toBe(false);
    expect(isPublicPath(path)).toBe(false);

    const response = await updateSession(request(path, false));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'not_authenticated' });
  });
});
