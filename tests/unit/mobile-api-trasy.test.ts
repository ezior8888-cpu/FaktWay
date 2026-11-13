import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Etap M6 planu aplikacji mobilnej (sekcja 4.3): trasy `/api/mobile/v1/*`.
 *
 * Prawdziwe trasy i prawdziwy kod uwierzytelniania (`lib/api/mobile/auth.ts`,
 * `lib/auth/verified-mfa.ts`). Atrapy tylko dla HTTP i baz: GoTrue i PostgREST
 * (przez `fetch`), Redis (sorted set w pamięci, jak w `api-v1-trasy.test.ts`),
 * kolejka zadań i przerwa techniczna.
 *
 * Atrapa GoTrue zna tylko wydane tokeny; atrapa PostgREST-a naśladuje RLS
 * (członkostwa tylko właściciela tokenu) i odrzuca klucz serwisowy przy
 * odczytach danych klienta. Prawdziwe polityki i prawdziwy GoTrue sprawdza
 * `tests/rls-mobile-api.test.ts` na bazie.
 */

const SUPABASE_URL = 'https://db.fixture.test';
const ANON_KEY = 'anon-fixture-key';
const SERVICE_ROLE_KEY = 'service-fixture-key';

const USER_A = 'aaaaaaaa-1111-4111-8111-000000000001';
const USER_TOTP = 'bbbbbbbb-1111-4111-8111-000000000002';
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_A2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000003';
const SESSION_A = 'cccccccc-2222-4222-8222-000000000001';
const SESSION_TOTP = 'cccccccc-2222-4222-8222-000000000002';

