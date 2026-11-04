import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Zgody i akceptacja dokumentów (15.10.2026). Do tej daty rejestracja miała
 * tylko napis „Rejestrując się akceptujesz regulamin” — bez pola wyboru i bez
 * zapisu, a porady i oferty szły e-mailem do każdego, kto się nie wypisał
 * (art. 398 Prawa komunikacji elektronicznej wymaga UPRZEDNIEJ zgody).
 */

const mocks = vi.hoisted(() => ({
  signUp: vi.fn(), record: vi.fn(), getUserById: vi.fn(), updateUserById: vi.fn(),
  audit: vi.fn(), sendEmail: vi.fn(), from: vi.fn(), pageContext: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: (p: string) => { throw new Error('redirect:' + p); } }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'https://app.example.test' }),
  cookies: async () => ({ get: () => undefined, set: vi.fn() }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { signUp: mocks.signUp } }),
  createAdminClient: () => ({
    from: mocks.from,
    auth: { admin: { getUserById: mocks.getUserById, updateUserById: mocks.updateUserById } },
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: mocks.from,
    auth: { admin: { getUserById: mocks.getUserById, updateUserById: mocks.updateUserById } },
  }),
}));
vi.mock('@/lib/feature-flags/signups', () => ({ isSignupClosed: async () => false, SIGNUPS_CLOSED_MESSAGE: 'x' }));
vi.mock('@/lib/auth/get-client-ip', () => ({ getClientIp: async () => '203.0.113.10' }));
vi.mock('@/lib/security/turnstile', () => ({ verifyTurnstile: async () => ({ success: true }) }));
vi.mock('@/lib/rate-limit/auth', () => ({ checkRegisterRateLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/auth/password', () => ({ validatePassword: async () => ({ valid: true }) }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/email/send', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('@/lib/jobs/events', () => ({ userRegistered: { create: (data: unknown) => ({ data }) } }));
vi.mock('@/components/auth/turnstile-widget', () => ({ TurnstileWidget: () => null }));
vi.mock('../../app/(auth)/login/actions', () => ({ loginWithGoogle: vi.fn() }));
// Billing — tylko to, co potrzebne, by sprawdzić oświadczenie przed płatnością.
vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: mocks.pageContext }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));
vi.mock('@/lib/stripe/client', () => ({ isStripeConfigured: () => true }));
vi.mock('@/lib/stripe/checkout', () => ({ createCheckoutSession: vi.fn() }));
vi.mock('@/lib/stripe/portal', () => ({ createPortalSession: vi.fn() }));
vi.mock('@/lib/stripe/customer-email', () => ({ syncStripeCustomerEmail: vi.fn() }));
vi.mock('@/lib/auth/sensitive-mfa', () => ({
  assertSensitiveMfa: vi.fn(), SensitiveMfaRequiredError: class extends Error {},
}));

import { readLegalMetadata, hasEmailConsent, needsTermsAcceptance } from '@/lib/legal/acceptance';
import { safeNextPath } from '@/lib/legal/safe-next';
import { CONTRACT_VERSION } from '@/lib/legal/versions';

const terms = (over: Record<string, unknown> = {}) => ({
  legal: {
    terms: {
      version: CONTRACT_VERSION, accepted_at: '2026-10-15T10:00:00Z', draft: false,
      method: 'register_form', statement_version: '2026-10-15', ...over,
    },
  },
});

describe('bramka akceptacji', () => {
  it('śpi, dopóki dane usługodawcy są niepełne — nikt nie akceptuje projektu', () => {
    expect(needsTermsAcceptance({}, { entityComplete: false })).toBe(false);
  });

  it('po uzupełnieniu danych wymaga bieżącej, nie-roboczej wersji', () => {
    const opts = { entityComplete: true };
    expect(needsTermsAcceptance({}, opts)).toBe(true);
    expect(needsTermsAcceptance(terms(), opts)).toBe(false);
    expect(needsTermsAcceptance(terms({ draft: true }), opts)).toBe(true);
    expect(needsTermsAcceptance(terms({ version: '2020-01-01' }), opts)).toBe(true);
  });

  it('uszkodzony zapis = brak akceptacji, nie wyjątek', () => {
    expect(readLegalMetadata({ legal: { terms: { version: 7 } } })).toEqual({});
    expect(readLegalMetadata('nonsense')).toEqual({});
    expect(needsTermsAcceptance({ legal: 'x' }, { entityComplete: true })).toBe(true);
  });

  it('zgoda na e-maile tylko przy granted === true', () => {
    const meta = { legal: { email_consents: { marketing: { granted: false, at: 'x', statement_version: 'v', method: 'm' } } } };
    expect(hasEmailConsent(meta, 'marketing')).toBe(false);
    expect(hasEmailConsent({}, 'product_updates')).toBe(false);
  });

  it('powrót po akceptacji tylko w obrębie serwisu', () => {
    expect(safeNextPath('/invoices?x=1')).toBe('/invoices?x=1');
    for (const evil of ['//evil.example', 'https://evil.example', '/\\evil.example', 42, null, '/onboarding/zgody']) {
      expect(safeNextPath(evil)).toBe('/dashboard');
    }
  });
});

