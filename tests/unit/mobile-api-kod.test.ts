import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Etap M6c planu aplikacji mobilnej: kod 2FA z telefonu przez
 * `POST /api/mobile/v1/kod`, a nie wprost do GoTrue.
 *
 * Powód (przegląd kodu M6b): telefon potwierdzał kod `mfa.challengeAndVerify`
 * wprost w GoTrue, więc omijał limit prób kodu, który ma strona
 * (`checkMfaRateLimit`: 5 prób na 5 minut na konto, Redis, fail-closed), i nie
 * zostawiał wpisów `auth.mfa_challenge_failed` / `auth.mfa_challenge_succeeded`.
 * Trasa robi to samo co `verifyMfaChallengeAction` (`app/(auth)/login/two-factor/actions.ts`)
 * i oddaje sesję AAL2 dla `supabase.auth.setSession`.
 *
 * Prawdziwa trasa, prawdziwa bramka (`authenticateMobileRequest`), prawdziwe
 * limity i audyt. Atrapy tylko dla HTTP i baz: GoTrue i PostgREST (przez
 * `fetch`), Redis (sorted set i licznik z czasem życia w pamięci), Sentry,
 * przerwa techniczna. Prawdziwy GoTrue sprawdza `tests/rls-mobile-kod.test.ts`.
 */

const SUPABASE_URL = 'https://db.fixture.test';
const ANON_KEY = 'anon-fixture-key';
const SERVICE_ROLE_KEY = 'service-fixture-key';

const USER_PLAIN = 'aaaaaaaa-1111-4111-8111-000000000001';
const USER_TOTP = 'bbbbbbbb-1111-4111-8111-000000000002';
/** 2FA innego rodzaju niż TOTP (aplikacja go nie obsługuje). */
const USER_PHONE = 'cccccccc-1111-4111-8111-000000000003';
const FACTOR = 'ffffffff-1111-4111-8111-000000000001';
const GOOD_CODE = '246810';

const fake = vi.hoisted(() => {
  const sets = new Map<string, Map<string, number>>();
  const counters = new Map<string, { count: number; expiresAt: number }>();
  const zset = (key: string) => {
    let set = sets.get(key);
    if (!set) sets.set(key, (set = new Map()));
    return set;
  };
  const state = { redisFails: false };
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
    /** Skrypt limitu kodu z `lib/rate-limit/mfa.ts`: stałe okno od pierwszej próby, odmowy nie liczą się dalej. */
    async eval(_script: string, keys: string[], args: number[]) {
      if (state.redisFails) throw new Error('Redis niedostępny');
      const [key] = keys as [string];
      const [limit, windowMs] = args as [number, number];
      const now = Date.now();
      const entry = counters.get(key);
      if (!entry || entry.expiresAt <= now) {
        counters.set(key, { count: 1, expiresAt: now + windowMs });
        return [1, 1, windowMs];
      }
      const ttl = entry.expiresAt - now;
      if (entry.count >= limit) return [0, entry.count, ttl];
      entry.count += 1;
      return [1, entry.count, ttl];
    },
  };
  return { client, sets, counters, state, maintenance: vi.fn(), captureException: vi.fn(), captureMessage: vi.fn() };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return { ...actual, isRedisConfigured: () => Boolean(process.env.UPSTASH_REDIS_REST_URL), getRedis: () => fake.client };
});
vi.mock('@/lib/feature-flags/maintenance', () => ({
  isMaintenanceMode: fake.maintenance,
  MAINTENANCE_PATH: '/przerwa-techniczna',
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: fake.captureException,
  captureMessage: fake.captureMessage,
}));

import { POST as kodRoute } from '@/app/api/mobile/v1/kod/route';
import { GET as kontoRoute } from '@/app/api/mobile/v1/konto/route';
import { checkMfaRateLimit } from '@/lib/rate-limit/mfa';

// ─── Konta i tokeny ───────────────────────────────────────────────────

const b64url = (value: string) => Buffer.from(value).toString('base64url');

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

interface Issued { sub: string; aal: 'aal1' | 'aal2'; sessionId: string }

/** Tokeny wydane przez atrapę GoTrue: token → konto, poziom i sesja. */
const issued = new Map<string, Issued>();
let tokenCounter = 0;

