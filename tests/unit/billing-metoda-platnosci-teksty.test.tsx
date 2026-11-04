import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render } from '@react-email/render';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BLIK obok karty: wszystko, co zakładało kartę, mówi teraz o metodzie płatności,
 * a ujawnienia Stripe (zgoda, 0 zł dziś, data pierwszego obciążenia, cykl, banki)
 * klient widzi przed przekierowaniem. Przy wyłączonym przełączniku strona zakupu
 * zostaje przy karcie: klient nie może zobaczyć BLIK-a, którego Checkout nie pokaże.
 */

const mocks = vi.hoisted(() => ({
  startCheckout: vi.fn(),
  openPortal: vi.fn(),
  pageContext: vi.fn(),
  getActiveSubscription: vi.fn(),
  getLatestPaymentFailureReason: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  logAudit: vi.fn(),
  logAuditSystem: vi.fn(),
  tenantRead: vi.fn(),
  assertSensitiveMfa: vi.fn(),
  isStripeConfigured: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => { throw new Error('redirect:' + path); },
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: vi.fn() }),
}));
vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: mocks.pageContext }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.tenantRead }) }) }),
  }),
}));
vi.mock('@/lib/stripe/client', () => ({ isStripeConfigured: mocks.isStripeConfigured }));
vi.mock('@/lib/stripe/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/stripe/subscription')>()),
  getActiveSubscription: mocks.getActiveSubscription,
  getLatestPaymentFailureReason: mocks.getLatestPaymentFailureReason,
}));
vi.mock('@/lib/stripe/checkout', () => ({ createCheckoutSession: mocks.createCheckoutSession }));
vi.mock('@/lib/stripe/portal', () => ({ createPortalSession: mocks.createPortalSession }));
vi.mock('@/lib/stripe/customer-email', () => ({ syncStripeCustomerEmail: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.logAudit }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: mocks.logAuditSystem }));
vi.mock('@/lib/auth/sensitive-mfa', () => ({
  assertSensitiveMfa: mocks.assertSensitiveMfa,
  SensitiveMfaRequiredError: class extends Error {},
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import BillingPage from '@/app/(dashboard)/settings/billing/page';
import { openCustomerPortalAction, startCheckoutAction } from '@/app/(dashboard)/settings/billing/actions';
import { PlanCards } from '@/app/(dashboard)/settings/billing/_components/plan-cards';
import { BLIK_RECURRING_BANKS, buildBlikDisclosure, trialPaymentHint } from '@/lib/billing/trial-payment';
import RefundIssued from '@/lib/email/templates/RefundIssued';
import TrialEnding from '@/lib/email/templates/TrialEnding';
import PaymentFailed from '@/lib/email/templates/PaymentFailed';
import { BLIK_RECURRING_STATEMENT, CHECKOUT_STATEMENT, CONTRACT_VERSION } from '@/lib/legal/versions';

// `\b` nie działa z polskimi znakami: po „ę” nie ma granicy słowa.
const CARD_WORD = /(?<!\p{L})kart(a|ę|ą|y|ie)(?!\p{L})/iu;
const LONG_DASH = /[–—]/;
const NOW = new Date('2026-11-02T10:00:00.000Z');

const subscription = {
  id: 'sub-row',
  tenant_id: 't-1',
  stripe_subscription_id: 'sub_Test',
  stripe_customer_id: 'cus_Test',
  stripe_price_id: 'price_monthly',
  status: 'active' as const,
  plan: 'monthly' as const,
  current_period_start: '2026-11-02T10:00:00.000Z',
  current_period_end: '2026-12-02T10:00:00.000Z',
  trial_start: null,
  trial_end: null,
  cancel_at_period_end: false,
  canceled_at: null,
  last_webhook_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pageContext.mockResolvedValue({
    role: 'owner',
    tenantId: 't-1',
    user: { id: 'u-1', email: 'wlasciciel@example.test' },
  });
  mocks.isStripeConfigured.mockReturnValue(true);
  mocks.getActiveSubscription.mockResolvedValue(null);
  mocks.getLatestPaymentFailureReason.mockResolvedValue(null);
  mocks.assertSensitiveMfa.mockResolvedValue(undefined);
  mocks.tenantRead.mockResolvedValue({
    data: { name: 'Firma Testowa', nip: '1234567890', stripe_customer_id: 'cus_Test' },
    error: null,
  });
  mocks.createCheckoutSession.mockResolvedValue({
    sessionId: 'cs_test_x',
    url: 'https://checkout.stripe.test/cs_test_x',
  });
  mocks.createPortalSession.mockResolvedValue({ url: 'https://billing.stripe.test/portal' });
  mocks.logAudit.mockResolvedValue(undefined);
  mocks.logAuditSystem.mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllEnvs());

async function pageHtml(params: Record<string, string> = {}) {
  return renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve(params) }));
}

