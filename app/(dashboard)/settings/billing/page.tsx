import {
  RiAlertLine,
  RiCheckboxCircleLine,
  RiShieldLine,
  RiSparklingLine,
  type RemixiconComponentType,
} from '@remixicon/react';

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { formatSettingsDate } from '@/components/settings/finora/format-date';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { paymentFailureAdvice } from '@/lib/billing/payment-failure';
import { PRICE_PER_MONTH, PRICE_PER_MONTH_WITH_NET, TRIAL_DAYS } from '@/lib/billing/pricing';
import {
  buildBlikDisclosure,
  isBlikAvailable,
  trialPaymentHint,
  trialPaymentMethodLabel,
  trialPaymentRetryHint,
} from '@/lib/billing/trial-payment';
import { isStripeConfigured } from '@/lib/stripe/client';
import {
  getActiveSubscription,
  getLatestPaymentFailureReason,
  isInTrial,
  trialDaysRemaining,
  type ActiveSubscription,
} from '@/lib/stripe/subscription';
import { plural } from '@/lib/i18n/plural';
import { getPageContext } from '@/lib/supabase/page-context';
import { cn } from '@/lib/utils';

import { BlikTerms } from './_components/blik-terms';
import { PlanCards } from './_components/plan-cards';
import { PortalButton } from './_components/portal-button';

export const dynamic = 'force-dynamic';

/**
 * Zakładka „Abonament” (plan P14, bez odpowiednika w Finorze) — sekcje
 * i wiersze ustawień Finory: komunikaty w `Alert`, plan i daty jako wiersze
 * `Field` (etykieta i opis po lewej, wartość po prawej).
 */

interface SearchParams {
  checkout?: 'success' | 'canceled';
  error?: string;
}

const fmtDate = formatSettingsDate;

function fmtPlan(plan: ActiveSubscription['plan']): string {
  // Plan roczny nie jest już sprzedawany (decyzja z 1 października 2026);
  // etykieta zostaje dla subskrypcji założonych wcześniej.
  return plan === 'monthly' ? `Miesięczny (${PRICE_PER_MONTH})` : 'Roczny (plan wycofany)';
}

type Tone = 'success' | 'warning' | 'danger' | 'default';

function statusLabel(status: ActiveSubscription['status']): {
  label: string;
  tone: Tone;
} {
  switch (status) {
    case 'trialing':
      return { label: 'Trial', tone: 'success' };
    case 'active':
      return { label: 'Aktywna', tone: 'success' };
    case 'past_due':
      return { label: 'Płatność opóźniona', tone: 'warning' };
    case 'unpaid':
      return { label: 'Nieopłacona', tone: 'danger' };
    case 'canceled':
      return { label: 'Anulowana', tone: 'danger' };
    case 'incomplete':
    case 'incomplete_expired':
      return { label: 'Niedokończona', tone: 'warning' };
    case 'paused':
      return { label: 'Wstrzymana', tone: 'warning' };
    default:
      return { label: status, tone: 'default' };
  }
}

// Kolory odznak i komunikatów jak w Finorze (`bg-green-600/10 text-green-800`…).
const TONE_BADGE: Record<Tone, string | undefined> = {
  success: 'bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400',
  warning: 'bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400',
  danger: 'bg-red-600/10 text-red-600 dark:bg-red-400/10 dark:text-red-400',
  default: undefined,
};

const TONE_ALERT: Record<Tone, string | undefined> = {
  success: 'border-none bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400',
  warning: 'border-none bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400',
  danger: undefined,
  default: undefined,
};

const TONE_ALERT_TEXT: Record<Tone, string | undefined> = {
  success: 'text-green-800 dark:text-green-400/80',
  warning: 'text-amber-800 dark:text-amber-400/80',
  danger: undefined,
  default: undefined,
};

const ERROR_MESSAGES: Record<string, string> = {
  'not-configured':
    'Stripe nie jest skonfigurowany. Skontaktuj się z administratorem.',
  forbidden:
    'Tylko właściciel lub admin organizacji może zarządzać subskrypcją.',
  unexpected: 'Coś poszło nie tak. Spróbuj ponownie za chwilę.',
  'tenant-not-found': 'Nie znaleziono organizacji.',
  'plan-unavailable': 'Ten plan nie jest już dostępny. Wybierz plan miesięczny.',
  'mfa-required':
    'Zmiany w płatnościach wymagają weryfikacji dwuetapowej. Włącz ją w Ustawieniach → Bezpieczeństwo.',
  'statement-required':
    'Zaznacz oświadczenie pod ceną (zamówienie i akceptacja Regulaminu), żeby przejść do płatności.',
};

