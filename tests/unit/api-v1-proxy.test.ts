import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Krok 7.1 planu kompletnej aplikacji (publiczne API, część 1).
 *
 * `/api/v1/…` uwierzytelnia każda trasa sama, kluczem API z nagłówka
 * `Authorization: Bearer`, a `/api/docs` to statyczna dokumentacja. Proxy nie
 * może dla nich budować klienta Supabase z ciasteczek: sesja przeglądarki nie
 * otwiera ani nie odświeża niczego w API, a bez ciasteczek proxy nie może
 * odpowiedzieć 401 „not_authenticated”, zanim trasa sprawdzi klucz.
 *
 * Przepuszczone są TYLKO te dwa prefiksy. Sąsiednie adresy (`/api/v10`,
 * `/api/v1x`, `/api/docsy`, reszta `/api/*`) zostają za bramką sesji.
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

import { isPublicApiPath, isPublicPath, updateSession } from '@/lib/supabase/middleware';

const SUPABASE_URL = 'https://fixture.supabase.test';
const COOKIE_NAME = 'sb-fixture-auth-token';
const userId = '22222222-2222-4222-8222-222222222222';

const API_PATHS = [
  '/api/v1',
  '/api/v1/invoices',
  '/api/v1/invoices/11111111-1111-4111-8111-111111111111',
  '/api/v1/expenses',
  '/api/docs',
  '/api/docs/openapi.json',
  '/api/mcp',
] as const;

const GATED_PATHS = [
  '/api/v10/invoices',
  '/api/v1x',
  '/api/v1-invoices',
  '/api/v2/invoices',
  '/api/docsy',
  '/api/docs-old',
  '/api/mcpx',
  '/api/mcp-old',
  '/api/invoices',
  '/api/ksef/status',
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
      authorization: 'Bearer fwk_fixture',
      ...(withCookie ? { cookie: sessionCookie() } : {}),
    },
  });
}

describe('publiczne API przechodzi przez proxy bez sesji', () => {
  describe.each(API_PATHS)('%s', (path) => {
    it.each([true, false])('z ciasteczkiem sesji: %s; bez klienta Supabase, bez Set-Cookie, do trasy', async (withCookie) => {
      expect(isPublicApiPath(path)).toBe(true);
      expect(isPublicPath(path)).toBe(true);

      const response = await updateSession(request(path, withCookie));

      expect(mocks.create).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(response.headers.get('x-middleware-next')).toBe('1');
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.status).toBe(200);
    });
  });
});

describe('sąsiednie adresy zostają za bramką sesji', () => {
  it.each(GATED_PATHS)('%s bez sesji: 401 z proxy, mimo nagłówka Bearer', async (path) => {
    expect(isPublicApiPath(path)).toBe(false);
    expect(isPublicPath(path)).toBe(false);

    const response = await updateSession(request(path, false));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'not_authenticated' });
  });
});
