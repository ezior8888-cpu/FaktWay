/**
 * Aktywność klienta dla harmonogramu skrzynki (FaktWay 1.0, decyzja 4). Woła ją
 * aplikacja web po sprawdzeniu członkostwa; zapis robi RPC tylko dla serwera.
 *
 * Dwa limity, celowo oba:
 *   - `lib/rate-limit` (Redis albo pamięć procesu): oszczędza bazę przy zwykłym
 *     odświeżaniu strony,
 *   - warunek w `note_ksef_inbox_activity` (00160): trzyma po restarcie procesu
 *     i przy kilku replikach, kiedy pamięć procesu jest pusta albo osobna.
 */

import { checkRateLimit } from '@/lib/rate-limit';

import { noteInboxActivity, type InboxActivityResult } from './inbox-schedule-db';
import { INBOX_ACTIVITY_NOTE_SECONDS, INBOX_NUDGE_MIN_SECONDS } from './inbox-schedule';

export type InboxPollRequest =
  | InboxActivityResult
  | { status: 'no_ksef'; retryAfterSeconds: 0 };

/** Przyspiesza termin firmy, najwyżej raz na 5 minut. Błąd bazy rzuca. */
export async function requestInboxPoll(tenantId: string): Promise<InboxPollRequest> {
  const limit = await checkRateLimit({
    bucket: 'ksef_inbox_check',
    identifier: tenantId,
    limit: 1,
    windowSeconds: INBOX_NUDGE_MIN_SECONDS,
  });
  if (!limit.allowed) return { status: 'too_soon', retryAfterSeconds: limit.retryAfter };
  const result = await noteInboxActivity(tenantId, { requestPoll: true });
  return result ?? { status: 'no_ksef', retryAfterSeconds: 0 };
}

/** Wejście do Skrzynki: to samo co przycisk, ale błąd nie może psuć strony. */
export async function requestInboxPollOnVisit(tenantId: string): Promise<void> {
  try {
    await requestInboxPoll(tenantId);
  } catch (error) {
    console.error('[skrzynka] przyspieszenie terminu po wejściu nieudane', error instanceof Error ? error.message : String(error));
  }
}

/** Sufit pamięci: starsze wpisy wypadają, co kosztuje najwyżej jeden dodatkowy zapis. */
const MEMORY_MAX_ENTRIES = 20_000;
const lastNoted = new Map<string, number>();

export function inboxActivityMemorySize(): number {
  return lastNoted.size;
}

/**
 * Znacznik „ktoś z firmy jest aktywny”, wołany z layoutu panelu: najwyżej raz
 * na godzinę na firmę i proces. Do okna 24 h ta dokładność wystarcza, a każde
 * wejście na panel nie płaci zapisem. Nieudany zapis nie psuje strony i może się
 * powtórzyć przy następnym wejściu.
 */
export async function noteTenantActivityThrottled(tenantId: string, nowMs: number = Date.now()): Promise<void> {
  const last = lastNoted.get(tenantId);
  if (last !== undefined && nowMs - last < INBOX_ACTIVITY_NOTE_SECONDS * 1000) return;
  lastNoted.delete(tenantId);
  lastNoted.set(tenantId, nowMs);
  if (lastNoted.size > MEMORY_MAX_ENTRIES) {
    const oldest = lastNoted.keys().next().value;
    if (oldest !== undefined) lastNoted.delete(oldest);
  }
  try {
    await noteInboxActivity(tenantId, { requestPoll: false });
  } catch (error) {
    lastNoted.delete(tenantId);
    console.error('[skrzynka] zapis aktywności nieudany', error instanceof Error ? error.message : String(error));
  }
}
