import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Etap M6b planu aplikacji mobilnej (decyzja D16): logowanie hasłem z telefonu
 * przez `POST /api/mobile/v1/logowanie`, a nie wprost do GoTrue.
 *
 * Powód: po kroku 2 runbooka `docs/runbooks/captcha-w-gotrue.md` GoTrue odrzuca
 * logowanie hasłem bez tokenu Turnstile (`captcha_failed`), a aplikacja go nie
 * ma. Trasa loguje kluczem serwisowym, który GoTrue przepuszcza bez captchy
 * (sprawdzone na lokalnym GoTrue z captchą, wynik w opisie PR), za naszymi
 * limitami prób i z wpisem w audycie.
 *
 * Prawdziwa trasa, prawdziwe limity (`lib/rate-limit`), prawdziwy audyt.
 * Atrapy tylko dla HTTP i baz: GoTrue i PostgREST (przez `fetch`), Redis
 * (sorted set w pamięci, jak w `mobile-api-trasy.test.ts`), kolejka zadań
 * i przerwa techniczna. Atrapa GoTrue zachowuje się jak GoTrue z włączoną
 * captchą: klucz anon dostaje `captcha_failed`. Prawdziwy GoTrue sprawdza
 * `tests/rls-mobile-logowanie.test.ts`.
 */

const SUPABASE_URL = 'https://db.fixture.test';
const ANON_KEY = 'anon-fixture-key';
const SERVICE_ROLE_KEY = 'service-fixture-key';

const USER_A = 'aaaaaaaa-1111-4111-8111-000000000001';
const USER_TOTP = 'bbbbbbbb-1111-4111-8111-000000000002';
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const PASS = 'Poprawne-Haslo-2026';

const fake = vi.hoisted(() => {
  const sets = new Map<string, Map<string, number>>();
  const zset = (key: string) => {
    let set = sets.get(key);
    if (!set) sets.set(key, (set = new Map()));
    return set;
  };
  const state = { redisConfigured: true, redisFails: false };
  const client = {
    pipeline() {
      const operations: Array<() => number> = [];
      const pipe = {
        zremrangebyscore(key: string, min: number, max: number) {
          operations.push(() => {
            for (const [member, score] of zset(key)) if (score >= min && score <= max) zset(key).delete(member);
            return 0;
          });
          return pipe;
        },
        zadd(key: string, entry: { score: number; member: string }) {
          operations.push(() => (zset(key).set(entry.member, entry.score), 1));
          return pipe;
        },
        zcard(key: string) {
          operations.push(() => zset(key).size);
          return pipe;
        },
        expire() {
          operations.push(() => 1);
          return pipe;
        },
        async exec() {
          if (state.redisFails) throw new Error('Redis niedostępny');
          return operations.map((operation) => operation());
        },
      };
      return pipe;
    },
    async zrange(key: string) {
      const oldest = [...zset(key)].sort((a, b) => a[1] - b[1])[0];
      return oldest ? [oldest[0], oldest[1]] : [];
    },
    async zrem(key: string, member: string) {
      return zset(key).delete(member) ? 1 : 0;
    },
  };
  return { client, sets, state, maintenance: vi.fn(), sendJobEvent: vi.fn(), captureException: vi.fn(), captureMessage: vi.fn() };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return { ...actual, isRedisConfigured: () => fake.state.redisConfigured, getRedis: () => fake.client };
});
vi.mock('@/lib/feature-flags/maintenance', () => ({
  isMaintenanceMode: fake.maintenance,
  MAINTENANCE_PATH: '/przerwa-techniczna',
}));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: fake.sendJobEvent }));
vi.mock('@sentry/nextjs', () => ({
  captureException: fake.captureException,
  captureMessage: fake.captureMessage,
}));

import { POST as logowanieRoute } from '@/app/api/mobile/v1/logowanie/route';
import { MOBILE_LOGIN_RATE_LIMITS } from '@/lib/rate-limit/auth';

// ─── Konta i tokeny ───────────────────────────────────────────────────

const b64url = (value: string) => Buffer.from(value).toString('base64url');

function accessToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64url(JSON.stringify({ aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600, ...claims })),
    b64url('fixture-signature'),
  ].join('.');
}

interface FixtureUser {
  id: string;
  email: string;
  password: string;
  factors: Array<{ id: string; factor_type: string; status: string }>;
}

