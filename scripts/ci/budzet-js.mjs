#!/usr/bin/env node
// Plan usprawnień 4.5: budżet First Load JS tras App Routera.
//
//   node scripts/ci/budzet-js.mjs [katalog .next] [plik progu]
//   (domyślnie .next i scripts/ci/budzet-js.json)
//
// Next 16 nie wypisuje już „First Load JS” w `next build`
// (node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md),
// więc liczymy z plików builda webpack (`next build --webpack`). Dla każdej
// trasy, czyli pliku `static/chunks/app/**/page-<hash>.js`, suma rozmiarów po
// gzip skryptów ładowanych przy pierwszym wejściu:
//   - wspólne: `build-manifest.json` → `rootMainFiles` (runtime, React, main-app),
//   - wejścia segmentów: strona oraz `layout`, `template`, `loading`, `error`,
//     `not-found` z jej katalogu i katalogów nadrzędnych,
//   - kawałki, na które te wejścia czekają: lista w `.O(0,[id,…],…)` na końcu
//     pliku wejścia; id → plik z nagłówka `.push([[id,…],` każdego kawałka.
//     Id bez pliku JS (sam CSS albo część runtime) runtime webpacka ma od
//     startu jako załadowane (`={5601:0,…},x.f.j=`) i te pomijamy.
// Kawałki doładowywane później (`next/dynamic`, `import()`) się nie liczą
// i o to chodzi: przeniesienie biblioteki do leniwego ładowania widać jako
// spadek liczby. Polyfille (`nomodule`) też nie, jak dawniej w `next build`.
//
// BŁĄD (kod 1): któraś trasa przekracza próg albo nie da się zmierzyć buildu
// (brak tras, nieznane id kawałka: Next zmienił format plików, popraw skrypt).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const SEGMENT_FILES = /^(layout|template|loading|error|not-found)-[0-9a-f]+\.js$/;
const PAGE_FILE = /^page-[0-9a-f]+\.js$/;

/** Bajty na kB tak jak dawniej w `next build` (1 kB = 1000 B). */
export const kB = (bytes) => Math.round(bytes / 100) / 10;

/** Wszystkie pliki .js pod katalogiem, ścieżki względne z `/`. */
function listJs(root, dir = root) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(root, path));
    else if (entry.name.endsWith('.js')) out.push(relative(root, path).split(sep).join('/'));
  }
  return out;
}

