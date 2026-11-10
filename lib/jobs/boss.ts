/**
 * Singleton klienta pg-boss (schemat `pgboss` w NASZYM Postgresie na db-1).
 *
 * Lazy init — moduł można importować w kodzie apki bez DATABASE_URL
 * (błąd dopiero przy realnym użyciu w trybie pgboss).
 */

import { PgBoss } from 'pg-boss';

import { listActiveJobs } from './active-jobs';
import { getJobsDatabaseUrl, getJobsSchema } from './config';
import { createJobLogger } from './logger';

const log = createJobLogger('boss');

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
  if (closed) {
    // Handler oblany przez failWip biegnie dalej do process.exit; nowa instancja
    // w umierającym procesie wysłałaby drugie ponowienie joba (G1).
    throw new Error('pg-boss zatrzymany: worker się zamyka, zadania przejmie następny proces');
  }
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

/**
 * Ile czasu ma zamknięcie workera po SIGTERM (G1, ryzyko M9).
 *
 * Po czasie łaski kontener dostaje SIGKILL. Gdy trafi w środek jobu, job
 * zostaje w pg-boss `active`, aż nadzór nowego workera wykryje brak heartbeatu
 * (`QUEUE_POLICY.heartbeatSeconds`, razem ok. 3–4 min), a w logu nie ma śladu,
 * co przerwano. Dlatego zamykamy się sami przed czasem łaski:
 *
 * - `drainMs`: tyle pg-boss czeka na aktywne joby; potem oznacza je jako
 *   nieudane (`failWip`: stan `retry`, start po `retryDelay`) i zamyka pulę.
 *   Sprawdza co 500 ms, a `failWip` i `db.close` idą już po limicie, stąd zapas.
 * - `hardStopMs`: twardy limit całego `stop()`. Kroki pg-boss przed i po
 *   czekaniu (`failWip` czeka na połączenie do 10 s) nie mają własnego limitu.
 * - `sentryFlushMs`: `flushWorkerSentry()` po `stopBoss()` w `worker.ts`
 *   (domyślny argument w `sentry.ts`).
 *
 * `containerGraceMs` = 10 s to domyślny `docker stop` i liczba z karty G1;
 * repo nie zapisuje, ile daje Coolify. Zmieniaj świadomie, po potwierdzeniu
 * (pilnuje `tests/unit/stopboss-czas-laski.test.ts`).
 */
export const WORKER_SHUTDOWN_BUDGET = {
  containerGraceMs: 10_000,
  sentryFlushMs: 2_000,
  hardStopMs: 7_000,
  drainMs: 5_000,
} as const;

let stopping: Promise<void> | null = null;
let closed = false;

/** Zamyka pg-boss w budżecie `WORKER_SHUTDOWN_BUDGET`; drugi sygnał dostaje to samo zamykanie. */
export function stopBoss(): Promise<void> {
  if (!stopping) {
    stopping = doStopBoss().finally(() => {
      stopping = null;
    });
  }
  return stopping;
}

async function doStopBoss(): Promise<void> {
  const boss = cached;
  if (!boss || !started) return;
  const { drainMs, hardStopMs } = WORKER_SHUTDOWN_BUDGET;

  const active = listActiveJobs();
  if (active.length > 0) {
    log.info(`zamykanie: czekam do ${drainMs / 1000} s na aktywne joby (${active.length})`);
  }

  const stopped = boss.stop({ graceful: true, close: true, timeout: drainMs }).then(
    () => ({ error: null }),
    (error: unknown) => ({ error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), hardStopMs);
  });

  try {
    const outcome = await Promise.race([stopped, deadline]);
    const left = listActiveJobs();
    if (outcome === 'deadline') {
      log.error(
        `pg-boss nie zamknął się w ${hardStopMs / 1000} s, wychodzimy bez niego: ` +
          'przerwane joby zostają active do wykrycia przez heartbeat nowego workera',
        { przerwane: left },
      );
      return;
    }
    if (left.length > 0) {
      log.warn(
        `przerwane przy zamykaniu (${left.length}): pg-boss oznaczył je jako nieudane, ` +
          `wrócą do kolejki po ${QUEUE_POLICY.retryDelay} s, jeśli zostały próby`,
        { przerwane: left },
      );
    }
    if (outcome.error) throw outcome.error;
  } finally {
    clearTimeout(timer);
    started = false;
    cached = null;
    closed = true;
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
