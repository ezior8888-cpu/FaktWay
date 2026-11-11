import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 8.5: każde logowanie przez FaktWay zostawia w audycie wpis `auth.login`
 * z identyfikatorem sesji GoTrue (`metadata.session_id`). Po nim lista urządzeń
 * (00174, `list_account_sessions`) łączy sesję z przeglądarką i adresem z chwili
 * logowania, bo GoTrue zapisuje w `auth.sessions` nagłówki serwera aplikacji.
 *
 * Prawdziwe: akcja logowania hasłem i trasa `/auth/callback`. Atrapą są GoTrue,
 * ciasteczka i zapis audytu. Logowanie biometrią: `passkey-login-route.test.ts`.
 */

const h = vi.hoisted(() => ({
  signIn: vi.fn(), getUser: vi.fn(), aal: vi.fn(), exchange: vi.fn(), audit: vi.fn(),
  tenantLookup: vi.fn(),
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
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => h.tenantLookup(table),
      };
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

const { loginWithEmail } = await import('@/app/(auth)/login/actions');
const { GET: callback } = await import('@/app/auth/callback/route');

const USER_ID = '0d5c6a1e-6a8b-4c55-9e0e-2f4b1a7c3d10';
const SESSION_ID = '5b7e2d1c-3f4a-4b6c-8d9e-0f1a2b3c4d5e';
const TENANT_ID = '7c1f3e2a-9b4d-4e6f-8a0b-1c2d3e4f5a6b';

function accessToken(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [part({ alg: 'HS256', typ: 'JWT' }), part({ sub: USER_ID, ...payload }), 'podpis'].join('.');
}

function form() {
  const data = new FormData();
  data.set('email', 'fixture@example.test');
  data.set('password', 'Fixture-Passw0rd!');
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://faktway.pl');
  h.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
  h.aal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal1' } });
  h.tenantLookup.mockResolvedValue({ data: { last_active_tenant_id: TENANT_ID }, error: null });
});

describe('logowanie hasłem', () => {
  it('wpis auth.login niesie identyfikator nowej sesji GoTrue', async () => {
    h.signIn.mockResolvedValue({
      data: { session: { access_token: accessToken({ session_id: SESSION_ID, amr: [{ method: 'password', timestamp: 1 }] }) } },
      error: null,
    });
    await expect(loginWithEmail(form())).rejects.toThrow('redirect:/dashboard');
    expect(h.audit).toHaveBeenCalledExactlyOnceWith({
      action: 'auth.login', tenantId: TENANT_ID, userId: USER_ID,
      metadata: { method: 'password', session_id: SESSION_ID },
    });
  });

  it('bez tokenu w odpowiedzi: wpis bez identyfikatora, logowanie bez zmian', async () => {
    h.signIn.mockResolvedValue({ data: {}, error: null });
    await expect(loginWithEmail(form())).rejects.toThrow('redirect:/dashboard');
    expect(h.audit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ metadata: { method: 'password' } }));
  });
});

describe('/auth/callback (Google i linki z e-maila)', () => {
  const request = (next = '/dashboard') =>
    new Request('https://faktway.pl/auth/callback?' + new URLSearchParams({ code: 'fixture-code', next }));

  it('Google: wpis auth.login z metodą i sesją, przekierowanie bez zmian', async () => {
    h.exchange.mockResolvedValue({
      data: {
        user: { id: USER_ID },
        session: { access_token: accessToken({ session_id: SESSION_ID, amr: [{ method: 'oauth', timestamp: 1 }] }) },
      },
      error: null,
    });
    const response = await callback(request());
    expect(response.headers.get('location')).toBe('https://faktway.pl/dashboard');
    // Bez firmy: trasa nie pyta bazy klientem sesji poza wymianą kodu
    // (auth-browser-url-boundary.test.ts); historia logowań czyta wpisy po użytkowniku.
    expect(h.audit).toHaveBeenCalledExactlyOnceWith({
      action: 'auth.login', tenantId: null, userId: USER_ID,
      metadata: { method: 'google', session_id: SESSION_ID },
    });
    expect(h.tenantLookup).not.toHaveBeenCalled();
  });

  it('link do zmiany hasła: logowanie linkiem z e-maila', async () => {
    h.exchange.mockResolvedValue({
      data: {
        user: { id: USER_ID },
        session: { access_token: accessToken({ session_id: SESSION_ID, amr: [{ method: 'recovery', timestamp: 1 }] }) },
      },
      error: null,
    });
    const response = await callback(request('/reset-password'));
    expect(response.headers.get('location')).toBe('https://faktway.pl/reset-password');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auth.login', metadata: { method: 'email_link', session_id: SESSION_ID },
    }));
  });

  it('nieudana wymiana kodu: bez wpisu', async () => {
    h.exchange.mockResolvedValue({ data: { user: null, session: null }, error: { message: 'invalid' } });
    const response = await callback(request());
    expect(response.headers.get('location')).toBe('https://faktway.pl/login?error=auth_callback_failed');
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('odpowiedź bez tokenu: wpis bez sesji i bez zgadywania sposobu logowania', async () => {
    h.exchange.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
    const response = await callback(request());
    expect(response.headers.get('location')).toBe('https://faktway.pl/dashboard');
    expect(h.audit).toHaveBeenCalledExactlyOnceWith({ action: 'auth.login', tenantId: null, userId: USER_ID, metadata: {} });
  });
});