/** Id kawałków zapisane w pliku (`.push([[12,34],`). */
export function chunkIds(source) {
  const m = source.match(/\.push\(\[\[([\d,]+)\]/);
  return m ? m[1].split(',').map(Number) : [];
}

/** Id kawałków, na które czeka wejście (ostatnie `.O(0,[…],`). */
export function entryDeps(source) {
  const all = [...source.matchAll(/\.O\(0,\[([\d,]*)\]/g)];
  const last = all.at(-1);
  return last && last[1] ? last[1].split(',').map(Number) : [];
}

/** Id, które runtime webpacka ma od startu jako załadowane (bez osobnego pliku JS). */
export function preloadedIds(runtimeSource) {
  const m = runtimeSource.match(/=\{((?:\d+:0,)*\d+:0)\},\w+\.f\.j=/);
  return new Set(m ? m[1].split(',').map((pair) => Number(pair.split(':')[0])) : []);
}

/**
 * Trasy i ich pliki JS z katalogu `.next`.
 * @returns {{ route: string, files: string[] }[]}
 */
export function collectRoutes(nextDir) {
  const buildManifest = JSON.parse(readFileSync(join(nextDir, 'build-manifest.json'), 'utf8'));
  const shared = buildManifest.rootMainFiles ?? [];
  const chunksDir = join(nextDir, 'static', 'chunks');
  const appDir = join(chunksDir, 'app');
  if (!existsSync(appDir)) return [];

  const all = listJs(chunksDir).map((f) => `static/chunks/${f}`);
  const sources = new Map(all.map((f) => [f, readFileSync(join(nextDir, f), 'utf8')]));
  const byId = new Map();
  for (const [file, source] of sources) for (const id of chunkIds(source)) byId.set(id, file);
  const runtime = shared.find((f) => posix.basename(f).startsWith('webpack-'));
  const preloaded = runtime && sources.has(runtime) ? preloadedIds(sources.get(runtime)) : new Set();

  const entriesIn = (dir) =>
    all.filter((f) => posix.dirname(f) === dir && SEGMENT_FILES.test(posix.basename(f)));

  const routes = [];
  for (const page of all.filter((f) => f.startsWith('static/chunks/app/') && PAGE_FILE.test(posix.basename(f)))) {
    const dir = posix.dirname(page);
    const segments = dir.split('/').slice(3); // bez static/chunks/app
    const entries = [page];
    for (let i = 0; i <= segments.length; i++) {
      entries.push(...entriesIn(['static/chunks/app', ...segments.slice(0, i)].join('/')));
    }
    const files = new Set(shared);
    for (const entry of entries) {
      files.add(entry);
      for (const id of entryDeps(sources.get(entry))) {
        if (preloaded.has(id)) continue;
        const file = byId.get(id);
        if (!file) throw new Error(`Nieznany kawałek ${id} w ${entry}: Next zmienił format plików, popraw scripts/ci/budzet-js.mjs.`);
        files.add(file);
      }
    }
    routes.push({ route: '/' + segments.join('/'), files: [...files] });
  }
  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

/** Rozmiar po gzip; ten sam plik liczony raz na przebieg. */
export function gzipSizer(nextDir) {
  const cache = new Map();
  return (file) => {
    if (!cache.has(file)) {
      cache.set(file, gzipSync(readFileSync(join(nextDir, file)), { level: 9 }).length);
    }
    return cache.get(file);
  };
}

/**
 * Porównanie z progiem. Czysta funkcja, testowana w tests/unit/budzet-js.test.ts.
 * @param {{ route: string, bytes: number }[]} measured
 * @param {{ maxFirstLoadKB: number, trasy?: Record<string, number> }} budget
 */
export function compareBudget(measured, budget) {
  if (measured.length === 0) {
    return {
      ok: false,
      lines: [
        'BŁĄD: w buildzie nie ma żadnej trasy do zmierzenia (brak static/chunks/app/**/page-*.js).',
        'Next mógł zmienić format plików w .next; popraw scripts/ci/budzet-js.mjs.',
      ],
    };
  }
  const over = [];
  for (const { route, bytes } of measured) {
    const limit = budget.trasy?.[route] ?? budget.maxFirstLoadKB;
    if (kB(bytes) > limit) over.push({ route, size: kB(bytes), limit });
  }
  const top = [...measured].sort((a, b) => b.bytes - a.bytes)[0];
  const lines = [
    `Budżet First Load JS: ${measured.length} tras, największa ${top.route} = ${kB(top.bytes)} kB (gzip), próg ${budget.maxFirstLoadKB} kB.`,
  ];
  for (const o of over) {
    lines.push(`BŁĄD: trasa ${o.route} ładuje ${o.size} kB JS przy pierwszym wejściu, próg ${o.limit} kB (+${Math.round((o.size - o.limit) * 10) / 10} kB).`);
  }
  if (over.length > 0) {
    lines.push(
      'Co zrobić: przenieś ciężką bibliotekę do leniwego ładowania (next/dynamic, import() po interakcji)',
      'albo, jeśli wzrost jest świadomy, podnieś próg w scripts/ci/budzet-js.json i napisz w PR dlaczego.',
    );
  }
  return { ok: over.length === 0, lines };
}

function main() {
  const [nextDir = '.next', budgetPath = 'scripts/ci/budzet-js.json'] = process.argv.slice(2);
  const budget = JSON.parse(readFileSync(budgetPath, 'utf8'));
  const size = gzipSizer(nextDir);
  const measured = collectRoutes(nextDir).map(({ route, files }) => ({
    route,
    bytes: files.reduce((sum, f) => sum + size(f), 0),
  }));
  const ranking = [...measured].sort((a, b) => b.bytes - a.bytes).slice(0, 10);
  console.log('Najcięższe trasy (First Load JS, gzip):');
  for (const { route, bytes } of ranking) console.log(`  ${String(kB(bytes)).padStart(7)} kB  ${route}`);
  const { ok, lines } = compareBudget(measured, budget);
  for (const line of lines) (ok ? console.log : console.error)(line);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