describe('karta planu i ujawnienia przed przekierowaniem', () => {
  it('przełącznik wyłączony: bez BLIK-a, tekst o karcie jak dotąd', () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', '');
    const html = renderToStaticMarkup(<PlanCards blikDisclosure={null} paymentHint={trialPaymentHint()} />);
    expect(html).toContain('Kartę podajesz teraz, pierwsza płatność po 30 dniach.');
    expect(html).not.toMatch(/BLIK/);
    expect(html).not.toContain('PKO Bank Polski');
  });

  it('przełącznik włączony: zgoda, 0 zł dziś, data i cykl, banki, wyjście dla innego banku', () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', 'on');
    const disclosure = buildBlikDisclosure(NOW);
    const html = renderToStaticMarkup(<PlanCards blikDisclosure={disclosure} paymentHint={trialPaymentHint()} />);

    expect(html).toContain('Kartę albo BLIK podajesz teraz');
    expect(html).toContain('0 zł');
    expect(html).toContain('2 grudnia 2026');
    expect(html).toContain(disclosure.cycle);
    expect(html).toContain(BLIK_RECURRING_STATEMENT.text);
    for (const bank of disclosure.banks) expect(html).toContain(bank);
    expect(html).toMatch(/wybierz kartę/);
    // Zgoda i dane są PRZED przyciskiem, który przekierowuje do Stripe.
    expect(html.indexOf(BLIK_RECURRING_STATEMENT.text)).toBeLessThan(html.indexOf('Zacznij 30 dni za darmo'));
    expect(html.indexOf('PKO Bank Polski')).toBeLessThan(html.indexOf('Zacznij 30 dni za darmo'));
    expect(html).not.toMatch(LONG_DASH);
  });
});

