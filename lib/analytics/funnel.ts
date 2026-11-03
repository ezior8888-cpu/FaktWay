import 'server-only';

import { cookies } from 'next/headers';
import type Stripe from 'stripe';

import { logAudit } from '@/lib/audit/log';
import { ANALYTICS_STATEMENT } from '@/lib/legal/versions';
import { createAdminClient } from '@/lib/supabase/admin';

import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_COOKIE_DELIVERED,
  ATTRIBUTION_COOKIE_MAX_AGE_SECONDS,
  decodeFirstTouch,
} from './attribution';
import { ANALYTICS_EVENTS } from './events';
import type { ChurnReason } from './privacy';
import { trackServer } from './server';

/**
 * Zdarzenia lejka FaktWay w prawdziwych momentach (docs/analytics/lejek-faktway.md).
 * Każde: raz, bo ma deterministyczny uuid i chwilę z bazy albo ze Stripe, oraz bez
 * wpływu na operację biznesową, bo żadna funkcja stąd nie rzuca. Zgodę i listy
 * dozwolonych danych pilnuje `trackServer`.
 */

// Wpłaty, które naprawdę się zdarzyły; późniejszy zwrot tego nie cofa. Kwota 0 zł to faktura z próby.
const REAL_PAYMENT_STATUSES = ['succeeded', 'partially_refunded', 'refunded'];
// Wymiana kodu PKCE idzie sekundy po utworzeniu konta. Zapas na różnicę zegarów:
// drugie wejście w tym oknie skleja się po uuid, a starszego konta nie liczymy.
const GOOGLE_SIGNUP_WINDOW_MS = 10 * 60 * 1000;

function logFailure(what: string, err: unknown): void {
  console.error(`[analytics:funnel] ${what} failed:`, err instanceof Error ? err.message : 'unknown');
}

interface SignupUser {
  id: string;
  created_at?: string | null;
}

/**
 * Rejestracja: serwer nie widzi localStorage, ale ciasteczko pierwszego dotyku
 * powstaje tylko po zgodzie i znika przy odwołaniu, więc jest jej dowodem dla gościa.
 * Dowód jest jednorazowy: po użyciu zostaje sam znacznik bez danych, inaczej kolejne
 * konto w tej przeglądarce dostałoby cudze „tak” i cudze źródło (biuro księgowe).
 * Warunek `analytics_consent IS NULL`: decyzja już zapisana na koncie wygrywa.
 */
export async function recordSignupCompleted(input: {
  user: SignupUser;
  method: 'password' | 'google';
}): Promise<void> {
  try {
    const cookieStore = await cookies();
    const touch = decodeFirstTouch(cookieStore.get(ATTRIBUTION_COOKIE)?.value);
    if (touch) {
      const admin = await createAdminClient();
      const consentAt = new Date().toISOString();
      const { data, error } = await admin
        .from('users')
        .update({ analytics_consent: 'granted', analytics_consent_at: consentAt, signup_source: touch })
        .eq('id', input.user.id)
        .is('analytics_consent', null)
        .select('id');
      if (error) throw new Error(`signup source write: ${error.code ?? 'unknown'}`);
      // Bez `httpOnly`: przeglądarka czyta znacznik i sprząta go przy następnej stronie.
      cookieStore.set(ATTRIBUTION_COOKIE, ATTRIBUTION_COOKIE_DELIVERED, {
        path: '/',
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: ATTRIBUTION_COOKIE_MAX_AGE_SECONDS,
      });
      if (data?.length) {
        await logAudit({
          action: 'analytics.consent_changed',
          tenantId: null,
          userId: input.user.id,
          metadata: {
            consent: 'granted',
            chosen_at: consentAt,
            statement_version: ANALYTICS_STATEMENT.version,
            via: input.method === 'google' ? 'google_signup' : 'register_form',
          },
        });
      }
    }
    await trackServer({
      userId: input.user.id,
      event: ANALYTICS_EVENTS.signupCompleted,
      properties: { method: input.method },
      setPersonProperties: { plan: 'trial' },
      dedupeKey: input.user.id,
      timestamp: input.user.created_at,
    });
  } catch (err) {
    logFailure('signup_completed', err);
  }
}