export default async function BillingPage(props: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await props.searchParams;
  const ctx = await getPageContext();

  const stripeConfigured = isStripeConfigured();
  const subscription = stripeConfigured
    ? await getActiveSubscription(ctx.tenantId).catch(() => null)
    : null;
  // Przyczyna tylko do podpowiedzi: jej brak daje tekst ogólny, nie błąd strony.
  const paymentFailureReason =
    subscription?.status === 'past_due' || subscription?.status === 'unpaid'
      ? await getLatestPaymentFailureReason(ctx.tenantId).catch(() => null)
      : null;

  const canManage = ctx.role === 'owner' || ctx.role === 'admin';
  const errorMsg = params.error ? ERROR_MESSAGES[params.error] : null;

  return (
    <FieldGroup>
      <div>
        <FieldLabel>Subskrypcja i rozliczenia</FieldLabel>
        <FieldDescription>
          Zarządzaj planem, metodą płatności i fakturami. Płatności obsługuje Stripe.
        </FieldDescription>
      </div>

      {/* Status banery */}
      {params.checkout === 'success' ? (
        <Banner
          icon={RiCheckboxCircleLine}
          tone="success"
          title="Subskrypcja aktywna"
          description="Dziękujemy! Trial 30 dni właśnie się rozpoczął. Pierwsza płatność dopiero po jego zakończeniu."
        />
      ) : null}
      {params.checkout === 'canceled' ? (
        <Banner
          icon={RiAlertLine}
          tone="warning"
          title="Subskrypcja niedokończona"
          description={`Płatność nie została dokończona, żadne pieniądze nie zostały pobrane. Możesz spróbować ponownie. ${trialPaymentRetryHint()}`.trim()}
        />
      ) : null}
      {errorMsg ? (
        <Banner
          icon={RiAlertLine}
          tone="danger"
          title="Błąd"
          description={errorMsg}
        />
      ) : null}

      {!stripeConfigured ? (
        <Banner
          icon={RiShieldLine}
          tone="warning"
          title="Stripe nie skonfigurowany"
          description={
            'Aby włączyć subskrypcje, ustaw STRIPE_SECRET_KEY, STRIPE_PRICE_MONTHLY i STRIPE_PRICE_ANNUAL w env vars (roczny nie jest sprzedawany, ale mapowanie cen Stripe wciąż go wymaga). Po wdrożeniu odśwież stronę.'
          }
        />
      ) : null}

      {!canManage ? (
        <Banner
          icon={RiShieldLine}
          tone="default"
          title="Brak uprawnień do edycji"
          description="Subskrypcją zarządza właściciel lub admin organizacji. Możesz zobaczyć stan, ale nie zmienić planu."
        />
      ) : null}

      {/* Active subscription view */}
      {subscription ? (
        <ActiveSubscriptionSection
          subscription={subscription}
          canManage={canManage}
          paymentFailureReason={paymentFailureReason}
        />
      ) : stripeConfigured ? (
        // Brak subskrypcji + Stripe OK = pokaż plan selection
        <>
          <Banner
            icon={RiSparklingLine}
            tone="success"
            title="30 dni za darmo"
            description={`Wybierz plan. Podajesz ${trialPaymentMethodLabel('biernik')}, ale pierwsza płatność dopiero po ${TRIAL_DAYS} dniach trialu. Anulujesz, kiedy chcesz.`}
          />

          {canManage ? (
            <PlanCards
              blikDisclosure={isBlikAvailable() ? buildBlikDisclosure() : null}
              paymentHint={trialPaymentHint()}
            />
          ) : null}
        </>
      ) : null}
    </FieldGroup>
  );
}

/** Kiedy BLIK dodany w portalu zostanie obciążony pierwszy raz. */
function blikNextCharge(subscription: ActiveSubscription, inTrial: boolean): string {
  if (subscription.cancel_at_period_end) {
    return `tylko jeśli wznowisz subskrypcję przed ${fmtDate(subscription.current_period_end)}`;
  }
  if (subscription.status === 'past_due') return 'zaległa kwota, przy najbliższej próbie pobrania';
  if (subscription.status === 'unpaid') return 'zaległa kwota, gdy opłacisz fakturę';
  return fmtDate(inTrial ? subscription.trial_end : subscription.current_period_end);
}