describe('strona abonamentu', () => {
  it('bez subskrypcji i z wyłączonym przełącznikiem: karta, bez ujawnień BLIK', async () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', '');
    const html = await pageHtml();
    expect(html).toContain('Podajesz kartę');
    expect(html).not.toMatch(/BLIK/);
  });

  it('bez subskrypcji i z włączonym przełącznikiem: karta albo BLIK z ujawnieniami', async () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', 'on');
    const html = await pageHtml();
    expect(html).toContain('Podajesz kartę albo BLIK');
    expect(html).toContain('PKO Bank Polski');
    expect(html).toContain(BLIK_RECURRING_STATEMENT.text);
  });

  it('powrót z Checkout przy włączonym BLIK-u podpowiada inną metodę albo bank', async () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', 'on');
    const html = await pageHtml({ checkout: 'canceled' });
    expect(html).toMatch(/nie obsługuje BLIK-a cyklicznego/);
    expect(html).toMatch(/innym banku/);
    expect(html).not.toMatch(LONG_DASH);
  });

  it('po starcie próby i przy aktywnej subskrypcji mówi o płatności, nie o karcie', async () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', 'on');
    mocks.getActiveSubscription.mockResolvedValue(subscription);
    const html = await pageHtml({ checkout: 'success' });
    expect(html).toContain('metodą płatności');
    expect(html).toContain('Pobierzemy płatność automatycznie');
    // Jedyne słowo „karta” przy włączonym przełączniku to wyjście dla klienta banku spoza listy.
    expect(html.replace('Na stronie płatności wybierz kartę.', '')).not.toMatch(CARD_WORD);
    expect(html).not.toMatch(/3D-Secure/);
  });

  it('nieudana płatność z nieobsługiwanym bankiem: co zrobić, nie „Stripe ponowi”', async () => {
    mocks.getActiveSubscription.mockResolvedValue({ ...subscription, status: 'past_due' });
    mocks.getLatestPaymentFailureReason.mockResolvedValue('recurring_not_supported_by_bank');
    const html = await pageHtml();
    expect(html).toContain('Twój bank nie obsługuje');
    expect(html).toContain('Zmień metodę płatności');
    expect(html).not.toMatch(/Stripe ponowi/);
    expect(mocks.getLatestPaymentFailureReason).toHaveBeenCalledWith('t-1');
  });

  it('nieudana płatność bez znanego kodu: tekst ogólny, bez karty', async () => {
    mocks.getActiveSubscription.mockResolvedValue({ ...subscription, status: 'past_due' });
    const html = await pageHtml();
    expect(html).toContain('Płatność nie została pobrana');
    expect(html).toContain('zmień metodę płatności');
    expect(html).not.toMatch(CARD_WORD);
  });

  it.each([
    ['insufficient_funds', 'Na koncie zabrakło środków.'],
    ['customer_declined', 'Płatność nie została zatwierdzona'],
    ['recurring_not_supported_by_bank', 'Twój bank nie obsługuje'],
    [null, null],
  ])('status unpaid przy kodzie %s: Stripe już nie pobiera, więc bez obietnicy kolejnej próby', async (code, reason) => {
    mocks.getActiveSubscription.mockResolvedValue({ ...subscription, status: 'unpaid' });
    mocks.getLatestPaymentFailureReason.mockResolvedValue(code);

    const html = await pageHtml();

    expect(html).toContain('Płatność nie została pobrana');
    if (reason) expect(html).toContain(reason);
    expect(html).toContain('Kolejnych prób pobrania już nie będzie');
    expect(html).toContain('Opłać zaległą fakturę');
    expect(html).not.toMatch(/spróbujemy/i);
    expect(html).not.toMatch(/kolejną próbę/i);
    expect(html).not.toMatch(LONG_DASH);
  });

  it('status past_due: Stripe może jeszcze pobrać, tekst jak dla kodu', async () => {
    mocks.getActiveSubscription.mockResolvedValue({ ...subscription, status: 'past_due' });
    mocks.getLatestPaymentFailureReason.mockResolvedValue('insufficient_funds');

    const html = await pageHtml();

    expect(html).toContain('Uzupełnij środki, a spróbujemy ponownie');
    expect(html).not.toContain('Kolejnych prób pobrania już nie będzie');
  });

  it('błąd odczytu przyczyny nie wywraca strony', async () => {
    mocks.getActiveSubscription.mockResolvedValue({ ...subscription, status: 'past_due' });
    mocks.getLatestPaymentFailureReason.mockRejectedValue(new Error('baza niedostępna'));
    await expect(pageHtml()).resolves.toContain('Płatność nie została pobrana');
  });

  it('w aktywnej subskrypcji nie czyta przyczyny płatności', async () => {
    mocks.getActiveSubscription.mockResolvedValue(subscription);
    await pageHtml();
    expect(mocks.getLatestPaymentFailureReason).not.toHaveBeenCalled();
  });
});

