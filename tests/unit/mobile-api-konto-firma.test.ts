import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan aplikacji mobilnej, M10b: wybór firmy zapisany jak na stronie
 * (`users.last_active_tenant_id`) i usunięcie konta (RODO, 14 dni) z telefonu.
 *
 * Prawdziwe: trasy `app/api/mobile/v1/{firma,konto/usuniecie}`, bramka
 * `authenticateMobileRequest`, `lib/api/mobile/konto-usuniecie.ts`,
 * `lib/auth/password-check.ts` (hasło w GoTrue, ten sam limit prób co strona),
 * `lib/gdpr/account-deletion.ts` (to samo co akcja strony: żądanie, mail,
 * audyt). Atrapy: HTTP (GoTrue, PostgREST), Redis, magazyn żądań RODO (klucz
 * serwisowy, własne testy `gdpr-deletion`), limit prób hasła, mail, audyt.
 *
 * Reguła telefonu (decyzja M10b): 2FA wymusza bramka (sesja po kodzie); konto
 * z hasłem potwierdza hasłem; konto bez hasła (tylko Google) potwierdza
 * świeżym logowaniem w tej sesji (najwyżej 10 minut, claim `amr`). Metoda z
 * serwera (`app_metadata.providers`), nie z telefonu.
 */

const SUPABASE_URL = 'https://db.fixture.test';
const ANON_KEY = 'anon-fixture-key';
const SERVICE_ROLE_KEY = 'service-fixture-key';

const USER_PASS = 'aaaaaaaa-1111-4111-8111-000000000001';
const USER_GOOGLE = 'aaaaaaaa-1111-4111-8111-000000000002';
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const NOW = new Date('2026-11-14T09:00:00Z');

const fake = vi.hoisted(() => {
  const sets = new Map<string, Map<string, number>>();
  const zset = (key: string) => {
    let set = sets.get(key);
    if (!set) sets.set(key, (set = new Map()));
    return set;
  };
  const client = {
    pipeline() {
      const ops: Array<() => number> = [];
      const pipe = {
        zremrangebyscore: () => (ops.push(() => 0), pipe),
        zadd: (key: string, entry: { score: number; member: string }) => (ops.push(() => (zset(key).set(entry.member, entry.score), 1)), pipe),
        zcard: (key: string) => (ops.push(() => zset(key).size), pipe),
        expire: () => (ops.push(() => 1), pipe),
        exec: async () => ops.map((op) => op()),
      };
      return pipe;
    },
    zrange: async () => [],
    zrem: async () => 0,
  };
  return {
    client,
    sets,
    audit: vi.fn(),
    revalidate: vi.fn(),
    mail: vi.fn(async () => ({ sent: true })),
    limit: vi.fn(async () => ({ allowed: true, retryAfter: 0, unavailable: false })),
    create: vi.fn(),
    cancel: vi.fn(),
    active: vi.fn(),
  };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return { ...actual, isRedisConfigured: () => true, getRedis: () => fake.client };
});
vi.mock('@/lib/feature-flags/maintenance', () => ({ isMaintenanceMode: async () => false, MAINTENANCE_PATH: '/przerwa-techniczna' }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: fake.revalidate }));
vi.mock('@/lib/audit/log', () => ({ logAudit: fake.audit, logAuditWithResult: fake.audit }));
vi.mock('@/lib/email/send', () => ({ sendGdprDeletionScheduledEmail: fake.mail }));
vi.mock('@/lib/rate-limit/password', () => ({ checkPasswordOperationRateLimit: fake.limit }));
vi.mock('@/lib/gdpr/deletion', () => ({ createGdprRequest: fake.create, cancelOwnGdprRequest: fake.cancel, getActiveGdprRequest: fake.active }));

import { POST as firmaRoute } from '@/app/api/mobile/v1/firma/route';
import { GET as stanUsunieciaRoute, POST as usunRoute } from '@/app/api/mobile/v1/konto/usuniecie/route';
import { POST as anulujRoute } from '@/app/api/mobile/v1/konto/usuniecie/anuluj/route';
import { GdprDeletionBlockedError } from '@/lib/gdpr/deletion-blockers';

// ─── Tokeny i atrapa GoTrue ───────────────────────────────────────────

