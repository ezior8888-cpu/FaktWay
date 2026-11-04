/**
 * Czasy wybranych operacji do linii `process.metrics` (plan skalowania,
 * sesja 23, CPU-12). `recordTiming` zbiera próbki, `takeTimingSummary` raz na
 * interwał oddaje p50/p95/max i zeruje bufor.
 *
 * Czysty moduł, bez importów `node:` — woła go strona Pulpitu.
 *
 * Stan leży na `globalThis`, nie w zmiennej modułu: Next.js buduje
 * `instrumentation.ts` i strony jako osobne paczki, więc każda dostaje własną
 * kopię modułu. Zmienna modułu dałaby dwa bufory w jednym procesie — strona
 * pisałaby do swojego, a licznik z instrumentation czytałby pusty.
 */

/** Ile próbek na nazwę trzymamy w interwale; `n` liczy wszystkie. */
const MAX_SAMPLES = 2000;
/** Bezpiecznik na nazwy z danych zamiast ze stałej w kodzie. */
const MAX_NAMES = 50;

type Bucket = { n: number; max: number; samples: number[] };

export type TimingSummary = Record<string, { n: number; p50Ms: number; p95Ms: number; maxMs: number }>;

const STORE_KEY = Symbol.for('faktway.observability.timings');

function store(): Map<string, Bucket> {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: Map<string, Bucket> };
  const existing = g[STORE_KEY];
  if (existing) return existing;
  const created = new Map<string, Bucket>();
  g[STORE_KEY] = created;
  return created;
}

export function recordTiming(name: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const buckets = store();
  let bucket = buckets.get(name);
  if (!bucket) {
    if (buckets.size >= MAX_NAMES) return;
    bucket = { n: 0, max: 0, samples: [] };
    buckets.set(name, bucket);
  }
  bucket.n += 1;
  if (ms > bucket.max) bucket.max = ms;
  if (bucket.samples.length < MAX_SAMPLES) {
    bucket.samples.push(ms);
    return;
  }
  // Pełny bufor: losowanie rezerwuarowe — próbka zostaje równomierna dla
  // całego interwału, a nie tylko dla jego pierwszych 2000 pomiarów.
  const slot = Math.floor(Math.random() * bucket.n);
  if (slot < MAX_SAMPLES) bucket.samples[slot] = ms;
}

/** Percentyl metodą najbliższej rangi; `sorted` rosnąco, niepuste. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(rank, 1)) - 1];
}

export function takeTimingSummary(): TimingSummary {
  const buckets = store();
  const summary: TimingSummary = {};
  for (const [name, bucket] of buckets) {
    const sorted = [...bucket.samples].sort((a, b) => a - b);
    summary[name] = {
      n: bucket.n,
      p50Ms: Math.round(percentile(sorted, 50)),
      p95Ms: Math.round(percentile(sorted, 95)),
      maxMs: Math.round(bucket.max),
    };
  }
  buckets.clear();
  return summary;
}
