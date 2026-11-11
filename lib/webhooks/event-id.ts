import { createHash } from 'node:crypto';

import type { WebhookEventType } from '@/lib/webhooks/types';

/**
 * Identyfikator zdarzenia webhooka (`id` w treści i nagłówek `FaktWay-Event-Id`).
 *
 * UUID v5 (RFC 9562) z typu zdarzenia i identyfikatora obiektu, w stałej
 * przestrzeni nazw FaktWay. To samo zdarzenie (np. ta sama wpłata) ma zawsze
 * ten sam identyfikator, także przy ponownej emisji po awarii albo z crona
 * uzupełniającego skrzynkę. Na nim stoi UNIQUE (webhook_id, event_id) w
 * `webhook_deliveries` (00187), więc zdarzenie nie wyśle się drugi raz,
 * a odbiorca może po nim odrzucać powtórki.
 */

/** Przestrzeń nazw zdarzeń webhooków FaktWay (losowy UUID, stały na zawsze). */
const NAMESPACE = '25ca5528-357d-450e-9f00-c2d4a0342601';

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

export function webhookEventId(type: WebhookEventType, entityId: string): string {
  const digest = createHash('sha1')
    .update(uuidBytes(NAMESPACE))
    .update(`${type}:${entityId}`, 'utf8')
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50; // wersja 5
  digest[8] = (digest[8]! & 0x3f) | 0x80; // wariant RFC
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
