/**
 * Entry point workera pg-boss (Etap 7 migracji Hetzner).
 *
 * Uruchomienie: `pnpm worker:dev` lokalnie / target `worker` w Dockerfile
 * na app-1 (drugi kontener z tego samego obrazu, obok apki Next).
 *
 * Co robi:
 *   1. startuje pg-boss (schemat `pgboss` w Postgresie na db-1),
 *   2. tworzy kolejki zarejestrowanych jobów (QUEUE_POLICY z boss.ts: siatka na
 *      joby zabite w trakcie; retry merytoryczny liczy run-job.ts),
 *   3. rejestruje handlery przez wrapper retry (parytet z Inngest, `run-job.ts`),
 *   4. planuje crony TYLKO dla zarejestrowanych kolejek cron.*,
 *   5. wystawia healthcheck HTTP (Coolify) na WORKER_HEALTH_PORT (def. 8080),
 *   6. graceful shutdown na SIGTERM/SIGINT.
 */

import { createServer } from 'node:http';

import { ensureQueue, startBoss, stopBoss, enableWorkerRole } from './boss';
import { assertPgBossWorkerBackend, getWorkerHealthPort } from './config';
import { createJobLogger } from './logger';
import { CRON_JOBS, RETIRED_CRON_QUEUES, RETIRED_QUEUES, SMOKE_QUEUE } from './queues';
import { getRegisteredJobs, registerJob } from './registry';
import { wrapHandler } from './run-job';
import { workOptionsFor } from './work-options';
import { startProcessMetrics } from '@/lib/observability/process-metrics';
import {
  flushWorkerSentry,
  initWorkerSentry,
  reportWorkerStartupFailure,
} from './sentry';

// Rejestracje paczek (side-effect imports) — Etapy 3-6 planu.
import './handlers/package-a';
import './handlers/package-b';
import './handlers/package-c';
import './handlers/package-d';
import './handlers/flo-tick';
import './handlers/ops-heartbeat';

const log = createJobLogger('worker');

/** Kolejka smoke — weryfikacja fundamentu (Etap 1/2) i żywotności workera. */
registerJob<{ ping?: number }>({
  queue: SMOKE_QUEUE,
  handler: async (data, { logger }) => {
    logger.info('smoke: odebrano job', data);
    return { pong: data.ping ?? null, at: Date.now() };
  },
});

async function main(): Promise<void> {
  // Fail-closed (krok 5): bez jawnego pgboss worker nie startuje wcale —
  // błąd trafia do Sentry przez reportWorkerStartupFailure niżej.
  assertPgBossWorkerBackend();
  log.info('Worker startuje (JOBS_BACKEND=pgboss)');
  if (initWorkerSentry()) {
    log.info('Sentry: alerty z jobów włączone');
  } else {
    log.warn('Sentry: alerty z jobów WYŁĄCZONE (brak SENTRY_DSN albo NODE_ENV≠production)');
  }
  startProcessMetrics({ process: 'worker' });

  // Harmonogram i nadzór pg-boss prowadzi TYLKO worker (AUD-88).
  enableWorkerRole();
  const boss = await startBoss();
  boss.on('error', (err) => log.error('pg-boss error', err));

  const defs = getRegisteredJobs();
  const registeredQueues = new Set(defs.map((d) => d.queue));

  for (const def of defs) {
    await ensureQueue(def.queue);
    await boss.work(def.queue, workOptionsFor(def), wrapHandler(def));
    log.info(`kolejka aktywna: ${def.queue}`);
  }

  // Wycofane crony zdejmujemy zawsze — inaczej wpis w `pgboss.schedule`
  // z poprzedniego startu dalej produkuje joby bez workera (AUD-118).
  for (const queue of RETIRED_CRON_QUEUES) {
    await boss.unschedule(queue);
  }

  // Martwe kolejki (PR 4b cyklu życia): nikt nie wysyła, nikt nie czyta —
  // usuwamy, żeby nie mylić przy przeglądzie `pgboss.queue`. Fail-soft:
  // brak kolejki albo błąd nie zatrzymuje startu workera.
  for (const queue of RETIRED_QUEUES) {
    if (registeredQueues.has(queue)) continue;
    try {
      await boss.deleteQueue(queue);
      log.info(`usunięto martwą kolejkę: ${queue}`);
    } catch (err) {
      log.warn(`nie usunięto kolejki ${queue}`, err);
    }
  }

  let scheduled = 0;
  // WORKER_DISABLE_SCHEDULES=true: tryb testowy (lokalny worker przez tunel)
  // oraz pierwsza faza cutoveru — worker obsługuje kolejki, ale nie prowadzi
  // cronów, bo w tym czasie robi to jeszcze poprzedni backend.
  //
  // Samo pominięcie `schedule()` NIE wystarcza: wpisy z wcześniejszego startu
  // zostają w tabeli `pgboss.schedule` i pg-boss podejmie je natychmiast po
  // starcie dowolnej instancji, niezależnie od tej flagi. Dlatego przy
  // wyłączonych cronach kasujemy je jawnie — inaczej flaga daje złudzenie
  // bezpieczeństwa. (Sprawdzone bólem: przypadkowo uruchomiony worker
  // przepracował noc na cronach, mimo że nikt ich nie planował świadomie.)
  const schedulesDisabled = process.env.WORKER_DISABLE_SCHEDULES === 'true';
  if (schedulesDisabled) {
    for (const cron of CRON_JOBS) {
      await boss.unschedule(cron.queue);
    }
    log.warn(
      `WORKER_DISABLE_SCHEDULES=true — crony wyłączone, wyczyszczono ${CRON_JOBS.length} wpisów harmonogramu`,
    );
  }
  for (const cron of CRON_JOBS) {
    if (schedulesDisabled) break;
    if (!registeredQueues.has(cron.queue)) continue;
    await boss.schedule(cron.queue, cron.cron, {}, cron.tz ? { tz: cron.tz } : {});
    scheduled++;
  }
  log.info(
    `Gotowy: ${defs.length} kolejek, ${scheduled}/${CRON_JOBS.length} cronów zaplanowanych`,
  );

  const startedAt = Date.now();
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          queues: defs.length,
          crons: scheduled,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(getWorkerHealthPort(), () =>
    log.info(`healthcheck: http://0.0.0.0:${getWorkerHealthPort()}/health`),
  );

  const shutdown = async (signal: string) => {
    log.info(`${signal} — graceful shutdown...`);
    server.close();
    try {
      await stopBoss();
    } finally {
      await flushWorkerSentry();
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('Worker padł przy starcie', err);
  reportWorkerStartupFailure(err);
  void flushWorkerSentry().finally(() => process.exit(1));
});
