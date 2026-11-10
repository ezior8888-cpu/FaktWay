/**
 * Joby, które ten proces właśnie wykonuje (G1).
 *
 * pg-boss nie podaje z zewnątrz id aktywnych jobów (`getWipData()` zwraca
 * tylko ich liczbę), a przy zamykaniu workera trzeba zapisać w logu, co
 * przerwano. `worker.ts` owija tym handler każdej kolejki, a `stopBoss()`
 * czyta listę po upływie limitu.
 *
 * Wpis znika, gdy handler paczki wróci. pg-boss przy przerwaniu oblewa całą
 * paczkę (`failWip`), także joby, które wrapper już przerobił, więc paczka
 * jest tu jednym wpisem na każdy job aż do końca handlera.
 */

export interface ActiveJob {
  queue: string;
  id: string;
  runningSeconds: number;
}

const active = new Map<string, { queue: string; startedAt: number }>();

export function trackActiveJobs<J extends { id: string }, R>(
  queue: string,
  handler: (jobs: J[]) => Promise<R>,
): (jobs: J[]) => Promise<R> {
  return async (jobs) => {
    const startedAt = Date.now();
    for (const job of jobs) active.set(job.id, { queue, startedAt });
    try {
      return await handler(jobs);
    } finally {
      for (const job of jobs) active.delete(job.id);
    }
  };
}

export function listActiveJobs(now: number = Date.now()): ActiveJob[] {
  return [...active].map(([id, { queue, startedAt }]) => ({
    queue,
    id,
    runningSeconds: Math.round((now - startedAt) / 1000),
  }));
}