const users: FixtureUser[] = [
  { id: USER_A, email: 'a@ksef-saas.test', password: PASS, factors: [] },
  {
    id: USER_TOTP,
    email: 'totp@ksef-saas.test',
    password: PASS,
    factors: [{ id: 'factor-1', factor_type: 'totp', status: 'verified' }],
  },
];

/** Tokeny wydane przez atrapę: token → użytkownik. */
const issued = new Map<string, string>();
let sessionCounter = 0;

// ─── Atrapa GoTrue i PostgREST ────────────────────────────────────────

let auditRows: Array<Record<string, unknown>> = [];
let lastActive: Record<string, string | null> = {};
let gotrueDown = false;
let gotrueRateLimited = false;
/** GoTrue odrzuca captchą nawet klucz serwisowy (zła konfiguracja klucza w aplikacji). */
let captchaForEveryone = false;
let auditInsertFails = false;
const requests: Array<{ method: string; url: URL; authorization: string | null; apikey: string | null; body: string }> = [];

function bearerOf(headers: Headers): string | null {
  const value = headers.get('authorization');
  return value?.startsWith('Bearer ') ? value.slice(7) : null;
}

function eqFilter(url: URL, column: string): string | null {
  const value = url.searchParams.get(column);
  return value?.startsWith('eq.') ? value.slice(3) : null;
}

const gotrueError = (status: number, code: string, msg: string) =>
  Response.json({ code: status, error_code: code, msg }, { status });

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const token = bearerOf(request.headers);
  const body = request.method === 'GET' ? '' : await request.text();
  requests.push({ method: request.method, url, authorization: token, apikey: request.headers.get('apikey'), body });

  if (url.origin !== SUPABASE_URL) throw new Error(`nieoczekiwane wyjście do ${url.origin}`);

  if (url.pathname === '/auth/v1/token') {
    if (gotrueDown) return Response.json({ message: 'upstream' }, { status: 502 });
    if (gotrueRateLimited) return gotrueError(429, 'over_request_rate_limit', 'Request rate limit reached');
    // GoTrue z włączoną captchą: bez tokenu przechodzi tylko klucz serwisowy w nagłówku Authorization.
    if (url.searchParams.get('grant_type') === 'password' && (captchaForEveryone || token !== SERVICE_ROLE_KEY)) {
      return gotrueError(400, 'captcha_failed', 'captcha protection: request disallowed (no captcha_token found)');
    }
    const { email, password } = JSON.parse(body) as { email?: string; password?: string };
    const user = users.find((candidate) => candidate.email === email && candidate.password === password);
    if (!user) return gotrueError(400, 'invalid_credentials', 'Invalid login credentials');
    sessionCounter += 1;
    const sessionId = `cccccccc-2222-4222-8222-${String(sessionCounter).padStart(12, '0')}`;
    const access = accessToken({ sub: user.id, email: user.email, aal: 'aal1', session_id: sessionId, amr: [{ method: 'password', timestamp: 1 }] });
    issued.set(access, user.id);
    return Response.json({
      access_token: access,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: `refresh-${sessionCounter}`,
      user: {
        id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email,
        app_metadata: { provider: 'email' }, user_metadata: {}, factors: user.factors,
        created_at: '2026-01-01T00:00:00Z',
      },
    });
  }

  const table = url.pathname.replace('/rest/v1/', '');
  const isService = token === SERVICE_ROLE_KEY;

  if (table === 'audit_logs') {
    if (!isService) return Response.json({ message: 'permission denied' }, { status: 403 });
    if (request.method === 'POST') {
      if (auditInsertFails) return Response.json({ message: 'insert failed' }, { status: 500 });
      auditRows.push(JSON.parse(body) as Record<string, unknown>);
      return new Response(null, { status: 201 });
    }
    const userId = eqFilter(url, 'user_id');
    const action = eqFilter(url, 'action');
    const session = eqFilter(url, 'metadata->>session_id');
    const rows = auditRows.filter((row) => row.user_id === userId && row.action === action
      && (row.metadata as Record<string, unknown> | null)?.session_id === session);
    return Response.json(rows.map(() => ({ id: 'audit-row' })));
  }

  // Dane klienta czyta wyłącznie token klienta (RLS), nigdy klucz serwisowy.
  if (isService) return Response.json({ message: 'logowanie nie może czytać danych kluczem serwisowym' }, { status: 418 });
  const sub = token ? issued.get(token) : undefined;
  if (!sub) return Response.json({ message: 'JWT invalid' }, { status: 401 });
  if (table === 'users') return Response.json([{ last_active_tenant_id: lastActive[sub] ?? null }]);
  if (table === 'memberships') {
    return Response.json(sub === USER_A ? [{ organization_id: ORG_A, role: 'owner' }] : []);
  }
  return Response.json({ message: `nieznana tabela ${table}` }, { status: 404 });
}