function issue(sub: string, aal: 'aal1' | 'aal2', sessionId: string): string {
  tokenCounter += 1;
  const now = Math.floor(Date.now() / 1000);
  const amr = aal === 'aal2'
    ? [{ method: 'totp', timestamp: now }, { method: 'password', timestamp: now - 10 }]
    : [{ method: 'password', timestamp: now }];
  const token = [
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64url(JSON.stringify({
      aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600,
      sub, aal, session_id: sessionId, amr, jti: String(tokenCounter),
    })),
    b64url('fixture-signature'),
  ].join('.');
  issued.set(token, { sub, aal, sessionId });
  return token;
}

const FACTORS: Record<string, Array<{ id: string; factor_type: string; status: string }>> = {
  [USER_PLAIN]: [],
  [USER_TOTP]: [{ id: FACTOR, factor_type: 'totp', status: 'verified' }],
  [USER_PHONE]: [{ id: 'eeeeeeee-1111-4111-8111-000000000001', factor_type: 'phone', status: 'verified' }],
};

// ─── Atrapa GoTrue i PostgREST ────────────────────────────────────────

let auditRows: Array<Record<string, unknown>> = [];
const challenges = new Map<string, { factorId: string; sub: string }>();
let challengeCounter = 0;
let verifyDown = false;
let verifyRateLimited = false;
/** GoTrue przyjmuje kod, ale oddaje token bez AAL2 (odpowiedź SDK nie może być jedynym dowodem). */
let verifyIssuesAal1 = false;
/** Sesja zakończona między bramką a wyzwaniem (wylogowanie na innym urządzeniu). */
let challengeSessionGone = false;
/** GoTrue odmawia kodu 403 z innego powodu niż brak sesji (np. hak MFA). */
let verifyForbidden = false;
const requests: Array<{ method: string; url: URL; authorization: string | null; apikey: string | null; body: string }> = [];

function bearerOf(headers: Headers): string | null {
  const value = headers.get('authorization');
  return value?.startsWith('Bearer ') ? value.slice(7) : null;
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

  if (url.pathname === '/auth/v1/user') {
    const session = token ? issued.get(token) : undefined;
    if (!session) return gotrueError(401, 'bad_jwt', 'invalid JWT');
    return Response.json({
      id: session.sub, aud: 'authenticated', role: 'authenticated', email: `${session.sub.slice(0, 4)}@ksef-saas.test`,
      app_metadata: { provider: 'email' }, user_metadata: {}, factors: FACTORS[session.sub], created_at: '2026-01-01T00:00:00Z',
    });
  }

  const factorPath = /^\/auth\/v1\/factors\/([^/]+)\/(challenge|verify)$/.exec(url.pathname);
  if (factorPath) {
    const [, factorId, step] = factorPath as unknown as [string, string, 'challenge' | 'verify'];
    // Kod potwierdza klient swoją sesją (klucz anon i jego token), nigdy klucz serwisowy.
    if (request.headers.get('apikey') !== ANON_KEY || token === SERVICE_ROLE_KEY) {
      return gotrueError(403, 'no_authorization', 'zły klucz');
    }
    const session = token ? issued.get(token) : undefined;
    if (!session || (step === 'challenge' && challengeSessionGone)) {
      return gotrueError(403, 'session_not_found', 'Session from session_id claim in JWT does not exist');
    }
    if (!FACTORS[session.sub]!.some((factor) => factor.id === factorId)) return gotrueError(404, 'mfa_factor_not_found', 'Factor not found');

    if (step === 'challenge') {
      challengeCounter += 1;
      const id = `cccccccc-3333-4333-8333-${String(challengeCounter).padStart(12, '0')}`;
      challenges.set(id, { factorId, sub: session.sub });
      return Response.json({ id, type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 300 });
    }

    if (verifyDown) return Response.json({ message: 'upstream' }, { status: 502 });
    if (verifyForbidden) return gotrueError(403, 'mfa_verification_rejected', 'MFA verification rejected');
    if (verifyRateLimited) return gotrueError(429, 'over_request_rate_limit', 'Request rate limit reached');
    const { challenge_id: challengeId, code } = JSON.parse(body) as { challenge_id?: string; code?: string };
    const challenge = challengeId ? challenges.get(challengeId) : undefined;
    if (!challenge || challenge.factorId !== factorId || challenge.sub !== session.sub) {
      return gotrueError(404, 'mfa_challenge_not_found', 'Challenge not found');
    }
    challenges.delete(challengeId!);
    if (code !== GOOD_CODE) return gotrueError(422, 'mfa_verification_failed', 'Invalid TOTP code entered');
    const access = issue(session.sub, verifyIssuesAal1 ? 'aal1' : 'aal2', session.sessionId);
    return Response.json({
      access_token: access, token_type: 'bearer', expires_in: 3600,
      refresh_token: `refresh-aal2-${tokenCounter}`,
      user: { id: session.sub, aud: 'authenticated', role: 'authenticated', factors: FACTORS[session.sub] },
    });
  }

  const table = url.pathname.replace('/rest/v1/', '');
  if (table === 'audit_logs' && request.method === 'POST') {
    if (token !== SERVICE_ROLE_KEY) return Response.json({ message: 'permission denied' }, { status: 403 });
    auditRows.push(JSON.parse(body) as Record<string, unknown>);
    return new Response(null, { status: 201 });
  }
  if (table === 'memberships' || table === 'users') return Response.json([]);
  return Response.json({ message: `nieoczekiwane zapytanie ${request.method} ${url.pathname}` }, { status: 404 });
}

