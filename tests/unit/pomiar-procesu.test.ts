import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startProcessMetrics } from '@/lib/observability/process-metrics';
import { recordTiming, takeTimingSummary } from '@/lib/observability/timings';

/**
 * Plan skalowania, sesja 23 (CPU-12): web i worker co minutę zapisują do logu
 * jedną linię JSON z wykorzystaniem pętli zdarzeń, jej opóźnieniem i pamięcią.
 * Bez tego decyzja „druga replika / większy serwer” nie ma progu.
 */

const ROOT = join(__dirname, '..', '..');

/**
 * Próg ELU wyłączony w testach ze sztucznym zegarem. Vitest podmienia
 * `process.hrtime`, z którego Node liczy czas aktywny pętli: przesunięte
 * 1000 ms bez chwili bezczynności to ELU = 1, więc domyślny próg 0,7 słusznie
 * dopisałby `process.metrics.warn`. Progi pętli i pamięci zostają domyślne.
 */
const ELU_OFF = { elu: 2 };

describe('pomiar procesu (sesja 23)', () => {
  let stop: (() => void) | null = null;

  afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
    takeTimingSummary();
  });

  it('co interwał zapisuje linię process.metrics z pętlą zdarzeń i pamięcią', () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    stop = startProcessMetrics({ process: 'web', intervalMs: 1_000, sink: (l) => lines.push(l), thresholds: ELU_OFF });

    vi.advanceTimersByTime(1_000);

    expect(lines).toHaveLength(1);
    const m = JSON.parse(lines[0]);
    expect(m.msg).toBe('process.metrics');
    expect(m.process).toBe('web');
    expect(m.elu).toBeGreaterThanOrEqual(0);
    expect(m.elu).toBeLessThanOrEqual(1);
    for (const k of ['p50', 'p99', 'max'] as const) {
      expect(Number.isFinite(m.loopDelayMs[k])).toBe(true);
      expect(m.loopDelayMs[k]).toBeGreaterThanOrEqual(0);
    }
    expect(m.memMb.rss).toBeGreaterThan(0);
    expect(m.memMb.heapUsed).toBeGreaterThan(0);
    expect(m.memMb.heapLimit).toBeGreaterThan(m.memMb.heapUsed);
  });

  it('dołącza czasy z recordTiming (p50, p95, max, liczba) i zeruje je po zapisie', () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    stop = startProcessMetrics({ process: 'web', intervalMs: 1_000, sink: (l) => lines.push(l), thresholds: ELU_OFF });

    for (let i = 1; i <= 20; i++) recordTiming('dashboard', i * 10);
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(1_000);

    const first = JSON.parse(lines[0]);
    expect(first.timings.dashboard).toEqual({ n: 20, p50Ms: 100, p95Ms: 190, maxMs: 200 });
    const second = JSON.parse(lines[1]);
    expect(second.timings).toEqual({});
  });

  it('przy przekroczeniu progu dopisuje linię process.metrics.warn z powodem', () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    stop = startProcessMetrics({
      process: 'worker',
      intervalMs: 1_000,
      sink: (l) => lines.push(l),
      // Próg pamięci 0 = każdy pomiar go przekracza; reszta progów nieosiągalna.
      thresholds: { elu: 2, loopDelayP99Ms: Number.POSITIVE_INFINITY, heapRatio: 0 },
    });

    vi.advanceTimersByTime(1_000);

    const warn = lines.map((l) => JSON.parse(l)).find((m) => m.msg === 'process.metrics.warn');
    expect(warn).toBeDefined();
    expect(warn.process).toBe('worker');
    expect(warn.reasons).toEqual(['heap']);
  });

  it('drugi start w tym samym procesie nie uruchamia drugiego licznika', () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    stop = startProcessMetrics({ process: 'web', intervalMs: 1_000, sink: (l) => lines.push(l) });
    const again = startProcessMetrics({ process: 'web', intervalMs: 1_000, sink: (l) => lines.push(l) });

    vi.advanceTimersByTime(1_000);

    expect(lines.filter((l) => JSON.parse(l).msg === 'process.metrics')).toHaveLength(1);
    expect(again).toBe(stop);
  });

  it('web (instrumentation.ts), worker i Pulpit są podpięte', () => {
    const instrumentation = readFileSync(join(ROOT, 'instrumentation.ts'), 'utf8');
    const worker = readFileSync(join(ROOT, 'lib/jobs/worker.ts'), 'utf8');
    const pulpit = readFileSync(join(ROOT, 'app/(dashboard)/dashboard/page.tsx'), 'utf8');

    expect(instrumentation).toContain("startProcessMetrics({ process: 'web' })");
    expect(worker).toContain("startProcessMetrics({ process: 'worker' })");
    expect(pulpit).toContain("recordTiming('dashboard'");
  });
});