const b64url = (value: string) => Buffer.from(value).toString('base64url');
function accessToken(sub: string, n: number, zalogowanoSekundTemu: number, metoda = 'password'): string {
  const now = Math.floor(NOW.getTime() / 1000);
  return [
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64url(JSON.stringify({
      aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600, sub, aal: 'aal1',
      session_id: `cccccccc-2222-4222-8222-00000000000${n}`,
      amr: [{ method: metoda, timestamp: now - zalogowanoSekundTemu }],
    })),
    b64url('fixture-signature'),
  ].join('.');
}
const TOKEN_PASS = accessToken(USER_PASS, 1, 3 * 60 * 60);
const TOKEN_GOOGLE_STARY = accessToken(USER_GOOGLE, 2, 2 * 60 * 60, 'oauth');
const TOKEN_GOOGLE_SWIEZY = accessToken(USER_GOOGLE, 3, 2 * 60, 'oauth');
const issued = new Map([[TOKEN_PASS, USER_PASS], [TOKEN_GOOGLE_STARY, USER_GOOGLE], [TOKEN_GOOGLE_SWIEZY, USER_GOOGLE]]);
const users: Record<string, { email: string; providers: string[]; password?: string }> = {
  [USER_PASS]: { email: 'jan@example.test', providers: ['email'], password: 'Poprawne-Haslo-1' },
  [USER_GOOGLE]: { email: 'ola@example.test', providers: ['google'] },
};
const memberships = [
  { user_id: USER_PASS, organization_id: ORG_A, role: 'owner', status: 'active' },
  { user_id: USER_GOOGLE, organization_id: ORG_A, role: 'member', status: 'active' },
];

let passwordLogins: Array<{ email: string; apikey: string | null }> = [];
let logouts = 0;
let userUpdates: Array<{ token: string | null; id: string | null; body: Record<string, unknown> }> = [];

const eq = (url: URL, column: string) => {
  const value = url.searchParams.get(column);
  return value?.startsWith('eq.') ? decodeURIComponent(value.slice(3)) : null;
};

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== SUPABASE_URL) throw new Error(`nieoczekiwane wyjście do ${url.origin}`);
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;

  if (url.pathname === '/auth/v1/user') {
    const sub = token ? issued.get(token) : undefined;
    if (!sub) return Response.json({ msg: 'invalid JWT' }, { status: 401 });
    const u = users[sub]!;
    return Response.json({ id: sub, aud: 'authenticated', role: 'authenticated', email: u.email, factors: [], app_metadata: { provider: u.providers[0], providers: u.providers } });
  }
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
    const body = JSON.parse(await request.text()) as { email: string; password: string };
    passwordLogins.push({ email: body.email, apikey: request.headers.get('apikey') });
    const entry = Object.entries(users).find(([, u]) => u.email === body.email);
    if (!entry || entry[1].password !== body.password) return Response.json({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, { status: 400 });
    const tmp = accessToken(entry[0], 9, 0);
    return Response.json({ access_token: tmp, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, user: { id: entry[0], email: body.email, aud: 'authenticated' } });
  }
  if (url.pathname === '/auth/v1/logout') {
    logouts += 1;
    return new Response(null, { status: 204 });
  }
  if (token === SERVICE_ROLE_KEY) return Response.json({ message: 'klucz serwisowy tylko do hasła' }, { status: 418 });
  const sub = token ? issued.get(token) : undefined;
  if (!sub) return Response.json({ message: 'JWT invalid' }, { status: 401 });

  if (url.pathname === '/rest/v1/memberships') {
    const rows = memberships.filter((m) => m.user_id === sub && (eq(url, 'organization_id') === null || m.organization_id === eq(url, 'organization_id')));
    const asObject = request.headers.get('accept')?.includes('vnd.pgrst.object');
    if (asObject) return rows[0] ? Response.json(rows[0]) : Response.json({ code: 'PGRST116' }, { status: 406 });
    return Response.json(rows);
  }
  if (url.pathname === '/rest/v1/users' && request.method === 'PATCH') {
    userUpdates.push({ token, id: eq(url, 'id'), body: JSON.parse(await request.text()) as Record<string, unknown> });
    return new Response(null, { status: 204 });
  }
  return Response.json({ message: `nieznana ścieżka ${url.pathname}` }, { status: 404 });
}

