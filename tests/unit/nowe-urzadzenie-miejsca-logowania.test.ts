import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 8.5, część 2: miejsca, które zapisują `auth.login` (hasło, callback
 * Google i linków z e-maila), zlecają sprawdzenie urządzenia z kluczem równym
 * identyfikatorowi sesji. Biometria: passkey-login-route.test.ts.
 */

const h = vi.hoisted(() => ({
  signIn: vi.fn(), getUser: vi.fn(), aal: vi.fn(), exchange: vi.fn(), audit: vi.fn(), sendJob: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error('redirect:' + path); } }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'https://faktway.pl', 'user-agent': 'Mozilla/5.0 (Macintosh)' }),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => undefined }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      signInWithPassword: h.signIn, getUser: h.getUser, exchangeCodeForSession: h.exchange,
      mfa: { getAuthenticatorAssuranceLevel: h.aal },
    },
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { last_active_tenant_id: null }, error: null }) };
      return q;
    },
  }),
}));
vi.mock('@/lib/auth/get-client-ip', () => ({ getClientIp: async () => '192.0.2.1' }));
vi.mock('@/lib/rate-limit/auth', () => ({ checkLoginRateLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/security/bot-check', () => ({
  checkBotBeforeGoTrue: async () => ({ ok: true }),
  isGoTrueCaptchaRejection: () => false,
}));
vi.mock('@/lib/security/honeypot', () => ({ isHoneypotTripped: () => false }));
vi.mock('@/lib/auth/oauth-providers', () => ({ isGoogleLoginEnabled: async () => true }));
vi.mock('@/lib/auth/sign-out', () => ({ signOutCurrentSession: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: h.audit }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@/lib/analytics/funnel', () => ({ recordGoogleSignupIfNew: vi.fn() }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: h.sendJob }));

const { loginWithEmail } = await import('@/app/(auth)/login/actions');
const { GET: callback } = await import('@/app/auth/callback/route');

const USER_ID = '0d5c6a1e-6a8b-4c55-9e0e-2f4b1a7c3d10';
const SESSION_ID = '5b7e2d1c-3f4a-4b6c-8d9e-0f1a2b3c4d5e';
const EVENT = {
  name: 'auth/login.completed',
  data: { userId: USER_ID, sessionId: SESSION_ID },
  singletonKey: `new-login/${SESSION_ID}`,
};

function accessToken(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [part({ alg: 'HS256', typ: 'JWT' }), part({ sub: USER_ID, ...payload }), 'podpis'].join('.');
}
const TOKEN = accessToken({ session_id: SESSION_ID, amr: [{ method: 'password', timestamp: 1 }] });

function form() {
  const data = new FormData();
  data.set('email', 'fixture@example.test');
  data.set('password', 'Fixture-Passw0rd!');
  return data;
}
const callbackRequest = () =>
  new Request('https://faktway.pl/auth/callback?' + new URLSearchParams({ code: 'fixture-code', next: '/dashboard' }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://faktway.pl');
  h.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
  h.aal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal1' } });
  h.sendJob.mockResolvedValue({ ids: ['job-1'] });
});

describe('miejsca logowania zlecają sprawdzenie urządzenia', () => {
  it('hasło', async () => {
    h.signIn.mockResolvedValue({ data: { session: { access_token: TOKEN } }, error: null });
    await expect(loginWithEmail(form())).rejects.toThrow('redirect:/dashboard');
    expect(h.sendJob).toHaveBeenCalledExactlyOnceWith(EVENT);
  });

  it('callback Google i linków z e-maila', async () => {
    h.exchange.mockResolvedValue({ data: { user: { id: USER_ID }, session: { access_token: TOKEN } }, error: null });
    await callback(callbackRequest());
    expect(h.sendJob).toHaveBeenCalledExactlyOnceWith(EVENT);
  });

  it('nieudana wymiana kodu: bez zlecenia', async () => {
    h.exchange.mockResolvedValue({ data: { user: null, session: null }, error: { message: 'invalid' } });
    await callback(callbackRequest());
    expect(h.sendJob).not.toHaveBeenCalled();
  });

  it('awaria kolejki nie zatrzymuje logowania', async () => {
    h.signIn.mockResolvedValue({ data: { session: { access_token: TOKEN } }, error: null });
    h.sendJob.mockRejectedValue(new Error('kolejka niedostępna'));
    await expect(loginWithEmail(form())).rejects.toThrow('redirect:/dashboard');
  });
});