describe('rejestracja e-mailem', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.record.mockResolvedValue({ ok: true });
  });

  function form(fields: Record<string, string>) {
    const f = new FormData();
    f.set('email', 'nowy@example.test');
    f.set('password', 'Fixture-Passw0rd!');
    f.set('name', 'Nowy');
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  }

  it('bez zaznaczonej akceptacji nie zakłada konta (serwer, nie tylko `required`)', async () => {
    const { signupWithEmail } = await import('@/app/(auth)/register/actions');
    await expect(signupWithEmail(form({}))).rejects.toThrow('redirect:/register?error=terms_required');
    expect(mocks.signUp).not.toHaveBeenCalled();
  });

  it('nowe konto: zapisuje akceptację i zgodę na e-maile w app_metadata', async () => {
    mocks.signUp.mockResolvedValue({
      data: { user: { id: 'u-1', email: 'nowy@example.test', identities: [{ id: 'i' }] }, session: null }, error: null,
    });
    mocks.getUserById.mockResolvedValue({ data: { user: { id: 'u-1', email: 'nowy@example.test', app_metadata: { provider: 'email' } } }, error: null });
    mocks.updateUserById.mockResolvedValue({ error: null });
    const { signupWithEmail } = await import('@/app/(auth)/register/actions');
    await expect(signupWithEmail(form({ terms: 'on', marketing: 'on' }))).rejects.toThrow('redirect:/login?success=check_email');

    expect(mocks.updateUserById).toHaveBeenCalledOnce();
    const [userId, patch] = mocks.updateUserById.mock.calls[0];
    expect(userId).toBe('u-1');
    // Tylko klucz `legal` — `provider` zostaje nietknięty (GoTrue scala klucze).
    expect(Object.keys(patch.app_metadata)).toEqual(['legal']);
    const legal = patch.app_metadata.legal;
    expect(legal.terms).toMatchObject({ version: CONTRACT_VERSION, method: 'register_form' });
    expect(legal.email_consents.product_updates.granted).toBe(true);
    expect(legal.email_consents.marketing.granted).toBe(true);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'legal.terms_accepted', userId: 'u-1' }));
  });

  it('bez pola zgody na e-maile nie zapisuje zgody', async () => {
    mocks.signUp.mockResolvedValue({
      data: { user: { id: 'u-2', email: 'a@example.test', identities: [{ id: 'i' }] }, session: null }, error: null,
    });
    mocks.getUserById.mockResolvedValue({ data: { user: { id: 'u-2', email: 'a@example.test', app_metadata: {} } }, error: null });
    mocks.updateUserById.mockResolvedValue({ error: null });
    const { signupWithEmail } = await import('@/app/(auth)/register/actions');
    await expect(signupWithEmail(form({ terms: 'on' }))).rejects.toThrow('redirect:/login');
    const legal = mocks.updateUserById.mock.calls[0][1].app_metadata.legal;
    expect(legal.email_consents).toBeUndefined();
  });

  it('zajęty adres (konto bez tożsamości): nie dopisuje akceptacji cudzemu kontu', async () => {
    mocks.signUp.mockResolvedValue({
      data: { user: { id: 'cudze', email: 'nowy@example.test', identities: [] }, session: null }, error: null,
    });
    const { signupWithEmail } = await import('@/app/(auth)/register/actions');
    await expect(signupWithEmail(form({ terms: 'on' }))).rejects.toThrow('redirect:/login');
    expect(mocks.getUserById).not.toHaveBeenCalled();
    expect(mocks.updateUserById).not.toHaveBeenCalled();
  });

  it('wersja robocza dokumentów: bez maila „potwierdzenie zawarcia umowy”', async () => {
    const { isLegalEntityComplete } = await import('@/lib/legal/entity');
    if (isLegalEntityComplete()) return; // po uzupełnieniu danych mail ma iść — sprawdza test niżej
    mocks.getUserById.mockResolvedValue({ data: { user: { id: 'u-3', email: 'a@example.test', app_metadata: {} } }, error: null });
    mocks.updateUserById.mockResolvedValue({ error: null });
    const { recordTermsAcceptance } = await import('@/lib/legal/record');
    expect(await recordTermsAcceptance({ userId: 'u-3', method: 'gate' })).toEqual({ ok: true });
    expect(mocks.updateUserById.mock.calls[0][1].app_metadata.legal.terms.draft).toBe(true);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('bramka nie wycofuje wcześniejszej zgody, gdy pole e-maili jest puste', async () => {
    const earlier = { granted: true, at: '2026-10-01T00:00:00Z', statement_version: '2026-10-15', method: 'settings_ui' };
    mocks.getUserById.mockResolvedValue({
      data: { user: { id: 'u-4', email: 'a@example.test', app_metadata: { legal: { email_consents: { marketing: earlier } } } } }, error: null,
    });
    mocks.updateUserById.mockResolvedValue({ error: null });
    const { recordTermsAcceptance } = await import('@/lib/legal/record');
    await recordTermsAcceptance({ userId: 'u-4', method: 'gate' });
    expect(mocks.updateUserById.mock.calls[0][1].app_metadata.legal.email_consents.marketing).toEqual(earlier);
  });

  it('formularz: pole akceptacji wymagane, pole e-maili domyślnie odznaczone', async () => {
    const RegisterPage = (await import('@/app/(auth)/register/page')).default;
    const html = renderToStaticMarkup(await RegisterPage({ searchParams: Promise.resolve({}) }));
    const inputs = html.match(/<input[^>]*>/g) ?? [];
    const termsInput = inputs.find((i) => i.includes('name="terms"'));
    const marketingInput = inputs.find((i) => i.includes('name="marketing"'));
    expect(termsInput).toContain('required');
    expect(marketingInput).toBeDefined();
    expect(marketingInput).not.toContain('checked');
    expect(marketingInput).not.toContain('required');
    expect(html).toContain('href="/legal/umowa-powierzenia"');
  });
});