/**
 * Logowanie Google zakłada konto bez formularza. Ponowne logowanie nie jest
 * rejestracją, a ten sam `/auth/callback` obsługuje też potwierdzenie e-maila
 * po rejestracji hasłem (tam zdarzenie poszło z formularza).
 */
export async function recordGoogleSignupIfNew(
  user: (SignupUser & { app_metadata?: { provider?: string } }) | null | undefined,
): Promise<void> {
  if (!user || user.app_metadata?.provider !== 'google') return;
  const created = Date.parse(user.created_at ?? '');
  if (!Number.isFinite(created) || Date.now() - created > GOOGLE_SIGNUP_WINDOW_MS) return;
  await recordSignupCompleted({ user, method: 'google' });
}

/** Pierwsze skuteczne podłączenie KSeF: wynik `claimed` z `finalize_ksef_certificate_claim`. */
export async function recordKsefConfigured(input: { tenantId: string; environment: string }): Promise<void> {
  await trackServer({
    tenantId: input.tenantId,
    event: ANALYTICS_EVENTS.ksefConfigured,
    properties: { env: input.environment },
    dedupeKey: input.tenantId,
  });
}

/**
 * Pierwsza faktura firmy przyjęta w KSeF. Warunkowy UPDATE rozstrzyga, kto wysyła.
 * Job ponawia cały handler od początku, więc awaria po wygranym UPDATE nie może
 * zgubić zdarzenia: ta sama chwila w firmie i na fakturze znaczy „to ja wygrałem”
 * i wysyłka idzie jeszcze raz z tym samym uuid. Data trafia do firmy także bez
 * zgody, bo lejek zbiorczy w /admin od zgód nie zależy.
 */
export async function recordFirstInvoiceAccepted(input: { tenantId: string; invoiceId: string }): Promise<void> {
  try {
    const admin = await createAdminClient();
    const { data: invoice, error: invoiceError } = await admin
      .from('invoices')
      .select('direction, origin, ksef_status, ksef_accepted_at, ksef_environment')
      .eq('id', input.invoiceId)
      .eq('tenant_id', input.tenantId)
      .maybeSingle();
    if (invoiceError) throw new Error(`invoice read: ${invoiceError.code ?? 'unknown'}`);
    // Sprzedaż pobrana z historii KSeF (`ksef_import`) nie została wystawiona w FaktWay.
    if (!invoice || invoice.direction !== 'outgoing' || invoice.ksef_status !== 'accepted' ||
        invoice.origin === 'ksef_import') return;

    const acceptedAt: string = invoice.ksef_accepted_at ?? new Date().toISOString();
    const { data: won, error: claimError } = await admin
      .from('tenants')
      .update({ first_invoice_accepted_at: acceptedAt })
      .eq('id', input.tenantId)
      .is('first_invoice_accepted_at', null)
      .select('id');
    if (claimError) throw new Error(`first invoice claim: ${claimError.code ?? 'unknown'}`);

    if (!won?.length) {
      const { data: tenant, error: tenantError } = await admin
        .from('tenants')
        .select('first_invoice_accepted_at')
        .eq('id', input.tenantId)
        .maybeSingle();
      if (tenantError) throw new Error(`first invoice read: ${tenantError.code ?? 'unknown'}`);
      const stored = Date.parse(tenant?.first_invoice_accepted_at ?? '');
      if (stored !== Date.parse(acceptedAt)) return;
    }

    await trackServer({
      tenantId: input.tenantId,
      event: ANALYTICS_EVENTS.firstInvoiceSent,
      properties: { ksef_env: invoice.ksef_environment },
      dedupeKey: input.tenantId,
      timestamp: acceptedAt,
    });
  } catch (err) {
    logFailure('first_invoice_sent', err);
  }
}

function fromUnix(seconds: number | null | undefined): Date | undefined {
  return seconds ? new Date(seconds * 1000) : undefined;
}

