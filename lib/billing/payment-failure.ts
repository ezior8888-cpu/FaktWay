/**
 * Co powiedzieć klientowi po nieudanej płatności za subskrypcję.
 *
 * Wejście to `stripe_payments.failure_reason`: kod odmowy Stripe albo tekst błędu
 * finalizacji. Klient widzi tylko kody z tej listy (kody BLIK z dokumentacji
 * Stripe; szczegółowe przychodzą dzięki wersji odczytu w `lib/stripe/payment-decline.ts`).
 * Reszta dostaje tekst ogólny: surowy kod nic nie mówi, a przy kartach
 * Stripe zakazuje podawania niektórych powodów (np. `lost_or_stolen_card`).
 *
 * `willRetry`: czy Stripe ma szansę pobrać płatność kolejną próbą. Przy banku bez
 * BLIK-a cyklicznego nie ma, więc tekst nie może obiecywać ponownej próby.
 */

export interface PaymentFailureAdvice {
  reason: string | null;
  action: string;
  willRetry: boolean;
}

/** Klient odnajdzie to w panelu: mail prowadzi na tę samą stronę. */
const CHANGE_METHOD_PATH = 'w Ustawieniach → Abonament kliknij „Zarządzaj subskrypcją”';

const GENERIC_ADVICE: PaymentFailureAdvice = {
  reason: null,
  action:
    'Spróbujemy pobrać płatność ponownie w ciągu najbliższych dni. Żeby uniknąć przerwy w usłudze, ' +
    `zmień metodę płatności: ${CHANGE_METHOD_PATH}.`,
  willRetry: true,
};

const ADVICE_BY_DECLINE_CODE: Record<string, PaymentFailureAdvice> = {
  recurring_not_supported_by_bank: {
    reason: 'Twój bank nie obsługuje płatności cyklicznych BLIK.',
    action:
      `Zmień metodę płatności: ${CHANGE_METHOD_PATH} i wybierz kartę albo BLIK w banku, który obsługuje ` +
      'płatności cykliczne. Kolejne próby z obecną metodą się nie udadzą.',
    willRetry: false,
  },
  insufficient_funds: {
    reason: 'Na koncie zabrakło środków.',
    action: `Uzupełnij środki, a spróbujemy ponownie, albo zmień metodę płatności: ${CHANGE_METHOD_PATH}.`,
    willRetry: true,
  },
  customer_declined: {
    reason: 'Płatność nie została zatwierdzona w aplikacji banku.',
    action: `Zatwierdź kolejną próbę w aplikacji banku albo zmień metodę płatności: ${CHANGE_METHOD_PATH}.`,
    willRetry: true,
  },
  payment_limit_exceeded: {
    reason: 'Płatność przekracza limit BLIK ustawiony w banku.',
    action: `Zmień limit w aplikacji banku, a spróbujemy ponownie, albo zmień metodę płatności: ${CHANGE_METHOD_PATH}.`,
    willRetry: true,
  },
  partner_generic_decline: {
    reason: 'Bank odrzucił płatność.',
    action: `Skontaktuj się z bankiem albo zmień metodę płatności: ${CHANGE_METHOD_PATH}.`,
    willRetry: true,
  },
};

export function paymentFailureAdvice(failureReason: string | null): PaymentFailureAdvice {
  if (failureReason && Object.hasOwn(ADVICE_BY_DECLINE_CODE, failureReason)) {
    return ADVICE_BY_DECLINE_CODE[failureReason];
  }
  return GENERIC_ADVICE;
}
