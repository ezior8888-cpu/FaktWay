import { isPublicApiEnabled } from '@/lib/api/v1/availability';
import type { invoiceSubmitSucceeded, webhookEventEmitted } from '@/lib/jobs/events';
import type { JobContext } from '@/lib/jobs/registry';
import { createAdminClient } from '@/lib/supabase/admin';
import { DELIVERY_TICK_LIMIT, dispatchWebhookDeliveries } from '@/lib/webhooks/dispatch';
import { buildWebhookEvent } from '@/lib/webhooks/payloads';

/**
 * Joby webhooków publicznego API (krok 7.1, część 3, 00187).
 * Rejestracja pg-boss: `lib/jobs/handlers/webhooks.ts`.
 *
 * Webhooki działają tylko przy włączonej fladze `publicApiEnabled`: każdy job
 * zaczyna od niej i przy `false` kończy się bez zapytań do bazy i bez sieci.
 *
 * PONOWIENIE OD ZERA (worker wykonuje cały handler jeszcze raz):
 * - odczyt webhooków i treści: tylko odczyt;
 * - `webhook_create_deliveries`: UNIQUE (webhook, zdarzenie) + `ON CONFLICT DO
 *   NOTHING`, identyfikator zdarzenia stały, więc ponowienie nie tworzy drugiej
 *   dostawy i nie wysyła drugi raz;
 * - pierwsza próba: tylko dostaw utworzonych w tym przebiegu; gdy przebieg
 *   padnie po utworzeniu, dostawy czekają jako `pending` i bierze je cron
 *   `cron.webhooks-deliver` (co minutę);
 * - próba i zapis wyniku: dzierżawa w bazie (`webhook_claim_deliveries`),
 *   numer próby zapisany przy przejęciu, spóźniony wynik odrzucony.
 */

type EmittedData = Parameters<typeof webhookEventEmitted.create>[0];
type SucceededData = Pick<Parameters<typeof invoiceSubmitSucceeded.create>[0], 'tenantId' | 'invoiceId'>;

export async function runWebhookEventFanOut(data: EmittedData, { logger }: JobContext) {
  if (!(await isPublicApiEnabled())) return { skipped: 'api_disabled' as const };
  const db = createAdminClient();

  // Najpierw tani odczyt: większość firm nie ma webhooków, wtedy bez odczytu faktury.
  const { data: hooks, error: hooksError } = await db
    .from('webhook_endpoints')
    .select('id')
    .eq('tenant_id', data.tenantId)
    .is('disabled_at', null)
    .contains('events', [data.type])
    .limit(1);
  if (hooksError) throw new Error(`webhooks: odczyt webhooków firmy nieudany (${hooksError.code ?? 'bez kodu'})`);
  if (!hooks || hooks.length === 0) return { skipped: 'no_webhooks' as const };

  const event = await buildWebhookEvent(db, data);
  if (!event) return { skipped: 'not_eligible' as const };

  const { data: created, error: createError } = await db.rpc('webhook_create_deliveries', {
    p_tenant_id: data.tenantId,
    p_event_type: event.type,
    p_event_id: event.eventId,
    p_occurred_at: event.occurredAt,
    p_data: event.data,
  });
  if (createError) throw new Error(`webhooks: zapis dostaw nieudany (${createError.code ?? 'bez kodu'})`);
  const deliveryIds = ((created ?? []) as unknown[]).map(String);
  if (deliveryIds.length === 0) return { created: 0, eventId: event.eventId };

  // Pierwsza próba od razu (bez czekania na cron). Błąd tu niczego nie gubi:
  // dostawy są zapisane i należne, więc weźmie je następny przebieg crona.
  try {
    const summary = await dispatchWebhookDeliveries(db, { deliveryIds, limit: deliveryIds.length });
    return { created: deliveryIds.length, eventId: event.eventId, ...summary };
  } catch (error) {
    logger.warn('webhooks: pierwsza próba nieudana, dostawy czekają na cron', {
      eventId: event.eventId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { created: deliveryIds.length, eventId: event.eventId, deferred: true as const };
  }
}

/** Trzecia kolejka `invoice/submit.succeeded`: faktura przyjęta w KSeF → `invoice.ksef_accepted`. */
export function runInvoiceAcceptedWebhook(data: SucceededData, ctx: JobContext) {
  return runWebhookEventFanOut({ tenantId: data.tenantId, type: 'invoice.ksef_accepted', entityId: data.invoiceId }, ctx);
}

/** `cron.webhooks-deliver` (co minutę): należne dostawy, w tym ponowienia. */
export async function runWebhookDeliveryTick(_ctx: JobContext) {
  if (!(await isPublicApiEnabled())) return { skipped: 'api_disabled' as const };
  return dispatchWebhookDeliveries(createAdminClient(), { limit: DELIVERY_TICK_LIMIT });
}
