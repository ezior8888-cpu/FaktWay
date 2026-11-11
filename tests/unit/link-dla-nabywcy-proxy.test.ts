import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Krok 2.10 planu kompletnej aplikacji: strona faktury dla nabywcy
 * (`/faktura/<token>`) jest publiczna, ale TYLKO ta ścieżka i jej pliki.
 * Proxy (`lib/supabase/middleware.ts`) przepuszcza ją bez logowania i dokłada
 * nagłówki prywatnej strony: bez indeksowania, bez cache, bez Referer (token
 * jest w adresie). Ścieżki o podobnym początku dalej prowadzą na logowanie.
 *
 * Token w adresie nie może też trafić do telemetrii: Sentry wycina go jak
 * token portalu księgowej, a PostHog widzi tylko `/[redacted]`.
 *
 * Prawdziwy klient `@supabase/ssr`; atrapa tylko dla HTTP (GoTrue).
 */

const mocks = vi.hoisted(() => ({ maintenance: vi.fn() }));
vi.mock('@/lib/feature-flags/maintenance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/feature-flags/maintenance')>()),
  isMaintenanceMode: mocks.maintenance,
}));

import { isPublicPath, updateSession } from '@/lib/supabase/middleware';
import { scrubTelemetryText } from '@/lib/observability/scrub';
import { sanitizeAnalyticsUrl } from '@/lib/analytics/privacy';

const SUPABASE_URL = 'https://fixture.supabase.test';
const COOKIE_NAME = 'sb-fixture-auth-token';
const userId = '22222222-2222-4222-8222-222222222222';
/** 43 znaki base64url, jak token z `generateAccountantToken` (32 bajty losowe). */
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';

const b64url = (value: string) => Buffer.from(value).toString('base64url');

function validSessionCookie(): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600;
  const jwt = [
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64url(JSON.stringify({ sub: userId, aal: 'aal1', role: 'authenticated', aud: 'authenticated', iat: now, exp, session_id: 's' })),
    b64url('fixture-signature'),
  ].join('.');
  const session = {
    access_token: jwt, refresh_token: 'fixture-refresh', token_type: 'bearer',
    expires_in: 3600, expires_at: exp,
    user: { id: userId, aud: 'authenticated', role: 'authenticated' },
  };
  return `${COOKIE_NAME}=base64-${b64url(JSON.stringify(session))}`;
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname.startsWith('/auth/v1/')) {
    return Response.json({ id: userId, aud: 'authenticated', role: 'authenticated', factors: [] });
  }
  if (url.pathname.startsWith('/rest/v1/')) return Response.json([]);
  throw new Error(`Nieoczekiwane żądanie w teście proxy: ${url.href}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fixture-anon-key');
  mocks.maintenance.mockResolvedValue(false);
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function request(path: string, loggedIn: boolean) {
  return new NextRequest(`https://app.example.test${path}`, {
    headers: loggedIn ? { cookie: validSessionCookie() } : undefined,
  });
}

const BUYER_PATHS = [`/faktura/${TOKEN}`, `/faktura/${TOKEN}/pdf`, `/faktura/${TOKEN}/xml`] as const;

describe('strona faktury dla nabywcy w proxy', () => {
  describe.each(BUYER_PATHS)('%s', (path) => {
    it('jest publiczna', () => {
      expect(isPublicPath(path)).toBe(true);
    });

    it.each([false, true])('zalogowany=%s: bez przekierowania na logowanie, z nagłówkami prywatnej strony', async (loggedIn) => {
      const response = await updateSession(request(path, loggedIn));
      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('x-robots-tag')).toMatch(/noindex/);
      expect(response.headers.get('x-robots-tag')).toMatch(/nofollow/);
      expect(response.headers.get('cache-control')).toMatch(/no-store/);
      expect(response.headers.get('cache-control')).toMatch(/private/);
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    });
  });

  it('inna strona publiczna nie dostaje nagłówka noindex strony nabywcy', async () => {
    const response = await updateSession(request('/pricing', false));
    expect(response.headers.get('x-robots-tag')).toBeNull();
  });

  it.each([
    '/faktura',
    '/faktura/',
    '/fakturax/abc',
    '/faktury/abc',
    '/fakturaabc',
    '/invoices/abc',
  ])('%s nie jest publiczna i prowadzi na logowanie', async (path) => {
    expect(isPublicPath(path)).toBe(false);
    const response = await updateSession(request(path, false));
    expect(response.status).toBe(307);
    const target = new URL(response.headers.get('location')!);
    expect(target.pathname.replace(/\/$/, '')).toBe('/login');
  });

  it('/api/faktura/... nie jest publiczne (API bez sesji dostaje 401)', async () => {
    expect(isPublicPath(`/api/faktura/${TOKEN}`)).toBe(false);
    const response = await updateSession(request(`/api/faktura/${TOKEN}`, false));
    expect(response.status).toBe(401);
  });
});

describe('token z adresu strony nabywcy nie trafia do telemetrii', () => {
  it('Sentry wycina token z adresu strony i plików', () => {
    for (const path of BUYER_PATHS) {
      const scrubbed = scrubTelemetryText(`GET https://faktway.pl${path}`);
      expect(scrubbed).not.toContain(TOKEN);
      expect(scrubbed).toContain('/faktura/[REDACTED]');
    }
  });

  it('PostHog widzi tylko ukryty adres', () => {
    expect(sanitizeAnalyticsUrl(`https://faktway.pl/faktura/${TOKEN}`)).toBe('/[redacted]');
  });
});