// ─── Żądania ──────────────────────────────────────────────────────────

let ipCounter = 0;

function kodRequest(token: string | null, body: unknown, options: { raw?: string } = {}): Request {
  return new Request('https://app.example.test/api/mobile/v1/kod', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-real-ip': `198.51.100.${(ipCounter += 1) % 250}`,
      'user-agent': 'FaktWay/1 CFNetwork/3826 Darwin/25.0.0',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: options.raw ?? JSON.stringify(body),
  });
}

const potwierdz = (token: string | null, body: unknown, options?: { raw?: string }) => kodRoute(kodRequest(token, body, options));

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  const body = await response.json() as { error: { code: string; message: string } };
  return body.error;
}

const factorCalls = () => requests.filter((entry) => entry.url.pathname.startsWith('/auth/v1/factors/'));
const mfaAudit = () => auditRows.filter((row) => String(row.action).startsWith('auth.mfa_challenge'));

const SESSION_T = 'dddddddd-2222-4222-8222-000000000001';
let aal1Token = '';

beforeEach(() => {
  vi.clearAllMocks();
  fake.sets.clear();
  fake.counters.clear();
  fake.state.redisFails = false;
  requests.length = 0;
  issued.clear();
  challenges.clear();
  auditRows = [];
  verifyDown = false;
  verifyRateLimited = false;
  verifyIssuesAal1 = false;
  challengeSessionGone = false;
  verifyForbidden = false;
  fake.maintenance.mockResolvedValue(false);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_KEY);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY);
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.fixture.test');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-fixture-token');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  aal1Token = issue(USER_TOTP, 'aal1', SESSION_T);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ─── Dobry kod ────────────────────────────────────────────────────────

describe('POST /api/mobile/v1/kod: dobry kod', () => {
  it('sesja AAL1 konta z TOTP: nowa sesja AAL2 tej samej sesji GoTrue dla setSession', async () => {
    const response = await potwierdz(aal1Token, { kod: GOOD_CODE });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const body = await response.json() as { sesja: { accessToken: string; refreshToken: string } };
    expect(claimsOf(body.sesja.accessToken)).toMatchObject({ sub: USER_TOTP, aal: 'aal2', session_id: SESSION_T });
    expect(body.sesja.refreshToken).toMatch(/^refresh-aal2-/);

    // Wyzwanie i kod idą do GoTrue tokenem klienta i kluczem anon, jak ze strony.
    const calls = factorCalls();
    expect(calls.map((entry) => entry.url.pathname)).toEqual([
      `/auth/v1/factors/${FACTOR}/challenge`,
      `/auth/v1/factors/${FACTOR}/verify`,
    ]);
    for (const entry of calls) {
      expect(entry.authorization).toBe(aal1Token);
      expect(entry.apikey).toBe(ANON_KEY);
    }
    expect(JSON.parse(calls[1]!.body)).toMatchObject({ code: GOOD_CODE });
  });

  it('wpis auth.mfa_challenge_succeeded jak na stronie (z oznaczeniem telefonu), bez wpisu o błędzie', async () => {
    await potwierdz(aal1Token, { kod: ` ${GOOD_CODE} ` });
    expect(mfaAudit()).toHaveLength(1);
    expect(mfaAudit()[0]).toMatchObject({
      action: 'auth.mfa_challenge_succeeded',
      user_id: USER_TOTP,
      tenant_id: null,
      metadata: { method: 'totp', client: 'mobile' },
    });
  });

  it('dobry kod też zużywa próbę z limitu konta (jak na stronie)', async () => {
    await potwierdz(aal1Token, { kod: GOOD_CODE });
    expect([...fake.counters.values()].map((entry) => entry.count)).toEqual([1]);
  });

  it('GoTrue przyjął kod, ale nowy token nie jest AAL2: 503, bez wpisu o sukcesie i bez sesji', async () => {
    verifyIssuesAal1 = true;
    const response = await potwierdz(aal1Token, { kod: GOOD_CODE });
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('service_unavailable');
    expect(mfaAudit().filter((row) => row.action === 'auth.mfa_challenge_succeeded')).toHaveLength(0);
  });
});

