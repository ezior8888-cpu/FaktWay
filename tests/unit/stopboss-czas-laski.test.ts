import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// G1 (plan „zero zgubionych faktur”, ryzyko M9): na SIGTERM worker woła
// `stopBoss()`, a ten `stop({ graceful: true })` bez limitu czasu. pg-boss
// 12.27.0 czeka wtedy domyślnie 30 s (`dist/index.js:174`), a kontener ma
// krótszy czas łaski i po nim dostaje SIGKILL w środku jobu. Job zostaje
// w stanie `active`, aż nadzór nowego workera wykryje heartbeat (ok. 3–4 min),
// a w logu nie ma śladu, co przerwano.

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('pg-boss', () => ({
  PgBoss: class {
    start = mocks.start;
    stop = mocks.stop;
    on = vi.fn();
  },
}));
vi.mock('@/lib/jobs/config', () => ({ getJobsDatabaseUrl: () => 'postgres://fixture', getJobsSchema: () => 'pgboss' }));

/** Czas łaski z karty G1 (Coolify 10 s = domyślny `docker stop`). Niepotwierdzony w repo: pytanie do Bartosza w PR. */
const CZAS_LASKI_MS = 10_000;
/** `flushWorkerSentry()` po `stopBoss()` w `worker.ts` (domyślne 2000 ms, `lib/jobs/sentry.ts`). */
const FLUSH_SENTRY_MS = 2_000;
/** Na `process.exit` i spóźnione timery zostawiamy sekundę. */
const ZAPAS_NA_WYJSCIE_MS = 1_000;
const NAJPOZNIEJ_MS = CZAS_LASKI_MS - FLUSH_SENTRY_MS - ZAPAS_NA_WYJSCIE_MS;

const JOB_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `stop()` z pg-boss 12.27.0 w skrócie: graceful czeka w pętli co 500 ms, aż
 * aktywne handlery skończą albo minie `timeout` (domyślnie 30 s, minimum 1 s,
 * `dist/index.js:174-175, 208-211`), potem `failWip` i `db.close`.
 */
function stopJakPgBoss12(jobMs: number) {
  return async (options: { timeout?: number } = {}) => {
    const timeout = Math.max(options.timeout ?? 30_000, 1_000);
    const stoppingOn = Date.now();
    while (Date.now() - stoppingOn < timeout && Date.now() - stoppingOn < jobMs) {
      await sleep(500);
    }
    await sleep(50); // failWip + db.close
  };
}

async function wystartowanyBoss() {
  const boss = await import('@/lib/jobs/boss');
  await boss.startBoss();
  return boss;
}

