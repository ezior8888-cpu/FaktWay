/**
 * Licznik procesu workera w teście obciążenia (`node --import`). Niczego nie
 * podmienia: tylko liczy, ile zapytań idzie do bazy i dopisuje próbkę do pliku.
 *
 *   - `postgrest`: żądania `fetch` na adres Supabase (z workera przez PostgREST),
 *   - `pg`: zapytania połączenia pg-boss (`pg.Client.prototype.query`),
 *   - rss, heap, procesor (user + sys, ms), opóźnienie pętli zdarzeń.
 *
 * Próbka co 5 s jako linia JSON w `LICZNIK_PLIK`. Bez tej zmiennej nic nie robi.
 */

import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const file = process.env.LICZNIK_PLIK;

if (file) {
  const counters = { postgrest: 0, pg: 0, ksef: 0, other: 0 };
  const supabaseHost = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const ksefHost = process.env.KSEF_TEST_URL ?? '';

  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (supabaseHost && url.startsWith(supabaseHost)) counters.postgrest += 1;
    else if (ksefHost && url.startsWith(ksefHost)) counters.ksef += 1;
    else counters.other += 1;
    return realFetch(input, init);
  };

  // `pg` jest zależnością pg-boss, nie projektu: bierzemy tę samą kopię modułu.
  const require = createRequire(import.meta.url);
  const pg = createRequire(require.resolve('pg-boss'))('pg');
  const realQuery = pg.Client.prototype.query;
  pg.Client.prototype.query = function countedQuery(...args) {
    counters.pg += 1;
    return realQuery.apply(this, args);
  };

  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const startedAt = Date.now();

  const timer = setInterval(() => {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    appendFileSync(file, `${JSON.stringify({
      at: Date.now(),
      uptimeMs: Date.now() - startedAt,
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      loopP99Ms: Math.round(loop.percentile(99) / 1e6),
      loopMaxMs: Math.round(loop.max / 1e6),
      ...counters,
    })}\n`);
    loop.reset();
  }, 5000);
  timer.unref();
}
