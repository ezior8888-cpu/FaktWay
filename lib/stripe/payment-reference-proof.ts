/**
 * Prove the signed invoice payment's full PI/Charge identity against current
 * Stripe objects before publishing it to the local financial tables.
 */
import type Stripe from 'stripe';

import { getStripe } from './client';
import {
  ReconciliationRequiredWebhookError,
  RetryablePreEffectWebhookError,
} from './webhook-errors';

const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9]{8,}$/;
const CHARGE_ID = /^ch_[A-Za-z0-9]{8,}$/;
const CUSTOMER_ID = /^cus_[A-Za-z0-9]{8,}$/;

type References = {
  paymentIntentId: string | null;
  chargeId: string | null;
};

function referenceId(
  value: unknown,
  pattern: RegExp,
  objectType: string,
): string | null {
  if (value === null || value === undefined) return null;
  const id = typeof value === 'string'
    ? value
    : (typeof value === 'object' && !Array.isArray(value) &&
        value !== null && 'object' in value && value.object === objectType &&
        'id' in value ? value.id : null);
  if (typeof id !== 'string' || !pattern.test(id)) {
    throw new ReconciliationRequiredWebhookError(
      'Stripe payment proof contains an invalid ' + objectType + ' reference',
    );
  }
  return id;
}

async function retrievePaymentIntent(id: string): Promise<Stripe.PaymentIntent> {
  try {
    return await getStripe().paymentIntents.retrieve(id);
  } catch {
    throw new RetryablePreEffectWebhookError(
      'financial_object_lookup_failed',
      'Stripe PaymentIntent lookup failed before local payment effects',
    );
  }
}

async function retrieveCharge(id: string): Promise<Stripe.Charge> {
  try {
    return await getStripe().charges.retrieve(id);
  } catch {
    throw new RetryablePreEffectWebhookError(
      'financial_object_lookup_failed',
      'Stripe Charge lookup failed before local payment effects',
    );
  }
}

/**
 * The signed invoice proves which payment attempt it reports. Fresh PI and
 * Charge objects must prove each other and the same Customer and amount.
 * Unsupported or contradictory shapes stay for operator reconciliation.
 *
 * `paymentMethodType` (np. `card`, `blik`) nie jest częścią dowodu: nic tu nie
 * zależy od metody, a faktura za abonament potrzebuje go do formy płatności.
 */
export async function verifyPaidInvoicePaymentReferences(
  invoice: Stripe.Invoice,
  signed: References,
): Promise<{ paymentIntentId: string; chargeId: string; paymentMethodType?: string }> {
  let paymentIntentId = signed.paymentIntentId;
  let chargeId = signed.chargeId;
  if (!paymentIntentId && !chargeId) {
    throw new ReconciliationRequiredWebhookError(
      'Stripe paid invoice has no payment identity to verify',
    );
  }

  let charge: Stripe.Charge | null = null;
  if (!paymentIntentId && chargeId) {
    charge = await retrieveCharge(chargeId);
    paymentIntentId = referenceId(
      charge.payment_intent, PAYMENT_INTENT_ID, 'payment_intent',
    );
  }
  if (!paymentIntentId) {
    throw new ReconciliationRequiredWebhookError(
      'Stripe Charge has no PaymentIntent for invoice payment proof',
    );
  }

  const paymentIntent = await retrievePaymentIntent(paymentIntentId);
  if (paymentIntent.id !== paymentIntentId || paymentIntent.status !== 'succeeded') {
    throw new ReconciliationRequiredWebhookError(
      'Stripe PaymentIntent is not the paid invoice identity',
    );
  }
  const latestChargeId = referenceId(
    paymentIntent.latest_charge, CHARGE_ID, 'charge',
  );
  if (!latestChargeId || (chargeId && chargeId !== latestChargeId)) {
    throw new ReconciliationRequiredWebhookError(
      'Stripe invoice Charge does not match the successful PaymentIntent',
    );
  }
  chargeId = latestChargeId;
  charge ??= await retrieveCharge(chargeId);
  if (charge.id !== chargeId ||
      referenceId(charge.payment_intent, PAYMENT_INTENT_ID, 'payment_intent') !==
        paymentIntentId ||
      charge.status !== 'succeeded' || charge.paid !== true ||
      charge.disputed !== false || charge.amount_refunded !== 0) {
    throw new ReconciliationRequiredWebhookError(
      'Stripe Charge does not prove an undisputed paid invoice',
    );
  }

  const invoiceCustomerId = referenceId(invoice.customer, CUSTOMER_ID, 'customer');
  const intentCustomerId = referenceId(
    paymentIntent.customer, CUSTOMER_ID, 'customer',
  );
  const chargeCustomerId = referenceId(charge.customer, CUSTOMER_ID, 'customer');
  if (!invoiceCustomerId || intentCustomerId !== invoiceCustomerId ||
      chargeCustomerId !== invoiceCustomerId ||
      typeof invoice.livemode !== 'boolean' ||
      paymentIntent.livemode !== invoice.livemode ||
      charge.livemode !== invoice.livemode ||
      !Number.isSafeInteger(invoice.amount_paid) || invoice.amount_paid <= 0 ||
      paymentIntent.amount_received !== invoice.amount_paid ||
      charge.amount_captured !== invoice.amount_paid ||
      paymentIntent.currency !== invoice.currency ||
      charge.currency !== invoice.currency) {
    throw new ReconciliationRequiredWebhookError(
      'Stripe paid invoice, PaymentIntent and Charge disagree',
    );
  }

  return {
    paymentIntentId,
    chargeId,
    paymentMethodType: charge.payment_method_details?.type,
  };
}