describe('subskrypcja z portalem: warunki BLIK-a przy przycisku, bo portal pozwala go dodać', () => {
  const CONSENT = BLIK_RECURRING_STATEMENT.text;

  it('włączony przełącznik: zgoda, następna płatność, cykl i banki, przy przycisku portalu', async () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', 'on');
    mocks.getActiveSubscription.mockResolvedValue(subscription);

    const html = await pageHtml();

    expect(html).toContain('Zarządzaj subskrypcją');
    expect(html).toContain(CONSENT);
    expect(html).toContain('Następna płatność');
    expect(html).toContain('02.12.2026');
    expect(html).toContain('0 zł');
    expect(html).toContain(buildBlikDisclosure().cycle);
    for (const bank of BLIK_RECURRING_BANKS) expect(html).toContain(bank);
    expect(html.indexOf('Zarządzaj subskrypcją')).toBeLessThan(html.indexOf(CONSENT));
    expect(html.indexOf(CONSENT)).toBeLessThan(html.indexOf('Następne odnowienie'));
    expect(html).not.toMatch(LONG_DASH);
  });

  it('wyłączony przełącznik: bez BLIK-a, strona jak dotąd', async () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', '');
    mocks.getActiveSubscription.mockResolvedValue(subscription);

    const html = await pageHtml();

    expect(html).toContain('Zarządzaj subskrypcją');
    expect(html).not.toMatch(/BLIK/);
    expect(html).not.toContain('PKO Bank Polski');
  });

  it('w próbie pierwsza płatność to koniec próby, nie koniec okresu', async () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', 'on');
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      mocks.getActiveSubscription.mockResolvedValue({
        ...subscription,
        status: 'trialing',
        trial_end: '2026-12-15T10:00:00.000Z',
        current_period_end: '2026-12-20T10:00:00.000Z',
      });

      const html = await pageHtml();

      expect(html).toMatch(/Następna płatność<\/dt><dd[^>]*>15\.12\.2026/);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['past_due', { status: 'past_due' }, 'zaległa kwota, przy najbliższej próbie pobrania'],
    ['unpaid', { status: 'unpaid' }, 'zaległa kwota, gdy opłacisz fakturę'],
    ['anulowana z końcem okresu', { cancel_at_period_end: true }, 'tylko jeśli wznowisz subskrypcję przed 02.12.2026'],
  ])('%s: następna płatność zgodna ze stanem subskrypcji', async (_name, overrides, label) => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', 'on');
    mocks.getActiveSubscription.mockResolvedValue({ ...subscription, ...overrides });

    const html = await pageHtml();

    expect(html).toContain(label);
    expect(html).toContain(CONSENT);
  });

  it('kto nie może otworzyć portalu, nie widzi warunków', async () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', 'on');
    mocks.pageContext.mockResolvedValue({
      role: 'member',
      tenantId: 't-1',
      user: { id: 'u-2', email: 'pracownik@example.test' },
    });
    mocks.getActiveSubscription.mockResolvedValue(subscription);

    const html = await pageHtml();

    expect(html).not.toContain('Zarządzaj subskrypcją');
    expect(html).not.toContain(CONSENT);
  });

  it('wycofany plan roczny: bez warunków, bo zgoda mówi o płatnościach co miesiąc', async () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', 'on');
    mocks.getActiveSubscription.mockResolvedValue({ ...subscription, plan: 'annual' });

    const html = await pageHtml();

    expect(html).toContain('Zarządzaj subskrypcją');
    expect(html).not.toContain(CONSENT);
  });

  it('bank bez BLIK-a cyklicznego: tekst odmowy podaje banki, które go obsługują', async () => {
    mocks.getActiveSubscription.mockResolvedValue({ ...subscription, status: 'past_due' });
    mocks.getLatestPaymentFailureReason.mockResolvedValue('recurring_not_supported_by_bank');
    vi.stubEnv('STRIPE_BLIK_RECURRING', '');

    const html = await pageHtml();

    for (const bank of BLIK_RECURRING_BANKS) expect(html).toContain(bank);
  });
});

describe('openCustomerPortalAction: ślad warunków BLIK-a pokazanych przed portalem', () => {
  const portalAudit = () => mocks.logAuditSystem.mock.calls[0][0] as {
    entityType: string;
    metadata: Record<string, unknown>;
  };

  async function open(version: string | null) {
    await expect(openCustomerPortalAction(version))
      .rejects.toThrow('redirect:https://billing.stripe.test/portal');
  }

  it('włączony przełącznik i aktualna wersja: wersja w audycie otwarcia portalu', async () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', 'on');
    await open(BLIK_RECURRING_STATEMENT.version);
    expect(portalAudit().entityType).toBe('stripe_portal');
    expect(portalAudit().metadata.blikStatementVersion).toBe(BLIK_RECURRING_STATEMENT.version);
  });

  it.each([
    ['brak wersji', 'on', null],
    ['inne brzmienie', 'on', '2000-01-01'],
    ['przełącznik wyłączony', '', BLIK_RECURRING_STATEMENT.version],
  ])('%s: portal otwiera się, a audyt nie twierdzi, że warunki były pokazane', async (_name, env, version) => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', env);
    await open(version);
    expect(portalAudit().metadata).not.toHaveProperty('blikStatementVersion');
  });
});

