import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Odpowiedź z odświeżonym ciasteczkiem sesji nie może trafić do wspólnego
 * cache'u (CDN, reverse proxy) — oddałby cudzą sesję następnemu klientowi.
 *
 * `@supabase/ssr` 0.10 podaje do `setAll(ciasteczka, nagłówki)` drugi
 * argument: `Cache-Control: private, no-cache, no-store, must-revalidate,
 * max-age=0`, `Expires: 0`, `Pragma: no-cache`. Proxy go ignorowało.
 * Next 16 przenosi nagłówki odpowiedzi proxy (z `Set-Cookie`) do odpowiedzi
 * trasy, a trasa i strona dokładają własny `Cache-Control` tylko wtedy, gdy
 * go jeszcze nie ma (`send-response.js`, `send-payload.js`). Stąd
 * `/api/status/components` (`public, s-maxage=30`) albo statyczna strona
 * marketingowa mogły wyjść z cudzym ciasteczkiem i nagłówkiem, który wolno
 * przechować we wspólnym cache'u.
 *
 * Test używa PRAWDZIWEGO `@supabase/ssr`; atrapa `fetch` gra GoTrue
 * i PostgREST. Ciasteczko niesie WYGASŁY token HS256, więc `getClaims()`
 * naprawdę odświeża sesję przez `/auth/v1/token?grant_type=refresh_token`.
 * Scenariusze obejmują każde wyjście z `updateSession`: przepuszczenie do
 * trasy, każde przekierowanie i każdą odmowę API.
 */

const mocks = vi.hoisted(() => ({ maintenance: vi.fn(), cookieStore: vi.fn() }));
vi.mock('@/lib/feature-flags/maintenance', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/feature-flags/maintenance')>(),
  isMaintenanceMode: mocks.maintenance,
}));
vi.mock('next/headers', () => ({ cookies: mocks.cookieStore }));

import { updateSession } from '@/lib/supabase/middleware';
import { ACTIVE_ORG_COOKIE } from '@/lib/supabase/active-org';

const SUPABASE_URL = 'https://fixture.supabase.test';
const COOKIE_NAME = 'sb-fixture-auth-token';
const userId = '22222222-2222-4222-8222-222222222222';
const org = '11111111-1111-4111-8111-111111111111';
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';

type Aal = 'aal1' | 'aal2';

/** Zachowanie atrapy GoTrue/PostgREST w jednym scenariuszu. */
type Fixture = {
  /** Wynik `/auth/v1/token?grant_type=refresh_token`. */
  refresh: 'ok' | 'fails';
  /** `aal` w tokenie wydanym przy odświeżeniu. */
  aal: Aal;
  /**
   * `/auth/v1/user`: ten sam użytkownik, inny, od drugiego wywołania odmowa
   * tokenu (`bad_jwt`) albo sesja usunięta w GoTrue (`session_not_found` —
   * biblioteka kasuje wtedy ciasteczko: drugi `setAll` w tym samym żądaniu).
   */
  authUser: 'same' | 'other' | 'rejected-after-first' | 'gone-after-first';
  memberships: number;
};

let fixture: Fixture;
let refreshCalls: number;
let userCalls: number;

const b64url = (value: string) => Buffer.from(value).toString('base64url');

function jwt(exp: number, aal: Aal): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64url(JSON.stringify({
      sub: userId, aal, role: 'authenticated', aud: 'authenticated',
      iat: now, exp, session_id: 'fixture-session',
    })),
    b64url('fixture-signature'),
  ].join('.');
}

function session(expiresAt: number, aal: Aal, refreshToken: string) {
  return {
    access_token: jwt(expiresAt, aal), refresh_token: refreshToken, token_type: 'bearer',
    expires_in: expiresAt - Math.floor(Date.now() / 1000), expires_at: expiresAt,
    user: { id: userId, aud: 'authenticated', role: 'authenticated' },
  };
}