const fake = vi.hoisted(() => {
  const sets = new Map<string, Map<string, number>>();
  const zset = (key: string) => {
    let set = sets.get(key);
    if (!set) sets.set(key, (set = new Map()));
    return set;
  };
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
  return { client, sets, maintenance: vi.fn(), sendJobEvent: vi.fn(), captureException: vi.fn(), captureMessage: vi.fn() };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return { ...actual, isRedisConfigured: () => true, getRedis: () => fake.client };
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

import { GET as kontoRoute } from '@/app/api/mobile/v1/konto/route';
import { POST as sesjaRoute } from '@/app/api/mobile/v1/sesja/route';
import { authenticateMobileRequest, MOBILE_API_RATE_LIMITS } from '@/lib/api/mobile/auth';

// ─── Tokeny i konta ───────────────────────────────────────────────────

const b64url = (value: string) => Buffer.from(value).toString('base64url');

/** Token jak z GoTrue (HS256): `getClaims()` pyta wtedy GoTrue, więc o ważności decyduje atrapa. */
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
  factors: Array<{ id: string; factor_type: string; status: string }>;
}

const users: Record<string, FixtureUser> = {
  [USER_A]: { id: USER_A, email: 'a@ksef-saas.test', factors: [] },
  [USER_TOTP]: {
    id: USER_TOTP,
    email: 'totp@ksef-saas.test',
    factors: [{ id: 'factor-1', factor_type: 'totp', status: 'verified' }],
  },
};

const TOKEN_A = accessToken({
  sub: USER_A, aal: 'aal1', session_id: SESSION_A, amr: [{ method: 'password', timestamp: 1 }],
});
const TOKEN_TOTP_AAL1 = accessToken({
  sub: USER_TOTP, aal: 'aal1', session_id: SESSION_TOTP, amr: [{ method: 'password', timestamp: 1 }],
});
const TOKEN_TOTP_AAL2 = accessToken({
  sub: USER_TOTP, aal: 'aal2', session_id: SESSION_TOTP,
  amr: [{ method: 'totp', timestamp: 2 }, { method: 'oauth', timestamp: 1 }],
});
/** Token w poprawnym kształcie, którego GoTrue nie wydał (podrobiony albo z innej bazy). */
const TOKEN_FORGED = accessToken({ sub: USER_A, aal: 'aal2', session_id: SESSION_A });

const issuedTokens = new Map<string, string>([
  [TOKEN_A, USER_A],
  [TOKEN_TOTP_AAL1, USER_TOTP],
  [TOKEN_TOTP_AAL2, USER_TOTP],
]);

// ─── Atrapa GoTrue i PostgREST ────────────────────────────────────────

interface MembershipRow {
  user_id: string;
  organization_id: string;
  role: string;
  status: string;
  joined_at: string;
  name: string;
  nip: string;
}

let memberships: MembershipRow[] = [];
let lastActive: Record<string, string | null> = {};
let auditRows: Array<Record<string, unknown>> = [];
let gotrueDown = false;
let gotruePlain401 = false;
let auditInsertFails = false;
const requests: Array<{ method: string; url: URL; authorization: string | null; apikey: string | null; activeOrg: string | null }> = [];

function bearerOf(headers: Headers): string | null {
  const value = headers.get('authorization');
  return value?.startsWith('Bearer ') ? value.slice(7) : null;
}

function subOf(token: string | null): string | null {
  if (!token) return null;
  return issuedTokens.get(token) ?? null;
}

function eqFilter(url: URL, column: string): string | null {
  const value = url.searchParams.get(column);
  return value?.startsWith('eq.') ? value.slice(3) : null;
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const headers = request.headers;
  const token = bearerOf(headers);
  requests.push({
    method: request.method,
    url,
    authorization: token,
    apikey: headers.get('apikey'),
    activeOrg: headers.get('x-active-org'),
  });

  if (url.origin !== SUPABASE_URL) throw new Error(`nieoczekiwane wyjście do ${url.origin}`);

  if (url.pathname === '/auth/v1/user') {
    if (gotrueDown) return Response.json({ message: 'upstream' }, { status: 502 });
    if (gotruePlain401) return new Response('Unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } });
    const sub = subOf(token);
    if (!sub) return Response.json({ code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' }, { status: 401 });
    const user = users[sub]!;
    return Response.json({ id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, factors: user.factors });
  }

  const table = url.pathname.replace('/rest/v1/', '');
  const isService = token === SERVICE_ROLE_KEY;

  if (table === 'audit_logs') {
    if (!isService) return Response.json({ message: 'permission denied' }, { status: 403 });
    if (request.method === 'POST') {
      if (auditInsertFails) return Response.json({ message: 'insert failed' }, { status: 500 });
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      auditRows.push(body);
      return new Response(null, { status: 201 });
    }
    const userId = eqFilter(url, 'user_id');
    const action = eqFilter(url, 'action');
    const session = eqFilter(url, 'metadata->>session_id');
    const rows = auditRows.filter((row) => row.user_id === userId && row.action === action
      && (row.metadata as Record<string, unknown> | null)?.session_id === session);
    return Response.json(rows.map((row) => ({ id: row.id ?? 'audit-row' })));
  }

  // Dane klienta czyta wyłącznie token klienta (RLS), nigdy klucz serwisowy.
  if (isService) return Response.json({ message: 'API aplikacji nie może czytać kluczem serwisowym' }, { status: 418 });
  const sub = subOf(token);
  if (!sub) return Response.json({ message: 'JWT invalid' }, { status: 401 });

  if (table === 'memberships') {
    const rows = memberships
      .filter((row) => row.user_id === sub && row.status === 'active')
      .filter((row) => !eqFilter(url, 'organization_id') || row.organization_id === eqFilter(url, 'organization_id'))
      .sort((a, b) => b.joined_at.localeCompare(a.joined_at))
      .map((row) => ({
        organization_id: row.organization_id,
        role: row.role,
        joined_at: row.joined_at,
        tenants: { name: row.name, nip: row.nip },
      }));
    return Response.json(rows);
  }
  if (table === 'users') {
    return Response.json([{ last_active_tenant_id: lastActive[sub] ?? null }]);
  }
  return Response.json({ message: `nieznana tabela ${table}` }, { status: 404 });
}

// ─── Żądania ──────────────────────────────────────────────────────────

let ipCounter = 0;

function mobileRequest(path: string, options: {
  method?: string;
  authorization?: string | null;
  cookie?: string;
  activeOrg?: string;
  ip?: string;
} = {}): Request {
  const headers: Record<string, string> = {
    'x-real-ip': options.ip ?? `198.51.100.${(ipCounter += 1) % 250}`,
    'user-agent': 'FaktWay/1 CFNetwork/3826 Darwin/25.0.0',
  };
  if (options.authorization !== null) headers.authorization = options.authorization ?? `Bearer ${TOKEN_A}`;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.activeOrg) headers['x-active-org'] = options.activeOrg;
  return new Request(`https://app.example.test${path}`, { method: options.method ?? 'GET', headers });
}

const konto = (options?: Parameters<typeof mobileRequest>[1]) => kontoRoute(mobileRequest('/api/mobile/v1/konto', options));
const sesja = (options?: Parameters<typeof mobileRequest>[1]) =>
  sesjaRoute(mobileRequest('/api/mobile/v1/sesja', { method: 'POST', ...options }));

function goTrueCalls(): number {
  return requests.filter((entry) => entry.url.pathname.startsWith('/auth/v1/')).length;
}
function restCalls(): number {
  return requests.filter((entry) => entry.url.pathname.startsWith('/rest/v1/')).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.sets.clear();
  requests.length = 0;
  gotrueDown = false;
  gotruePlain401 = false;
  auditInsertFails = false;
  auditRows = [];
  memberships = [
    { user_id: USER_A, organization_id: ORG_A, role: 'owner', status: 'active', joined_at: '2026-01-02T00:00:00Z', name: 'Firma A', nip: '1234567890' },
    { user_id: USER_A, organization_id: ORG_A2, role: 'accountant', status: 'active', joined_at: '2026-03-01T00:00:00Z', name: 'Klient A2', nip: '1234567890' },
    { user_id: USER_A, organization_id: ORG_B, role: 'member', status: 'revoked', joined_at: '2026-04-01T00:00:00Z', name: 'Dawna firma', nip: '1234567890' },
    { user_id: USER_TOTP, organization_id: ORG_B, role: 'owner', status: 'active', joined_at: '2026-02-01T00:00:00Z', name: 'Firma B', nip: '1234567890' },
  ];
  lastActive = { [USER_A]: ORG_A, [USER_TOTP]: null };
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

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  const body = await response.json() as { error: { code: string; message: string } };
  return body.error;
}

// ─── Brak i zły token ─────────────────────────────────────────────────

describe('każda trasa sama odrzuca brak i zły token', () => {
  const routes = [['GET /konto', konto], ['POST /sesja', sesja]] as const;

  describe.each(routes)('%s', (_name, call) => {
    it('bez nagłówka Authorization: 401 missing_token, bez GoTrue i bazy', async () => {
      const response = await call({ authorization: null });
      expect(response.status).toBe(401);
      expect(await errorOf(response)).toMatchObject({ code: 'missing_token' });
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="FaktWay"');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(goTrueCalls()).toBe(0);
      expect(restCalls()).toBe(0);
    });

    it('sesja z ciasteczek przeglądarki nie otwiera API: 401 missing_token', async () => {
      const response = await call({ authorization: null, cookie: `sb-db-auth-token=base64-${b64url(JSON.stringify({ access_token: TOKEN_A }))}` });
      expect(response.status).toBe(401);
      expect(await errorOf(response)).toMatchObject({ code: 'missing_token' });
      expect(goTrueCalls()).toBe(0);
    });

    it.each([
      ['inny schemat', `Basic ${TOKEN_A}`],
      ['pusty Bearer', 'Bearer '],
      ['nie JWT', 'Bearer fwk_klucz_publicznego_api'],
      ['dwa tokeny', `Bearer ${TOKEN_A} ${TOKEN_A}`],
      ['za długi', `Bearer ${'a'.repeat(5000)}.${'b'.repeat(5000)}.c`],
    ])('zły kształt (%s): 401 invalid_token bez GoTrue', async (_label, authorization) => {
      const response = await call({ authorization });
      expect(response.status).toBe(401);
      expect(await errorOf(response)).toMatchObject({ code: 'invalid_token' });
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="FaktWay", error="invalid_token"');
      expect(goTrueCalls()).toBe(0);
      expect(restCalls()).toBe(0);
    });

    it('token, którego GoTrue nie uznaje (podrobiony, wygasły, wylogowany): 401 invalid_token bez bazy', async () => {
      const response = await call({ authorization: `Bearer ${TOKEN_FORGED}` });
      expect(response.status).toBe(401);
      expect(await errorOf(response)).toMatchObject({ code: 'invalid_token' });
      expect(goTrueCalls()).toBe(1);
      expect(restCalls()).toBe(0);
    });

    it('klucz anon albo serwisowy zamiast tokenu sesji: 401 invalid_token', async () => {
      for (const key of [ANON_KEY, SERVICE_ROLE_KEY]) {
        const response = await call({ authorization: `Bearer ${accessToken({ role: key === ANON_KEY ? 'anon' : 'service_role' })}` });
        expect(response.status).toBe(401);
        expect(await errorOf(response)).toMatchObject({ code: 'invalid_token' });
      }
      expect(restCalls()).toBe(0);
    });

    it('konto z TOTP w sesji AAL1: 403 mfa_required, zanim trasa dotknie bazy', async () => {
      const response = await call({ authorization: `Bearer ${TOKEN_TOTP_AAL1}` });
      expect(response.status).toBe(403);
      expect(await errorOf(response)).toMatchObject({ code: 'mfa_required' });
      expect(restCalls()).toBe(0);
      expect(fake.sendJobEvent).not.toHaveBeenCalled();
    });

    it('GoTrue niedostępny: 503 session_verification_failed, a nie 401 (telefon nie wyloguje klienta)', async () => {
      gotrueDown = true;
      const response = await call({ authorization: `Bearer ${TOKEN_A}` });
      expect(response.status).toBe(503);
      expect(await errorOf(response)).toMatchObject({ code: 'session_verification_failed' });
      expect(restCalls()).toBe(0);
    });

    it('odmowa GoTrue bez treści JSON to 401, nie 503 bez końca', async () => {
      gotruePlain401 = true;
      const response = await call({ authorization: `Bearer ${TOKEN_A}` });
      expect(response.status).toBe(401);
      expect(await errorOf(response)).toMatchObject({ code: 'invalid_token' });
    });

    it('przerwa techniczna: 503 maintenance, zanim trasa zapyta GoTrue', async () => {
      fake.maintenance.mockResolvedValue(true);
      const response = await call({});
      expect(response.status).toBe(503);
      expect(await errorOf(response)).toMatchObject({ code: 'maintenance' });
      expect(response.headers.get('retry-after')).toBe('300');
      expect(goTrueCalls()).toBe(0);
    });
  });
});

// ─── Limity prób ──────────────────────────────────────────────────────

describe('limity prób', () => {
  it('limit na adres obejmuje żądania bez tokenu i ze złym tokenem; nadmiar bez GoTrue', async () => {
    const ip = '203.0.113.7';
    const { limit } = MOBILE_API_RATE_LIMITS.ip;
    for (let i = 0; i < limit; i += 1) {
      const response = await konto({ ip, authorization: i % 2 ? null : 'Bearer zly' });
      expect(response.status).toBe(401);
    }
    const before = goTrueCalls();
    const blocked = await konto({ ip });
    expect(blocked.status).toBe(429);
    expect(await errorOf(blocked)).toMatchObject({ code: 'rate_limited' });
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(goTrueCalls()).toBe(before);
  });

  it('limit na osobę liczy żądania z różnych adresów', async () => {
    const { limit } = MOBILE_API_RATE_LIMITS.user;
    for (let i = 0; i < limit; i += 1) {
      expect((await konto({ ip: `192.0.2.${i % 200}` })).status).toBe(200);
    }
    const blocked = await konto({ ip: '192.0.2.250' });
    expect(blocked.status).toBe(429);
    expect(await errorOf(blocked)).toMatchObject({ code: 'rate_limited' });
  });
});

// ─── GET /api/mobile/v1/konto ─────────────────────────────────────────

describe('GET /api/mobile/v1/konto', () => {
  it('konto bez 2FA: firmy z aktywnym członkostwem, ostatnio używana na wierzchu; dane czyta token klienta', async () => {
    const response = await konto({});
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await response.json()).toEqual({
      konto: { id: USER_A, email: 'a@ksef-saas.test' },
      dwaEtapy: { wlaczone: false, poziom: 'aal1' },
      firmy: [
        { id: ORG_A2, nazwa: 'Klient A2', nip: '1234567890', rola: 'accountant' },
        { id: ORG_A, nazwa: 'Firma A', nip: '1234567890', rola: 'owner' },
      ],
      wszystkie: true,
      aktywnaFirma: ORG_A,
    });
    const rest = requests.filter((entry) => entry.url.pathname.startsWith('/rest/v1/'));
    expect(rest.length).toBeGreaterThan(0);
    for (const entry of rest) {
      expect(entry.authorization).toBe(TOKEN_A);
      expect(entry.apikey).toBe(ANON_KEY);
    }
  });

  it('konto z TOTP po kodzie (AAL2) przechodzi; bez ostatnio używanej firmy aktywna jest najnowsza', async () => {
    const response = await konto({ authorization: `Bearer ${TOKEN_TOTP_AAL2}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dwaEtapy: { wlaczone: true, poziom: 'aal2' },
      firmy: [{ id: ORG_B, nazwa: 'Firma B', rola: 'owner' }],
      aktywnaFirma: ORG_B,
    });
  });

  it('ostatnio używana firma bez członkostwa (odebrany dostęp) nie zostaje aktywną', async () => {
    lastActive[USER_A] = ORG_B;
    const response = await konto({});
    expect(await response.json()).toMatchObject({ aktywnaFirma: ORG_A2 });
  });

  it('konto bez żadnej firmy: pusta lista i brak aktywnej', async () => {
    memberships = memberships.filter((row) => row.user_id !== USER_A);
    const response = await konto({});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ firmy: [], aktywnaFirma: null });
  });
});

// ─── POST /api/mobile/v1/sesja ────────────────────────────────────────

describe('POST /api/mobile/v1/sesja: logowanie z telefonu w audycie', () => {
  it('pierwsze wywołanie zapisuje auth.login tej sesji i zleca sprawdzenie nowego urządzenia', async () => {
    const response = await sesja({});
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ zapisane: true });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'auth.login',
      user_id: USER_A,
      tenant_id: ORG_A,
      metadata: { method: 'password', session_id: SESSION_A, client: 'mobile' },
    });
    expect(fake.sendJobEvent).toHaveBeenCalledTimes(1);
    expect(fake.sendJobEvent.mock.calls[0]![0]).toMatchObject({
      data: { userId: USER_A, sessionId: SESSION_A },
    });
  });

  it('ponowienie dla tej samej sesji niczego nie dopisuje', async () => {
    expect((await sesja({})).status).toBe(201);
    const again = await sesja({});
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ zapisane: false });
    expect(auditRows).toHaveLength(1);
    expect(fake.sendJobEvent).toHaveBeenCalledTimes(1);
  });

  it('logowanie Google z kodem 2FA: metoda z claimu amr, firma ostatnio używana pusta', async () => {
    const response = await sesja({ authorization: `Bearer ${TOKEN_TOTP_AAL2}` });
    expect(response.status).toBe(201);
    expect(auditRows[0]).toMatchObject({
      action: 'auth.login',
      user_id: USER_TOTP,
      tenant_id: ORG_B,
      metadata: { method: 'google', session_id: SESSION_TOTP, client: 'mobile' },
    });
  });

  it('ostatnio używana firma bez dostępu: wpis dostaje najpóźniej dołączoną', async () => {
    lastActive[USER_A] = ORG_B;
    expect((await sesja({})).status).toBe(201);
    expect(auditRows[0]).toMatchObject({ tenant_id: ORG_A2 });
  });

  it('nieudany zapis audytu: 503 i bez zlecenia (runner nie znalazłby wpisu), telefon ponowi', async () => {
    auditInsertFails = true;
    const response = await sesja({});
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatchObject({ code: 'service_unavailable' });
    expect(fake.sendJobEvent).not.toHaveBeenCalled();
  });

  it('GET na /sesja nie istnieje', async () => {
    const routeModule = await import('@/app/api/mobile/v1/sesja/route');
    expect('GET' in routeModule).toBe(false);
  });
});

// ─── Aktywna firma (trasy z danymi firmy, od M7) ──────────────────────

describe('authenticateMobileRequest z firmą', () => {
  const withOrg = (activeOrg?: string, authorization = `Bearer ${TOKEN_A}`) =>
    authenticateMobileRequest(mobileRequest('/api/mobile/v1/x', { activeOrg, authorization }), { org: 'required' });

  it('bez nagłówka X-Active-Org: 400 missing_org', async () => {
    const result = await withOrg();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
    expect(await errorOf(result.response)).toMatchObject({ code: 'missing_org' });
  });

  it('nagłówek, który nie jest UUID: 400 missing_org', async () => {
    const result = await withOrg('firma-a');
    if (result.ok) throw new Error('powinno odmówić');
    expect(result.response.status).toBe(400);
  });

  it.each([
    ['cofnięte członkostwo', ORG_B],
    ['firma bez członkostwa', 'dddddddd-0000-4000-8000-000000000009'],
  ])('%s: 403 no_active_org', async (_label, org) => {
    const result = await withOrg(org);
    if (result.ok) throw new Error('powinno odmówić');
    expect(result.response.status).toBe(403);
    expect(await errorOf(result.response)).toMatchObject({ code: 'no_active_org' });
  });

  it('własna firma: klient bazy niesie token klienta i nagłówek x-active-org (RLS jak na stronie)', async () => {
    const result = await withOrg(ORG_A);
    if (!result.ok) throw new Error(`odmowa ${result.response.status}`);
    expect(result.caller.org).toEqual({ tenantId: ORG_A, role: 'owner' });
    requests.length = 0;
    await result.caller.db.from('memberships').select('organization_id');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ authorization: TOKEN_A, apikey: ANON_KEY, activeOrg: ORG_A });
  });

  it('AAL1 konta z TOTP nie dochodzi do sprawdzenia firmy', async () => {
    const result = await withOrg(ORG_B, `Bearer ${TOKEN_TOTP_AAL1}`);
    if (result.ok) throw new Error('powinno odmówić');
    expect(result.response.status).toBe(403);
    expect(await errorOf(result.response)).toMatchObject({ code: 'mfa_required' });
    expect(restCalls()).toBe(0);
  });
});
