import { createServerClient } from '@supabase/ssr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ client: vi.fn(), cookies: vi.fn(), audit: vi.fn(), redirect: vi.fn(), revalidate: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.client }));
vi.mock('next/headers', () => ({ cookies: mocks.cookies, headers: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@/lib/security/turnstile', () => ({ verifyTurnstile: vi.fn() }));
vi.mock('@/lib/rate-limit/auth', () => ({ checkLoginRateLimit: vi.fn() }));
import { clearDeviceLoginCookies, signOutCurrentSession } from '@/lib/auth/sign-out';
import { signOut } from '@/app/(auth)/login/actions';
import { forceSignOutInactive } from '@/lib/auth/inactivity-logout';

const user = { id: '11111111-1111-4111-8111-111111111111', email: 'fixture@example.test', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const base = 'sb-auth-auth-token';
let jar: Map<string, string>;
let writes: Array<{ name: string; value: string; maxAge?: number }>;
function cookieStore() {
  return {
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, options: { maxAge?: number }) => {
      writes.push({ name, value, maxAge: options.maxAge });
      if (options.maxAge === 0 || value === '') jar.delete(name); else jar.set(name, value);
    },
  };
}
function token() {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [encode({ alg: 'HS256', typ: 'JWT' }), encode({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600, aal: 'aal2' }), Buffer.from('fixture-signature').toString('base64url')].join('.');
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://auth.example.test');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request'); }));
  jar = new Map(); writes = [];
  mocks.cookies.mockImplementation(async () => cookieStore());
  mocks.redirect.mockImplementation((destination: string) => { throw new Error('REDIRECT:' + destination); });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function seedSdk(logoutStatus: number, identityFails = false) {
  const jwt = token();
  const requests: Array<{ pathname: string; authorization: string | null; search: string }> = [];
  let seeded = false;
  const client = createServerClient('https://auth.example.test', 'synthetic-anon-key', {
    cookies: {
      getAll: () => cookieStore().getAll(),
      setAll: (values) => { values.forEach(({ name, value, options }) => cookieStore().set(name, value, options)); },
    },
    global: { fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      requests.push({ pathname: url.pathname, search: url.search, authorization: new Headers(init?.headers).get('authorization') });
      if (url.pathname === '/auth/v1/user') {
        if (seeded && identityFails) return new Response(JSON.stringify({ message: 'synthetic-identity-outage' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        // Force chunked SSR cookies, as real accounts with metadata can have.
        return new Response(JSON.stringify({ ...user, user_metadata: { fixture: 'x'.repeat(6500) } }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname === '/auth/v1/logout') {
        return logoutStatus === 204 ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ message: 'synthetic-logout-outage' }), { status: logoutStatus, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error('Unexpected mocked Auth route');
    } },
  });
  expect((await client.auth.setSession({ access_token: jwt, refresh_token: 'synthetic-refresh' })).error).toBeNull();
  expect([...jar.keys()].filter((name) => name.startsWith(base + '.')).length).toBeGreaterThan(1);
  seeded = true; requests.length = 0; writes.length = 0;
  jar.set('ksef.active_org', 'other-cookie'); jar.set('sb-other-auth-token', 'other-project-session');
  mocks.client.mockResolvedValue(client);
  return { requests, jwt };
}

describe('logout uses the real SDK and clears only the current browser session', () => {
  it.each([204, 401, 403, 404, 500])('reports remote HTTP %s honestly while clearing chunked cookies', async (status) => {
    const { requests, jwt } = await seedSdk(status);
    expect(await signOutCurrentSession()).toEqual({ userId: user.id, localSessionCleared: true, globalSignOutConfirmed: status === 204 });
    expect([...jar.keys()]).toEqual(['ksef.active_org', 'sb-other-auth-token']);
    expect(writes.length).toBeGreaterThan(1);
    expect(writes.every((entry) => entry.value === '' && entry.maxAge === 0)).toBe(true);
    expect(requests.find((request) => request.pathname.endsWith('/logout'))).toEqual({ pathname: '/auth/v1/logout', search: '?scope=global', authorization: 'Bearer ' + jwt });
  });
  it.each([signOut, forceSignOutInactive])('real action no longer reports global success after HTTP500', async (action) => {
    await seedSdk(500);
    await expect(action()).rejects.toThrow('REDIRECT:/login');
    expect(mocks.redirect).toHaveBeenCalledWith(expect.stringContaining('notice=logout_local_only'));
    expect([...jar.keys()]).toEqual(['ksef.active_org', 'sb-other-auth-token']);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auth.logout', userId: user.id, tenantId: null,
      metadata: expect.objectContaining({ local_session_cleared: true, global_sign_out_confirmed: false }),
    }));
  });
  it('does not attribute the cookie user identity when Auth cannot verify it', async () => {
    await seedSdk(500, true);
    expect(await signOutCurrentSession()).toEqual({ userId: null, localSessionCleared: true, globalSignOutConfirmed: false });
  });
  it('cleans the exact cookie names even when session initialization fails', async () => {
    mocks.client.mockRejectedValue(new Error('synthetic-private-error'));
    const owned = [base, base + '.0', base + '.12', base + '-code-verifier', base + '-code-verifier.0'];
    const unrelated = ['theme', 'ksef.active_org', base + '-different', base + '.backup', 'sb-other-auth-token'];
    jar = new Map([...owned, ...unrelated].map((name) => [name, 'synthetic']));
    expect(await signOutCurrentSession()).toEqual({ userId: null, localSessionCleared: true, globalSignOutConfirmed: false });
    expect([...jar.keys()]).toEqual(unrelated);
  });
  // Logowanie biometrią (FW1): znacznik sesji i „zapamiętaj mnie” nie mogą
  // przeżyć wylogowania, nawet gdy Auth jest niedostępny.
  it.each([204, 500])('clears the passkey marker, remember-me and offer cookies after remote HTTP %s', async (status) => {
    await seedSdk(status);
    jar.set('ksef.passkey_session', 'v1.fixture'); jar.set('ksef.remember_me', '1'); jar.set('ksef.passkey_offer', '1');
    expect((await signOutCurrentSession()).localSessionCleared).toBe(true);
    expect([...jar.keys()]).toEqual(['ksef.active_org', 'sb-other-auth-token']);
  });
  it('clears the passkey cookies even when session initialization fails', async () => {
    mocks.client.mockRejectedValue(new Error('synthetic-private-error'));
    jar = new Map([['ksef.passkey_session', 'v1.fixture'], ['ksef.remember_me', '1'], ['theme', 'dark']]);
    expect((await signOutCurrentSession()).localSessionCleared).toBe(true);
    expect([...jar.keys()]).toEqual(['theme']);
  });
  it('clearDeviceLoginCookies (wylogowanie po zmianie hasła z linku) nie rusza innych ciasteczek i nie rzuca', async () => {
    jar = new Map([['ksef.passkey_session', 'v1.fixture'], ['ksef.remember_me', '1'], ['ksef.active_org', 'other-cookie']]);
    await clearDeviceLoginCookies();
    expect([...jar.keys()]).toEqual(['ksef.active_org']);
    mocks.cookies.mockRejectedValue(new Error('poza żądaniem'));
    await expect(clearDeviceLoginCookies()).resolves.toBeUndefined();
  });
  it.each([signOut, forceSignOutInactive])('does not redirect or write logout success when cookie cleanup fails', async (action) => {
    await seedSdk(204);
    mocks.cookies.mockResolvedValue({ getAll: () => cookieStore().getAll(), set: () => { throw new Error('synthetic-cookie-error'); } });
    if (action === forceSignOutInactive) await expect(action()).resolves.toEqual({ ok: false, error: 'local_logout_failed' });
    else await expect(action()).rejects.toThrow('Nie udało się wylogować');
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
