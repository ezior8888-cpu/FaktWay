import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 17.10.2026: strony logowania i rejestracji pokazywały „Zaloguj przez Google”
// na sztywno, a produkcyjny GoTrue ma dostawcę wyłączony
// (`/auth/v1/settings` → `external.google: false`). `signInWithOAuth` nie pyta
// GoTrue, tylko buduje adres — klient lądował na surowym JSON-ie
// `Unsupported provider: provider is not enabled` z db.*. Mock tylko HTTP do
// GoTrue i klienta Supabase; reszta to prawdziwe strony i akcja.

const mocks = vi.hoisted(() => ({ signInWithOAuth: vi.fn(), flag: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { signInWithOAuth: mocks.signInWithOAuth } }),
}));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error('redirect:' + path); } }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'https://app.example.test' }),
  cookies: async () => ({ set: vi.fn() }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@/lib/auth/get-client-ip', () => ({ getClientIp: async () => '203.0.113.10' }));
vi.mock('@/lib/rate-limit/auth', () => ({ checkLoginRateLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/security/turnstile', () => ({ verifyTurnstile: async () => ({ success: true }) }));
vi.mock('@/lib/auth/sign-out', () => ({ signOutCurrentSession: vi.fn() }));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: mocks.flag }));
vi.mock('@/components/auth/turnstile-widget', () => ({ TurnstileWidget: () => null }));

const SETTINGS_URL = 'https://db.example.test/auth/v1/settings';
let fetchMock: ReturnType<typeof vi.fn>;

function goTrue(google: boolean | 'error') {
  fetchMock.mockImplementation(async (url: string) => {
    if (url !== SETTINGS_URL) throw new Error('nieoczekiwany fetch: ' + url);
    if (google === 'error') throw new Error('fetch failed');
    return new Response(JSON.stringify({ external: { email: true, google } }), { status: 200 });
  });
}

async function loginPage(error?: string) {
  const { default: LoginPage } = await import('@/app/(auth)/login/page');
  return renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(error ? { error } : {}) }));
}

async function registerPage() {
  const { default: RegisterPage } = await import('@/app/(auth)/register/page');
  return renderToStaticMarkup(await RegisterPage({ searchParams: Promise.resolve({}) }));
}

async function googleAction(): Promise<string> {
  const { loginWithGoogle } = await import('@/app/(auth)/login/actions');
  try {
    await loginWithGoogle();
  } catch (e) {
    return (e as Error).message;
  }
  return 'bez przekierowania';
}

beforeEach(() => {
  vi.resetModules();
  mocks.signInWithOAuth.mockReset().mockResolvedValue({ data: { url: 'https://accounts.example.test/o/oauth2' }, error: null });
  mocks.flag.mockReset().mockResolvedValue(false);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.test/');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-test');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Google wyłączone w GoTrue', () => {
  it('logowanie: bez przycisku Google, formularz e-mail zostaje', async () => {
    goTrue(false);
    const html = await loginPage();
    expect(html).not.toContain('Zaloguj przez Google');
    expect(html).toContain('name="password"');
  });

  it('rejestracja: bez przycisku Google, formularz e-mail zostaje', async () => {
    goTrue(false);
    const html = await registerPage();
    expect(html).not.toContain('Zarejestruj przez Google');
    expect(html).toContain('name="email"');
  });

  it('akcja nie wysyła do GoTrue, tylko wraca z komunikatem', async () => {
    goTrue(false);
    expect(await googleAction()).toBe('redirect:/login?error=oauth_disabled');
    expect(mocks.signInWithOAuth).not.toHaveBeenCalled();
  });

  it('komunikat mówi, co zrobić, i podaje adres pomocy', async () => {
    goTrue(false);
    const html = await loginPage('oauth_disabled');
    expect(html).toContain('Logowanie przez Google jest teraz wyłączone');
    expect(html).toContain('Nie pamiętasz hasła?');
    expect(html).toMatch(/pomoc@[a-z]+\.pl/);
  });
});

describe('Google włączone w GoTrue', () => {
  it('przyciski na obu stronach i przekierowanie do Google jak dotąd', async () => {
    goTrue(true);
    expect(await loginPage()).toContain('Zaloguj przez Google');
    expect(await registerPage()).toContain('Zarejestruj przez Google');
    expect(await googleAction()).toBe('redirect:https://accounts.example.test/o/oauth2');
    expect(mocks.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: 'https://app.example.test/auth/callback' },
    });
  });

  it('pyta GoTrue kluczem anon i pamięta wynik — jedno zapytanie na kilka wejść', async () => {
    goTrue(true);
    const { isGoogleLoginEnabled } = await import('@/lib/auth/oauth-providers');
    expect(await isGoogleLoginEnabled()).toBe(true);
    expect(await isGoogleLoginEnabled()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('apikey')).toBe('anon-test');
  });
});

describe('GoTrue nie odpowiada', () => {
  it('bez znanej wartości przycisk zostaje (zachowanie sprzed zmiany)', async () => {
    goTrue('error');
    const { isGoogleLoginEnabled } = await import('@/lib/auth/oauth-providers');
    expect(await isGoogleLoginEnabled()).toBe(true);
  });

  it('po czasie pamięci błąd odczytu trzyma ostatnią znaną wartość', async () => {
    vi.useFakeTimers();
    goTrue(false);
    const { isGoogleLoginEnabled } = await import('@/lib/auth/oauth-providers');
    expect(await isGoogleLoginEnabled()).toBe(false);
    vi.advanceTimersByTime(10 * 60_000);
    goTrue('error');
    expect(await isGoogleLoginEnabled()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('brak zmiennych Supabase — przycisk zostaje, bez zapytania', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    goTrue(false);
    const { isGoogleLoginEnabled } = await import('@/lib/auth/oauth-providers');
    expect(await isGoogleLoginEnabled()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
