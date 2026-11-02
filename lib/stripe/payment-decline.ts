/**
 * Kod odmowy nieudanego obciążenia. Zdarzenie `invoice.payment_failed` w acacia
 * niesie tylko identyfikator PaymentIntent, a przyczyna leży w
 * `last_payment_error.decline_code` (np. `recurring_not_supported_by_bank`).
 *
 * Przyczyna jest dodatkiem do stanu i maila, więc awaria odczytu niczego nie
 * zatrzymuje: płatność zapisze się jako nieudana, a mail pójdzie z tekstem ogólnym,
 * który też każe zmienić metodę płatności. Ponowienie webhooka odczyta kod jeszcze raz.
 */
import * as Sentry from '@sentry/nextjs';

import { getStripe } from './client';

/** Webhook ma odpowiedzieć szybko, a ten odczyt nie jest warunkiem jego powodzenia. */
const STRIPE_READ_OPTIONS = { timeout: 3_000, maxNetworkRetries: 0 } as const;

export async function readPaymentDeclineCode(
  paymentIntentId: string | null,
): Promise<string | null> {
  if (!paymentIntentId) return null;
  try {
    const paymentIntent = await getStripe().paymentIntents.retrieve(
      paymentIntentId, {}, STRIPE_READ_OPTIONS,
    );
    const error = paymentIntent.last_payment_error;
    return error?.decline_code ?? error?.code ?? null;
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: 'billing.payment_failed.decline_lookup' },
      extra: { paymentIntentId },
    });
    return null;
  }
}
