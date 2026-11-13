// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Hook przed pushem uruchamia strażnika tekstów dla klienta
 * (`tests/unit/teksty-straznik.test.ts`). Strażnik czyta pliki przez
 * `git ls-files`, a nie przez importy, więc `vitest related` go nie znajduje.
 * Długi myślnik w nowym komunikacie wychodził przez to dopiero w CI
 * („Vitest (część 2/3)”, #538 i #660).
 *
 * Test uruchamia prawdziwy `.githooks/pre-push` w repozytorium tymczasowym.
 * `pnpm` jest tu atrapą: zapisuje swoje wywołania, a na żądanie testu
 * „czerwieni” strażnika. Widać więc, co hook uruchamia i czy zatrzymuje push.
 */

const KATALOG = path.resolve(__dirname, '../..');
const STRAZNIK = 'tests/unit/teksty-straznik.test.ts';
const STAN = 'tests/unit/fixtures/teksty-stan.json';
const WYWOLANIE_STRAZNIKA = `-s exec vitest run ${STRAZNIK}`;
const ZERO = '0'.repeat(40);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hak-straznik-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Atrapa pnpm: dopisuje argumenty do pliku z PNPM_LOG. Przy STRAZNIK_CZERWONY=1
// wywołanie strażnika kończy się błędem, jak po dopisaniu długiego myślnika.
const atrapy = path.join(tmp, 'atrapy');
fs.mkdirSync(atrapy);
fs.writeFileSync(
  path.join(atrapy, 'pnpm'),
  [
    '#!/usr/bin/env bash',
    'printf \'%s\\n\' "$*" >>"$PNPM_LOG"',
    'case "$*" in',
    '  *teksty-straznik*) if [ "${STRAZNIK_CZERWONY:-}" = 1 ]; then echo "lib/nowy.ts: długie myślniki 0 → 1"; exit 1; fi ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'),
  { mode: 0o755 },
);

// Bez zmiennych gita z otoczenia: hook i `vitest related` dostają GIT_DIR
// prawdziwego repo (zob. testy-git-izolacja.test.ts). Atrapa pnpm na początku PATH.
const env: NodeJS.ProcessEnv = {
  ...(Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k.toUpperCase() !== 'PATH'),
  ) as NodeJS.ProcessEnv),
  PATH: [atrapy, process.env.PATH ?? ''].join(path.delimiter),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
}

function zapisz(dir: string, plik: string, tresc: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, plik)), { recursive: true });
  fs.writeFileSync(path.join(dir, plik), tresc);
}

let licznik = 0;
/** Repo z kopią hooka, strażnikiem i jego stanem; `origin/main` na pierwszym commicie. */
function repo(): string {
  licznik += 1;
  const dir = path.join(tmp, `repo-${licznik}`);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  // Kopia z LF: na Windows kopia robocza bywa z CRLF, a bash go nie znosi.
  zapisz(dir, '.githooks/pre-push', fs.readFileSync(path.join(KATALOG, '.githooks/pre-push'), 'utf8').replace(/\r\n/g, '\n'));
  zapisz(dir, STRAZNIK, '// atrapa strażnika\n');
  zapisz(dir, STAN, '{}\n');
  zapisz(dir, 'lib/stary.ts', "export const stary = 'tekst';\n");
  zapisz(dir, 'README.md', 'repo testowe\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'baza');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  // Bez node_modules hook pomija typy i testy.
  fs.mkdirSync(path.join(dir, 'node_modules'));
  return dir;
}

function commit(dir: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'zmiana');
}

