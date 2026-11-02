import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * „Zapamiętaj mnie” i propozycja biometrii w prawdziwej akcji logowania.
 * Atrapą jest GoTrue i ciasteczka; `IdleWatcher` przy zapamiętanym logowaniu
 * sprawdza `e2e/tests/09-biometria.spec.ts` (zegar Playwrighta).
 */

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(), getUser: vi.fn(), oauth: vi.fn(), aal: vi.fn(), google: vi.fn(),
  userAgent: { value: '' }, cookieWrites: [] as Array<{ name: string; value: string; options: Record<string, unknown> }>,
}));

vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error('redirect:' + path); } }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'https://faktway.pl', 'user-agent': mocks.userAgent.value }),
  cookies: async () => ({
    get: () => undefined,
    getAll: () => [],
    set: (name: string, value: string, options: Record<string, unknown>) => {
      mocks.cookieWrites.push({ name, value, options });
    },
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      signInWithPassword: mocks.signIn, getUser: mocks.getUser, signInWithOAuth: mocks.oauth,
      mfa: { getAuthenticatorAssuranceLevel: mocks.aal },
    },
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: null }) };
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
vi.mock('@/lib/auth/oauth-providers', () => ({ isGoogleLoginEnabled: mocks.google }));
vi.mock('@/lib/auth/sign-out', () => ({ signOutCurrentSession: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));

const { loginWithEmail, loginWithGoogle } = await import('@/app/(auth)/login/actions');

const PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

function form(remember: boolean) {
  const data = new FormData();
  data.set('email', 'fixture@example.test');
  data.set('password', 'Fixture-Passw0rd!');
  if (remember) data.set('remember', 'on');
  return data;
}
const written = (name: string) => mocks.cookieWrites.filter((cookie) => cookie.name === name);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookieWrites.length = 0;
  mocks.userAgent.value = DESKTOP;
  mocks.signIn.mockResolvedValue({ data: {}, error: null });
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mocks.aal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal1' } });
  mocks.google.mockResolvedValue(true);
  mocks.oauth.mockResolvedValue({ data: { url: 'https://accounts.google.com/x' }, error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe('loginWithEmail: „Zapamiętaj mnie”', () => {
  it('zaznaczone: ciasteczko httpOnly na 90 dni', async () => {
    await expect(loginWithEmail(form(true))).rejects.toThrow('redirect:/dashboard');
    expect(written('ksef.remember_me')).toEqual([{
      name: 'ksef.remember_me', value: '1',
      options: expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 90 * 24 * 60 * 60 }),
    }]);
  });

  it('na produkcji jest Secure', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(loginWithEmail(form(true))).rejects.toThrow('redirect:/dashboard');
    expect(written('ksef.remember_me')[0]?.options.secure).toBe(true);
  });

  it('niezaznaczone: czyści wcześniejsze zapamiętanie na tym urządzeniu', async () => {
    await expect(loginWithEmail(form(false))).rejects.toThrow('redirect:/dashboard');
    expect(written('ksef.remember_me')).toEqual([expect.objectContaining({ value: '', options: expect.objectContaining({ maxAge: 0 }) })]);
  });

  it('nieudane logowanie nie zostawia ciasteczka', async () => {
    mocks.signIn.mockResolvedValue({ data: {}, error: { message: 'Invalid login credentials' } });
    await expect(loginWithEmail(form(true))).rejects.toThrow('redirect:/login?error=invalid_credentials');
    expect(mocks.cookieWrites).toEqual([]);
  });

  it('przy koncie z 2FA ciasteczko powstaje przed prośbą o kod, a droga do kodu się nie zmienia', async () => {
    mocks.aal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' } });
    await expect(loginWithEmail(form(true))).rejects.toThrow('redirect:/login/two-factor');
    expect(written('ksef.remember_me')).toHaveLength(1);
  });
});

describe('loginWithEmail: propozycja biometrii tylko na telefonie', () => {
  it.each([['Android', PHONE], ['iPhone', IPHONE]])('%s: krótkie ciasteczko dla jednorazowej propozycji', async (_name, userAgent) => {
    mocks.userAgent.value = userAgent;
    await expect(loginWithEmail(form(true))).rejects.toThrow('redirect:/dashboard');
    expect(written('ksef.passkey_offer')).toEqual([{
      name: 'ksef.passkey_offer', value: '1',
      // Czyta je komponent w przeglądarce, żeby skasować je po pokazaniu.
      options: expect.objectContaining({ httpOnly: false, sameSite: 'lax', path: '/', maxAge: 60 * 60 }),
    }]);
  });

  it('komputer: bez propozycji', async () => {
    await expect(loginWithEmail(form(true))).rejects.toThrow('redirect:/dashboard');
    expect(written('ksef.passkey_offer')).toEqual([]);
  });
});

describe('loginWithGoogle: pole z formularza e-mail tu nie sięga, więc liczy się urządzenie', () => {
  it('telefon: zapamiętane domyślnie', async () => {
    mocks.userAgent.value = PHONE;
    await expect(loginWithGoogle()).rejects.toThrow('redirect:https://accounts.google.com/x');
    expect(written('ksef.remember_me')).toEqual([expect.objectContaining({ value: '1' })]);
  });

  it('komputer: bez zapamiętania', async () => {
    await expect(loginWithGoogle()).rejects.toThrow('redirect:https://accounts.google.com/x');
    expect(written('ksef.remember_me')).toEqual([expect.objectContaining({ value: '', options: expect.objectContaining({ maxAge: 0 }) })]);
  });
});
