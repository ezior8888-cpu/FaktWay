import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { ES256_JWKS, signEs256Jwt } from '../helpers/gotrue-es256';

/**
 * Plan skalowania 3000, sesja 5 (REQ-V01, QRY-V1, LIM-05).
 *
 * Proxy czekało na GoTrue i PostgREST bez żadnego limitu czasu. Zawieszony
 * serwer na db-1 trzymał każde żądanie w jedynym procesie Node, a gdy fetch
 * w końcu padał, bramka brała to za brak sesji i kierowała na `/login`.
 *
 * Atrapa gra serwer, który przyjmuje żądanie i nigdy nie odpowiada (jak
 * undici: kończy się dopiero, gdy ktoś przerwie żądanie sygnałem). Test używa
 * PRAWDZIWEGO `@supabase/ssr` i `updateSession`. Sprawdza, że po limicie
 * chroniona trasa dostaje 503 „spróbuj ponownie”, bez przekierowania i bez
 * kasowania sesji, publiczna jedzie dalej jak dla gościa, a przy serwerze,
 * który odpowiada (także wolno, ale w limicie), decyzje bramki logowania
 * i 2FA są takie same jak dotąd.
 */

const mocks = vi.hoisted(() => ({ maintenance: vi.fn() }));
vi.mock('@/lib/feature-flags/maintenance', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/feature-flags/maintenance')>(),
  isMaintenanceMode: mocks.maintenance,
}));

import { ACTIVE_ORG_COOKIE } from '@/lib/supabase/active-org';
import { PROXY_GATE_TIMEOUT_MS } from '@/lib/supabase/fetch-timeout';
import { updateSession } from '@/lib/supabase/middleware';

/** Limit całej bramki w proxy: tyle najdłużej czeka żądanie, zanim dostanie 503. */
const LIMIT_MS = 5_000;

const SUPABASE_URL = 'https://fixture.supabase.test';
const COOKIE_NAME = 'sb-fixture-auth-token';
const SESSION_ID = 'fixture-session-id';
const userId = '22222222-2222-4222-8222-222222222222';
const otherUserId = '33333333-3333-4333-8333-333333333333';
const org = '11111111-1111-4111-8111-111111111111';
const totp = { id: 'fixture-factor', factor_type: 'totp', status: 'verified' };
const UNAVAILABLE_TEXT = 'Nie udało się zweryfikować sesji. Spróbuj ponownie.';

type Keys = 'hs256' | 'es256';
type Aal = 'aal1' | 'aal2';

let keys: Keys;
/** Ścieżki atrapy, które przyjmują żądanie i nigdy nie odpowiadają. */
let hang: Set<string>;
/** Ścieżki atrapy, które odpowiadają po tylu milisekundach. */
let delay: Map<string, number>;
/** Sygnały, z którymi przyszły zawieszone żądania (`undefined` = bez sygnału). */
let hungSignals: (AbortSignal | undefined)[];
let rejectUser: boolean;
/** `/auth/v1/user` oddaje innego użytkownika niż token (niespójna odpowiedź GoTrue). */
let userMismatch: boolean;
let refreshCalls: number;

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

/** Serwer, który nie odpowiada: żądanie kończy dopiero przerwanie sygnałem, jak w undici. */
function neverAnswers(init?: RequestInit): Promise<Response> {
  const signal = init?.signal ?? undefined;
  hungSignals.push(signal);
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function answersAfter(ms: number, init: RequestInit | undefined, respond: () => Response): Promise<Response> {
  const signal = init?.signal ?? undefined;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(respond()), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function gotrueError(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status, headers: { 'x-supabase-api-version': '2024-01-01' } });
}

function answer(url: URL, init?: RequestInit): Response {
  if (url.pathname === '/auth/v1/token') {
    return Response.json(session(userId, Math.floor(Date.now() / 1000) + 3600, 'aal2', 'fixture-refresh-2'));
  }
  if (url.pathname === '/auth/v1/.well-known/jwks.json') return Response.json(ES256_JWKS);
  if (url.pathname === '/auth/v1/user') {
    if (rejectUser) return gotrueError(403, 'bad_jwt', 'invalid JWT');
    const token = new Headers(init?.headers).get('authorization')!.replace('Bearer ', '');
    const { sub } = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { sub: string };
    const id = userMismatch ? otherUserId : sub;
    return Response.json({ id, aud: 'authenticated', role: 'authenticated', factors: [totp] });
  }
  if (url.pathname === '/rest/v1/memberships') {
    return Response.json([{ organization_id: org, joined_at: '2026-10-01T00:00:00Z' }]);
  }
  if (url.pathname === '/rest/v1/users') return Response.json([{ last_active_tenant_id: org }]);
  throw new Error(`Nieoczekiwane żądanie w teście proxy: ${url.href}`);
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname === '/auth/v1/token') refreshCalls += 1;
  if (hang.has(url.pathname)) return neverAnswers(init);
  const wait = delay.get(url.pathname);
  if (wait !== undefined) return answersAfter(wait, init, () => answer(url, init));
  return answer(url, init);
}

