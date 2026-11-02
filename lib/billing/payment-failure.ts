/**
 * Co powiedzieć klientowi po nieudanej płatności za subskrypcję.
 *
 * Wejście to `stripe_payments.failure_reason`: kod odmowy Stripe albo tekst błędu
 * finalizacji. Klient widzi tylko kody z tej listy (kody BLIK z dokumentacji
 * Stripe; szczegółowe przychodzą dzięki wersji odczytu w `lib/stripe/payment-decline.ts`).
 * Reszta dostaje tekst ogólny: surowy kod nic nie mówi, a przy kartach
 * Stripe zakazuje podawania niektórych powodów (np. `lost_or_stolen_card`).
 *
 * Tekst nie może obiecywać ponownej próby, której nie będzie: przy banku bez BLIK-a
 * cyklicznego kolejne próby się nie udadzą, a przy statusie `unpaid` Stripe już nie
 * pobiera (docs.stripe.com/billing/subscriptions/overview: „doesn't attempt payment”).
 * Mail wychodzi raz, po pierwszej odmowie, więc zna tylko kod; strona zna też status.
 */

import type { ActiveSubscription } from '@/lib/stripe/subscription';

import { BLIK_RECURRING_BANKS } from './trial-payment';

export interface PaymentFailureAdvice {
  reason: string | null;
  action: string;
}

/** Klient odnajdzie to w panelu: mail prowadzi na tę samą stronę. */
const PORTAL_PATH = 'w Ustawieniach → Abonament kliknij „Zarządzaj subskrypcją”';

const GENERIC_ADVICE: PaymentFailureAdvice = {
  reason: null,
  action:
    'Spróbujemy pobrać płatność ponownie w ciągu najbliższych dni. Żeby uniknąć przerwy w usłudze, ' +
    `zmień metodę płatności: ${PORTAL_PATH}.`,
};

/** Portal pozwala opłacić fakturę; sama nowa metoda nic nie zmienia, bo Stripe nie pobiera. */
const UNPAID_ACTION =
  `Kolejnych prób pobrania już nie będzie. Opłać zaległą fakturę: ${PORTAL_PATH}. ` +
  'Sama zmiana metody płatności jej nie opłaci.';

const ADVICE_BY_DECLINE_CODE: Record<string, PaymentFailureAdvice> = {
  recurring_not_supported_by_bank: {
    reason: 'Twój bank nie obsługuje płatności cyklicznych BLIK.',
    action:
      `Zmień metodę płatności: ${PORTAL_PATH} i wybierz kartę albo BLIK w jednym z banków: ` +
      `${BLIK_RECURRING_BANKS.join(', ')}. Kolejne próby z obecną metodą się nie udadzą.`,
  },
  insufficient_funds: {
    reason: 'Na koncie zabrakło środków.',
    action: `Uzupełnij środki, a spróbujemy ponownie, albo zmień metodę płatności: ${PORTAL_PATH}.`,
  },
  customer_declined: {
    reason: 'Płatność nie została zatwierdzona w aplikacji banku.',
    action: `Zatwierdź kolejną próbę w aplikacji banku albo zmień metodę płatności: ${PORTAL_PATH}.`,
  },
  payment_limit_exceeded: {
    reason: 'Płatność przekracza limit BLIK ustawiony w banku.',
    action: `Zmień limit w aplikacji banku, a spróbujemy ponownie, albo zmień metodę płatności: ${PORTAL_PATH}.`,
  },
  partner_generic_decline: {
    reason: 'Bank odrzucił płatność.',
    action: `Skontaktuj się z bankiem albo zmień metodę płatności: ${PORTAL_PATH}.`,
  },
};

export function paymentFailureAdvice(
  failureReason: string | null,
  subscriptionStatus?: ActiveSubscription['status'],
): PaymentFailureAdvice {
  const advice = failureReason && Object.hasOwn(ADVICE_BY_DECLINE_CODE, failureReason)
    ? ADVICE_BY_DECLINE_CODE[failureReason]
    : GENERIC_ADVICE;
  return subscriptionStatus === 'unpaid' ? { reason: advice.reason, action: UNPAID_ACTION } : advice;
}