// ─── Zły kod ──────────────────────────────────────────────────────────

describe('POST /api/mobile/v1/kod: zły kod i limit prób', () => {
  it('zły kod: 400 invalid_code i wpis auth.mfa_challenge_failed jak na stronie', async () => {
    const response = await potwierdz(aal1Token, { kod: '135799' });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe('invalid_code');
    expect(error.message).toBe('Kod nieprawidłowy. Sprawdź godzinę w telefonie i wpisz aktualny kod z aplikacji TOTP.');
    expect(mfaAudit()).toEqual([
      expect.objectContaining({
        action: 'auth.mfa_challenge_failed',
        user_id: USER_TOTP,
        tenant_id: null,
        metadata: { method: 'totp', stage: 'verify', client: 'mobile' },
      }),
    ]);
  });

  it('pięć złych kodów, szósta próba (nawet dobrym kodem): 429 z Retry-After, bez GoTrue', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await potwierdz(aal1Token, { kod: '000000' })).status).toBe(400);
    }
    requests.length = 0;
    const response = await potwierdz(aal1Token, { kod: GOOD_CODE });
    expect(response.status).toBe(429);
    expect((await errorOf(response)).code).toBe('rate_limited');
    const retryAfter = Number(response.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(300);
    expect(factorCalls()).toHaveLength(0);
    expect(mfaAudit()).toHaveLength(5);
  });

  it('limit wspólny ze stroną: po pięciu próbach na stronie telefon też czeka', async () => {
    // To samo wywołanie co `verifyMfaChallengeAction` (strona, ten sam klucz konta).
    for (let attempt = 0; attempt < 5; attempt += 1) await checkMfaRateLimit(USER_TOTP);
    const response = await potwierdz(aal1Token, { kod: GOOD_CODE });
    expect(response.status).toBe(429);
    expect(factorCalls()).toHaveLength(0);
  });

  it('kod w złym kształcie: 400 invalid_code bez zużycia próby i bez GoTrue', async () => {
    for (const kod of ['12345', '1234567', 'abcdef', '', 'ab-cd-ef']) {
      const response = await potwierdz(aal1Token, { kod });
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_code');
    }
    expect(fake.counters.size).toBe(0);
    expect(factorCalls()).toHaveLength(0);
    expect(mfaAudit()).toHaveLength(0);
  });

  it('treść bez kodu albo nie JSON: 400 invalid_request bez zużycia próby', async () => {
    for (const response of [
      await potwierdz(aal1Token, {}),
      await potwierdz(aal1Token, { kod: 246810 }),
      await potwierdz(aal1Token, null, { raw: 'kod=246810' }),
      await potwierdz(aal1Token, null, { raw: JSON.stringify({ kod: 'x'.repeat(5000) }) }),
    ]) {
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
    expect(fake.counters.size).toBe(0);
    expect(factorCalls()).toHaveLength(0);
  });
});

// ─── Fail-closed i awarie ─────────────────────────────────────────────

