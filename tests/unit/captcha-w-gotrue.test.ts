import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Token Cloudflare sprawdzany w GoTrue (25.10.2026, krok 2 po #330).
 *
 * Sprawdzanie tylko w akcjach aplikacji chroni nasze formularze, ale nie
 * samo GoTrue. Po włączeniu captcha w GoTrue token trzeba mu przekazać,
 * a aplikacja nie może go wcześniej zużyć (token działa tylko raz) — stąd
 * przełącznik `AUTH_CAPTCHA_IN_GOTRUE`. Odmowa captcha z GoTrue musi dać
 * komunikat o weryfikacji, a nie „złe hasło” ani „wysłaliśmy link”.
 * Procedura: docs/runbooks/captcha-w-gotrue.md.
 */

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(), signUp: vi.fn(), reset: vi.fn(), getUser: vi.fn(),
  verifierSignIn: vi.fn(), verifierSignOut: vi.fn(), reauthLimit: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error('redirect:' + path); } }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'https://app.example.test' }),
  cookies: async () => ({ get: () => undefined, set: vi.fn() }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      signInWithPassword: mocks.signIn, signUp: mocks.signUp, resetPasswordForEmail: mocks.reset, getUser: mocks.getUser,
    },
  }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { signInWithPassword: mocks.verifierSignIn, admin: { signOut: mocks.verifierSignOut } } }),
}));
vi.mock('@/lib/auth/get-client-ip', () => ({ getClientIp: async () => '192.0.2.1' }));
vi.mock('@/lib/rate-limit/auth', () => ({
  checkLoginRateLimit: async () => ({ allowed: true }),
  checkRegisterRateLimit: async () => ({ allowed: true }),
}));
vi.mock('@/lib/rate-limit/password', () => ({
  checkPasswordRecoveryRequestRateLimit: async () => ({ allowed: true, unavailable: false, retryAfter: 0 }),
  checkPasswordOperationRateLimit: mocks.reauthLimit,
}));
vi.mock('@/lib/feature-flags/signups', () => ({ isSignupClosed: async () => false }));
vi.mock('@/lib/auth/password', () => ({ validatePassword: async () => ({ valid: true }) }));
vi.mock('@/lib/auth/oauth-providers', () => ({ isGoogleLoginEnabled: async () => false }));
vi.mock('@/lib/auth/sign-out', () => ({ signOutCurrentSession: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: vi.fn() }));
vi.mock('@/lib/jobs/events', () => ({ userRegistered: { create: (data: unknown) => ({ data }) } }));
vi.mock('@/lib/legal/record', () => ({ recordTermsAcceptance: async () => ({ ok: true }) }));

const { loginWithEmail } = await import('@/app/(auth)/login/actions');
const { signupWithEmail } = await import('@/app/(auth)/register/actions');
const { requestPasswordReset } = await import('@/app/(auth)/forgot-password/actions');
const { reauthenticateWithPassword } = await import('@/lib/auth/reauth');

const TOKEN = 'synthetic-turnstile-token-0123456789';
const email = 'fixture@example.test';
const password = 'Fixture-Passw0rd!';

function form(token: string | null = TOKEN) {
  const data = new FormData();
  data.set('email', email);
  data.set('password', password);
  data.set('terms', 'on');
  if (token !== null) data.set('cf-turnstile-response', token);
  return data;
}

const invalidCredentials = { message: 'Invalid login credentials', code: 'invalid_credentials', status: 400 };
const captchaFailed = { message: 'captcha protection: request disallowed (invalid-input-response)', code: 'captcha_failed', status: 400 };
// Brak tokenu GoTrue zgłasza jako błąd wewnętrzny, nie `captcha_failed`.
const captchaMissing = { message: 'captcha verification process failed', code: 'unexpected_failure', status: 500 };

let siteverify: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://auth.example.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon-key');
  vi.stubEnv('TURNSTILE_SECRET_KEY', 'synthetic-turnstile-secret');
  vi.stubEnv('AUTH_CAPTCHA_IN_GOTRUE', '');
  siteverify = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
  vi.stubGlobal('fetch', siteverify);
  mocks.signIn.mockResolvedValue({ data: { user: null, session: null }, error: invalidCredentials });
  mocks.signUp.mockResolvedValue({ data: { user: null, session: null }, error: { message: 'Signups not allowed', status: 422 } });
  mocks.reset.mockResolvedValue({ data: {}, error: null });
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email } }, error: null });
  mocks.reauthLimit.mockResolvedValue({ allowed: true, unavailable: false, retryAfter: 0 });
  mocks.verifierSignIn.mockResolvedValue({ data: { user: { id: 'user-1' }, session: { access_token: 'temporary' } }, error: null });
  mocks.verifierSignOut.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('przełącznik wyłączony: jak dotąd sprawdza aplikacja', () => {
  it('logowanie pyta Cloudflare i nie przekazuje tokenu do GoTrue', async () => {
    await expect(loginWithEmail(form())).rejects.toThrow('redirect:/login?error=invalid_credentials');
    expect(siteverify).toHaveBeenCalledTimes(1);
    expect(mocks.signIn).toHaveBeenCalledWith({ email, password });
  });
});