function request(path: string, opts: { state?: 'valid' | 'expired'; aal?: Aal; org?: boolean } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = opts.state === 'expired' ? now - 60 : now + 3600;
  const value = session(userId, expiresAt, opts.aal ?? 'aal2', 'fixture-refresh-1');
  const cookies = [`${COOKIE_NAME}=base64-${b64url(JSON.stringify(value))}`];
  if (opts.org ?? true) cookies.push(`${ACTIVE_ORG_COOKIE}=${org}`);
  return new NextRequest(`https://app.example.test${path}`, { headers: { cookie: cookies.join('; ') } });
}

/** Stan obietnicy bez czekania na nią: zegar jest sztuczny, więc test sam go przesuwa. */
function track<T>(promise: Promise<T>) {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false };
  promise.then(
    (value) => { state.done = true; state.value = value; },
    (error: unknown) => { state.done = true; state.error = error; },
  );
  return state;
}

// Podpis ES256 sprawdza WebCrypto w puli wątków, poza sztucznym zegarem.
// Test zapisuje te obietnice i przed każdym krokiem zegara czeka na nie
// naprawdę, żeby limit liczył się od rzeczywistego końca tej pracy.
const pendingCrypto = new Set<Promise<unknown>>();
function trackWebCrypto(): void {
  const subtle = globalThis.crypto.subtle;
  for (const method of ['importKey', 'verify', 'digest'] as const) {
    const original = (subtle[method] as (...args: unknown[]) => Promise<unknown>).bind(subtle);
    vi.spyOn(subtle, method).mockImplementation(((...args: unknown[]) => {
      const work = original(...args);
      pendingCrypto.add(work);
      const forget = () => { pendingCrypto.delete(work); };
      work.then(forget, forget);
      return work;
    }) as never);
  }
}

// `setImmediate` zostaje prawdziwy (zob. `vi.useFakeTimers` niżej): jeden
// obrót pętli zdarzeń wykonuje wszystkie czekające mikrozadania, a na Windowsie
// nie kosztuje 15 ms jak prawdziwy `setTimeout`.
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settleRealWork(): Promise<void> {
  await nextTurn();
  while (pendingCrypto.size > 0) {
    await Promise.allSettled([...pendingCrypto]);
    await nextTurn();
  }
}

/** Przesuwa sztuczny zegar krokami po 50 ms, kończąc prawdziwą pracę przed każdym krokiem. */
async function advance(ms: number): Promise<void> {
  let left = ms;
  do {
    await settleRealWork();
    const step = Math.min(50, left);
    vi.advanceTimersByTime(step);
    left -= step;
  } while (left > 0);
  await settleRealWork();
}

/** Żądanie kończy się dokładnie po limicie, a nie wcześniej. */
async function settlesAtLimit(path: string, opts?: Parameters<typeof request>[1]): Promise<Response> {
  const result = track(updateSession(request(path, opts)));
  await advance(LIMIT_MS - 1);
  expect(result.done, 'przed limitem żądanie jeszcze czeka').toBe(false);
  await advance(1);
  expect(result.done, 'po limicie żądanie ma odpowiedź').toBe(true);
  expect(result.error).toBeUndefined();
  return result.value!;
}

/** Decyzja bramki, gdy serwer odpowiada (zegar idzie daleko za limit). */
async function decide(path: string, opts?: Parameters<typeof request>[1]): Promise<Response> {
  const result = track(updateSession(request(path, opts)));
  await advance(LIMIT_MS + 500);
  expect(result.done, 'decyzja zapadła').toBe(true);
  expect(result.error).toBeUndefined();
  return result.value!;
}

const passedToRoute = (response: Response) => response.headers.get('x-middleware-next') === '1';
const loginFor = (path: string) => `https://app.example.test/login?redirect=${encodeURIComponent(path)}`;
const challengeFor = (path: string) => `https://app.example.test/login/two-factor?redirect=${encodeURIComponent(path)}`;

/** Ciasteczka sesji, które odpowiedź kasuje (wylogowanie). */
const clearedSessionCookies = (response: Response) => response.headers.getSetCookie()
  .filter((cookie) => cookie.startsWith(COOKIE_NAME) && /max-age=0|expires=thu, 01 jan 1970/i.test(cookie));