// ─── Żądania ──────────────────────────────────────────────────────────

let ipCounter = 0;

function loginRequest(body: unknown, options: { ip?: string; raw?: string } = {}): Request {
  return new Request('https://app.example.test/api/mobile/v1/logowanie', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-real-ip': options.ip ?? `198.51.100.${(ipCounter += 1) % 250}`,
      'user-agent': 'FaktWay/1 CFNetwork/3826 Darwin/25.0.0',
    },
    body: options.raw ?? JSON.stringify(body),
  });
}

const zaloguj = (body: unknown, options?: Parameters<typeof loginRequest>[1]) => logowanieRoute(loginRequest(body, options));

function goTrueCalls(): number {
  return requests.filter((entry) => entry.url.pathname.startsWith('/auth/v1/')).length;
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  const body = await response.json() as { error: { code: string; message: string } };
  return body.error;
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.sets.clear();
  fake.state.redisConfigured = true;
  fake.state.redisFails = false;
  requests.length = 0;
  issued.clear();
  auditRows = [];
  lastActive = { [USER_A]: ORG_A, [USER_TOTP]: null };
  gotrueDown = false;
  gotrueRateLimited = false;
  captchaForEveryone = false;
  auditInsertFails = false;
  fake.maintenance.mockResolvedValue(false);
  fake.sendJobEvent.mockResolvedValue(undefined);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_KEY);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY);
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ─── Udane logowanie ──────────────────────────────────────────────────

describe('POST /api/mobile/v1/logowanie: udane logowanie przy captchy w GoTrue', () => {
  it('konto bez 2FA: sesja z GoTrue i wymagaKodu false; GoTrue dostał klucz serwisowy w Authorization', async () => {
    const response = await zaloguj({ email: '  A@ksef-saas.test ', haslo: PASS });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const body = await response.json() as { sesja: { accessToken: string; refreshToken: string }; wymagaKodu: boolean };
    expect(body.wymagaKodu).toBe(false);
    expect(issued.get(body.sesja.accessToken)).toBe(USER_A);
    expect(body.sesja.refreshToken).toBe('refresh-1');

    const login = requests.filter((entry) => entry.url.pathname === '/auth/v1/token');
    expect(login).toHaveLength(1);
    expect(login[0]!.url.searchParams.get('grant_type')).toBe('password');
    expect(login[0]!.authorization).toBe(SERVICE_ROLE_KEY);
    // E-mail jak na stronie: bez spacji i małymi literami.
    expect(JSON.parse(login[0]!.body)).toMatchObject({ email: 'a@ksef-saas.test', password: PASS });
  });

  it('wpis auth.login jak przy logowaniu na stronie (firma ostatnio używana, sesja, telefon) i sprawdzenie nowego urządzenia', async () => {
    const response = await zaloguj({ email: 'a@ksef-saas.test', haslo: PASS });
    const { sesja } = await response.json() as { sesja: { accessToken: string } };
    const sessionId = JSON.parse(Buffer.from(sesja.accessToken.split('.')[1]!, 'base64url').toString()).session_id as string;

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'auth.login',
      user_id: USER_A,
      tenant_id: ORG_A,
      metadata: { method: 'password', session_id: sessionId, client: 'mobile' },
    });
    expect(fake.sendJobEvent).toHaveBeenCalledTimes(1);
    expect(fake.sendJobEvent.mock.calls[0]![0]).toMatchObject({ data: { userId: USER_A, sessionId } });
    // Firmę wpisu czyta token klienta (RLS), nie klucz serwisowy.
    const rest = requests.filter((entry) => entry.url.pathname.startsWith('/rest/v1/') && !entry.url.pathname.endsWith('audit_logs'));
    expect(rest.length).toBeGreaterThan(0);
    for (const entry of rest) expect(entry.authorization).toBe(sesja.accessToken);
    // Świeża sesja nie ma wpisu: bez zapytania o niego (robi to tylko POST /sesja).
    expect(requests.filter((entry) => entry.url.pathname.endsWith('audit_logs') && entry.method === 'GET')).toHaveLength(0);
  });

  it('konto z TOTP: sesja AAL1 i wymagaKodu true; wpis logowania jak na stronie (przed kodem)', async () => {
    const response = await zaloguj({ email: 'totp@ksef-saas.test', haslo: PASS });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ wymagaKodu: true });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ action: 'auth.login', user_id: USER_TOTP, tenant_id: null });
  });

  it('nieudany zapis audytu nie blokuje logowania; bez wpisu nie ma zlecenia maila (zrobi je POST /sesja)', async () => {
    auditInsertFails = true;
    const response = await zaloguj({ email: 'a@ksef-saas.test', haslo: PASS });
    expect(response.status).toBe(200);
    expect(fake.sendJobEvent).not.toHaveBeenCalled();
  });
});

