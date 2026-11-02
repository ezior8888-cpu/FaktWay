'use server';

import { redirect } from 'next/navigation';

import { logAudit } from '@/lib/audit/log';
import { logAuditSystem } from '@/lib/audit/log-system';
import { CHECKOUT_STATEMENT, CONTRACT_VERSION } from '@/lib/legal/versions';
import { isStripeConfigured } from '@/lib/stripe/client';
import { createCheckoutSession, type CheckoutPlan } from '@/lib/stripe/checkout';
import { createPortalSession } from '@/lib/stripe/portal';
import { createAdminClient } from '@/lib/supabase/admin';
import { getPageContext } from '@/lib/supabase/page-context';
import { mfaStepUpHref } from '@/lib/auth/mfa-step-up';
import { assertSensitiveMfa, SensitiveMfaRequiredError } from '@/lib/auth/sensitive-mfa';
import { syncStripeCustomerEmail } from '@/lib/stripe/customer-email';

/**
 * Server actions dla `/settings/billing` (Faza 25 Krok 2).
 *
 * Wszystkie akcje:
 *   1. `getPageContext()` — auth + tenant guard (redirect na /login/onboarding)
 *   2. Sprawdzają rolę (`owner` lub `admin` mogą zarządzać billingiem — nie
 *      `member` żeby pracownik nie anulował subskrypcji szefa).
 *   3. Wywołują Stripe SDK i robią `redirect()` (NEXT_REDIRECT) na hosted page.
 *
 * Uwaga: w pliku z `'use server'` mogą być eksportowane wyłącznie async
 * funkcje (Server Actions). Type guardy / stałe daj do osobnego modułu
 * (np. `lib/billing/billing-action-errors.ts`).
 */

/** Whitelist ról które mogą touch'ować billing. */
function canManageBilling(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

function getBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'http://localhost:3000'
  );
}

/**
 * Sukces = redirect na Stripe Checkout (303). Fail = redirect na
 * `/settings/billing?error=<code>` (kody: not-configured, forbidden, …).
 */
export async function startCheckoutAction(
  plan: CheckoutPlan,
  /**
   * Oświadczenie z `CHECKOUT_STATEMENT` (zamówienie z obowiązkiem zapłaty
   * i — dla konsumenta/PNPK — żądanie rozpoczęcia usługi przed upływem
   * 14 dni na odstąpienie, art. 15 ust. 3 i art. 35 ustawy o prawach
   * konsumenta). Bez niego nie kierujemy do płatności.
   */
  statementAccepted = false,
): Promise<void> {
  const ctx = await getPageContext();

  if (!canManageBilling(ctx.role)) {
    redirect('/settings/billing?error=forbidden');
  }
  if (statementAccepted !== true) {
    redirect('/settings/billing?error=statement-required');
  }
  await enforceBillingMfa(ctx);

  // Sprzedajemy wyłącznie plan miesięczny (lib/billing/pricing.ts). Stara
  // karta w otwartej zakładce nie może założyć subskrypcji rocznej.
  if (plan !== 'monthly') {
    redirect('/settings/billing?error=plan-unavailable');
  }

  if (!isStripeConfigured()) {
    redirect('/settings/billing?error=not-configured');
  }

  const admin = createAdminClient();
  const { data: tenant } = await admin
    .from('tenants')
    .select('name, nip, stripe_customer_id')
    .eq('id', ctx.tenantId)
    .maybeSingle();

  if (!tenant) {
    redirect('/settings/billing?error=tenant-not-found');
  }
  await syncBillingEmail(tenant.stripe_customer_id, ctx.user.email, ctx.tenantId);

  let url: string;
  try {
    const result = await createCheckoutSession({
      tenantId: ctx.tenantId,
      email: ctx.user.email ?? '',
      tenantName: tenant.name,
      nip: tenant.nip,
      plan,
      baseUrl: getBaseUrl(),
    });
    url = result.url;
    // Dowód oświadczenia: wersja brzmienia, regulaminu i plan. Zapis po
    // utworzeniu sesji — przy błędzie Stripe nie ma czego dokumentować.
    // `logAudit` nie rzuca, więc nie trafi do `catch` poniżej.
    await logAudit({
      action: 'legal.checkout_statement_accepted',
      tenantId: ctx.tenantId,
      userId: ctx.user.id,
      metadata: {
        plan,
        statementVersion: CHECKOUT_STATEMENT.version,
        contractVersion: CONTRACT_VERSION,
      },
    });
  } catch (e) {
    // Klient zobaczy "Coś poszło nie tak — spróbuj ponownie" zamiast goly
    // stack trace. Operator widzi w Sentry full kontekst.
    const Sentry = await import('@sentry/nextjs');
    Sentry.captureException(e, {
      tags: { area: 'billing.checkout' },
      extra: { tenantId: ctx.tenantId, plan },
    });
    redirect('/settings/billing?error=unexpected');
  }

  redirect(url);
}