/** 503 „spróbuj ponownie”: bez przekierowania, bez cache i bez kasowania ciasteczka sesji. */
async function expectUnavailable(response: Response, api: boolean): Promise<void> {
  expect(response.status).toBe(503);
  expect(response.headers.get('location')).toBeNull();
  expect(response.headers.get('cache-control')).toContain('no-store');
  if (api) expect(await response.json()).toEqual({ error: 'session_verification_failed' });
  else expect(await response.text()).toBe(UNAVAILABLE_TEXT);
  expect(clearedSessionCookies(response)).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  pendingCrypto.clear();
  trackWebCrypto();
  keys = 'hs256';
  hang = new Set();
  delay = new Map();
  hungSignals = [];
  rejectUser = false;
  userMismatch = false;
  refreshCalls = 0;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fixture-anon-key');
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-role-key-do-testow');
  mocks.maintenance.mockResolvedValue(false);
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('limit bramki w teście to limit z kodu', () => {
  expect(PROXY_GATE_TIMEOUT_MS).toBe(LIMIT_MS);
});

describe.each(['hs256', 'es256'] as const)('klucze %s', (mode) => {
  beforeEach(() => { keys = mode; });

  describe('serwer nie odpowiada: 503 po limicie, nigdy logowanie', () => {
    it.each([
      ['strona panelu', '/invoices', false],
      ['API panelu', '/api/invoices', true],
      ['panel operatora', '/admin', false],
    ] as const)('GoTrue wisi, %s (%s)', async (_name, path, api) => {
      hang.add('/auth/v1/user');

      await expectUnavailable(await settlesAtLimit(path), api);

      // Zawieszone żądania są przerwane, a nie zostawione w procesie.
      expect(hungSignals.length).toBeGreaterThan(0);
      expect(hungSignals.every((signal) => signal?.aborted === true)).toBe(true);
    });

    it('odświeżenie tokenu wisi: 503 po limicie, nie po 30 s ponowień auth-js', async () => {
      hang.add('/auth/v1/token');

      await expectUnavailable(await settlesAtLimit('/invoices', { state: 'expired' }), false);
      expect(refreshCalls).toBeGreaterThanOrEqual(1);
    });

    it('wybór firmy: baza wisi, więc 503, a nie /onboarding', async () => {
      hang.add('/rest/v1/memberships');

      await expectUnavailable(await settlesAtLimit('/dashboard', { org: false }), false);
      expect(hungSignals.every((signal) => signal?.aborted === true)).toBe(true);
    });

    it('sprawdzenie przerwy technicznej wisi: 503 po limicie', async () => {
      mocks.maintenance.mockReturnValue(new Promise<boolean>(() => {}));

      await expectUnavailable(await settlesAtLimit('/invoices'), false);
    });

    // Klucze publiczne (JWKS) po 10 minutach w pamięci auth-js pobiera na nowo.
    // Zawieszone pobranie to ten sam limit, co zawieszony GoTrue.
    it.runIf(mode === 'es256')('pobranie kluczy JWKS wisi: 503 po limicie', async () => {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      hang.add('/auth/v1/.well-known/jwks.json');

      await expectUnavailable(await settlesAtLimit('/invoices'), false);
      expect(hungSignals.every((signal) => signal?.aborted === true)).toBe(true);
    });

    // Przy HS256 każda trasa z ciasteczkiem sesji pyta GoTrue (getClaims), także
    // publiczna. Trasa publiczna nie potrzebuje sesji, więc po limicie jedzie
    // dalej jak dla gościa: bez 503, bez przekierowania i bez kasowania sesji.
    it.runIf(mode === 'hs256')('trasa publiczna z sesją: po limicie jak dla gościa', async () => {
      hang.add('/auth/v1/user');

      for (const path of ['/login', '/', '/pomoc']) {
        const response = await settlesAtLimit(path);
        expect(passedToRoute(response), path).toBe(true);
        expect(response.headers.get('location'), path).toBeNull();
        expect(clearedSessionCookies(response), path).toEqual([]);
      }
    });
  });

  describe('serwer odpowiada w limicie: decyzje bramki bez zmian', () => {
    it.each([
      ['od razu', 0],
      ['tuż przed limitem', LIMIT_MS - 500],
    ])('GoTrue odpowiada %s', async (_name, wait) => {
      if (wait > 0) delay.set('/auth/v1/user', wait);

      expect(passedToRoute(await decide('/invoices'))).toBe(true);
      expect(passedToRoute(await decide('/admin'))).toBe(true);

      const twoFactor = await decide('/invoices', { aal: 'aal1' });
      expect(twoFactor.headers.get('location')).toBe(challengeFor('/invoices'));

      const twoFactorApi = await decide('/api/invoices', { aal: 'aal1' });
      expect(twoFactorApi.status).toBe(403);
      expect(await twoFactorApi.json()).toEqual({ error: 'mfa_required' });
    });

    it('token odrzucony przez GoTrue tuż przed limitem: strona na logowanie, API 401', async () => {
      rejectUser = true;
      delay.set('/auth/v1/user', LIMIT_MS - 500);

      expect((await decide('/invoices')).headers.get('location')).toBe(loginFor('/invoices'));
      const api = await decide('/api/invoices');
      expect(api.status).toBe(401);
      expect(await api.json()).toEqual({ error: 'not_authenticated' });
    });

    it('GoTrue oddaje innego użytkownika niż token: dalej 503 (fail-closed bez zmian)', async () => {
      userMismatch = true;

      await expectUnavailable(await decide('/invoices'), false);
    });

    it('po decyzji nie zostaje żaden zegar bramki', async () => {
      const pending = track(updateSession(request('/invoices')));
      await advance(0);

      expect(pending.done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
