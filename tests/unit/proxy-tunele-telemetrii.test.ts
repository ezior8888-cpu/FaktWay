import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { modifyRouteRegex } from 'next/dist/lib/redirect-status';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';

/**
 * `/ingest/*` (PostHog) i `/monitoring` (tunel Sentry) Next przepisuje na
 * zewnętrzne serwery (`next.config.ts`: `rewrites()` i `tunnelRoute`), a proxy
 * traktowało je jak każdą inną stronę:
 *
 *  - Next wysyła do serwera docelowego nagłówki żądania z listy, którą oddaje
 *    proxy (`x-middleware-override-headers` z `NextResponse.next({ request })`),
 *    a każdy inny nagłówek odpowiedzi proxy — także `set-cookie` — dokleja do
 *    żądania (`next/dist/server/lib/router-utils/resolve-routes.js`). Do
 *    PostHog i Sentry szły więc ciasteczka przeglądarki, a po odświeżeniu
 *    sesji także nowe tokeny.
 *  - Przy przepisaniu na zewnętrzny adres Next porzuca nagłówki odpowiedzi
 *    proxy (`resHeaders: null`). Sesja odświeżona w proxy nie docierała do
 *    przeglądarki, która zostawała ze zużytym refresh tokenem.
 *
 * Test woła prawdziwe `proxy()` z prawdziwym `@supabase/ssr`. Atrapa `fetch`
 * gra GoTrue, a ciasteczko niesie WYGASŁY token, więc bez naprawy
 * `getClaims()` naprawdę odświeża sesję. Co dostaje serwer docelowy, liczy
 * `forwardedHeaders` — odtworzenie reguł z `resolve-routes.js` (Next 16.4).
 */

const mocks = vi.hoisted(() => ({ maintenance: vi.fn() }));
vi.mock('@/lib/feature-flags/maintenance', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/feature-flags/maintenance')>(),
  isMaintenanceMode: mocks.maintenance,
}));

import { config, proxy } from '@/proxy';
import { isTelemetryTunnelPath } from '@/lib/telemetry-tunnel';

