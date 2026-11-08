/**
 * Pomiar procesu Node (plan skalowania, sesja 23, CPU-12): web i worker co
 * interwał (domyślnie 60 s) zapisują do logu kontenera jedną linię JSON:
 *
 *   {"msg":"process.metrics","process":"web","elu":0.12,
 *    "loopDelayMs":{"p50":0.2,"p99":14.6,"max":41.3},
 *    "memMb":{"rss":270,"heapUsed":120,"heapLimit":2096},
 *    "timings":{"dashboard":{"n":40,"p50Ms":310,"p95Ms":900,"maxMs":1400}}}
 *
 * - `elu` — wykorzystanie pętli zdarzeń w interwale (0–1). Web to jeden
 *   proces Node, czyli jeden rdzeń: ELU blisko 1 znaczy, że proces nie
 *   nadąża, nawet gdy reszta serwera stoi.
 * - `loopDelayMs` — o ile spóźniały się timery pętli (p50/p99/max, bez
 *   10 ms taktu próbkowania); tyle czeka żądanie, zanim w ogóle zacznie być
 *   obsługiwane. Bezczynny proces: ok. 0.
 * - `memMb` — RSS, zajęta sterta i jej limit (`heap_size_limit`).
 * - `timings` — czasy z `recordTiming` (np. render Pulpitu), zerowane po
 *   każdej linii.
 *
 * Po przekroczeniu progu dochodzi linia `process.metrics.warn` z powodami
 * (`elu`, `loop`, `heap`). Odczyt: `docker logs <kontener> | grep process.metrics`.
 *
 * Domyślne ujście to `console.log`, nie `logger.info` — ten na produkcji nic
 * nie robi (`lib/observability/logger.ts`).
 */

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

import { takeTimingSummary } from '@/lib/observability/timings';

export type ProcessMetricsThresholds = {
  /** Wykorzystanie pętli zdarzeń w interwale (0–1). */
  elu: number;
  /** p99 opóźnienia pętli zdarzeń w ms. */
  loopDelayP99Ms: number;
  /** Zajęta sterta jako część limitu sterty (0–1). */
  heapRatio: number;
};

export const DEFAULT_PROCESS_METRICS_THRESHOLDS: ProcessMetricsThresholds = {
  elu: 0.7,
  loopDelayP99Ms: 200,
  heapRatio: 0.8,
};

export type ProcessMetricsOptions = {
  process: 'web' | 'worker';
  intervalMs?: number;
  sink?: (line: string) => void;
  thresholds?: Partial<ProcessMetricsThresholds>;
};

/** Jeden licznik na proces, także gdy moduł trafił do kilku paczek Next.js. */
const STATE_KEY = Symbol.for('faktway.observability.processMetrics');

const NS_PER_MS = 1e6;
/** Pusty histogram oddaje `min` ≈ 2^63 ns; powyżej godziny to nie pomiar. */
const MAX_SANE_NS = 3_600 * 1e9;
const BYTES_PER_MB = 1024 * 1024;
/**
 * Co ile ms histogram próbkuje pętlę. Próbka to odstęp między dwoma jego
 * taktami, czyli rozdzielczość + spóźnienie — rozdzielczość odejmujemy, żeby
 * bezczynny proces miał ok. 0, a nie 10 ms.
 */
const LOOP_RESOLUTION_MS = 10;

/** Spóźnienie pętli w ms ponad takt histogramu. */
function lateMs(ns: number): number {
  if (!Number.isFinite(ns) || ns <= 0 || ns > MAX_SANE_NS) return 0;
  return Math.max(0, Math.round((ns / NS_PER_MS - LOOP_RESOLUTION_MS) * 10) / 10);
}

function toMb(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MB);
}

function ratio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(Math.min(value, 1) * 1000) / 1000;
}

/**
 * Startuje pomiar i zwraca funkcję stop. Drugi start w tym samym procesie
 * nie uruchamia drugiego licznika — zwraca stop pierwszego.
 */
export function startProcessMetrics(options: ProcessMetricsOptions): () => void {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: () => void };
  const running = g[STATE_KEY];
  if (running) return running;

  const { process: processName, intervalMs = 60_000, sink = (line: string) => console.log(line) } = options;
  const thresholds = { ...DEFAULT_PROCESS_METRICS_THRESHOLDS, ...options.thresholds };

  const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  loopDelay.enable();
  let lastElu = performance.eventLoopUtilization();

  const tick = (): void => {
    try {
      // Delta od poprzedniego taktu, nie średnia od startu procesu.
      const currentElu = performance.eventLoopUtilization();
      const elu = ratio(performance.eventLoopUtilization(currentElu, lastElu).utilization);
      lastElu = currentElu;

      const loopDelayMs = {
        p50: lateMs(loopDelay.percentile(50)),
        p99: lateMs(loopDelay.percentile(99)),
        max: lateMs(loopDelay.max),
      };
      loopDelay.reset();

      const heap = getHeapStatistics();
      const memMb = {
        rss: toMb(process.memoryUsage.rss()),
        heapUsed: toMb(heap.used_heap_size),
        heapLimit: toMb(heap.heap_size_limit),
      };

      sink(
        JSON.stringify({
          msg: 'process.metrics',
          process: processName,
          elu,
          loopDelayMs,
          memMb,
          timings: takeTimingSummary(),
        }),
      );

      const reasons: string[] = [];
      if (elu > thresholds.elu) reasons.push('elu');
      if (loopDelayMs.p99 > thresholds.loopDelayP99Ms) reasons.push('loop');
      if (heap.used_heap_size > thresholds.heapRatio * heap.heap_size_limit) reasons.push('heap');
      if (reasons.length > 0) {
        sink(JSON.stringify({ msg: 'process.metrics.warn', process: processName, reasons }));
      }
    } catch {
      // Pomiar nie może położyć procesu ani zalać logu — gubimy jedną linię.
    }
  };

  const timer = setInterval(tick, intervalMs);
  // Licznik nie trzyma procesu przy życiu (graceful shutdown, `next build`).
  timer.unref();

  const stop = (): void => {
    clearInterval(timer);
    loopDelay.disable();
    if (g[STATE_KEY] === stop) delete g[STATE_KEY];
  };
  g[STATE_KEY] = stop;
  return stop;
}