/** Start próby z webhooka `customer.subscription.created`, chwila ze Stripe. */
export async function recordTrialStarted(tenantId: string, subscription: Stripe.Subscription): Promise<void> {
  if (!subscription.trial_start) return;
  await trackServer({
    tenantId,
    event: ANALYTICS_EVENTS.trialStarted,
    properties: subscription.trial_end
      ? { trial_days: Math.round((subscription.trial_end - subscription.trial_start) / 86400) }
      : {},
    setPersonProperties: { plan: 'trial' },
    // Okres próbny przysługuje raz dla danej firmy (regulamin).
    dedupeKey: tenantId,
    timestamp: fromUnix(subscription.trial_start),
  });
}

/** Czy firma wcześniej naprawdę zapłaciła. `paidBefore` zawęża do płatności sprzed tej chwili. */
async function hasRealPayment(tenantId: string, paidBefore?: string): Promise<boolean> {
  const admin = await createAdminClient();
  let query = admin
    .from('stripe_payments')
    .select('id')
    .eq('tenant_id', tenantId)
    .gt('amount_cents', 0)
    .in('status', REAL_PAYMENT_STATUSES);
  if (paidBefore) query = query.lt('paid_at', paidBefore);
  const { data, error } = await query.limit(1);
  if (error) throw new Error(`payment history read: ${error.code ?? 'unknown'}`);
  return (data?.length ?? 0) > 0;
}

/**
 * Prawdziwa płatność powyżej 0 zł. Flaga `first_payment` liczona po chwili płatności,
 * więc ponowienie starego webhooka po przyjściu kolejnej faktury daje tę samą odpowiedź.
 * Nieudany odczyt historii nie kasuje zdarzenia: płatność była, nie znamy tylko flagi.
 */
export async function recordPaymentSucceeded(input: {
  tenantId: string;
  stripeInvoiceId: string;
  amountPaidCents: number;
  paidAt: string;
}): Promise<void> {
  if (!(input.amountPaidCents > 0)) return;
  let firstPayment: boolean | null = null;
  try {
    firstPayment = !(await hasRealPayment(input.tenantId, input.paidAt));
  } catch (err) {
    logFailure('first_payment', err);
  }
  await trackServer({
    tenantId: input.tenantId,
    event: ANALYTICS_EVENTS.paymentSucceeded,
    properties: firstPayment === null ? {} : { first_payment: firstPayment },
    setPersonProperties: { plan: 'active' },
    dedupeKey: input.stripeInvoiceId,
    timestamp: input.paidAt,
  });
}

/**
 * Odejście z webhooka `customer.subscription.deleted`. Próba bez żadnej płatności to
 * trial_ended także przy nieudanym pierwszym obciążeniu: tej firmy nigdy nie było
 * wśród płacących. Dopiero po płatnościach powód ze Stripe rozdziela rezygnację
 * od nieudanych płatności (spór o płatność Stripe też kończy tą drugą drogą).
 */
export async function recordSubscriptionEnded(tenantId: string, subscription: Stripe.Subscription): Promise<void> {
  try {
    const neverPaid = Boolean(subscription.trial_start) && !(await hasRealPayment(tenantId));
    const stripeReason = subscription.cancellation_details?.reason;
    const paymentProblem = stripeReason === 'payment_failed' || stripeReason === 'payment_disputed';

    let event = ANALYTICS_EVENTS.subscriptionCanceled as
      | typeof ANALYTICS_EVENTS.subscriptionCanceled
      | typeof ANALYTICS_EVENTS.paymentChurn
      | typeof ANALYTICS_EVENTS.trialEnded;
    let reason: ChurnReason = 'canceled';
    if (neverPaid) {
      event = ANALYTICS_EVENTS.trialEnded;
      reason = 'trial_no_payment';
    } else if (paymentProblem) {
      event = ANALYTICS_EVENTS.paymentChurn;
      reason = 'payment_failed';
    }

    await trackServer({
      tenantId,
      event,
      properties: { reason, ...(neverPaid ? { converted: false } : {}) },
      setPersonProperties: { plan: 'canceled' },
      dedupeKey: subscription.id,
      timestamp: fromUnix(subscription.ended_at ?? subscription.canceled_at),
    });
  } catch (err) {
    logFailure('subscription end', err);
  }
}