/** Ciasteczko sesji z tokenem, który wygasł minutę temu — wymusza odświeżenie. */
function sessionCookie(state: 'expired' | 'valid'): string {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = state === 'expired' ? now - 60 : now + 3600;
  return `${COOKIE_NAME}=base64-${b64url(JSON.stringify(session(expiresAt, 'aal2', 'fixture-refresh-1')))}`;
}

function user(id: string) {
  return {
    id, aud: 'authenticated', role: 'authenticated',
    factors: [{ id: 'fixture-factor', factor_type: 'totp', status: 'verified' }],
  };
}

/** Błąd GoTrue tak, jak go czyta auth-js: `code` liczy się tylko z nagłówkiem wersji API. */
function gotrueError(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status, headers: { 'x-supabase-api-version': '2024-01-01' } });
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
    refreshCalls += 1;
    if (fixture.refresh === 'fails') {
      return gotrueError(400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used');
    }
    return Response.json(session(Math.floor(Date.now() / 1000) + 3600, fixture.aal, 'fixture-refresh-2'));
  }
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
    return Response.json({ ...session(Math.floor(Date.now() / 1000) + 3600, 'aal1', 'fixture-refresh-1'), user: user(userId) });
  }
  if (url.pathname === '/auth/v1/user') {
    userCalls += 1;
    if (fixture.authUser === 'rejected-after-first' && userCalls > 1) {
      return gotrueError(403, 'bad_jwt', 'invalid JWT');
    }
    if (fixture.authUser === 'gone-after-first' && userCalls > 1) {
      return gotrueError(403, 'session_not_found', 'Session from session_id claim in JWT does not exist');
    }
    return Response.json(user(fixture.authUser === 'other' ? '33333333-3333-4333-8333-333333333333' : userId));
  }
  if (url.pathname === '/rest/v1/memberships') {
    return Response.json(Array.from({ length: fixture.memberships }, () => ({
      organization_id: org, joined_at: '2026-10-01T00:00:00Z',
    })));
  }
  if (url.pathname === '/rest/v1/users') {
    return Response.json([{ last_active_tenant_id: org }]);
  }
  throw new Error(`Nieoczekiwane żądanie w teście proxy: ${url.href}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture = { refresh: 'ok', aal: 'aal2', authUser: 'same', memberships: 1 };
  refreshCalls = 0;
  userCalls = 0;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fixture-anon-key');
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_MOBILE_PANEL', 'off');
  vi.stubEnv('NEXT_PUBLIC_MOBILE_PANEL_ALLOWLIST', '');
  mocks.maintenance.mockResolvedValue(false);
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function request(path: string, opts: { session?: 'expired' | 'valid' | 'none'; org?: boolean; phone?: boolean } = {}) {
  const state = opts.session ?? 'expired';
  const cookies: string[] = [];
  if (state !== 'none') cookies.push(sessionCookie(state));
  if (opts.org) cookies.push(`${ACTIVE_ORG_COOKIE}=${org}`);
  const headers: Record<string, string> = {};
  if (cookies.length > 0) headers.cookie = cookies.join('; ');
  if (opts.phone) { headers['user-agent'] = PHONE_UA; headers.accept = 'text/html'; }
  return new NextRequest('https://app.example.test' + path, { headers });
}

/** Dyrektywy `Cache-Control`, które zabraniają wspólnemu cache'owi przechowania odpowiedzi. */
function expectNotStorableBySharedCache(response: Response) {
  const directives = (response.headers.get('cache-control') ?? '')
    .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  expect(directives).toContain('private');
  expect(directives).toContain('no-store');
  expect(response.headers.get('expires')).toBe('0');
  expect(response.headers.get('pragma')).toBe('no-cache');
}

function sessionSetCookies(response: Response): string[] {
  return response.headers.getSetCookie().filter((c) => c.startsWith(`${COOKIE_NAME}=`));
}

type Scenario = {
  name: string;
  path: string;
  opts?: Parameters<typeof request>[1];
  setup?: () => void;
  status: number;
  location?: string;
  /** Treść odmowy API — odróżnia wyjścia o tym samym statusie. */
  error?: string;
  /**
   * Liczba wywołań `/auth/v1/user` tam, gdzie inne wyjście dałoby ten sam
   * status: odmowa przy weryfikacji MFA (2) ≠ brak użytkownika po `getClaims` (1).
   */
  userCalls?: number;
};

const scenarios: Scenario[] = [
  // Przepuszczenie do trasy — tu Next łączy nagłówki proxy z nagłówkami trasy.
  { name: 'publiczne API z cache CDN trasy (/api/status/components)', path: '/api/status/components', status: 200 },
  { name: 'statyczna strona marketingowa (/pricing)', path: '/pricing', status: 200 },
  { name: 'strona panelu z wybraną firmą', path: '/dashboard', opts: { org: true }, status: 200 },
  { name: 'API panelu z wybraną firmą', path: '/api/invoices', opts: { org: true }, status: 200 },
  // Przekierowania.
  { name: 'zalogowany na landingu → pulpit', path: '/', status: 307, location: '/dashboard' },
  { name: 'zalogowany na /login → pulpit', path: '/login', status: 307, location: '/dashboard' },
  { name: 'wybór firmy przy pierwszym wejściu', path: '/dashboard', status: 307, location: '/dashboard' },
  { name: 'bez firmy → onboarding', path: '/dashboard', setup: () => { fixture.memberships = 0; }, status: 307, location: '/onboarding' },
  { name: 'telefon → /mobile', path: '/dashboard', opts: { phone: true }, status: 307, location: '/mobile' },
  { name: 'przerwa techniczna (strona)', path: '/dashboard', setup: () => { mocks.maintenance.mockResolvedValue(true); }, status: 307, location: '/przerwa-techniczna' },
  { name: 'MFA do potwierdzenia (strona)', path: '/invoices', setup: () => { fixture.aal = 'aal1'; }, status: 307, location: '/login/two-factor?redirect=%2Finvoices' },
  { name: 'sesja odrzucona przy weryfikacji (strona)', path: '/invoices', setup: () => { fixture.authUser = 'rejected-after-first'; }, status: 307, location: '/login?redirect=%2Finvoices', userCalls: 2 },
  // Odmowy.
  { name: 'przerwa techniczna (API)', path: '/api/invoices', setup: () => { mocks.maintenance.mockResolvedValue(true); }, status: 503, error: 'maintenance' },
  { name: 'MFA do potwierdzenia (API)', path: '/api/invoices', setup: () => { fixture.aal = 'aal1'; }, status: 403, error: 'mfa_required' },
  { name: 'niezgodna tożsamość (strona)', path: '/invoices', setup: () => { fixture.authUser = 'other'; }, status: 503, userCalls: 3 },
  { name: 'niezgodna tożsamość (API)', path: '/api/invoices', setup: () => { fixture.authUser = 'other'; }, status: 503, error: 'session_verification_failed', userCalls: 3 },
  { name: 'sesja odrzucona przy weryfikacji (API)', path: '/api/invoices', setup: () => { fixture.authUser = 'rejected-after-first'; }, status: 401, error: 'not_authenticated', userCalls: 2 },
];

describe('odświeżona sesja w proxy', () => {
  it.each(scenarios)('$name: odpowiedź z ciasteczkiem sesji nie trafia do wspólnego cache', async (s) => {
    s.setup?.();
    const response = await updateSession(request(s.path, s.opts));

    // Scenariusz trafił w zamierzone wyjście i naprawdę odświeżył sesję.
    expect(response.status).toBe(s.status);
    if (s.location) expect(response.headers.get('location')).toBe('https://app.example.test' + s.location);
    if (s.status === 200) expect(response.headers.get('x-middleware-next')).toBe('1');
    if (s.error) expect(await response.json()).toEqual({ error: s.error });
    if (s.userCalls) expect(userCalls).toBe(s.userCalls);
    expect(refreshCalls).toBe(1);
    const cookies = sessionSetCookies(response);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).not.toContain('Max-Age=0');

    expectNotStorableBySharedCache(response);
  });

  // Odświeżenie, a zaraz potem GoTrue mówi, że sesji już nie ma: biblioteka
  // woła `setAll` drugi raz w tym samym żądaniu, tym razem z kasowaniem.
  // Wygrywa ostatni zapis — ciasteczka i nagłówki.
  it('odświeżenie, potem sesja usunięta w GoTrue: dwa zapisy w jednym żądaniu, oba bez wspólnego cache', async () => {
    fixture.authUser = 'gone-after-first';
    const response = await updateSession(request('/invoices'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.example.test/login?redirect=%2Finvoices');
    expect(refreshCalls).toBe(1);
    expect(userCalls).toBe(2);
    const cookies = sessionSetCookies(response);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain('Max-Age=0');

    expectNotStorableBySharedCache(response);
  });

  // Nieudane odświeżenie: biblioteka kasuje ciasteczko (SIGNED_OUT) i podaje te
  // same nagłówki. Przechowane „skasuj sesję” wylogowywałoby kolejnych klientów.
  it.each([
    { name: 'strona panelu → logowanie', path: '/dashboard', status: 307, location: '/login?redirect=%2Fdashboard' },
    { name: 'API panelu → 401', path: '/api/invoices', status: 401 },
    { name: 'publiczne API → trasa', path: '/api/status/components', status: 200 },
  ])('nieudane odświeżenie, $name: skasowanie ciasteczka też bez wspólnego cache', async (s) => {
    fixture.refresh = 'fails';
    const response = await updateSession(request(s.path));

    expect(response.status).toBe(s.status);
    if (s.location) expect(response.headers.get('location')).toBe('https://app.example.test' + s.location);
    expect(refreshCalls).toBe(1);
    const cookies = sessionSetCookies(response);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain('Max-Age=0');

    expectNotStorableBySharedCache(response);
  });

  // Uszkodzone ciasteczko: biblioteka kasuje je bez wywołania GoTrue
  // (SIGNED_OUT) — także u anonimowego gościa na stronie publicznej.
  it('uszkodzone ciasteczko sesji na stronie publicznej: skasowanie też bez wspólnego cache', async () => {
    const response = await updateSession(new NextRequest('https://app.example.test/pricing', {
      headers: { cookie: `${COOKIE_NAME}=uszkodzone` },
    }));

    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(refreshCalls).toBe(0);
    const cookies = sessionSetCookies(response);
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) expect(cookie).toContain('Max-Age=0');

    expectNotStorableBySharedCache(response);
  });

  // Bez odświeżenia proxy nie dokłada nagłówków — trasa publiczna dalej sama
  // decyduje o cache CDN (status 30 s), a anonimowy ruch go nie traci.
  it.each([
    { name: 'ważny token', session: 'valid' as const },
    { name: 'bez sesji', session: 'none' as const },
  ])('$name: proxy nie ustawia Cache-Control ani Set-Cookie', async ({ session: state }) => {
    const response = await updateSession(request('/api/status/components', { session: state }));

    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(refreshCalls).toBe(0);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get('cache-control')).toBeNull();
    expect(response.headers.get('expires')).toBeNull();
    expect(response.headers.get('pragma')).toBeNull();
  });
});

describe('trasa sesji dla testów obciążenia (tylko poza produkcją)', () => {
  it('ciasteczka z logowania wychodzą z nagłówkami anty-cache', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'test');
    vi.stubEnv('LOAD_TEST_MODE', 'true');
    mocks.cookieStore.mockResolvedValue({ getAll: () => [] });
    const { POST } = await import('@/app/api/dev/load-test-session/route');

    const response = await POST(new Request('https://app.example.test/api/dev/load-test-session', {
      method: 'POST', body: JSON.stringify({ email: 'k6@example.test', password: 'fixture-password' }),
    }));

    expect(response.status).toBe(200);
    expect(sessionSetCookies(response)).toHaveLength(1);
    expectNotStorableBySharedCache(response);
  });
});
