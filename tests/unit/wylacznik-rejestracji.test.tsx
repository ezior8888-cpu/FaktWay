import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// AUD-63: `/wylacz rejestracja` w bramce ustawia `disableSignups`, którego
// nikt nie czytał — bramka odpowiadała „Wyłączono”, a rejestracja działała.
// Wyłącznik zamyka formularz e-mail i zakładanie PIERWSZEJ firmy (konto
// z Google albo prosto z GoTrue bez firmy nic nie może). Błąd odczytu
// flagi = rejestracja zamknięta (fail-closed).

const mocks = vi.hoisted(() => ({
  flag: vi.fn(), signUp: vi.fn(), createAdminClient: vi.fn(), from: vi.fn(),
  userContext: vi.fn(), setCookie: vi.fn(), audit: vi.fn(), requirePage: vi.fn(),
}));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: mocks.flag }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { signUp: mocks.signUp } }),
  createAdminClient: mocks.createAdminClient,
}));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error('redirect:' + path); } }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'https://app.example.test' }),
  cookies: async () => ({ get: () => undefined, set: mocks.setCookie }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/get-client-ip', () => ({ getClientIp: async () => '203.0.113.10' }));
vi.mock('@/lib/security/turnstile', () => ({ verifyTurnstile: async () => ({ success: true }) }));
vi.mock('@/lib/rate-limit/auth', () => ({ checkRegisterRateLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/auth/password', () => ({ validatePassword: async () => ({ valid: true }) }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/jobs/events', () => ({ userRegistered: { create: (data: unknown) => ({ data }) } }));
vi.mock('@/lib/auth/verified-user', () => ({ getVerifiedUserContext: mocks.userContext, requireVerifiedUserForPage: mocks.requirePage }));
vi.mock('@/components/onboarding/form', () => ({ OnboardingForm: () => null }));
vi.mock('@/components/brand/faktway-logo', () => ({ FaktWayLogo: () => null, FaktWayMark: () => null }));
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/dashboard-shell-data', () => ({
  getCachedMembershipRowsWithTenants: vi.fn(), getDashboardSessionUser: vi.fn(), mapMembershipRowsToOrgSwitcher: vi.fn(),
}));
vi.mock('@/lib/stripe/client', () => ({ isStripeConfigured: () => false }));
vi.mock('@/components/auth/turnstile-widget', () => ({ TurnstileWidget: () => null }));

import { signupWithEmail } from '@/app/(auth)/register/actions';
import RegisterPage from '@/app/(auth)/register/page';
import OnboardingPage from '@/app/onboarding/page';
import { createOrganizationAction, skipOnboardingWithoutNipAction } from '@/app/actions/organizations';

const company = {
  nip: '1234567890', name: 'Fixture', city: 'Test', postalCode: '00-000', street: 'Test', buildingNumber: '1',
};
let memberships: { organization_id: string }[];
let inserts: string[];

function chain(table: string) {
  const result = { data: table === 'memberships' ? memberships : table === 'tenants' ? [] : null, error: null, count: table === 'memberships' ? memberships.length : null };
  const c = {
    select: vi.fn(() => c), eq: vi.fn(() => c), limit: vi.fn(async () => result),
    insert: vi.fn(() => { inserts.push(table); return c; }),
    update: vi.fn(() => c),
    single: vi.fn(async () => ({ data: { id: 'new-org' }, error: null })),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  };
  return c;
}

function signupForm() {
  const form = new FormData();
  form.set('email', 'nowy@example.test');
  form.set('password', 'Fixture-Passw0rd!');
  form.set('name', 'Nowy');
  // Od 15.10.2026 rejestracja wymaga akceptacji regulaminu (pole `terms`);
  // brak pola sprawdza tests/unit/legal-zgody.test.ts.
  form.set('terms', 'on');
  return form;
}