let ip = 0;
function req(path: string, options: { method?: string; token?: string | null; org?: string | null; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { 'x-real-ip': `198.51.100.${(ip += 1) % 250}`, 'user-agent': 'FaktWay/1.0 (iPhone)' };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN_PASS}`;
  if (options.org) headers['x-active-org'] = options.org;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://app.example.test/api/mobile/v1/${path}`, {
    method: options.method ?? 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}
async function errorOf(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

const ZAPLANOWANE = new Date('2026-11-28T09:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  fake.sets.clear();
  passwordLogins = [];
  logouts = 0;
  userUpdates = [];
  fake.limit.mockResolvedValue({ allowed: true, retryAfter: 0, unavailable: false });
  fake.active.mockResolvedValue(null);
  fake.create.mockResolvedValue({ id: 'r-1', scheduledFor: ZAPLANOWANE, cancelToken: 'a'.repeat(64), alreadyScheduled: false });
  fake.cancel.mockResolvedValue({ ok: true, requestId: 'r-1' });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_KEY);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://faktway.test');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ─── Wybór firmy ──────────────────────────────────────────────────────

describe('POST /api/mobile/v1/firma', () => {
  it('zapisuje firmę jako ostatnio używaną, jak przełącznik firm na stronie (tokenem klienta, własny wiersz)', async () => {
    const response = await firmaRoute(req('firma', { org: ORG_A }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ aktywnaFirma: ORG_A, zapisane: true });
    expect(userUpdates).toEqual([{ token: TOKEN_PASS, id: USER_PASS, body: { last_active_tenant_id: ORG_A } }]);
  });

  it('firma bez członkostwa: 403 bez zapisu; bez firmy: 400', async () => {
    const cudza = await firmaRoute(req('firma', { org: ORG_B }));
    expect(cudza.status).toBe(403);
    expect((await errorOf(cudza)).code).toBe('no_active_org');
    const bez = await firmaRoute(req('firma'));
    expect(bez.status).toBe(400);
    expect(userUpdates).toEqual([]);
  });
});

// ─── Usunięcie konta ──────────────────────────────────────────────────

describe('GET /api/mobile/v1/konto/usuniecie', () => {
  it('metoda potwierdzenia z serwera: hasło albo świeże logowanie (z terminem), stan żądania', async () => {
    fake.active.mockResolvedValue({ id: 'r-1', scheduled_for: ZAPLANOWANE.toISOString(), status: 'pending' });
    const haslo = await (await stanUsunieciaRoute(req('konto/usuniecie', { method: 'GET' }))).json();
    expect(haslo).toEqual({ zaplanowane: ZAPLANOWANE.toISOString(), potwierdzenie: 'haslo', swiezeDo: null });
    fake.active.mockResolvedValue(null);
    const google = await (await stanUsunieciaRoute(req('konto/usuniecie', { method: 'GET', token: TOKEN_GOOGLE_SWIEZY }))).json();
    expect(google).toEqual({ zaplanowane: null, potwierdzenie: 'swieze_logowanie', swiezeDo: new Date(NOW.getTime() + 8 * 60 * 1000).toISOString() });
    const googleStary = await (await stanUsunieciaRoute(req('konto/usuniecie', { method: 'GET', token: TOKEN_GOOGLE_STARY }))).json();
    expect(googleStary).toMatchObject({ potwierdzenie: 'swieze_logowanie', swiezeDo: null });
  });
});

describe('POST /api/mobile/v1/konto/usuniecie', () => {
  it('konto z hasłem: hasło w GoTrue (klucz serwisowy, bez captchy), żądanie, mail z linkiem anulowania, audyt z telefonu', async () => {
    const response = await usunRoute(req('konto/usuniecie', { body: { haslo: 'Poprawne-Haslo-1' } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ zaplanowane: ZAPLANOWANE.toISOString(), juzBylo: false, mailWyslany: true });
    expect(fake.limit).toHaveBeenCalledWith(USER_PASS);
    expect(passwordLogins).toEqual([{ email: 'jan@example.test', apikey: SERVICE_ROLE_KEY }]);
    expect(logouts).toBe(1);
    expect(fake.create).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_PASS, userEmail: 'jan@example.test', userAgent: 'FaktWay/1.0 (iPhone)' }));
    expect(fake.mail).toHaveBeenCalledWith(expect.objectContaining({ userEmail: 'jan@example.test', cancelUrl: `https://faktway.test/gdpr/cancel?token=${'a'.repeat(64)}` }));
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'gdpr.deletion_requested', userId: USER_PASS, metadata: expect.objectContaining({ client: 'mobile' }) }));
  });

  it('złe hasło: 400 `invalid_credentials`, bez żądania; brak hasła: 400 bez sprawdzania', async () => {
    const zle = await usunRoute(req('konto/usuniecie', { body: { haslo: 'zle' } }));
    expect(zle.status).toBe(400);
    expect((await errorOf(zle)).code).toBe('invalid_credentials');
    const brak = await usunRoute(req('konto/usuniecie', { body: {} }));
    expect(brak.status).toBe(400);
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('limit prób hasła (wspólny ze stroną): 429; limit niedostępny: 503', async () => {
    fake.limit.mockResolvedValueOnce({ allowed: false, retryAfter: 120, unavailable: false });
    const limit = await usunRoute(req('konto/usuniecie', { body: { haslo: 'Poprawne-Haslo-1' } }));
    expect(limit.status).toBe(429);
    expect(limit.headers.get('retry-after')).toBe('120');
    fake.limit.mockResolvedValueOnce({ allowed: false, retryAfter: 0, unavailable: true });
    const brak = await usunRoute(req('konto/usuniecie', { body: { haslo: 'Poprawne-Haslo-1' } }));
    expect(brak.status).toBe(503);
    expect(passwordLogins).toEqual([]);
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('konto tylko z Google: stare logowanie daje 403 `reauth_required`; świeże przechodzi bez hasła', async () => {
    const stary = await usunRoute(req('konto/usuniecie', { token: TOKEN_GOOGLE_STARY, body: {} }));
    expect(stary.status).toBe(403);
    expect((await errorOf(stary)).code).toBe('reauth_required');
    expect(fake.create).not.toHaveBeenCalled();
    const swiezy = await usunRoute(req('konto/usuniecie', { token: TOKEN_GOOGLE_SWIEZY, body: {} }));
    expect(swiezy.status).toBe(200);
    expect(passwordLogins).toEqual([]);
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ confirmation: 'recent_login' }) }));
  });

  it('ponowienie po zerwanym połączeniu: istniejące żądanie, bez drugiego maila i audytu', async () => {
    fake.create.mockResolvedValue({ id: 'r-1', scheduledFor: ZAPLANOWANE, cancelToken: null, alreadyScheduled: true });
    const response = await usunRoute(req('konto/usuniecie', { body: { haslo: 'Poprawne-Haslo-1' } }));
    expect(await response.json()).toEqual({ zaplanowane: ZAPLANOWANE.toISOString(), juzBylo: true, mailWyslany: false });
    expect(fake.mail).not.toHaveBeenCalled();
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it('aktywna subskrypcja firmy: 409 `deletion_blocked` z nazwą firmy i tym, co zrobić', async () => {
    fake.create.mockRejectedValue(new GdprDeletionBlockedError(['Firma A']));
    const response = await usunRoute(req('konto/usuniecie', { body: { haslo: 'Poprawne-Haslo-1' } }));
    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.code).toBe('deletion_blocked');
    expect(error.message).toMatch(/Firma A/);
    expect(error.message).toMatch(/faktway\.pl/);
  });
});

