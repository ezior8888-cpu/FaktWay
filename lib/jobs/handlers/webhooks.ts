/**
 * Paczka W: 3 joby webhooków publicznego API (krok 7.1 planu kompletnej
 * aplikacji, część 3, 00187). Runnery: `lib/jobs/runners/webhooks.ts`.
 *
 * - `webhooks.event.emitted`: zdarzenie z aplikacji (koszt ze skrzynki,
 *   wpłata) → dostawy → pierwsza próba.
 * - `invoice.submit.succeeded.webhook`: trzecia kolejka zdarzenia wyniku
 *   wysyłki do KSeF → „faktura przyjęta w KSeF”. Wysyłka faktury bez zmian.
 * - `cron.webhooks-deliver`: co minutę należne dostawy (ponowienia).
 *
 * Ponowienia DOSTAW prowadzi baza (1 min, 5 min, 30 min, 2 h, 12 h; 00187),
 * nie pg-boss. Ponowienia jobów są tylko na chwilowy błąd bazy: dwie dla
 * zdarzeń (dostawa ma UNIQUE, więc powtórka nie dubluje), zero dla crona
 * (ponowieniem jest następna minuta).
 */

import { z } from 'zod';

import { WebhookEventEmittedSchema } from '../events';
import { registerJob, type JobContext } from '../registry';
import { runInvoiceAcceptedWebhook, runWebhookDeliveryTick, runWebhookEventFanOut } from '../runners/webhooks';

/** Pierwsza próba idzie w tym jobie (do 10 s na adres), więc kilka zdarzeń naraz. */
const EVENT_LOCAL_CONCURRENCY = 5;

registerJob<z.infer<typeof WebhookEventEmittedSchema>>({
  queue: 'webhooks.event.emitted',
  schema: WebhookEventEmittedSchema,
  maxRetries: 2,
  localConcurrency: EVENT_LOCAL_CONCURRENCY,
  handler: (data, ctx) => runWebhookEventFanOut(data, ctx),
});

const SubmitSucceededForWebhookSchema = z.object({
  tenantId: z.string().uuid('tenantId musi być UUID'),
  invoiceId: z.string().uuid('invoiceId musi być UUID'),
});

registerJob<z.infer<typeof SubmitSucceededForWebhookSchema>>({
  queue: 'invoice.submit.succeeded.webhook',
  schema: SubmitSucceededForWebhookSchema,
  maxRetries: 2,
  localConcurrency: EVENT_LOCAL_CONCURRENCY,
  handler: (data, ctx) => runInvoiceAcceptedWebhook(data, ctx),
});

registerJob<Record<string, never>>({
  queue: 'cron.webhooks-deliver',
  maxRetries: 0,
  handler: (_data, ctx: JobContext) => runWebhookDeliveryTick(ctx),
});
