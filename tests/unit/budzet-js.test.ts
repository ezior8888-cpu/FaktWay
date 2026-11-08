import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { chunkIds, collectRoutes, compareBudget, entryDeps, kB, preloadedIds } from '../../scripts/ci/budzet-js.mjs';

/**
 * Plan usprawnień 4.5: `scripts/ci/budzet-js.mjs` liczy First Load JS tras
 * z plików `.next` (Next 16 nie wypisuje już tej liczby w `next build`)
 * i porównuje z progiem w `scripts/ci/budzet-js.json`.
 */

const SCRIPT = resolve(__dirname, '../../scripts/ci/budzet-js.mjs');
let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

type Measured = { route: string; bytes: number };

describe('compareBudget', () => {
  it('przepuszcza trasy poniżej progu i pokazuje największą', () => {
    const measured: Measured[] = [
      { route: '/', bytes: 150_000 },
      { route: '/(dashboard)/faktury', bytes: 240_000 },
    ];
    const { ok, lines } = compareBudget(measured, { maxFirstLoadKB: 250 });
    expect(ok).toBe(true);
    expect(lines[0]).toContain('/(dashboard)/faktury = 240 kB');
    expect(lines.join('\n')).not.toContain('BŁĄD');
  });

  it('wskazuje trasę, rozmiar i próg przy przekroczeniu', () => {
    const { ok, lines } = compareBudget(
      [
        { route: '/', bytes: 100_000 },
        { route: '/(dashboard)/faktury/nowa', bytes: 262_345 },
      ],
      { maxFirstLoadKB: 250 },
    );
    expect(ok).toBe(false);
    expect(lines).toContain(
      'BŁĄD: trasa /(dashboard)/faktury/nowa ładuje 262.3 kB JS przy pierwszym wejściu, próg 250 kB (+12.3 kB).',
    );
    expect(lines.join('\n')).not.toContain('trasa / ładuje');
  });

  it('równość z progiem to jeszcze nie przekroczenie', () => {
    expect(compareBudget([{ route: '/', bytes: 250_000 }], { maxFirstLoadKB: 250 }).ok).toBe(true);
    expect(compareBudget([{ route: '/', bytes: 250_100 }], { maxFirstLoadKB: 250 }).ok).toBe(false);
  });

  it('próg trasy z `trasy` ma pierwszeństwo przed ogólnym', () => {
    const budget = { maxFirstLoadKB: 300, trasy: { '/login': 120 } };
    expect(compareBudget([{ route: '/login', bytes: 130_000 }], budget).ok).toBe(false);
    expect(compareBudget([{ route: '/inna', bytes: 130_000 }], budget).ok).toBe(true);
  });

  it('pusty pomiar to błąd, nie ciche zielone', () => {
    const { ok, lines } = compareBudget([], { maxFirstLoadKB: 250 });
    expect(ok).toBe(false);
    expect(lines[0]).toContain('nie ma żadnej trasy');
  });

  it('kB jak dawne `next build`: 1000 B, jedno miejsce po przecinku', () => {
    expect(kB(102_449)).toBe(102.4);
    expect(kB(102_450)).toBe(102.5);
  });
});

/**
 * Syntetyczny `.next` w formacie Next 16 `next build --webpack` (wzór:
 * prawdziwy build z 08.11.2026): nagłówek Sentry, `.push([[id],…])`
 * w każdym kawałku, `.O(0,[zależności],…)` na końcu wejścia, runtime
 * z id załadowanymi od startu.
 */
function fakeNext(pageBytes: number, pageDeps = [4234, 9070, 7358]) {
  dir = mkdtempSync(join(tmpdir(), 'budzet-js-'));
  const next = join(dir, '.next');
  // Pseudolosowa treść, żeby gzip nie zwinął jej do kilku bajtów.
  let seed = 7;
  const noise = (n: number) =>
    Array.from({ length: n }, () => ((seed = (seed * 48271) % 2147483647) % 36).toString(36)).join('');
  const sentry = '!function(){try{var e=window;e._sentryDebugIds={}}catch(e){}}(),';
  const chunk = (ids: number[], bytes: number, deps?: number[]) =>
    `${sentry}(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[${ids.join(',')}],{1:()=>{"${noise(bytes)}"}}` +
    (deps ? `,e=>{e.O(0,[${deps.join(',')}],()=>e(e.s=1)),_N_E=e.O()}` : '') +
    ']);';
  const files: Record<string, string> = {
    'static/chunks/webpack-aaaa.js': `!function(){c.p="/_next/",i={8068:0,5601:0},c.f.j=(e,t)=>{"${noise(3_000)}"}}();`,
    'static/chunks/main-app-bbbb.js': chunk([7358], 20_000),
    'static/chunks/polyfills-ffff.js': chunk([1], 50_000),
    'static/chunks/4234-cccc.js': chunk([4234], 30_000),
    'static/chunks/9070-dddd.js': chunk([9070], 10_000),
    'static/chunks/1111.eeee.js': chunk([1111], 90_000), // leniwy import(), nie liczy się
    'static/chunks/app/layout-0a0a.js': chunk([1001], 2_000, [5601, 9070, 7358]),
    'static/chunks/app/(dashboard)/layout-0b0b.js': chunk([1002], 2_000, [9070]),
    'static/chunks/app/(dashboard)/faktury/page-0c0c.js': chunk([1003], pageBytes, pageDeps),
    'static/chunks/app/(marketing)/layout-0d0d.js': chunk([1004], 40_000, [7358]),
    'static/chunks/app/(marketing)/cennik/page-0e0e.js': chunk([1005], 1_000, [7358]),
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(next, file)), { recursive: true });
    writeFileSync(join(next, file), content);
  }
  writeFileSync(
    join(next, 'build-manifest.json'),
    JSON.stringify({
      rootMainFiles: ['static/chunks/webpack-aaaa.js', 'static/chunks/main-app-bbbb.js'],
      polyfillFiles: ['static/chunks/polyfills-ffff.js'],
    }),
  );
  return next;
}

