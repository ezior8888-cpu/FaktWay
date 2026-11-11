// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * 11.11.2026: hook przed pushem uruchamia vitest, a git przekazuje hookowi
 * GIT_DIR prawdziwego repo. Testy, które zakładają własne repo w katalogu
 * tymczasowym, brały `process.env` do `git init` i `git config`, więc przez
 * GIT_DIR zmieniły prawdziwe repo: `core.bare=true` (wszystkie worktree
 * i główna kopia przestały działać) i inny `core.hooksPath`.
 *
 * Ten test uruchamia takie pliki testów tak, jak robi to hook: z GIT_DIR innego
 * repo w środowisku, i sprawdza, że tamto repo zostaje nietknięte.
 */

const KATALOG = path.resolve(__dirname, '../..');
const VITEST = path.join(KATALOG, 'node_modules/.bin/vitest');
const PLIKI: ReadonlyArray<{ plik: string; konfiguracja?: string }> = [{ plik: 'tests/unit/napraw-hook.test.ts' }];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'izolacja-git-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Środowisko bez zmiennych gita wskazujących repo (ten test też nie może ich dziedziczyć). */
const bezGit = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))) as NodeJS.ProcessEnv;

describe('testy z repozytoriami tymczasowymi nie dotykają repo z GIT_DIR', () => {
  it.each(PLIKI)('$plik', ({ plik, konfiguracja }) => {
    const zewnetrzne = path.join(tmp, path.basename(plik, '.test.ts'));
    fs.mkdirSync(zewnetrzne);
    execFileSync('git', ['init', '-q'], { cwd: zewnetrzne, env: { ...bezGit, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    const config = path.join(zewnetrzne, '.git/config');
    const przed = fs.readFileSync(config, 'utf8');

    const wynik = spawnSync(VITEST, ['run', ...(konfiguracja ? ['--config', konfiguracja] : []), plik], {
      cwd: KATALOG,
      env: { ...bezGit, GIT_DIR: path.join(zewnetrzne, '.git') },
      encoding: 'utf8',
      timeout: 180_000,
    });

    expect(fs.readFileSync(config, 'utf8'), 'config repo z GIT_DIR').toBe(przed);
    expect(wynik.status, `${wynik.stdout}\n${wynik.stderr}`.slice(-2000)).toBe(0);
  }, 200_000);

  it('hook przed pushem czyści zmienne gita przed pierwszym narzędziem (node, pnpm)', () => {
    const linie = fs.readFileSync(path.join(KATALOG, '.githooks/pre-push'), 'utf8').split('\n');
    const czyszczenie = linie.findIndex((l) => /^\s*unset\b.*\bGIT_DIR\b/.test(l));
    const narzedzie = linie.findIndex((l) => /^[^#]*\b(?:node|pnpm)\s/.test(l));
    expect(czyszczenie, 'unset GIT_DIR w hooku').toBeGreaterThan(-1);
    expect(czyszczenie).toBeLessThan(narzedzie === -1 ? Number.POSITIVE_INFINITY : narzedzie);
  });
});