describe('przełącznik włączony: token idzie do GoTrue, aplikacja go nie zużywa', () => {
  beforeEach(() => vi.stubEnv('AUTH_CAPTCHA_IN_GOTRUE', 'true'));

  it('logowanie', async () => {
    await expect(loginWithEmail(form())).rejects.toThrow('redirect:/login?error=invalid_credentials');
    expect(siteverify).not.toHaveBeenCalled();
    expect(mocks.signIn).toHaveBeenCalledWith({ email, password, options: { captchaToken: TOKEN } });
  });

  it('rejestracja', async () => {
    await expect(signupWithEmail(form())).rejects.toThrow('redirect:/register?error=');
    expect(siteverify).not.toHaveBeenCalled();
    expect(mocks.signUp.mock.calls[0]?.[0]?.options).toMatchObject({ captchaToken: TOKEN });
  });

  it('reset hasła', async () => {
    await expect(requestPasswordReset(form())).rejects.toThrow('redirect:/forgot-password?success=email_sent');
    expect(siteverify).not.toHaveBeenCalled();
    expect(mocks.reset.mock.calls[0]?.[1]).toMatchObject({ captchaToken: TOKEN });
  });

  it.each([
    ['logowanie', loginWithEmail, '/login?error=bot_check_failed', mocks.signIn],
    ['rejestracja', signupWithEmail, '/register?error=bot_check_failed', mocks.signUp],
    ['reset hasła', requestPasswordReset, '/forgot-password?error=bot_check_failed', mocks.reset],
  ] as const)('%s bez tokenu: odmowa przed GoTrue', async (_name, run, denied, provider) => {
    await expect(run(form(null))).rejects.toThrow('redirect:' + denied);
    expect(provider).not.toHaveBeenCalled();
  });
});

describe('odmowa captcha z GoTrue to komunikat o weryfikacji', () => {
  beforeEach(() => vi.stubEnv('AUTH_CAPTCHA_IN_GOTRUE', 'true'));

  it.each([captchaFailed, captchaMissing])('logowanie: nie „złe hasło” ($code)', async (error) => {
    mocks.signIn.mockResolvedValue({ data: { user: null, session: null }, error });
    await expect(loginWithEmail(form())).rejects.toThrow('redirect:/login?error=bot_check_failed');
  });

  it.each([captchaFailed, captchaMissing])('rejestracja: nie surowy komunikat GoTrue ($code)', async (error) => {
    mocks.signUp.mockResolvedValue({ data: { user: null, session: null }, error });
    await expect(signupWithEmail(form())).rejects.toThrow('redirect:/register?error=bot_check_failed');
  });

  it.each([captchaFailed, captchaMissing])('reset hasła: nie „wysłaliśmy link” ($code)', async (error) => {
    mocks.reset.mockResolvedValue({ data: null, error });
    await expect(requestPasswordReset(form())).rejects.toThrow('redirect:/forgot-password?error=bot_check_failed');
  });
});

describe('ponowne podanie hasła (zmiana hasła, wyłączenie 2FA, usunięcie konta)', () => {
  it('przekazuje token do GoTrue', async () => {
    expect(await reauthenticateWithPassword(password, TOKEN)).toEqual({ ok: true });
    expect(mocks.verifierSignIn).toHaveBeenCalledWith({ email, password, options: { captchaToken: TOKEN } });
  });

  it('bez tokenu woła GoTrue jak dotąd', async () => {
    expect(await reauthenticateWithPassword(password)).toEqual({ ok: true });
    expect(mocks.verifierSignIn).toHaveBeenCalledWith({ email, password });
  });

  it.each([captchaFailed, captchaMissing])('odmowa captcha to „spróbuj ponownie”, nie „złe hasło” ($code)', async (error) => {
    mocks.verifierSignIn.mockResolvedValue({ data: { user: null, session: null }, error });
    expect(await reauthenticateWithPassword(password, TOKEN)).toEqual({ ok: false, error: 'verification_unavailable' });
  });
});

describe('okna z ponownym hasłem mają widżet, więc mają też token', () => {
  const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

  it.each([
    ['zmiana hasła', 'app/(dashboard)/settings/security/_components/password-change-card.tsx', 1],
    ['wyłączenie 2FA', 'app/(dashboard)/settings/security/_components/two-factor-card.tsx', 1],
    ['usunięcie konta i jego anulowanie', 'app/(dashboard)/settings/account/_components/gdpr-section.tsx', 2],
  ])('%s', (_name, file, forms) => {
    expect(source(file).match(/<TurnstileWidget action="reauth"/g)?.length).toBe(forms);
  });

  it('kod do zmiany hasła (przycisk, nie submit) też niesie token i bierze nowy', () => {
    const card = source('app/(dashboard)/settings/security/_components/password-change-card.tsx');
    expect(card).toMatch(/data\.set\('cf-turnstile-response'/);
    expect(card).toMatch(/refreshTurnstileToken\(form\)/);
  });

  it('wyłączenie 2FA przekazuje token do akcji', () => {
    const card = source('app/(dashboard)/settings/security/_components/two-factor-card.tsx');
    expect(card).toMatch(/unenrollTotpAction\(password, typeof captchaToken === 'string'/);
  });
});
