/**
 * Dzwonek w aplikacji: 3 kolejki (plan kompletnej aplikacji, krok 8.1,
 * część 2, 00188, i część 3, 00197). Runnery: `lib/jobs/runners/app-notifications.ts`.
 *
 * - `invoice.submit.succeeded.bell`: trzecia kolejka zdarzenia „faktura
 *   przyjęta w KSeF” (obok powiadomienia i Offline24).
 * - `invoice.submit.failed.bell`: trzecia kolejka zdarzenia „wysyłka nieudana”;
 *   wpis tylko przy fakturze odrzuconej za treść.
 * - `invoice.payment.received.bell`: druga kolejka zdarzenia „wpłata zapisana”
 *   (obok pusha); „Otrzymana płatność” albo „Wpłata częściowa”.
 *
 * Pozostałe źródła dzwonka (nowa faktura zakupu ze skrzynki, termin podatku)
 * piszą wprost z istniejących jobów, fail-open (`publishAppNotification`).
 *
 * Ponowienia tylko na chwilowy błąd bazy: dwie, jak przy powiadomieniu
 * o wyniku wysyłki. Wpis ma UNIQUE, więc ponowienie od zera nie dubluje.
 */

import { z } from 'zod';

import { registerJob } from '../registry';
import {
  runAppNotificationInvoiceAccepted,
  runAppNotificationInvoiceRejected,
  runAppNotificationPaymentReceived,
} from '../runners/app-notifications';

const SubmitSucceededForBellSchema = z.object({
  tenantId: z.string().uuid('tenantId musi być UUID'),
  invoiceId: z.string().uuid('invoiceId musi być UUID'),
});

const SubmitFailedForBellSchema = z.object({
  tenantId: z.string().uuid('tenantId musi być UUID'),
  invoiceId: z.string().uuid('invoiceId musi być UUID'),
  error: z.string(),
  manualReconciliationRequired: z.boolean().optional(),
});

registerJob<z.infer<typeof SubmitSucceededForBellSchema>>({
  queue: 'invoice.submit.succeeded.bell',
  schema: SubmitSucceededForBellSchema,
  maxRetries: 2,
  handler: (data, ctx) => runAppNotificationInvoiceAccepted(data, ctx),
});

registerJob<z.infer<typeof SubmitFailedForBellSchema>>({
  queue: 'invoice.submit.failed.bell',
  schema: SubmitFailedForBellSchema,
  maxRetries: 2,
  handler: (data, ctx) => runAppNotificationInvoiceRejected(data, ctx),
});

// `paymentId` opcjonalny jak w typie zdarzenia (`invoicePaymentReceived`); bez niego runner kończy bez wpisu.
const PaymentReceivedForBellSchema = z.object({
  invoiceId: z.string().uuid('invoiceId musi być UUID'),
  paymentId: z.string().uuid('paymentId musi być UUID').optional(),
});

registerJob<z.infer<typeof PaymentReceivedForBellSchema>>({
  queue: 'invoice.payment.received.bell',
  schema: PaymentReceivedForBellSchema,
  maxRetries: 2,
  handler: (data, ctx) => runAppNotificationPaymentReceived(data, ctx),
});