/** Odpala `stopBoss()` i przesuwa sztuczny zegar; zwraca, czy zdążył się skończyć. */
async function stopPo(stopBoss: () => Promise<void>, ms: number) {
  let skonczone = false;
  const wynik = stopBoss().then(() => {
    skonczone = true;
  });
  await vi.advanceTimersByTimeAsync(ms);
  return { skonczone, wynik };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.start.mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('stopBoss a czas łaski kontenera (G1)', () => {
  it('SIGTERM w trakcie 60-sekundowego jobu: stopBoss kończy się przed czasem łaski', async () => {
    mocks.stop.mockImplementation(stopJakPgBoss12(JOB_MS));
    const { stopBoss } = await wystartowanyBoss();

    const { skonczone } = await stopPo(stopBoss, NAJPOZNIEJ_MS);

    expect(skonczone).toBe(true);
  });

  it('pg-boss zawieszony w zamykaniu (failWip czeka na połączenie): stopBoss i tak wraca przed czasem łaski', async () => {
    mocks.stop.mockImplementation(() => new Promise(() => {}));
    const { stopBoss } = await wystartowanyBoss();

    const { skonczone } = await stopPo(stopBoss, NAJPOZNIEJ_MS);

    expect(skonczone).toBe(true);
  });

  it('przekazuje pg-boss jawny limit z zapasem na pętlę co 500 ms, failWip i zamknięcie połączeń', async () => {
    mocks.stop.mockImplementation(stopJakPgBoss12(0));
    const { stopBoss } = await wystartowanyBoss();

    const { wynik } = await stopPo(stopBoss, NAJPOZNIEJ_MS);
    await wynik;

    expect(mocks.stop).toHaveBeenCalledTimes(1);
    const opcje = mocks.stop.mock.calls[0]?.[0] as { graceful?: boolean; close?: boolean; timeout?: number };
    expect(opcje).toMatchObject({ graceful: true, close: true });
    expect(opcje.timeout).toBeGreaterThanOrEqual(1_000);
    // 500 ms to krok pętli czekania pg-boss; reszta zapasu na failWip i db.close.
    expect(opcje.timeout! + 500).toBeLessThanOrEqual(NAJPOZNIEJ_MS - 1_000);
  });

  it('budżet zamykania w kodzie mieści się w czasie łaski i zgadza z flushem Sentry', async () => {
    const { WORKER_SHUTDOWN_BUDGET: b } = await import('@/lib/jobs/boss');

    // Zmieniasz świadomie: dopiero gdy Bartosz potwierdzi czas łaski w Coolify.
    expect(b.containerGraceMs).toBe(CZAS_LASKI_MS);
    expect(b.drainMs + 500).toBeLessThan(b.hardStopMs);
    expect(b.hardStopMs + b.sentryFlushMs + ZAPAS_NA_WYJSCIE_MS).toBeLessThanOrEqual(b.containerGraceMs);

    const sentry = readFileSync(join(process.cwd(), 'lib/jobs/sentry.ts'), 'utf8');
    expect(sentry).toMatch(new RegExp(`flushWorkerSentry\\(timeoutMs = ${b.sentryFlushMs}\\)`));
    const worker = readFileSync(join(process.cwd(), 'lib/jobs/worker.ts'), 'utf8');
    expect(worker).toMatch(/await stopBoss\(\);\s*\}\s*finally\s*\{\s*await flushWorkerSentry\(\);\s*process\.exit/);
  });

  it('loguje, które joby zostały przerwane: kolejka, id i od ilu sekund biegły', async () => {
    mocks.stop.mockImplementation(stopJakPgBoss12(JOB_MS));
    const { trackActiveJobs } = await import('@/lib/jobs/active-jobs');
    const { stopBoss } = await wystartowanyBoss();

    const handler = trackActiveJobs('invoice.submit.requested', () => sleep(JOB_MS).then(() => []));
    void handler([{ id: 'job-dlugi-0001' }]);
    await vi.advanceTimersByTimeAsync(3_000);

    const { wynik } = await stopPo(stopBoss, NAJPOZNIEJ_MS);
    await wynik;

    const ostrzezenia = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    const przerwane = ostrzezenia.find((l) => l.includes('job-dlugi-0001'));
    expect(przerwane).toBeDefined();
    expect(przerwane).toContain('invoice.submit.requested');
    expect(przerwane).toMatch(/przerwan/);
  });

  it('po stopBoss handler, który dalej biegnie, nie stawia nowego pg-boss w zamykanym procesie', async () => {
    // Po failWip handler biegnie dalej (nie słucha job.signal) aż do process.exit,
    // a ponowienie w run-job.ts woła startBoss(). Nowa instancja w umierającym
    // procesie miałaby harmonogram, nadzór i wysłałaby drugie ponowienie joba,
    // który pg-boss już sam ponawia.
    mocks.stop.mockImplementation(stopJakPgBoss12(JOB_MS));
    const { stopBoss, startBoss } = await wystartowanyBoss();
    expect(mocks.start).toHaveBeenCalledTimes(1);

    const { wynik } = await stopPo(stopBoss, NAJPOZNIEJ_MS);
    await wynik;

    await expect(startBoss()).rejects.toThrow(/zamyka/);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it('drugi SIGTERM w trakcie zamykania dostaje to samo zamykanie, bez drugiego stop()', async () => {
    mocks.stop.mockImplementation(stopJakPgBoss12(JOB_MS));
    const { stopBoss } = await wystartowanyBoss();

    const pierwszy = stopBoss();
    await vi.advanceTimersByTimeAsync(1_000);
    const drugi = stopBoss();
    await vi.advanceTimersByTimeAsync(NAJPOZNIEJ_MS);
    await Promise.all([pierwszy, drugi]);

    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it('job skończony przed zamknięciem nie trafia do logu przerwanych', async () => {
    mocks.stop.mockImplementation(stopJakPgBoss12(0));
    const { trackActiveJobs } = await import('@/lib/jobs/active-jobs');
    const { stopBoss } = await wystartowanyBoss();

    const handler = trackActiveJobs('fixture.queue', () => sleep(100).then(() => []));
    void handler([{ id: 'job-krotki-0001' }]);
    await vi.advanceTimersByTimeAsync(200);

    const { wynik } = await stopPo(stopBoss, NAJPOZNIEJ_MS);
    await wynik;

    const wszystko = [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]
      .map((c) => String(c[0]))
      .join('\n');
    expect(wszystko).not.toContain('job-krotki-0001');
  });
});