describe('POST /api/mobile/v1/kod: bez Redisa i przy awarii GoTrue', () => {
  it('Redis nie odpowiada: odmowa (fail-closed) 503 z Retry-After i komunikatem, bez GoTrue i bez wpisu', async () => {
    fake.state.redisFails = true;
    const response = await potwierdz(aal1Token, { kod: GOOD_CODE });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    const error = await errorOf(response);
    expect(error.code).toBe('service_unavailable');
    expect(error.message).toBe('Nie możemy teraz sprawdzić kodu. Spróbuj ponownie za chwilę.');
    expect(factorCalls()).toHaveLength(0);
    expect(mfaAudit()).toHaveLength(0);
    expect(fake.captureMessage).toHaveBeenCalled();
  });

  it('Redis nieskonfigurowany: ta sama odmowa', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    const response = await potwierdz(aal1Token, { kod: GOOD_CODE });
    expect(response.status).toBe(503);
    expect(factorCalls()).toHaveLength(0);
  });

  it('GoTrue nie odpowiada przy kodzie: 503 do ponowienia, bez wpisu o złym kodzie', async () => {
    verifyDown = true;
    const response = await potwierdz(aal1Token, { kod: GOOD_CODE });
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('service_unavailable');
    expect(mfaAudit()).toHaveLength(0);
  });

  it('limit GoTrue przy kodzie: 429 rate_limited', async () => {
    verifyRateLimited = true;
    const response = await potwierdz(aal1Token, { kod: GOOD_CODE });
    expect(response.status).toBe(429);
    expect((await errorOf(response)).code).toBe('rate_limited');
    expect(response.headers.get('retry-after')).toBe('60');
  });

  it('inna odmowa 403 przy kodzie: 503, nie 401 (telefon nie wysyła tego samego kodu drugi raz)', async () => {
    verifyForbidden = true;
    const response = await potwierdz(aal1Token, { kod: GOOD_CODE });
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('service_unavailable');
  });

  it('sesja zakończona między bramką a wyzwaniem: 401 invalid_token (telefon odświeża sesję)', async () => {
    challengeSessionGone = true;
    const response = await potwierdz(aal1Token, { kod: GOOD_CODE });
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe('invalid_token');
  });
});

// ─── Bramka ───────────────────────────────────────────────────────────

describe('POST /api/mobile/v1/kod: bramka', () => {
  it('bez tokenu: 401 missing_token; zły token: 401 invalid_token; bez próby z limitu', async () => {
    const missing = await potwierdz(null, { kod: GOOD_CODE });
    expect(missing.status).toBe(401);
    expect((await errorOf(missing)).code).toBe('missing_token');
    const invalid = await potwierdz('a.b.c', { kod: GOOD_CODE });
    expect(invalid.status).toBe(401);
    expect((await errorOf(invalid)).code).toBe('invalid_token');
    expect(fake.counters.size).toBe(0);
  });

  it('sesja nie czeka na kod (konto bez 2FA albo już AAL2): 409 mfa_not_required, bez próby i bez GoTrue', async () => {
    for (const token of [issue(USER_PLAIN, 'aal1', 'dddddddd-2222-4222-8222-000000000002'), issue(USER_TOTP, 'aal2', SESSION_T)]) {
      const response = await potwierdz(token, { kod: GOOD_CODE });
      expect(response.status).toBe(409);
      expect((await errorOf(response)).code).toBe('mfa_not_required');
    }
    expect(fake.counters.size).toBe(0);
    expect(factorCalls()).toHaveLength(0);
  });

  it('2FA bez TOTP: 400 invalid_request z komunikatem strony, bez zużycia próby i bez GoTrue', async () => {
    const response = await potwierdz(issue(USER_PHONE, 'aal1', 'dddddddd-2222-4222-8222-000000000003'), { kod: GOOD_CODE });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe('invalid_request');
    expect(error.message).toBe('Nie znaleźliśmy aktywnego 2FA. Skontaktuj się z pomocą techniczną.');
    expect(fake.counters.size).toBe(0);
    expect(factorCalls()).toHaveLength(0);
  });

  it('przerwa techniczna: 503 maintenance przed GoTrue', async () => {
    fake.maintenance.mockResolvedValue(true);
    const response = await potwierdz(aal1Token, { kod: GOOD_CODE });
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('maintenance');
    expect(factorCalls()).toHaveLength(0);
  });

  it('inne trasy dalej odmawiają sesji AAL1 konta z TOTP (403 mfa_required)', async () => {
    const response = await kontoRoute(new Request('https://app.example.test/api/mobile/v1/konto', {
      headers: { authorization: `Bearer ${aal1Token}`, 'x-real-ip': '198.51.100.250' },
    }));
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('mfa_required');
  });
});