// ─── Odmowy ───────────────────────────────────────────────────────────

describe('POST /api/mobile/v1/logowanie: odmowy', () => {
  it.each([
    ['złe hasło', { email: 'a@ksef-saas.test', haslo: 'zle-haslo' }],
    ['nieznany e-mail', { email: 'nikt@ksef-saas.test', haslo: PASS }],
  ])('%s: 400 invalid_credentials i wpis auth.login_failed bez adresu e-mail i hasła', async (_label, body) => {
    const response = await zaloguj(body);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toEqual({
      code: 'invalid_credentials',
      message: 'Nieprawidłowy e-mail lub hasło. Upewnij się, że e-mail jest potwierdzony.',
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'auth.login_failed',
      user_id: null,
      tenant_id: null,
      metadata: { method: 'password', client: 'mobile', reason: 'invalid_credentials' },
    });
    const zapis = JSON.stringify(auditRows[0]);
    expect(zapis).not.toContain(body.email);
    expect(zapis).not.toContain(body.haslo);
    expect((auditRows[0]!.metadata as { email_hash?: unknown }).email_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(fake.sendJobEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['brak hasła', { email: 'a@ksef-saas.test' }],
    ['puste pola', { email: ' ', haslo: '' }],
    ['nie napis', { email: ['a@ksef-saas.test'], haslo: PASS }],
    ['e-mail bez @', { email: 'ksef-saas.test', haslo: PASS }],
    ['za długie hasło', { email: 'a@ksef-saas.test', haslo: 'x'.repeat(2000) }],
  ])('%s: 400 invalid_request bez GoTrue', async (_label, body) => {
    const response = await zaloguj(body);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: 'invalid_request' });
    expect(goTrueCalls()).toBe(0);
  });

  it('treść, która nie jest JSON-em: 400 invalid_request', async () => {
    const response = await zaloguj(null, { raw: 'email=a@ksef-saas.test&haslo=x' });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: 'invalid_request' });
    expect(goTrueCalls()).toBe(0);
  });

  it('przerwa techniczna: 503 maintenance bez GoTrue', async () => {
    fake.maintenance.mockResolvedValue(true);
    const response = await zaloguj({ email: 'a@ksef-saas.test', haslo: PASS });
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatchObject({ code: 'maintenance' });
    expect(goTrueCalls()).toBe(0);
  });

  it('GoTrue niedostępny: 503 service_unavailable (telefon ponawia, bez wpisu o złym haśle)', async () => {
    gotrueDown = true;
    const response = await zaloguj({ email: 'a@ksef-saas.test', haslo: PASS });
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatchObject({ code: 'service_unavailable' });
    expect(auditRows).toHaveLength(0);
  });

  it('limit GoTrue: 429 rate_limited z Retry-After', async () => {
    gotrueRateLimited = true;
    const response = await zaloguj({ email: 'a@ksef-saas.test', haslo: PASS });
    expect(response.status).toBe(429);
    expect(await errorOf(response)).toMatchObject({ code: 'rate_limited' });
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('GoTrue odrzuca captchą nawet klucz serwisowy (zła konfiguracja): 503 login_unavailable i zgłoszenie do nas', async () => {
    captchaForEveryone = true;
    const response = await zaloguj({ email: 'a@ksef-saas.test', haslo: PASS });
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toEqual({
      code: 'login_unavailable',
      message: 'Logowanie w aplikacji jest chwilowo niedostępne. Zaloguj się na faktway.pl albo spróbuj za kilka minut.',
    });
    expect(fake.captureMessage).toHaveBeenCalled();
    expect(auditRows).toHaveLength(0);
  });

  it('hasło i adres e-mail nie trafiają do Sentry', async () => {
    captchaForEveryone = true;
    await zaloguj({ email: 'a@ksef-saas.test', haslo: PASS });
    gotrueDown = true;
    await zaloguj({ email: 'a@ksef-saas.test', haslo: PASS });
    const sent = JSON.stringify([...fake.captureMessage.mock.calls, ...fake.captureException.mock.calls]);
    expect(sent).not.toContain(PASS);
    expect(sent).not.toContain('a@ksef-saas.test');
  });
});