/**
 * Otwiera Stripe Customer Portal (hosted page do zarządzania subskrypcją:
 * zmiana karty, cancel, view invoices history).
 */
export async function openCustomerPortalAction(): Promise<void> {
  const ctx = await getPageContext();

  if (!canManageBilling(ctx.role)) {
    redirect('/settings/billing?error=forbidden');
  }
  await enforceBillingMfa(ctx);

  if (!isStripeConfigured()) {
    redirect('/settings/billing?error=not-configured');
  }

  const admin = createAdminClient();
  const { data: tenant } = await admin
    .from('tenants')
    .select('name, nip, stripe_customer_id')
    .eq('id', ctx.tenantId)
    .maybeSingle();

  if (!tenant) {
    redirect('/settings/billing?error=tenant-not-found');
  }
  await syncBillingEmail(tenant.stripe_customer_id, ctx.user.email, ctx.tenantId);

  let url: string;
  try {
    const result = await createPortalSession({
      tenantId: ctx.tenantId,
      email: ctx.user.email ?? '',
      tenantName: tenant.name,
      nip: tenant.nip,
      baseUrl: getBaseUrl(),
    });
    url = result.url;
  } catch (e) {
    const Sentry = await import('@sentry/nextjs');
    Sentry.captureException(e, {
      tags: { area: 'billing.portal' },
      extra: { tenantId: ctx.tenantId },
    });
    redirect('/settings/billing?error=unexpected');
  }

  // Audit log po sukcesie (Customer Portal może doprowadzić do cancel'a / refund'a).
  try {
    await logAuditSystem({
      action: 'billing.checkout.session_created',
      tenantId: ctx.tenantId,
      userId: ctx.user.id,
      entityType: 'stripe_portal',
      metadata: { adminEmail: ctx.user.email },
    });
  } catch {
    // Audit fail nie powinien blokować akcji billing'u.
  }

  redirect(url);
}

/**
 * AAL2 przy płatnościach (AUD-65). Konto bez 2FA przy włączonej fladze wraca
 * z komunikatem „włącz 2FA”. Sesja po biometrii ma 2FA, więc idzie prosto na
 * ekran kodu i wraca do Abonamentu.
 */
async function enforceBillingMfa(ctx: { tenantId: string; user: { id: string } }): Promise<void> {
  let refusal: SensitiveMfaRequiredError | null = null;
  try {
    await assertSensitiveMfa({ tenantId: ctx.tenantId, userId: ctx.user.id }, 'billing');
  } catch (e) {
    if (!(e instanceof SensitiveMfaRequiredError)) throw e;
    refusal = e;
  }
  if (!refusal) return;
  redirect(refusal.reason === 'challenge' ? mfaStepUpHref('/settings/billing') : '/settings/billing?error=mfa-required');
}

/**
 * Adres osoby zarządzającej płatnościami do klienta Stripe (AUD-78). Błąd
 * nie blokuje Checkout/Portalu — trafia do Sentry.
 */
async function syncBillingEmail(customerId: string | null, email: string | null, tenantId: string): Promise<void> {
  if (!customerId) return;
  try {
    await syncStripeCustomerEmail(customerId, email);
  } catch (e) {
    const Sentry = await import('@sentry/nextjs');
    Sentry.captureException(e, { tags: { area: 'billing.customer-email' }, extra: { tenantId } });
  }
}