describe('collectRoutes i CLI na syntetycznym .next', () => {
  it('liczy wspólne, wejścia segmentów nadrzędnych i ich zależności; bez polyfilli, leniwych i sąsiednich grup', () => {
    const routes = collectRoutes(fakeNext(10_000));
    expect(routes.map((r: { route: string }) => r.route)).toEqual(['/(dashboard)/faktury', '/(marketing)/cennik']);
    expect([...routes[0].files].sort()).toEqual(
      [
        'static/chunks/webpack-aaaa.js',
        'static/chunks/main-app-bbbb.js',
        'static/chunks/4234-cccc.js',
        'static/chunks/9070-dddd.js',
        'static/chunks/app/layout-0a0a.js',
        'static/chunks/app/(dashboard)/layout-0b0b.js',
        'static/chunks/app/(dashboard)/faktury/page-0c0c.js',
      ].sort(),
    );
    expect([...routes[1].files].sort()).toEqual(
      [
        'static/chunks/webpack-aaaa.js',
        'static/chunks/main-app-bbbb.js',
        'static/chunks/9070-dddd.js',
        'static/chunks/app/layout-0a0a.js',
        'static/chunks/app/(marketing)/layout-0d0d.js',
        'static/chunks/app/(marketing)/cennik/page-0e0e.js',
      ].sort(),
    );
  });

  it('nieznane id kawałka to błąd zmiany formatu, nie ciche zaniżenie', () => {
    expect(() => collectRoutes(fakeNext(1_000, [4234, 4321]))).toThrow(/Nieznany kawałek 4321 .*popraw scripts\/ci\/budzet-js\.mjs/);
  });

  it('czyta id z nagłówka, zależności z końca wejścia i id załadowane przez runtime', () => {
    expect(chunkIds('!function(){}(),(self.w=self.w||[]).push([[12,34],{5:()=>{}}])')).toEqual([12, 34]);
    expect(entryDeps('x.O(0,[1],()=>{}),e=>{e.O(0,[7,8],()=>e(e.s=1)),_N_E=e.O()}')).toEqual([7, 8]);
    expect([...preloadedIds('c.p="/_next/",i={8068:0,5601:0},c.f.j=(e,t)=>{}')]).toEqual([8068, 5601]);
  });

  const run = (next: string, maxFirstLoadKB: number) => {
    const budget = join(dir, 'budzet.json');
    writeFileSync(budget, JSON.stringify({ maxFirstLoadKB }));
    return spawnSync(process.execPath, [SCRIPT, next, budget], { encoding: 'utf8' });
  };

  it('kończy się kodem 0 pod progiem i 1 z komunikatem nad progiem', () => {
    const next = fakeNext(200_000);
    const pass = run(next, 1000);
    expect(pass.status).toBe(0);
    expect(pass.stdout).toContain('/(dashboard)/faktury');

    const fail = run(next, 100);
    expect(fail.status).toBe(1);
    expect(fail.stderr).toMatch(
      /BŁĄD: trasa \/\(dashboard\)\/faktury ładuje [\d.]+ kB JS przy pierwszym wejściu, próg 100 kB/,
    );
    expect(fail.stderr).not.toContain('trasa /(marketing)/cennik');
  });

  it('prawdziwy próg w repo jest liczbą dodatnią', () => {
    const budget = JSON.parse(readFileSync(resolve(__dirname, '../../scripts/ci/budzet-js.json'), 'utf8'));
    expect(budget.maxFirstLoadKB).toBeGreaterThan(0);
    expect(typeof budget.trasy).toBe('object');
  });
});