describe('POST /api/mobile/v1/konto/usuniecie/anuluj', () => {
  it('to samo potwierdzenie co przy usunięciu; anuluje i zapisuje audyt z telefonu', async () => {
    fake.active.mockResolvedValue({ id: 'r-1', scheduled_for: ZAPLANOWANE.toISOString(), status: 'pending' });
    const zle = await anulujRoute(req('konto/usuniecie/anuluj', { body: { haslo: 'zle' } }));
    expect(zle.status).toBe(400);
    expect(fake.cancel).not.toHaveBeenCalled();
    const ok = await anulujRoute(req('konto/usuniecie/anuluj', { body: { haslo: 'Poprawne-Haslo-1' } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ anulowane: true, juzBylo: false });
    expect(fake.cancel).toHaveBeenCalledWith(USER_PASS);
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'gdpr.deletion_canceled', metadata: expect.objectContaining({ client: 'mobile' }) }));
  });

  it('nic do anulowania (ponowienie): 200 `juzBylo`, bez zmian', async () => {
    const response = await anulujRoute(req('konto/usuniecie/anuluj', { body: { haslo: 'Poprawne-Haslo-1' } }));
    expect(await response.json()).toEqual({ anulowane: true, juzBylo: true });
    expect(fake.cancel).not.toHaveBeenCalled();
  });

  it('bez tokenu 401', async () => {
    const response = await anulujRoute(req('konto/usuniecie/anuluj', { token: null, body: {} }));
    expect(response.status).toBe(401);
  });
});
