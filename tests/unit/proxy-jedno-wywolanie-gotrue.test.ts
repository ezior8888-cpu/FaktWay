import { createHmac, hkdfSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { ES256_JWKS, signEs256Jwt } from '../helpers/gotrue-es256';

/**
 * Plan skalowania 3000, sesja 8 (REQ-01, QRY-01, QAL-02, DBC-06).
 *
 * Żądanie chronione pytało GoTrue trzy razy o ten sam token: `getClaims()`
 * w `updateSession`, a potem `getUser(token)` i `getClaims(token)` w kontroli
 * MFA. Przy kluczu HS256 każde `getClaims` to `GET /auth/v1/user`.
 *
 * Test używa PRAWDZIWEGO `@supabase/ssr`; atrapa `fetch` gra GoTrue i PostgREST.
 * Sprawdza licznik wywołań, a obok niego to, co ważniejsze od licznika: każda
 * decyzja bramki zostaje taka sama, a odpowiedź GoTrue nie przechodzi na inne
 * żądanie, więc sesję cofniętą między żądaniami widać od razu.
 */

const mocks = vi.hoisted(() => ({ maintenance: vi.fn() }));
vi.mock('@/lib/feature-flags/maintenance', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/feature-flags/maintenance')>(),
  isMaintenanceMode: mocks.maintenance,
}));

import { ACTIVE_ORG_COOKIE, ACTIVE_ORG_HEADER } from '@/lib/supabase/active-org';
import { createAuthUserFetch } from '@/lib/supabase/auth-user-fetch';
import { updateSession } from '@/lib/supabase/middleware';

const SUPABASE_URL = 'https://fixture.supabase.test';
const COOKIE_NAME = 'sb-fixture-auth-token';
const SERVICE_ROLE = 'fixture-service-role-key-do-testow';
const SESSION_ID = 'fixture-session-id';
const userId = '22222222-2222-4222-8222-222222222222';
const otherUserId = '33333333-3333-4333-8333-333333333333';
const org = '11111111-1111-4111-8111-111111111111';
const totp = { id: 'fixture-factor', factor_type: 'totp', status: 'verified' };

type Keys = 'hs256' | 'es256';
type Aal = 'aal1' | 'aal2';

let keys: Keys;
let factors: Record<string, (typeof totp)[]>;
/** `/auth/v1/user` odrzuca każdy token, dopóki flaga jest ustawiona. */
let rejectUser: boolean;
let userCalls: number;
let refreshCalls: number;
let userCallHeaders: Headers[];

const b64url = (value: string) => Buffer.from(value).toString('base64url');

function jwt(sub: string, exp: number, aal: Aal): string {
  const payload = {
    sub, aal, role: 'authenticated', aud: 'authenticated',
    iat: Math.floor(Date.now() / 1000), exp, session_id: SESSION_ID,
  };
  if (keys === 'es256') return signEs256Jwt(payload);
  return [b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), b64url(JSON.stringify(payload)), b64url('fixture-signature')].join('.');
}

function session(sub: string, expiresAt: number, aal: Aal, refreshToken: string) {
  return {
    access_token: jwt(sub, expiresAt, aal), refresh_token: refreshToken, token_type: 'bearer',
    expires_in: expiresAt - Math.floor(Date.now() / 1000), expires_at: expiresAt,
    user: { id: sub, aud: 'authenticated', role: 'authenticated' },
  };
}