describe('startCheckoutAction: BLIK tylko po ujawnieniach, które klient widział', () => {
  async function start(version: string | null | undefined) {
    await expect(startCheckoutAction('monthly', true, version as string | null))
      .rejects.toThrow('redirect:https://checkout.stripe.test/cs_test_x');
    return mocks.createCheckoutSession.mock.calls[0][0];
  }

  it('włączony i aktualna wersja zgody: oferta BLIK, dowód zgody w audycie', async () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', 'on');
    const checkout = await start(BLIK_RECURRING_STATEMENT.version);
    expect(checkout.offerBlik).toBe(true);
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'legal.checkout_statement_accepted',
      metadata: {
        plan: 'monthly',
        statementVersion: CHECKOUT_STATEMENT.version,
        contractVersion: CONTRACT_VERSION,
        blikStatementVersion: BLIK_RECURRING_STATEMENT.version,
      },
    }));
  });

  it.each([
    ['strona sprzed włączenia (brak wersji)', 'on', null],
    ['strona z inną wersją brzmienia', 'on', '2000-01-01'],
    ['przełącznik wyłączony po wyrenderowaniu strony', '', BLIK_RECURRING_STATEMENT.version],
  ])('%s: oferta bez BLIK-a i bez zapisu zgody', async (_name, env, version) => {
    // Że taka oferta to w żądaniu jawnie sama karta: tests/unit/stripe-checkout-blik.test.ts.
    vi.stubEnv('STRIPE_BLIK_RECURRING', env);
    const checkout = await start(version);
    expect(checkout.offerBlik).toBe(false);
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: {
        plan: 'monthly',
        statementVersion: CHECKOUT_STATEMENT.version,
        contractVersion: CONTRACT_VERSION,
      },
    }));
  });
});

describe('maile bez założenia, że płaci się kartą', () => {
  it('TrialEnding', async () => {
    for (const daysRemaining of [14, 7, 3, 1] as const) {
      const html = await render(TrialEnding({
        appUrl: 'https://app.example.test',
        tenantName: 'Firma Testowa',
        daysRemaining,
        trialEndDate: '2 grudnia 2026',
        planLabel: 'Miesięczny',
        monthlyPriceLabel: '29,99 zł/mc z VAT',
      }));
      expect(html, String(daysRemaining)).not.toMatch(CARD_WORD);
      expect(html, String(daysRemaining)).toContain('metody płatności');
    }
  });

  it('PaymentFailed: tekst ogólny mówi „metoda płatności”', async () => {
    const html = await render(PaymentFailed({
      appUrl: 'https://app.example.test',
      tenantName: 'Firma Testowa',
      amountLabel: '29,99 zł',
      failureReason: null,
    }));
    expect(html).not.toMatch(CARD_WORD);
    expect(html).toContain('Zmień metodę płatności');
    expect(html).toContain('Spróbujemy pobrać płatność ponownie');
  });

  it('RefundIssued: zwrot wraca tam, skąd poszła płatność', async () => {
    const html = await render(RefundIssued({
      tenantName: 'Firma Testowa',
      amountLabel: '29,99 zł',
      reason: null,
    }));
    expect(html).not.toMatch(CARD_WORD);
    expect(html).toContain('metodę płatności');
  });

  it('mail powitalny z sekwencji nie obiecuje podawania karty', () => {
    const source = readFileSync(join(process.cwd(), 'lib/jobs/runners/email-sequence.ts'), 'utf8');
    expect(source).not.toContain('kartę podajesz przy uruchomieniu');
    expect(source).toContain('Metodę płatności podajesz przy uruchomieniu');
  });
});