// ─── Limity prób ──────────────────────────────────────────────────────

describe('POST /api/mobile/v1/logowanie: limity prób', () => {
  it('na adres IP: różne konta z jednego adresu, nadmiar bez GoTrue', async () => {
    const ip = '203.0.113.7';
    const { limit } = MOBILE_LOGIN_RATE_LIMITS.ip;
    for (let i = 0; i < limit; i += 1) {
      expect((await zaloguj({ email: `nikt-${i}@ksef-saas.test`, haslo: PASS }, { ip })).status).toBe(400);
    }
    const before = goTrueCalls();
    const blocked = await zaloguj({ email: 'a@ksef-saas.test', haslo: PASS }, { ip });
    expect(blocked.status).toBe(429);
    expect(await errorOf(blocked)).toMatchObject({ code: 'rate_limited' });
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(goTrueCalls()).toBe(before);
  });

  it('na adres e-mail: jedno konto z wielu adresów, nadmiar bez GoTrue', async () => {
    const { limit } = MOBILE_LOGIN_RATE_LIMITS.email;
    for (let i = 0; i < limit; i += 1) {
      expect((await zaloguj({ email: 'a@ksef-saas.test', haslo: `zle-${i}` }, { ip: `192.0.2.${i}` })).status).toBe(400);
    }
    const before = goTrueCalls();
    const blocked = await zaloguj({ email: 'A@ksef-saas.test', haslo: PASS }, { ip: '192.0.2.200' });
    expect(blocked.status).toBe(429);
    expect(goTrueCalls()).toBe(before);
    // Odmowy nie przedłużają blokady cudzego konta: w oknie zostaje 10 prób, nie 12.
    expect((await zaloguj({ email: 'a@ksef-saas.test', haslo: PASS }, { ip: '192.0.2.201' })).status).toBe(429);
    const emailKeys = [...fake.sets.entries()].filter(([key]) => key.startsWith('rl:mobile_login_email:'));
    expect(emailKeys).toHaveLength(1);
    expect(emailKeys[0]![1].size).toBe(limit);
  });

  it('ten sam limit co logowanie na stronie (5 prób na adres i e-mail w 15 minut)', async () => {
    const ip = '203.0.113.9';
    for (let i = 0; i < 5; i += 1) {
      expect((await zaloguj({ email: 'a@ksef-saas.test', haslo: `zle-${i}` }, { ip })).status).toBe(400);
    }
    const blocked = await zaloguj({ email: 'a@ksef-saas.test', haslo: PASS }, { ip });
    expect(blocked.status).toBe(429);
    // Kubełek strony (`checkLoginRateLimit`): próby z telefonu i z formularza liczą się razem.
    expect([...fake.sets.keys()].some((key) => key.startsWith('rl:login:'))).toBe(true);
  });

  it('bez Redisa: 503 login_unavailable z drogą na stronę, bez GoTrue (fail-closed)', async () => {
    fake.state.redisConfigured = false;
    const response = await zaloguj({ email: 'a@ksef-saas.test', haslo: PASS });
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toEqual({
      code: 'login_unavailable',
      message: 'Logowanie w aplikacji jest chwilowo niedostępne. Zaloguj się na faktway.pl albo spróbuj za kilka minut.',
    });
    expect(response.headers.get('retry-after')).toBe('60');
    expect(goTrueCalls()).toBe(0);
  });

  it('awaria Redisa w trakcie: 503 login_unavailable, bez GoTrue', async () => {
    fake.state.redisFails = true;
    const response = await zaloguj({ email: 'a@ksef-saas.test', haslo: PASS });
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatchObject({ code: 'login_unavailable' });
    expect(goTrueCalls()).toBe(0);
  });
});

describe('trasa logowania', () => {
  it('ma tylko POST', async () => {
    const routeModule = await import('@/app/api/mobile/v1/logowanie/route');
    expect(Object.keys(routeModule).filter((key) => /^[A-Z]+$/.test(key))).toEqual(['POST']);
  });
});