/** Błąd GoTrue tak, jak go czyta auth-js: `code` liczy się tylko z nagłówkiem wersji API. */
function gotrueError(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status, headers: { 'x-supabase-api-version': '2024-01-01' } });
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
    refreshCalls += 1;
    return Response.json(session(userId, Math.floor(Date.now() / 1000) + 3600, 'aal2', 'fixture-refresh-2'));
  }
  if (url.pathname === '/auth/v1/.well-known/jwks.json') return Response.json(ES256_JWKS);
  if (url.pathname === '/auth/v1/user') {
    userCalls += 1;
    const headers = new Headers(init?.headers);
    userCallHeaders.push(headers);
    if (rejectUser) return gotrueError(403, 'bad_jwt', 'invalid JWT');
    const token = headers.get('authorization')!.replace('Bearer ', '');
    const { sub } = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { sub: string };
    return Response.json({ id: sub, aud: 'authenticated', role: 'authenticated', factors: factors[sub] ?? [] });
  }
  if (url.pathname === '/rest/v1/memberships') {
    return Response.json([{ organization_id: org, joined_at: '2026-10-01T00:00:00Z' }]);
  }
  if (url.pathname === '/rest/v1/users') return Response.json([{ last_active_tenant_id: org }]);
  throw new Error(`Nieoczekiwane żądanie w teście proxy: ${url.href}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  keys = 'hs256';
  factors = { [userId]: [totp], [otherUserId]: [totp] };
  rejectUser = false;
  userCalls = 0;
  refreshCalls = 0;
  userCallHeaders = [];
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fixture-anon-key');
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE);
  mocks.maintenance.mockResolvedValue(false);
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

/** Znacznik logowania biometrią, liczony niezależnie od kodu aplikacji. */
function passkeyMarker(expiresAt = Math.floor(Date.now() / 1000) + 3600): string {
  const expiry = String(expiresAt);
  const key = Buffer.from(hkdfSync('sha256', SERVICE_ROLE, Buffer.alloc(0), 'faktway/passkey-session-marker/v1', 32));
  const mac = createHmac('sha256', key).update(['v1', userId, SESSION_ID, expiry].join('\n')).digest('base64url');
  return ['v1', expiry, mac].join('.');
}

/**
 * Zmienia pierwszy znak podpisu, zawsze na inny. Pierwszy, bo ostatni znak
 * base64url niesie dwa bity dopełnienia, które `atob` pomija: przy podpisie
 * kończącym się na „A” zamiana na „B” dawała te same bajty (1 na 16 przebiegów).
 */
function forged(value: string): string {
  const at = value.lastIndexOf('.') + 1;
  return value.slice(0, at) + (value[at] === 'A' ? 'B' : 'A') + value.slice(at + 1);
}

function request(path: string, opts: {
  state?: 'valid' | 'expired'; sub?: string; aal?: Aal; org?: boolean; marker?: string;
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = opts.state === 'expired' ? now - 60 : now + 3600;
  const value = session(opts.sub ?? userId, expiresAt, opts.aal ?? 'aal2', 'fixture-refresh-1');
  const cookies = [`${COOKIE_NAME}=base64-${b64url(JSON.stringify(value))}`];
  if (opts.org ?? true) cookies.push(`${ACTIVE_ORG_COOKIE}=${org}`);
  if (opts.marker) cookies.push(`ksef.passkey_session=${opts.marker}`);
  return new NextRequest(`https://app.example.test${path}`, { headers: { cookie: cookies.join('; ') } });
}

const passedToRoute = (response: Response) => response.headers.get('x-middleware-next') === '1';
const challenge = (path: string) => `https://app.example.test/login/two-factor?redirect=${encodeURIComponent(path)}`;