const SUPABASE_URL = 'https://fixture.supabase.test';
const COOKIE_NAME = 'sb-fixture-auth-token';
const POSTHOG_COOKIE = 'ph_phc_fixture_posthog=%7B%22distinct_id%22%3A%22fixture%22%7D';
const userId = '22222222-2222-4222-8222-222222222222';

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
  if (url.pathname === '/auth/v1/user') {
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
  refreshCalls = 0;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fixture-anon-key');
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_MOBILE_PANEL', 'off');
  vi.stubEnv('NEXT_PUBLIC_MOBILE_PANEL_ALLOWLIST', '');
  vi.stubEnv('LEGACY_HOST_REDIRECT', '');
  mocks.maintenance.mockResolvedValue(false);
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function request(path: string, state: SessionState, init: { method?: string; body?: string } = {}) {
  const cookies = [POSTHOG_COOKIE];
  if (state !== 'none') cookies.unshift(sessionCookie(state));
  return new NextRequest(`https://app.example.test${path}`, {
    method: init.method ?? 'GET',
    body: init.body,
    headers: {
      cookie: cookies.join('; '),
      'user-agent': 'Mozilla/5.0 (fixture)',
      'content-type': 'text/plain',
    },
  });
}

/**
 * Nagłówki żądania, które Next 16.4 wyśle do celu przepisania po przejściu
 * przez proxy (`resolve-routes.js`, obsługa odpowiedzi proxy): lista
 * `x-middleware-override-headers` zastępuje nagłówki żądania wartościami
 * z `x-middleware-request-*`, a pozostałe nagłówki odpowiedzi proxy (poza
 * wewnętrznymi `x-middleware-*`) są doklejane do żądania — także `set-cookie`.
 */
function forwardedHeaders(req: NextRequest, res: Response): Headers {
  const out = new Headers(req.headers);
  const override = res.headers.get('x-middleware-override-headers');
  if (override !== null) {
    const keep = new Set(override.split(',').map((key) => key.trim()));
    for (const key of [...out.keys()]) if (!keep.has(key)) out.delete(key);
    for (const key of keep) {
      const value = res.headers.get(`x-middleware-request-${key}`);
      if (value === null) out.delete(key);
      else out.set(key, value);
    }
  }
  for (const cookie of res.headers.getSetCookie()) out.append('set-cookie', cookie);
  return out;
}

const TUNNELS = [
  { name: 'PostHog: zdarzenia', path: '/ingest/e/?ip=0&ver=1.0', method: 'POST' },
  { name: 'PostHog: flagi', path: '/ingest/flags/?v=2', method: 'POST' },
  { name: 'PostHog: skrypt', path: '/ingest/static/array.js', method: 'GET' },
  { name: 'PostHog: konfiguracja', path: '/ingest/array/phc_fixture/config.js', method: 'GET' },
  { name: 'Sentry: koperta', path: '/monitoring?o=123&p=456', method: 'POST' },
  { name: 'Sentry: koperta z regionem', path: '/monitoring/?o=123&p=456&r=de', method: 'POST' },
  // Next dopasowuje przepisania bez względu na wielkość liter — link z innym
  // zapisem też trafia do PostHog albo Sentry.
  { name: 'PostHog: wielkie litery', path: '/Ingest/e/?ip=0', method: 'GET' },
  { name: 'Sentry: wielkie litery', path: '/MONITORING?o=123&p=456', method: 'GET' },
] as const;

describe('tunele PostHog i Sentry w proxy', () => {
  describe.each(TUNNELS)('$name ($path)', ({ path, method }) => {
    it.each(['expired', 'valid', 'none'] as const)('sesja %s: bez odświeżenia i bez ciasteczek u celu', async (state) => {
      const req = request(path, state, method === 'POST' ? { method, body: 'data=fixture' } : {});
      // Proxy musi działać na tunelu — inaczej nikt nie zdejmie ciasteczek.
      expect(unstable_doesMiddlewareMatch({ config, url: req.url })).toBe(true);

      const res = await proxy(req);

      expect(res.headers.get('x-middleware-next')).toBe('1');
      expect(refreshCalls).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
      expect(res.headers.getSetCookie()).toEqual([]);

      const upstream = forwardedHeaders(req, res);
      expect(upstream.get('cookie')).toBeNull();
      expect(upstream.get('set-cookie')).toBeNull();
      // Reszta żądania dochodzi bez zmian — PostHog i Sentry dalej działają.
      expect(upstream.get('user-agent')).toBe('Mozilla/5.0 (fixture)');
      expect(upstream.get('content-type')).toBe('text/plain');
    });
  });

  it.each([
    '/ingest/static/toolbar.svg', '/ingest/static/logo.png', '/ingest/static/font.woff2',
    '/INGEST/static/logo.png', '/Ingest/static/toolbar.svg',
  ])('proxy obejmuje każdy plik tunelu PostHog, także z rozszerzeniem: %s', (path) => {
    expect(unstable_doesMiddlewareMatch({ config, url: `https://app.example.test${path}` })).toBe(true);
  });

  it.each([
    '/logo.png', '/icons/a.png', '/_next/static/chunks/x.js', '/ingestion.png', '/x/ingest/a.png', '/ingest.png',
  ])('wpis tunelu nie poszerza proxy na inne pliki: %s', (path) => {
    expect(unstable_doesMiddlewareMatch({ config, url: `https://app.example.test${path}` })).toBe(false);
  });

  it('kontrola: na zwykłej stronie wygasły token naprawdę się odświeża', async () => {
    const res = await proxy(request('/pricing', 'expired'));
    expect(refreshCalls).toBe(1);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE_NAME}=`))).toBe(true);
  });
});

describe('isTelemetryTunnelPath', () => {
  const TUNNEL = [
    '/ingest', '/ingest/', '/ingest/e/', '/ingest/static/array.js', '/ingest/array/phc_x/config.js',
    '/monitoring', '/monitoring/',
    '/Ingest/e/', '/INGEST', '/InGeSt/static/logo.png', '/MONITORING', '/Monitoring/',
  ];
  const NOT_TUNNEL = [
    '/', '/ingestion', '/ingest-raport', '/api/ingest', '/monitoringx', '/monitoring/raport', '/pricing',
    '/INGESTION', '/Monitoring/raport',
  ];

  it.each(TUNNEL)('tunel: %s', (path) => {
    expect(isTelemetryTunnelPath(path)).toBe(true);
  });

  it.each(NOT_TUNNEL)('nie tunel: %s', (path) => {
    expect(isTelemetryTunnelPath(path)).toBe(false);
  });

  /**
   * Reguła przepisania dopasowana tak jak w Next 16.4 (`filesystem.js`,
   * `buildCustomRoute`; bez `experimental.caseSensitiveRoutes`, więc
   * wielkość liter nie ma znaczenia). `has` (o, p) Sentry pomijamy:
   * `/monitoring` bez nich i tak idzie do aplikacji, tylko bez ciasteczek.
   */
  function rewrittenByNext(source: string, pathname: string): boolean {
    const match = getPathMatch(source, {
      strict: true, removeUnnamedParams: true, sensitive: false,
      regexModifier: (regex) => modifyRouteRegex(regex),
    });
    return match(pathname) !== false;
  }

  it('obejmuje dokładnie to, co Next przepisuje na PostHog i Sentry', () => {
    const src = readFileSync(join(process.cwd(), 'next.config.ts'), 'utf8');
    expect(src).toContain("tunnelRoute: '/monitoring'");
    const posthog = [...src.matchAll(/source: '(\/ingest[^']*)'/g)].map((m) => m[1]);
    expect(posthog.length).toBeGreaterThan(0);
    // Reguła, którą dokłada `withSentryConfig` (`${tunnelRoute}(/?)`).
    const sources = [...posthog, '/monitoring(/?)'];

    for (const path of [...TUNNEL, ...NOT_TUNNEL]) {
      const rewritten = sources.some((source) => rewrittenByNext(source, path));
      expect({ path, tunnel: isTelemetryTunnelPath(path) }).toEqual({ path, tunnel: rewritten });
      if (rewritten) {
        expect({ path, proxy: unstable_doesMiddlewareMatch({ config, url: `https://app.example.test${path}` }) })
          .toEqual({ path, proxy: true });
      }
    }
  });
});
