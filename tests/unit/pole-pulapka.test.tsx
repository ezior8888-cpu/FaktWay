import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pole-pułapka w formularzach logowania, rejestracji i resetu hasła
 * (25.10.2026, razem z niewidocznym Turnstile). Człowiek go nie widzi
 * i nie przejdzie do niego klawiszem Tab, a prosty bot wypełnia wszystkie
 * pola. Wypełnione pole = odmowa jak przy nieudanym Turnstile, zanim
 * cokolwiek pójdzie do Cloudflare, limitów albo GoTrue.
 */

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(), signUp: vi.fn(), reset: vi.fn(), turnstile: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error('redirect:' + path); } }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'https://app.example.test' }),
  cookies: async () => ({ get: () => undefined, set: vi.fn() }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { signInWithPassword: mocks.signIn, signUp: mocks.signUp, resetPasswordForEmail: mocks.reset },
  }),
}));
vi.mock('@/lib/security/turnstile', () => ({ verifyTurnstile: mocks.turnstile }));
vi.mock('@/lib/auth/get-client-ip', () => ({ getClientIp: async () => '192.0.2.1' }));
vi.mock('@/lib/rate-limit/auth', () => ({
  checkLoginRateLimit: async () => ({ allowed: true }),
  checkRegisterRateLimit: async () => ({ allowed: true }),
}));
vi.mock('@/lib/rate-limit/password', () => ({
  checkPasswordRecoveryRequestRateLimit: async () => ({ allowed: true, unavailable: false, retryAfter: 0 }),
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
const { HoneypotField, HONEYPOT_FIELD } = await import('@/components/auth/honeypot-field');

function form(fields: Record<string, string>) {
  const data = new FormData();
  data.set('email', 'fixture@example.test');
  data.set('password', 'Fixture-Passw0rd!');
  data.set('terms', 'on');
  data.set('cf-turnstile-response', 'synthetic-turnstile-token');
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const actions = [
  { name: 'logowanie', run: loginWithEmail, denied: '/login?error=bot_check_failed', provider: mocks.signIn },
  { name: 'rejestracja', run: signupWithEmail, denied: '/register?error=bot_check_failed', provider: mocks.signUp },
  { name: 'reset hasła', run: requestPasswordReset, denied: '/forgot-password?error=bot_check_failed', provider: mocks.reset },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test');
  mocks.turnstile.mockResolvedValue({ success: false });
});

describe('pole-pułapka', () => {
  it.each(actions)('$name: wypełnione pole kończy się odmową przed Cloudflare i GoTrue', async ({ run, denied, provider }) => {
    await expect(run(form({ [HONEYPOT_FIELD]: 'https://spam.example.test' }))).rejects.toThrow('redirect:' + denied);
    expect(mocks.turnstile).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it.each(actions)('$name: puste pole przechodzi dalej do Turnstile', async ({ run, denied }) => {
    await expect(run(form({ [HONEYPOT_FIELD]: '' }))).rejects.toThrow('redirect:' + denied);
    expect(mocks.turnstile).toHaveBeenCalledTimes(1);
  });

  it('pole jest ukryte przed człowiekiem, czytnikiem ekranu i menedżerem haseł', () => {
    const html = renderToStaticMarkup(<HoneypotField />);
    expect(html).toContain(`name="${HONEYPOT_FIELD}"`);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('data-1p-ignore');
    expect(html).not.toMatch(/required/);
  });

  it.each(['login', 'register', 'forgot-password'])('formularz %s ma pole-pułapkę obok Turnstile', (page) => {
    const source = readFileSync(join(process.cwd(), 'app/(auth)', page, 'page.tsx'), 'utf8');
    expect(source).toMatch(/<HoneypotField \/>\s*<TurnstileWidget/);
  });
});
