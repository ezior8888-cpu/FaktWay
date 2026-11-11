import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

import { attemptDelivery, type AttemptOutcome, type ClaimedDelivery } from '@/lib/webhooks/deliver';
import { httpsTransport, resolveHost } from '@/lib/webhooks/network';

/**
 * Wysyłka przejętych dostaw webhooków (worker, klucz serwisowy, 00187).
 *
 * 1. `webhook_claim_deliveries`: baza wybiera należne dostawy włączonych
 *    webhooków (SKIP LOCKED, dzierżawa 120 s, najwyżej 5 na webhook naraz)
 *    i od razu zapisuje numer próby. Dostawa po sukcesie albo w toku nie
 *    wraca, więc równoległy przebieg nie wyśle jej drugi raz.
 * 2. Próba (`attemptDelivery`), najwyżej 10 naraz.
 * 3. `webhook_record_attempt`: wynik i dziennik (kod, błąd, czas). Harmonogram
 *    ponowień, stan „nieudana” po 6 próbach i wyłączenie webhooka po 20
 *    nieudanych dostawach z rzędu liczy baza w tej samej transakcji.
 *
 * Ponowienie od zera: zapis wyniku, który nie dojdzie (awaria bazy), zostawia
 * dostawę z dzierżawą; po 120 s przejmie ją kolejny przebieg jako następną
 * próbę. Odbiorca mógł wtedy dostać to zdarzenie dwa razy, dlatego treść ma
 * stały `id` (nagłówek `FaktWay-Event-Id`) do odrzucania powtórek.
 */

export const DELIVERY_TICK_LIMIT = 30;
const CONCURRENCY = 10;

export interface DispatchSummary {
  claimed: number;
  succeeded: number;
  failed: number;
  /** Zapis wyniku nie doszedł albo był spóźniony (dzierżawa przejęta). */
  unrecorded: number;
}

export interface DispatchDeps {
  attempt?: (delivery: ClaimedDelivery) => Promise<AttemptOutcome>;
}

const defaultAttempt = (delivery: ClaimedDelivery) =>
  attemptDelivery(delivery, { resolve: resolveHost, transport: httpsTransport });

async function recordOutcome(db: SupabaseClient, delivery: ClaimedDelivery, outcome: AttemptOutcome): Promise<boolean> {
  const { data, error } = await db.rpc('webhook_record_attempt', {
    p_delivery_id: delivery.delivery_id,
    p_attempt: delivery.attempt,
    p_succeeded: outcome.succeeded,
    p_status_code: outcome.statusCode,
    p_error: outcome.succeeded ? null : outcome.error,
    p_duration_ms: outcome.durationMs,
    p_counts_toward_disable: outcome.succeeded ? true : outcome.countsTowardDisable,
  });
  if (error) {
    Sentry.captureException(new Error('webhooks: zapis wyniku dostawy nieudany'), {
      tags: { area: 'webhooks', step: 'record' },
      extra: { deliveryId: delivery.delivery_id, code: error.code },
    });
    return false;
  }
  const applied = typeof data === 'object' && data !== null && (data as { applied?: unknown }).applied === true;
  if (applied && (data as { webhook_disabled?: unknown }).webhook_disabled === true) {
    Sentry.captureMessage('webhooks: webhook wyłączony po 20 nieudanych dostawach z rzędu', {
      level: 'info',
      tags: { area: 'webhooks', kind: 'auto-disabled' },
      extra: { tenantId: delivery.tenant_id, webhookId: delivery.webhook_id },
    });
  }
  return applied;
}

/**
 * Należne dostawy (`deliveryIds` pominięte: przebieg crona) albo tylko podane
 * (pierwsza próba zaraz po utworzeniu). Błąd przejęcia rzuca: nic nie wysłano.
 */
export async function dispatchWebhookDeliveries(
  db: SupabaseClient,
  options: { deliveryIds?: string[]; limit?: number } = {},
  deps: DispatchDeps = {},
): Promise<DispatchSummary> {
  const attempt = deps.attempt ?? defaultAttempt;
  const { data, error } = await db.rpc('webhook_claim_deliveries', {
    p_delivery_ids: options.deliveryIds ?? null,
    p_limit: options.limit ?? DELIVERY_TICK_LIMIT,
  });
  if (error) throw new Error(`webhooks: przejęcie dostaw nieudane (${error.code ?? 'bez kodu'})`);
  const claimed = (data ?? []) as ClaimedDelivery[];

  const summary: DispatchSummary = { claimed: claimed.length, succeeded: 0, failed: 0, unrecorded: 0 };
  let signingReported = false;
  const queue = [...claimed];
  const worker = async () => {
    for (let delivery = queue.shift(); delivery; delivery = queue.shift()) {
      // Jedna dostawa nie zatrzymuje reszty: nieoczekiwany wyjątek zostawia ją
      // z dzierżawą (po 120 s weźmie ją cron jako następną próbę).
      try {
        const outcome = await attempt(delivery);
        if (outcome.succeeded) summary.succeeded += 1;
        else summary.failed += 1;
        if (!outcome.succeeded && outcome.error === 'signing_unavailable' && !signingReported) {
          signingReported = true;
          Sentry.captureMessage('webhooks: brak klucza do odszyfrowania sekretu (WEBHOOK_SECRETS_ENCRYPTION_KEY)', {
            level: 'error',
            tags: { area: 'webhooks', kind: 'signing-unavailable' },
          });
        }
        if (!(await recordOutcome(db, delivery, outcome))) summary.unrecorded += 1;
      } catch (error) {
        summary.unrecorded += 1;
        Sentry.captureException(error, { tags: { area: 'webhooks', step: 'deliver' }, extra: { deliveryId: delivery.delivery_id } });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, claimed.length) }, worker));
  return summary;
}