describe('e-maile z poradami i ofertami wymagają zgody', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Brak odbić i brak wypisu — sprawdzamy wyłącznie warstwę zgody.
    mocks.from.mockImplementation(() => {
      const q = {
        select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return q;
    });
  });

  const consent = (granted: boolean) => ({
    data: { user: { id: 'u', app_metadata: { legal: { email_consents: { product_updates: { granted, at: 'x', statement_version: 'v', method: 'm' } } } } } },
    error: null,
  });

  it('brak zgody = nie wysyłamy, choć użytkownik się nie wypisał', async () => {
    const { canSendTo } = await import('@/lib/email/preferences');
    mocks.getUserById.mockResolvedValue(consent(false));
    expect(await canSendTo('a@example.test', 'u', 'product_updates')).toEqual({ ok: false, reason: 'no_consent' });
  });

  it('zgoda + brak wypisu = wysyłamy', async () => {
    const { canSendTo } = await import('@/lib/email/preferences');
    mocks.getUserById.mockResolvedValue(consent(true));
    expect(await canSendTo('a@example.test', 'u', 'product_updates')).toEqual({ ok: true });
  });

  it('bez userId nie da się sprawdzić zgody — nie wysyłamy', async () => {
    const { canSendTo } = await import('@/lib/email/preferences');
    expect(await canSendTo('a@example.test', null, 'marketing')).toEqual({ ok: false, reason: 'no_consent' });
  });

  it('konto usunięte (404) = brak zgody; inny błąd odczytu = wyjątek (ponowienie)', async () => {
    const { canSendTo } = await import('@/lib/email/preferences');
    mocks.getUserById.mockResolvedValue({ data: { user: null }, error: { status: 404, message: 'not found' } });
    expect(await canSendTo('a@example.test', 'u', 'marketing')).toEqual({ ok: false, reason: 'no_consent' });
    mocks.getUserById.mockResolvedValue({ data: { user: null }, error: { status: 500, message: 'boom' } });
    await expect(canSendTo('a@example.test', 'u', 'marketing')).rejects.toThrow('email_consent_unavailable');
  });

  it('transakcyjne bez zmian — nie pytają o zgodę', async () => {
    const { canSendTo } = await import('@/lib/email/preferences');
    expect(await canSendTo('a@example.test', 'u', 'transactional')).toEqual({ ok: true });
    expect(mocks.getUserById).not.toHaveBeenCalled();
  });
});

describe('oświadczenie przed płatnością', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.pageContext.mockResolvedValue({ role: 'owner', tenantId: 't-1', user: { id: 'u-1', email: 'a@example.test' } });
  });

  it('bez oświadczenia nie ma przekierowania do Stripe', async () => {
    const { startCheckoutAction } = await import('@/app/(dashboard)/settings/billing/actions');
    await expect(startCheckoutAction('monthly')).rejects.toThrow('redirect:/settings/billing?error=statement-required');
    const checkout = await import('@/lib/stripe/checkout');
    expect(checkout.createCheckoutSession).not.toHaveBeenCalled();
  });
});