describe.each(['hs256', 'es256'] as const)('klucze %s', (mode) => {
  beforeEach(() => { keys = mode; });

  describe('jedno wywołanie GoTrue na żądanie chronione', () => {
    it.each([
      ['strona panelu', '/dashboard'],
      ['inna strona panelu', '/invoices'],
      ['API panelu', '/api/invoices'],
      ['panel operatora', '/admin'],
    ])('%s (%s)', async (_name, path) => {
      const response = await updateSession(request(path));

      expect(passedToRoute(response)).toBe(true);
      expect(userCalls).toBe(1);
      expect(refreshCalls).toBe(0);
    });

    it('wygasły token: jedno odświeżenie i jedno wywołanie z nowym tokenem', async () => {
      const response = await updateSession(request('/invoices', { state: 'expired' }));

      expect(passedToRoute(response)).toBe(true);
      expect(refreshCalls).toBe(1);
      expect(userCalls).toBe(1);
      expect(response.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE_NAME}=`))).toBe(true);
    });

    it('wybór firmy: zapytania do bazy idą dalej do bazy', async () => {
      const response = await updateSession(request('/dashboard', { org: false }));

      expect(response.status).toBe(307);
      expect(response.cookies.get(ACTIVE_ORG_COOKIE)?.value).toBe(org);
      expect(userCalls).toBe(1);
    });
  });

  describe('decyzje bramki bez zmian', () => {
    it('sesja AAL1 konta z 2FA: strona i panel operatora → kod, API → 403', async () => {
      const page = await updateSession(request('/invoices', { aal: 'aal1' }));
      expect(page.headers.get('location')).toBe(challenge('/invoices'));
      const admin = await updateSession(request('/admin', { aal: 'aal1' }));
      expect(admin.headers.get('location')).toBe(challenge('/admin'));
      const api = await updateSession(request('/api/invoices', { aal: 'aal1' }));
      expect(api.status).toBe(403);
      expect(await api.json()).toEqual({ error: 'mfa_required' });
      expect(userCalls).toBe(3);
    });

    it('znacznik biometrii tej sesji przechodzi przez panel, ale nie przez panel operatora', async () => {
      const marker = passkeyMarker();
      const page = await updateSession(request('/invoices', { aal: 'aal1', marker }));
      expect(passedToRoute(page)).toBe(true);
      const admin = await updateSession(request('/admin', { aal: 'aal1', marker }));
      expect(admin.headers.get('location')).toBe(challenge('/admin'));
      expect(userCalls).toBe(2);
    });

    // Podpis zależy od czasu wygaśnięcia, więc sprawdzamy 64 różne podpisy:
    // podróbka ma być odrzucona przy każdym, nie tylko przy tym z dzisiejszej godziny.
    it('podrobiony znacznik biometrii kończy się kodem', async () => {
      const start = Math.floor(Date.now() / 1000) + 3600;
      for (let i = 0; i < 256; i += 1) {
        const marker = forged(passkeyMarker(start + i));
        const page = await updateSession(request('/invoices', { aal: 'aal1', marker }));
        expect(page.headers.get('location'), `wygaśnięcie ${start + i}`).toBe(challenge('/invoices'));
      }
    });

    it('token odrzucony przez GoTrue: strona → logowanie, API → 401, bez powtórek', async () => {
      rejectUser = true;
      const page = await updateSession(request('/invoices'));
      expect(page.headers.get('location')).toBe('https://app.example.test/login?redirect=%2Finvoices');
      expect(userCalls).toBe(1);
      const api = await updateSession(request('/api/invoices'));
      expect(api.status).toBe(401);
      expect(await api.json()).toEqual({ error: 'not_authenticated' });
      expect(userCalls).toBe(2);
    });
  });

  describe('odpowiedź GoTrue nie wychodzi poza jedno żądanie', () => {
    it('sesja cofnięta między żądaniami jest odrzucona od razu', async () => {
      expect(passedToRoute(await updateSession(request('/invoices')))).toBe(true);
      expect(userCalls).toBe(1);

      rejectUser = true;
      const second = await updateSession(request('/invoices'));

      expect(second.headers.get('location')).toBe('https://app.example.test/login?redirect=%2Finvoices');
      expect(userCalls).toBe(2);
    });

    it('odmowa nie zostaje: po niej to samo ciasteczko znów pyta GoTrue i przechodzi', async () => {
      rejectUser = true;
      expect((await updateSession(request('/invoices'))).status).toBe(307);

      rejectUser = false;
      expect(passedToRoute(await updateSession(request('/invoices')))).toBe(true);
      expect(userCalls).toBe(2);
    });

    it('dwa równoległe żądania różnych osób: każde dostaje decyzję dla swojego konta', async () => {
      factors = { [userId]: [totp], [otherUserId]: [] };
      const [withFactor, withoutFactor] = await Promise.all([
        updateSession(request('/invoices', { sub: userId, aal: 'aal1' })),
        updateSession(request('/invoices', { sub: otherUserId, aal: 'aal1' })),
      ]);

      expect(withFactor.headers.get('location')).toBe(challenge('/invoices'));
      expect(passedToRoute(withoutFactor)).toBe(true);
      expect(userCalls).toBe(2);
    });
  });

  it('wybrana firma dalej jedzie nagłówkiem do GoTrue', async () => {
    await updateSession(request('/invoices'));

    expect(userCallHeaders[0]?.get(ACTIVE_ORG_HEADER)).toBe(org);
  });
});

describe('kontrola: trasa publiczna', () => {
  it.each([
    ['hs256', 1],
    ['es256', 0],
  ] as const)('klucze %s: /pricing pyta GoTrue %i raz', async (mode, calls) => {
    keys = mode;
    const response = await updateSession(request('/pricing'));

    expect(passedToRoute(response)).toBe(true);
    expect(userCalls).toBe(calls);
  });
});

describe('createAuthUserFetch', () => {
  const USER_URL = `${SUPABASE_URL}/auth/v1/user`;
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  let network: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    network = vi.fn(async () => Response.json({ id: userId }));
    vi.stubGlobal('fetch', network);
  });

  it('ten sam token: jedno wywołanie, a każdy czytający dostaje całą odpowiedź', async () => {
    const shared = createAuthUserFetch();
    for (let reader = 0; reader < 3; reader += 1) {
      const response = await shared(USER_URL, { method: 'GET', headers: bearer('a') });
      expect(await response.json()).toEqual({ id: userId });
    }
    expect(network).toHaveBeenCalledOnce();
  });

  it('inny token (odświeżenie w trakcie żądania) pyta GoTrue od nowa', async () => {
    const shared = createAuthUserFetch();
    await shared(USER_URL, { method: 'GET', headers: bearer('a') });
    await shared(USER_URL, { method: 'GET', headers: bearer('b') });
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('nowy fetch nie zna odpowiedzi poprzedniego', async () => {
    await createAuthUserFetch()(USER_URL, { method: 'GET', headers: bearer('a') });
    await createAuthUserFetch()(USER_URL, { method: 'GET', headers: bearer('a') });
    expect(network).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['zapis użytkownika', USER_URL, { method: 'PUT', headers: bearer('a') }],
    ['inna ścieżka GoTrue', `${SUPABASE_URL}/auth/v1/factors`, { method: 'GET', headers: bearer('a') }],
    ['podobna ścieżka', `${SUPABASE_URL}/auth/v1/user/extra`, { method: 'GET', headers: bearer('a') }],
    ['baza danych', `${SUPABASE_URL}/rest/v1/users`, { method: 'GET', headers: bearer('a') }],
    ['bez tokenu', USER_URL, { method: 'GET' }],
  ] as const)('%s nigdy nie idzie z pamięci', async (_name, url, init) => {
    const shared = createAuthUserFetch();
    await shared(url, init);
    await shared(url, init);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('odmowa i błąd sieci nie zostają w pamięci', async () => {
    const shared = createAuthUserFetch();
    network.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    expect((await shared(USER_URL, { method: 'GET', headers: bearer('a') })).status).toBe(403);
    network.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(shared(USER_URL, { method: 'GET', headers: bearer('a') })).rejects.toThrow('fetch failed');
    expect((await shared(USER_URL, { method: 'GET', headers: bearer('a') })).status).toBe(200);
    expect(network).toHaveBeenCalledTimes(3);
  });

  it('obiekt Request: ta sama zasada jak dla adresu i opcji', async () => {
    const shared = createAuthUserFetch();
    await shared(new Request(USER_URL, { headers: bearer('a') }));
    await shared(new Request(USER_URL, { headers: bearer('a') }));
    await shared(new Request(USER_URL, { method: 'PUT', headers: bearer('a') }));
    expect(network).toHaveBeenCalledTimes(2);
  });
});
