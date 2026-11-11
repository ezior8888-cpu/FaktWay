/**
 * Dzwonek w aplikacji: 2 kolejki (plan kompletnej aplikacji, krok 8.1,
 * część 2, 00188). Runnery: `lib/jobs/runners/app-notifications.ts`.
 *
 * - `invoice.submit.succeeded.bell`: trzecia kolejka zdarzenia „faktura
 *   przyjęta w KSeF” (obok powiadomienia i Offline24).
 * - `invoice.submit.failed.bell`: trzecia kolejka zdarzenia „wysyłka nieudana”;
 *   wpis tylko przy fakturze odrzuconej za treść.
 *
 * Pozostałe źródła dzwonka (nowa faktura zakupu ze skrzynki, termin podatku)
 * piszą wprost z istniejących jobów, fail-open (`publishAppNotification`).
 *
 * Ponowienia tylko na chwilowy błąd bazy: dwie, jak przy powiadomieniu
 * o wyniku wysyłki. Wpis ma UNIQUE, więc ponowienie od zera nie dubluje.
 */

import { z } from 'zod';

import { registerJob } from '../registry';
import { runAppNotificationInvoiceAccepted, runAppNotificationInvoiceRejected } from '../runners/app-notifications';

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