beforeEach(() => {
  vi.resetAllMocks();
  memberships = []; inserts = [];
  mocks.signUp.mockResolvedValue({ data: { user: null, session: null }, error: null });
  mocks.from.mockImplementation(chain);
  mocks.createAdminClient.mockReturnValue({ from: mocks.from });
  mocks.userContext.mockResolvedValue({ ok: true, user: { id: 'fixture-user', email: 'nowy@example.test' } });
  // Strona onboardingu czyta `app_metadata` (bramka dokumentów prawnych).
  mocks.requirePage.mockResolvedValue({ ok: true, user: { id: 'fixture-user', app_metadata: {} } });
  mocks.flag.mockResolvedValue(false);
});

describe('rejestracja e-mail', () => {
  it('odmawia, gdy rejestracja jest wyłączona', async () => {
    mocks.flag.mockResolvedValue(true);
    await expect(signupWithEmail(signupForm())).rejects.toThrow('redirect:/register?error=signups_disabled');
    expect(mocks.flag).toHaveBeenCalledWith('disableSignups');
    expect(mocks.signUp).not.toHaveBeenCalled();
  });

  it('odmawia, gdy nie da się odczytać wyłącznika (fail-closed)', async () => {
    mocks.flag.mockRejectedValue(new Error('fixture offline'));
    await expect(signupWithEmail(signupForm())).rejects.toThrow('redirect:/register?error=signups_disabled');
    expect(mocks.signUp).not.toHaveBeenCalled();
  });

  it('działa, gdy wyłącznik jest zdjęty', async () => {
    await expect(signupWithEmail(signupForm())).rejects.toThrow('redirect:/login?success=check_email');
    expect(mocks.signUp).toHaveBeenCalledOnce();
  });
});

describe('strona rejestracji', () => {
  it('przy wyłączonej rejestracji pokazuje komunikat zamiast formularza i przycisku Google', async () => {
    mocks.flag.mockResolvedValue(true);
    const html = renderToStaticMarkup(await RegisterPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('Rejestracja nowych kont jest chwilowo wstrzymana');
    expect(html).not.toContain('name="password"');
    expect(html).not.toContain('Google');
  });

  it('bez wyłącznika pokazuje formularz', async () => {
    const html = renderToStaticMarkup(await RegisterPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('name="password"');
  });
});

describe('zakładanie pierwszej firmy', () => {
  it.each([
    ['wyłączona rejestracja', () => mocks.flag.mockResolvedValue(true)],
    ['błąd odczytu wyłącznika', () => mocks.flag.mockRejectedValue(new Error('fixture offline'))],
  ])('odmawia nowemu użytkownikowi bez firmy: %s', async (_name, arrange) => {
    arrange();
    const result = await createOrganizationAction(company);
    expect(result).toEqual({ success: false, error: expect.stringContaining('chwilowo wstrzymane') });
    expect(inserts).not.toContain('tenants');
  });

  it('odmawia też „Pomiń NIP” (organizacja-szkic)', async () => {
    mocks.flag.mockResolvedValue(true);
    const result = await skipOnboardingWithoutNipAction();
    expect(result).toEqual({ success: false, error: expect.stringContaining('chwilowo wstrzymane') });
    expect(inserts).not.toContain('tenants');
  });

  it('nie blokuje dodania kolejnej firmy przez istniejącego klienta', async () => {
    mocks.flag.mockResolvedValue(true);
    memberships = [{ organization_id: '11111111-1111-4111-8111-111111111111' }];
    await createOrganizationAction(company).catch(() => undefined);
    expect(inserts).toContain('tenants');
  });
});

describe('strona onboardingu', () => {
  it('nowy użytkownik bez firmy widzi, że zakładanie firm jest wstrzymane', async () => {
    mocks.flag.mockResolvedValue(true);
    const html = renderToStaticMarkup(await OnboardingPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('Zakładanie nowych firm jest chwilowo wstrzymane');
  });

  it('bez wyłącznika komunikatu nie ma', async () => {
    const html = renderToStaticMarkup(await OnboardingPage({ searchParams: Promise.resolve({}) }));
    expect(html).not.toContain('chwilowo wstrzymane');
  });
});
