import * as Sentry from '@sentry/nextjs';

import { isPublicApiEnabled } from '@/lib/api/v1/availability';
import { sendJobEvent } from '@/lib/jobs/enqueue';
import { webhookEventEmitted } from '@/lib/jobs/events';
import type { WebhookEventType } from '@/lib/webhooks/types';

/**
 * Zlecenie zdarzenia webhooka (krok 7.1, część 3) z miejsca, w którym rzecz
 * się stała: job skrzynki po utworzeniu kosztu, akcja „Zapłacone” po zapisie
 * wpłaty. Resztę (webhooki firmy, treść, dostawy, wysyłka) robi job
 * `webhooks.event.emitted` w workerze.
 *
 * - Flaga `publicApiEnabled` wyłączona (dziś): nic się nie zleca, zero zapytań
 *   poza odczytem flagi z pamięci podręcznej.
 * - FAIL-OPEN: awaria kolejki nie cofa kosztu ani wpłaty i nie wywraca joba
 *   ani akcji; zostaje zgłoszenie do Sentry. Zgubione w ten sposób zdarzenie
 *   program klienta odczyta przez API (lista faktur i kosztów).
 * - Ponowna emisja tego samego zdarzenia jest bezpieczna: identyfikator
 *   zdarzenia jest stały (`webhookEventId`), a dostawa ma UNIQUE w bazie.
 */
export async function emitWebhookEvent(input: { tenantId: string; type: WebhookEventType; entityId: string }): Promise<void> {
  try {
    if (!(await isPublicApiEnabled())) return;
    await sendJobEvent(webhookEventEmitted.create(input));
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: 'webhooks', step: 'emit', type: input.type },
      extra: { tenantId: input.tenantId, entityId: input.entityId },
    });
  }
}