/** Push HEAD jako gałęzi `zmiana`: hook dostaje na wejściu to, co dostaje od gita. */
function push(dir: string, czerwony = false): { kod: number | null; stderr: string; wywolania: string[] } {
  const log = path.join(tmp, `pnpm-${path.basename(dir)}.log`);
  fs.writeFileSync(log, '');
  const sha = git(dir, 'rev-parse', 'HEAD');
  const wynik = spawnSync('bash', ['.githooks/pre-push', 'origin', 'https://example.invalid/repo.git'], {
    cwd: dir,
    env: { ...env, PNPM_LOG: log, STRAZNIK_CZERWONY: czerwony ? '1' : '' },
    input: `refs/heads/zmiana ${sha} refs/heads/zmiana ${ZERO}\n`,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    kod: wynik.status,
    stderr: wynik.stderr,
    wywolania: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

/** Katalogi, które strażnik czyta (`git ls-files -- …`); hook ma reagować na każdy z nich. */
function katalogiStraznika(): string[] {
  const zrodlo = fs.readFileSync(path.join(KATALOG, STRAZNIK), 'utf8');
  const lista = /\['ls-files', '--', ([^\]]*)\]/.exec(zrodlo)?.[1] ?? '';
  return lista
    .split(',')
    .map((s) => s.trim().replace(/^'(.*)'$/, '$1'))
    .filter(Boolean);
}
const KATALOGI = katalogiStraznika();

describe('hook przed pushem uruchamia strażnika tekstów', { timeout: 120_000 }, () => {
  it('nowy napis w lib/: strażnik idzie pierwszy, a czerwony zatrzymuje push', () => {
    const dir = repo();
    zapisz(dir, 'lib/nowy.ts', "export const komunikat = 'Faktura — wysłana';\n");
    commit(dir);
    const wynik = push(dir, true);
    expect(wynik.wywolania[0]).toBe(WYWOLANIE_STRAZNIKA);
    expect(wynik.kod).toBe(1);
    expect(wynik.stderr).toContain('strażnik tekstów');
    expect(wynik.stderr).toContain('lib/nowy.ts: długie myślniki 0 → 1');
  });

  it('zielony strażnik przepuszcza push, dalsze kroki idą jak dotąd', () => {
    const dir = repo();
    zapisz(dir, 'lib/nowy.ts', "export const komunikat = 'Faktura wysłana';\n");
    commit(dir);
    const wynik = push(dir);
    expect(wynik.kod).toBe(0);
    expect(wynik.wywolania).toContain(WYWOLANIE_STRAZNIKA);
    expect(wynik.wywolania).toContain('-s typecheck');
  });

  it('sam artykuł w content/ (bez kodu) też uruchamia strażnika', () => {
    const dir = repo();
    zapisz(dir, 'content/blog/nowy.mdx', '# Tytuł\n\nTekst — z myślnikiem.\n');
    commit(dir);
    const wynik = push(dir, true);
    expect(wynik.wywolania).toEqual([WYWOLANIE_STRAZNIKA]);
    expect(wynik.kod).toBe(1);
  });

  it('samo usunięcie pliku z zakresu uruchamia strażnika (zapisany stan może wtedy zawyżać liczby)', () => {
    const dir = repo();
    git(dir, 'rm', '-q', 'lib/stary.ts');
    commit(dir);
    expect(push(dir).wywolania).toEqual([WYWOLANIE_STRAZNIKA]);
  });

  it('zmiana zapisanego stanu uruchamia strażnika', () => {
    const dir = repo();
    zapisz(dir, STAN, '{ "lib/stary.ts": { "myslniki": 1, "plakietki": 0 } }\n');
    commit(dir);
    expect(push(dir).wywolania).toEqual([WYWOLANIE_STRAZNIKA]);
  });

  it('push bez plików z zakresu strażnika go nie uruchamia (sama dokumentacja zostaje szybka)', () => {
    const dir = repo();
    zapisz(dir, 'docs/notatka.md', 'Notatka — dla zespołu.\n');
    commit(dir);
    const wynik = push(dir);
    expect(wynik.kod).toBe(0);
    expect(wynik.wywolania).toEqual([]);
  });

  it('lista katalogów strażnika jest czytelna dla tego testu', () => {
    expect(KATALOGI, `brak listy \`git ls-files\` w ${STRAZNIK}: zaktualizuj ten test i hook`).not.toEqual([]);
  });

  it.each(KATALOGI)('zmiana w katalogu %s/ z listy strażnika uruchamia go', (katalog) => {
    const dir = repo();
    zapisz(dir, `${katalog}/nowy.ts`, "export const x = 'x';\n");
    commit(dir);
    expect(push(dir).wywolania).toContain(WYWOLANIE_STRAZNIKA);
  });
});
