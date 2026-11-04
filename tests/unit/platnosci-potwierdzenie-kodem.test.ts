import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Płatności w sesji po biometrii: prawdziwe akcje i prawdziwe `assertSensitiveMfa`.
 * Flaga `requireMfaForSensitive` jest wyłączona, a płatność i tak ma prosić
 * o kod, bo konto ma 2FA, a ta sesja go nie potwierdziła.
 */

const s = vi.hoisted(() => ({
  flag: false,
  mfa: 'challenge_required' as 'verified' | 'enrollment_required' | 'challenge_required',
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error('redirect:' + path); } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: async () => s.flag }));
vi.mock('@/lib/auth/verified-mfa', () => ({
  getVerifiedMfaState: async () => ({ status: s.mfa, user: { id: 'u-1' } }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({}),
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q, eq: () => q,
        maybeSingle: async () => ({ data: { role: 'owner' }, error: null }),
      });
      return q;
    },
  }),
}));
vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: async () => ({
    supabase: {}, tenantId: 't-1', role: 'owner', user: { id: 'u-1', email: 'owner@example.test' },
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));
vi.mock('@/lib/stripe/client', () => ({ isStripeConfigured: () => true }));
vi.mock('@/lib/stripe/checkout', () => ({ createCheckoutSession: s.createCheckoutSession }));
vi.mock('@/lib/stripe/portal', () => ({ createPortalSession: s.createPortalSession }));
vi.mock('@/lib/stripe/customer-email', () => ({ syncStripeCustomerEmail: vi.fn() }));

const { openCustomerPortalAction, startCheckoutAction } = await import('@/app/(dashboard)/settings/billing/actions');

const STEP_UP = 'redirect:/login/two-factor?redirect=%2Fsettings%2Fbilling&potwierdzenie=1';

beforeEach(() => {
  s.flag = false;
  s.mfa = 'challenge_required';
  s.createCheckoutSession.mockReset();
  s.createPortalSession.mockReset();
});

describe('sesja po biometrii', () => {
  it('Checkout: przejście na ekran kodu i powrót do Abonamentu, bez Stripe', async () => {
    await expect(startCheckoutAction('monthly', true)).rejects.toThrow(STEP_UP);
    expect(s.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('Portal klienta: to samo', async () => {
    await expect(openCustomerPortalAction()).rejects.toThrow(STEP_UP);
    expect(s.createPortalSession).not.toHaveBeenCalled();
  });
});

describe('konto bez 2FA przy włączonej fladze: dotychczasowy komunikat „włącz 2FA”', () => {
  it('Checkout wraca z kodem błędu, nie na ekran kodu', async () => {
    s.flag = true;
    s.mfa = 'enrollment_required';
    await expect(startCheckoutAction('monthly', true)).rejects.toThrow('redirect:/settings/billing?error=mfa-required');
  });
});