function ActiveSubscriptionSection({
  subscription,
  canManage,
  paymentFailureReason,
}: {
  subscription: ActiveSubscription;
  canManage: boolean;
  paymentFailureReason: string | null;
}) {
  const status = statusLabel(subscription.status);
  const inTrial = isInTrial(subscription);
  const trialLeft = trialDaysRemaining(subscription);
  const failureAdvice = paymentFailureAdvice(paymentFailureReason, subscription.status);
  // Portal pozwala dodać BLIK, a Stripe wymaga warunków przed kodem także przy formularzu
  // hostowanym. Mail po odmowie prowadzi tu, na stronę z przyciskiem. Wycofany plan roczny
  // zostaje bez warunków: zgoda mówi o płatnościach co miesiąc.
  const blikTerms =
    canManage && subscription.plan === 'monthly' && isBlikAvailable() ? buildBlikDisclosure() : null;

  return (
    <>
      <Separator />

      <Field orientation="responsive">
        <FieldContent>
          <div className="flex flex-wrap items-center gap-2">
            <FieldLabel>Bieżący plan</FieldLabel>
            <Badge variant={TONE_BADGE[status.tone] ? 'default' : 'secondary'} className={TONE_BADGE[status.tone]}>
              {status.label}
            </Badge>
            {subscription.cancel_at_period_end ? (
              <Badge variant="outline">
                Anulowana, wygasa {fmtDate(subscription.current_period_end)}
              </Badge>
            ) : null}
          </div>
          <FieldDescription>{fmtPlan(subscription.plan)}</FieldDescription>
        </FieldContent>
        {canManage ? <PortalButton blikStatementVersion={blikTerms?.version ?? null} /> : null}
      </Field>

      {blikTerms ? (
        <BlikTerms
          title="Zmieniasz metodę płatności na BLIK?"
          rows={[
            { label: 'Przy dodaniu BLIK-a płacisz', value: blikTerms.dueToday },
            { label: 'Następna płatność', value: blikNextCharge(subscription, inTrial) },
            { label: 'Potem', value: blikTerms.cycle },
          ]}
          banks={blikTerms.banks}
          consent={blikTerms.consent}
        />
      ) : null}

      {inTrial && trialLeft !== null ? (
        <StatRow
          label="Trial kończy się za"
          value={`${trialLeft} ${plural(trialLeft, ['dzień', 'dni', 'dni'])}`}
          sublabel={fmtDate(subscription.trial_end)}
          tone={trialLeft <= 3 ? 'warning' : 'default'}
        />
      ) : (
        <StatRow
          label="Następne odnowienie"
          value={fmtDate(subscription.current_period_end)}
          sublabel={
            subscription.cancel_at_period_end
              ? 'Subskrypcja wygaśnie po tej dacie'
              : 'Pobierzemy płatność automatycznie z Twojej metody płatności'
          }
        />
      )}
      <StatRow
        label="Plan"
        value={subscription.plan === 'monthly' ? 'Miesięczny' : 'Roczny'}
        sublabel={
          subscription.plan === 'monthly'
            ? PRICE_PER_MONTH_WITH_NET
            : 'plan wycofany'
        }
      />
      <StatRow
        label="Okres bieżący"
        value={fmtDate(subscription.current_period_start)}
        sublabel={`do ${fmtDate(subscription.current_period_end)}`}
      />

      {subscription.status === 'past_due' || subscription.status === 'unpaid' ? (
        <Banner
          icon={RiAlertLine}
          tone="warning"
          title="Płatność nie została pobrana"
          description={[failureAdvice.reason, failureAdvice.action].filter(Boolean).join(' ')}
        />
      ) : null}
    </>
  );
}

function Banner({
  icon: Icon,
  tone,
  title,
  description,
}: {
  icon: RemixiconComponentType;
  tone: Tone;
  title: string;
  description: string;
}) {
  return (
    <Alert
      role={tone === 'danger' ? 'alert' : 'status'}
      variant={tone === 'danger' ? 'destructive' : 'default'}
      className={TONE_ALERT[tone]}
    >
      <Icon aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className={TONE_ALERT_TEXT[tone]}>{description}</AlertDescription>
    </Alert>
  );
}

function StatRow({
  label,
  value,
  sublabel,
  tone = 'default',
}: {
  label: string;
  value: string;
  sublabel?: string;
  tone?: 'default' | 'warning';
}) {
  return (
    <Field orientation="responsive">
      <FieldContent>
        <FieldLabel>{label}</FieldLabel>
        {sublabel ? <FieldDescription>{sublabel}</FieldDescription> : null}
      </FieldContent>
      <span
        className={cn(
          'text-sm font-medium',
          tone === 'warning' && 'text-amber-700 dark:text-amber-400',
        )}
      >
        {value}
      </span>
    </Field>
  );
}
