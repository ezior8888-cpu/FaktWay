import { describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));

import '@/lib/jobs/handlers/package-d';
import { getRegisteredJobs } from '@/lib/jobs/registry';
import { workOptionsFor } from '@/lib/jobs/work-options';

/**
 * AUD-36: worker brał z każdej kolejki jeden job naraz (`localConcurrency`
 * domyślnie 1), więc wysyłka do KSeF szła po jednej fakturze dla
 * WSZYSTKICH firm, a skrzynki — firma po firmie. Równoległość ustawia teraz
 * definicja joba; limit per firma/NIP dalej pilnuje `groupConcurrency`.
 */

const def = (queue: string) => getRegisteredJobs().find((d) => d.queue === queue)!;

describe('równoległość kolejek KSeF', () => {
  it.each([
    ['invoice.submit.requested', 4],
    ['invoice.upo.requested', 3],
    ['inbox.poll.tenant', 3],
  ])('%s: co najmniej %s naraz, z limitem per grupa', (queue, min) => {
    const options = workOptionsFor(def(queue));
    expect(options.localConcurrency).toBeGreaterThanOrEqual(min);
    expect(options.groupConcurrency).toBeGreaterThanOrEqual(1);
    expect(options.perJobResults).toBe(true);
  });

  it('wysyłka: 5 slotów razem, najwyżej 2 na firmę (L1a)', () => {
    // L1a (08.11.2026): MF liczy limity na parę (NIP, IP), a cała platforma
    // wysyła z jednego adresu, więc jedna firma nie może zająć wszystkich
    // slotów (wcześniej `groupConcurrency` 100). Liczba slotów razem (5) bez
    // zmian — decyzja Bartosza z 03.11: podnosi ją sesja 15 planu skalowania
    // po pomiarze.
    const options = workOptionsFor(def('invoice.submit.requested'));
    expect(options.groupConcurrency).toBe(2);
    expect(options.localConcurrency).toBe(5);
  });

  it('kolejka bez ustawienia — jak dotąd jeden worker', () => {
    expect(workOptionsFor({})).toEqual({ batchSize: 1, perJobResults: true });
  });
});

describe('wycofane crony (AUD-118)', () => {
  it('odświeżanie widoków nie jest już planowane, worker zdejmuje stary wpis', async () => {
    const { CRON_JOBS, RETIRED_CRON_QUEUES } = await import('@/lib/jobs/queues');
    expect(CRON_JOBS.map((c) => c.queue)).not.toContain('cron.refresh-materialized-views');
    expect(RETIRED_CRON_QUEUES).toContain('cron.refresh-materialized-views');
  });
});
