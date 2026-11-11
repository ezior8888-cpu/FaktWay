import { describe, expect, it } from 'vitest';

import { RetryAfterError } from '@/lib/jobs/errors';
import { decideRetry, MAX_PAUSE_CHAIN_MS, MAX_WAIT_RETRIES } from '@/lib/jobs/retry';
import { KSEF_MAX_RETRIES, getKsefRetryDelay } from '@/lib/jobs/retry-schedule';
import { parseDurationMs } from '@/lib/jobs/duration';
import { describeSendAttemptFailure } from '@/lib/ksef/send-attempt-ledger';

/**
 * L1a, przegląd przed PR: budżet łańcucha pauz po 429 (`MAX_PAUSE_CHAIN_MS`,
 * doba) ma być WYJŚCIEM przy trwałej blokadzie MF. Pierwsza wersja po dobie
 * wpuszczała pauzę do gałęzi odczekań (pauza ma `countsAsAttempt: false`),
 * kasowała `__pauseSince` i otwierała nową dobę — onExhausted po ok. 31 dniach,
 * a faktura stała w `queued` bez komunikatu. Pętla poniżej przenosi stan
 * między wykonaniami tak jak `run-job.ts` (`__attempt`, `__waits`, `__pauseSince`).
 */

const HOUR = 3_600_000;
const policy = { maxRetries: KSEF_MAX_RETRIES, getDelayMs: (a: number) => parseDurationMs(getKsefRetryDelay(a)) };
const pause = () => new RetryAfterError('KSeF: firma w pauzie po 429', HOUR, { pause: true, countsAsAttempt: false });

describe('budżet łańcucha pauz po 429 (L1a)', () => {
  it('trwały 429 co godzinę: onExhausted najpóźniej po dobie + KSEF_MAX_RETRIES+1 wykonaniach, bez zużycia odczekań', () => {
    let now = Date.UTC(2026, 10, 9, 9);
    const start = now;
    let attempt = 0;
    let waits = 0;
    let pauseSince: number | null = null;
    let runs = 0;
    for (; runs < 1_000; runs += 1) {
      const d = decideRetry(pause(), attempt, policy, waits, { sinceMs: pauseSince, nowMs: now });
      if (d.action === 'exhausted') break;
      attempt = d.nextAttempt;
      waits = d.nextWaits;
      pauseSince = d.nextPauseSince ?? null; // run-job kasuje klucz, gdy decyzja go nie niesie
      now += d.delayMs;
    }
    expect(runs).toBeLessThan(1_000);
    expect(now - start).toBeLessThanOrEqual(MAX_PAUSE_CHAIN_MS + (KSEF_MAX_RETRIES + 1) * HOUR);
    expect(waits).toBe(0);
    expect(attempt).toBe(KSEF_MAX_RETRIES);
  });

  it('w budżecie pauza nie zużywa ani próby, ani odczekań — także przy wyczerpanych __waits i ostatniej próbie', () => {
    const now = Date.UTC(2026, 10, 9, 9);
    const d = decideRetry(pause(), KSEF_MAX_RETRIES, policy, MAX_WAIT_RETRIES, { sinceMs: now - (MAX_PAUSE_CHAIN_MS - 1), nowMs: now });
    expect(d).toMatchObject({ action: 'retry', nextAttempt: KSEF_MAX_RETRIES, nextWaits: MAX_WAIT_RETRIES, nextPauseSince: now - (MAX_PAUSE_CHAIN_MS - 1) });
  });

  it('po budżecie pauza zużywa próbę i zachowuje początek łańcucha (kolejne pauzy też zużywają próby)', () => {
    const now = Date.UTC(2026, 10, 9, 9);
    const since = now - MAX_PAUSE_CHAIN_MS;
    expect(decideRetry(pause(), 2, policy, 3, { sinceMs: since, nowMs: now })).toMatchObject({
      action: 'retry', nextAttempt: 3, nextWaits: 3, nextPauseSince: since,
    });
    expect(decideRetry(pause(), KSEF_MAX_RETRIES, policy, 0, { sinceMs: since, nowMs: now })).toEqual({
      action: 'exhausted', reason: 'attempts-exhausted',
    });
  });

  it('dziennik prób: pauza w budżecie to `waiting`, po budżecie zwykła porażka z kodem limitu KSeF', () => {
    const now = Date.now();
    expect(describeSendAttemptFailure(pause(), 'pause', 0, { sinceMs: now - HOUR, nowMs: now }).status).toBe('waiting');
    const after = describeSendAttemptFailure(pause(), 'pause', 0, { sinceMs: now - MAX_PAUSE_CHAIN_MS, nowMs: now });
    expect(after.status).toBe('failed');
    expect(after.error_code).not.toBeNull();
  });
});
