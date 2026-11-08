import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Plan skalowania 3000, sesja 2 (REQ-05, CAC-04, CPU-08).
 *
 * `/sw.js`, `/manifest.webmanifest`, `/robots.txt` i `/sitemap.xml` to pliki
 * techniczne: ta sama odpowiedź dla każdego, bez danych firmy. Przechodziły
 * jednak pełną bramkę sesji w proxy, co przy kluczu HS256 znaczy wywołanie
 * GoTrue przez sieć (`getClaims()` spada do `getUser()`), a po wygaśnięciu
 * tokenu także odświeżenie sesji. Przeglądarka sprawdza `/sw.js` przy pełnych
 * nawigacjach w zasięgu workera i pobiera manifest, a roboty wyszukiwarek
 * pobierają `robots.txt` i `sitemap.xml`.
 *
 * Skutek uboczny: odpowiedź z odświeżonym ciasteczkiem niesie `Set-Cookie`
 * i `Cache-Control: private, no-store` (#348), więc plik wspólny dla
 * wszystkich dostawał nagłówki prywatnej odpowiedzi. Naprawa ich nie zastępuje
 * nagłówkami cache'u: te ustala sama trasa, a żądanie dalej przechodzi przez
 * proxy, tylko bez klienta Supabase.
 *
 * Test używa PRAWDZIWEGO klienta `@supabase/ssr` (opakowanego szpiegiem)
 * i liczy żądania do GoTrue na atrapie `fetch`. Stan `expired` sprawdza
 * najgorszy przypadek: bez naprawy sesja naprawdę się odświeża.
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

import { isNoSessionPath, isPublicPath, updateSession } from '@/lib/supabase/middleware';

const SUPABASE_URL = 'https://fixture.supabase.test';
const COOKIE_NAME = 'sb-fixture-auth-token';
const userId = '22222222-2222-4222-8222-222222222222';

/** Pliki techniczne z sesji 2: te same bajty dla każdego, kto pyta. */
const TECHNICAL_PATHS = ['/sw.js', '/manifest.webmanifest', '/robots.txt', '/sitemap.xml'] as const;

let authCalls: string[];
let refreshCalls: number;

const b64url = (value: string) => Buffer.from(value).toString('base64url');

function jwt(exp: number): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64url(JSON.stringify({
      sub: userId, aal: 'aal2', role: 'authenticated', aud: 'authenticated',
      iat: now, exp, session_id: 'fixture-session',
    })),
    b64url('fixture-signature'),
  ].join('.');
}

function session(expiresAt: number, refreshToken: string) {
  return {
    access_token: jwt(expiresAt), refresh_token: refreshToken, token_type: 'bearer',
    expires_in: expiresAt - Math.floor(Date.now() / 1000), expires_at: expiresAt,
    user: { id: userId, aud: 'authenticated', role: 'authenticated' },
  };
}

type SessionState = 'expired' | 'valid' | 'none';

function sessionCookie(state: Exclude<SessionState, 'none'>): string {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = state === 'expired' ? now - 60 : now + 3600;
  return `${COOKIE_NAME}=base64-${b64url(JSON.stringify(session(expiresAt, 'fixture-refresh-1')))}`;
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
    refreshCalls += 1;
    return Response.json(session(Math.floor(Date.now() / 1000) + 3600, 'fixture-refresh-2'));
  }
  if (url.pathname.startsWith('/auth/v1/')) {
    authCalls.push(url.pathname);
    return Response.json({
      id: userId, aud: 'authenticated', role: 'authenticated',
      factors: [{ id: 'fixture-factor', factor_type: 'totp', status: 'verified' }],
    });
  }
  if (url.pathname.startsWith('/rest/v1/')) return Response.json([]);
  throw new Error(`Nieoczekiwane żądanie w teście proxy: ${url.href}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  authCalls = [];
  refreshCalls = 0;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fixture-anon-key');
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
  mocks.maintenance.mockResolvedValue(false);
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function request(path: string, state: SessionState) {
  return new NextRequest(`https://app.example.test${path}`, {
    headers: state === 'none' ? undefined : { cookie: sessionCookie(state) },
  });
}

describe('pliki techniczne nie tworzą klienta Supabase', () => {
  describe.each(TECHNICAL_PATHS)('%s', (path) => {
    it.each(['valid', 'expired', 'none'] as const)('sesja %s: bez GoTrue i bez Set-Cookie', async (state) => {
      const response = await updateSession(request(path, state));

      expect(mocks.create).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(authCalls).toEqual([]);
      expect(refreshCalls).toBe(0);
      // Przepuszczone do trasy. Proxy nie dokłada `Set-Cookie` ani `no-store`,
      // więc nagłówki cache'u ustala sama trasa.
      expect(response.headers.get('x-middleware-next')).toBe('1');
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.headers.get('cache-control')).toBeNull();
    });
  });

  it('kontrola: na zwykłej stronie wygasły token naprawdę się odświeża', async () => {
    const response = await updateSession(request('/pricing', 'expired'));

    expect(mocks.create).toHaveBeenCalledOnce();
    expect(refreshCalls).toBe(1);
    expect(response.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE_NAME}=`))).toBe(true);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});

describe('isNoSessionPath deleguje do tuneli telemetrii', () => {
  // `/ingest` i `/monitoring` obsługuje `lib/telemetry-tunnel.ts` (#349),
  // wołane w `proxy.ts` przed `updateSession`. Jedna lista, żeby obie
  // ścieżki nie rozjechały się przy następnej zmianie.
  it.each([
    '/ingest', '/ingest/', '/ingest/e/', '/ingest/static/array.js',
    '/monitoring', '/monitoring/', '/MONITORING', '/Ingest/e/',
  ])('tunel %s jest ścieżką bez sesji i ścieżką publiczną', (path) => {
    expect(isNoSessionPath(path)).toBe(true);
    expect(isPublicPath(path)).toBe(true);
  });

  it.each(TECHNICAL_PATHS)('plik techniczny %s jest ścieżką bez sesji i ścieżką publiczną', (path) => {
    expect(isNoSessionPath(path)).toBe(true);
    expect(isPublicPath(path)).toBe(true);
  });
});

describe('trasy o podobnym prefiksie dalej wymagają sesji', () => {
  // Dokładne dopasowanie, nie prefiks. `/ingestion` i `/ingest-raport` były
  // publiczne przez `startsWith('/ingest')` w `isPublicPath` — Next nie
  // przepisuje ich do PostHog, więc nie ma powodu, by je przepuszczać.
  it.each([
    '/sw.js.map', '/sw.js/', '/sw.jsx', '/sw.js/extra',
    '/manifest.json', '/manifest.webmanifest/', '/manifest.webmanifest.gz',
    '/robots.txt/', '/robots.txt/extra', '/robotstxt',
    '/sitemap.xml.gz', '/sitemap.xml/', '/sitemap',
    '/ingestion', '/ingest-raport', '/INGESTION',
    '/monitoringx', '/monitoring/raport',
  ])('%s', async (path) => {
    expect(isNoSessionPath(path)).toBe(false);
    expect(isPublicPath(path)).toBe(false);

    const anonymous = await updateSession(request(path, 'none'));
    expect(anonymous.status).toBe(307);
    const target = new URL(anonymous.headers.get('location')!);
    // Żądanie z końcowym ukośnikiem Next przepisuje na `/login/` (normalizacja
    // `NextURL`), więc porównujemy ścieżkę bez niego.
    expect(target.pathname.replace(/\/$/, '')).toBe('/login');
    expect(target.searchParams.get('redirect')).toBe(path);
  });
});
