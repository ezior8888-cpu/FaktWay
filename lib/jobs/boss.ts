/**
 * Singleton klienta pg-boss (schemat `pgboss` w NASZYM Postgresie na db-1).
 *
 * Lazy init — moduł można importować w kodzie apki bez DATABASE_URL
 * (błąd dopiero przy realnym użyciu w trybie pgboss).
 */

import { PgBoss } from 'pg-boss';

import { getJobsDatabaseUrl, getJobsSchema } from './config';

let cached: PgBoss | null = null;
let started = false;
let workerRole = false;

/**
 * Proces workera prowadzi harmonogram cronów i nadzór pg-boss (wygaszanie,
 * heartbeaty, retry). Aplikacja web tylko wysyła zadania — z harmonogramem
 * i nadzorem tworzyła crony także wtedy, gdy worker leżał, a te piętrzyły się
 * bez odbiorcy (AUD-88). Wołane przez `worker.ts` przed `startBoss()`.
 */
export function enableWorkerRole(): void {
  workerRole = true;
}

export function getBoss(): PgBoss {
  if (!cached) {
    cached = new PgBoss({
      connectionString: getJobsDatabaseUrl(),
      schema: getJobsSchema(),
      application_name: workerRole ? 'faktflow-jobs' : 'faktflow-web',
      // Mała pula — worker to jeden proces; apka enqueue'uje krótkimi zapytaniami.
      max: 5,
      ...(workerRole ? {} : { schedule: false, supervise: false }),
    });
  }
  return cached;
}

/** Start (idempotentny) — wymagany przed send/work/schedule. */
export async function startBoss(): Promise<PgBoss> {
  const boss = getBoss();
  if (!started) {
    await boss.start();
    started = true;
  }
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (cached && started) {
    // graceful: dokończ aktywne joby (timeout wewnętrzny pg-boss).
    await cached.stop({ graceful: true, close: true });
    started = false;
    cached = null;
  }
}

/**
 * Zasady każdej kolejki (AUD-16).
 *
 * Retry po błędzie handlera robimy sami (`run-job.ts`, parytet z Inngest:
 * własny harmonogram, klasyfikacja błędów) — wrapper nie rzuca, więc retry
 * pg-boss nie dubluje naszego. Łapie za to to, czego wrapper nie widzi:
 * job porzucony, bo worker zginął (deploy, OOM). Heartbeat wykrywa martwego
 * workera po 2 min, zamiast czekać na wygaśnięcie; długie joby (kopia bazy,
 * eksporty) nie są przy tym ucinane po 15 min, bo limit czasu to 4 h.
 */
export const QUEUE_POLICY = {
  retryLimit: 2,
  retryDelay: 60,
  heartbeatSeconds: 120,
  expireInSeconds: 4 * 60 * 60,
} as const;

/** Tworzy kolejkę i dopisuje zasady także do już istniejącej (createQueue ich nie zmienia). */
export async function ensureQueue(name: string): Promise<void> {
  const boss = await startBoss();
  await boss.createQueue(name, QUEUE_POLICY);
  await boss.updateQueue(name, QUEUE_POLICY);
}
