import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Skrypty z `scripts/ops/` szukają `.agents/infra.env` także w głównym
 * katalogu repo, bo worktree (`.claude/worktrees/*`) tego pliku nie ma.
 * Główny katalog liczą z `git rev-parse --git-common-dir`.
 *
 * Błąd (11.11.2026): 15 plików uznawało ścieżkę za bezwzględną tylko wtedy,
 * gdy zaczyna się od `/`. Git Bash na Windowsie podaje w worktree
 * `C:/dev/ksef-saas/.git`, więc skrypt doklejał ją do katalogu worktree,
 * `cd` padało i `set -e` kończył skrypt (exit 1) albo skrypt nie znajdował
 * `infra.env`. Ten sam blok był kopiowany ze skryptu do skryptu, dlatego
 * strażnik czyta wszystkie skrypty i hooki.
 *
 * Dwie części:
 * 1. Strażnik tekstu: każde wywołanie `--git-common-dir` daje ścieżkę
 *    bezwzględną (`--path-format=absolute` PRZED `--git-common-dir`, bo git
 *    stosuje go tylko do opcji, które idą po nim), a wynik nie jest doklejany
 *    do katalogu repo. Drugi poprawny zapis (`ksef-pauza.sh`): `case` na
 *    wyniku z gałęzią dla litery dysku (`[A-Za-z]:/` z gwiazdką) tuż za
 *    wywołaniem. Strażnik jest czerwony na każdym systemie, gdy stary blok wróci.
 * 2. PRAWDZIWE skrypty (kopie z końcami LF) uruchomione w tymczasowym
 *    repozytorium, z worktree i z głównego katalogu. `infra.env` leży tylko
 *    w głównym katalogu i kończy skrypt (`exit 0`) zaraz po `source`, więc nic
 *    dalej się nie wykonuje. Atrapy `ssh`, `scp`, `docker`, `psql` i `curl`
 *    w PATH tylko asekurują. Na Windowsie ta część odtwarza błąd. Na Linuksie
 *    i Macu git podaje `/…` i ta część pilnuje, że poprawka nie zepsuła
 *    działającej ścieżki.
 *
 * `wdroz-produkcje.sh`, `coolify-zrodlo.sh` i `wgraj-migracje.sh` zmieniają
 * produkcję, więc test ich nie uruchamia, nawet w piaskownicy. Dwa pierwsze
 * ładują `infra.env` funkcją `zaladuj_infra_env` z `coolify-wspolne.sh`; test
 * woła samą funkcję tak jak one (`set -euo pipefail`, `ROOT`, `source`).
 * `wgraj-migracje.sh` pilnuje tylko strażnik tekstu.
 */

const REPO = join(__dirname, '..', '..');
const OPS = join(REPO, 'scripts', 'ops');

// ─── 1. Strażnik tekstu ────────────────────────────────────────────────

type Wiersz = { nr: number; tekst: string };

/**
 * Wiersze kodu z numerami. Pełne wiersze komentarza (`# …`) pomijamy, a wiersz
 * zakończony `\` łączymy z następnym (numer zostaje z pierwszego).
 */
function wierszeKodu(tresc: string): Wiersz[] {
  const wynik: Wiersz[] = [];
  let zaczety: Wiersz | null = null;
  for (const [i, wiersz] of tresc.replace(/\r\n/g, '\n').split('\n').entries()) {
    if (!zaczety && /^\s*#/.test(wiersz)) continue;
    zaczety ??= { nr: i + 1, tekst: '' };
    if (wiersz.endsWith('\\')) {
      zaczety.tekst += `${wiersz.slice(0, -1)} `;
      continue;
    }
    wynik.push({ nr: zaczety.nr, tekst: zaczety.tekst + wiersz });
    zaczety = null;
  }
  if (zaczety) wynik.push(zaczety);
  return wynik;
}

/** Wzorzec gałęzi `case` dla litery dysku: `[A-Za-z]`, `[[:alpha:]]` albo `?`, potem `:/`, gwiazdka i `|` albo `)`. */
const GALAZ_LITERY_DYSKU = /(?:\[(?:[A-Za-z-]+|\[:alpha:\])\]|\?):\/\*\s*[|)]/;
/** Tyle wierszy kodu za wywołaniem `--git-common-dir` to jego blok (`if` i `case` z wynikiem). */
const BLOK = 8;

function bezwzgledna(tekst: string): boolean {
  const format = tekst.indexOf('--path-format=absolute');
  return format !== -1 && format < tekst.indexOf('--git-common-dir');
}

/** W bloku jest `case` na tej zmiennej, a w nim (do `esac`) gałąź dla litery dysku. */
function caseZLiteraDysku(blok: Wiersz[], zmienna: string): boolean {
  const odwolanie = new RegExp(`\\bcase\\s+["']?\\$\\{?${zmienna}\\b`);
  const start = blok.findIndex((w) => odwolanie.test(w.tekst));
  if (start === -1) return false;
  const koniec = blok.findIndex((w, j) => j >= start && /\besac\b/.test(w.tekst));
  return blok.slice(start, koniec === -1 ? undefined : koniec + 1).some((w) => GALAZ_LITERY_DYSKU.test(w.tekst));
}

/**
 * Usterki ścieżki głównego katalogu repo w treści skryptu (`<wiersz>: <opis>`).
 * Pusta lista: skrypt znajdzie główny katalog także z worktree na Windowsie.
 * Każde wywołanie sprawdzamy osobno, z jego blokiem: obsługa litery dysku
 * w innym miejscu pliku albo w `case` na innej zmiennej starego bloku nie ratuje.
 */
function usterkiSciezkiGlownegoRepo(tresc: string): string[] {
  const kod = wierszeKodu(tresc);
  return kod.flatMap(({ nr, tekst }, i) => {
    if (!tekst.includes('--git-common-dir')) return [];
    const blok = kod.slice(i + 1, i + 1 + BLOK);
    const zmienna = /(\w+)=["']?\$\(/.exec(tekst)?.[1];
    if (zmienna && caseZLiteraDysku(blok, zmienna)) return [];
    // Wynik doklejony do innego katalogu, czyli wzięty za ścieżkę względną.
    const doklejona = zmienna ? new RegExp(`/["']?\\$\\{?${zmienna}\\b`) : null;
    return [
      ...(bezwzgledna(tekst) ? [] : [`${nr}: --git-common-dir bez --path-format=absolute przed nim`]),
      ...blok
        .filter((w) => doklejona?.test(w.tekst))
        .map((w) => `${w.nr}: wynik --git-common-dir doklejony do katalogu repo`),
    ];
  });
}

/**
 * Skrypty powłoki i hooki gita: śledzone oraz nowe, jeszcze nieśledzone
 * (`--others --exclude-standard`), żeby strażnik widział plik przed commitem.
 */
function plikiPowloki(): string[] {
  const r = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.sh', '.githooks'],
    { cwd: REPO, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`git ls-files: ${r.stderr}`);
  return [...new Set(r.stdout.split('\n').filter(Boolean))].filter((plik) => existsSync(join(REPO, plik))).sort();
}

const STARY_BLOK = [
  'ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)',
  'MAIN_ROOT=""',
  'if command -v git >/dev/null 2>&1; then',
  '  COMMON_DIR=$(git -C "$ROOT" rev-parse --git-common-dir 2>/dev/null || true)',
  '  if [ -n "$COMMON_DIR" ]; then',
  '    case "$COMMON_DIR" in',
  '      /*) MAIN_ROOT=$(cd "$COMMON_DIR/.." && pwd) ;;',
  '      *)  MAIN_ROOT=$(cd "$ROOT/$COMMON_DIR/.." && pwd) ;;',
  '    esac',
  '  fi',
  'fi',
].join('\n');

const NOWY_BLOK = [
  'ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)',
  'MAIN_ROOT=""',
  'if command -v git >/dev/null 2>&1; then',
  '  COMMON_DIR=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)',
  '  if [ -n "$COMMON_DIR" ]; then',
  '    MAIN_ROOT=$(cd "$COMMON_DIR/.." 2>/dev/null && pwd) || MAIN_ROOT=""',
  '  fi',
  'fi',
].join('\n');

/** Połowiczna poprawka: ścieżka bezwzględna, ale `case /*` dalej wysyła `C:/…` do gałęzi względnej. */
const POLOWICZNA = STARY_BLOK.replace('rev-parse --git-common-dir', 'rev-parse --path-format=absolute --git-common-dir');

const BEZ_OPCJI = '--git-common-dir bez --path-format=absolute przed nim';
const DOKLEJONY = 'wynik --git-common-dir doklejony do katalogu repo';

describe('strażnik: ścieżka głównego katalogu repo w skryptach', () => {
  it('wykrywa stary blok i jego odmiany, przepuszcza oba poprawne zapisy', () => {
    expect(usterkiSciezkiGlownegoRepo(STARY_BLOK)).toEqual([`4: ${BEZ_OPCJI}`, `8: ${DOKLEJONY}`]);
    // Ten sam blok w funkcji, z małymi literami (`coolify-wspolne.sh`).
    expect(usterkiSciezkiGlownegoRepo(STARY_BLOK.replace(/COMMON_DIR/g, 'common_dir'))).toHaveLength(2);
    expect(usterkiSciezkiGlownegoRepo(POLOWICZNA)).toEqual([`8: ${DOKLEJONY}`]);
    // Zmienna o innej nazwie: strażnik bierze nazwę z przypisania.
    expect(usterkiSciezkiGlownegoRepo(POLOWICZNA.replace(/COMMON_DIR/g, 'gd'))).toEqual([`8: ${DOKLEJONY}`]);
    // Opcja po `--git-common-dir` nic nie zmienia: git stosuje ją tylko do opcji za nią.
    expect(
      usterkiSciezkiGlownegoRepo('X=$(git rev-parse --git-common-dir --path-format=absolute)\ncd "$X/.."'),
    ).toEqual([`1: ${BEZ_OPCJI}`]);
    // Komentarz za kodem nie robi z wiersza poprawnego wywołania.
    expect(
      usterkiSciezkiGlownegoRepo('X=$(git rev-parse --git-common-dir) # --path-format=absolute jest gdzie indziej'),
    ).toEqual([`1: ${BEZ_OPCJI}`]);
    // Litera dysku obsłużona gdzie indziej w pliku albo w `case` na innej zmiennej nie ratuje starego bloku.
    const obcyCase = 'case "$1" in [A-Za-z]:/*) echo "ścieżka z Windowsa" ;; esac';
    expect(usterkiSciezkiGlownegoRepo(`${obcyCase}\n${STARY_BLOK}`)).toEqual([`5: ${BEZ_OPCJI}`, `9: ${DOKLEJONY}`]);
    expect(
      usterkiSciezkiGlownegoRepo(
        STARY_BLOK.replace('  if [ -n "$COMMON_DIR" ]; then', `  ${obcyCase}\n  if [ -n "$COMMON_DIR" ]; then`),
      ),
    ).toEqual([`4: ${BEZ_OPCJI}`, `9: ${DOKLEJONY}`]);

    expect(usterkiSciezkiGlownegoRepo(NOWY_BLOK)).toEqual([]);
    expect(
      usterkiSciezkiGlownegoRepo('main_root="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"'),
    ).toEqual([]);
    // Drugi poprawny zapis: `case` zna literę dysku, a gałąź względna obsługuje `.git` w głównym katalogu.
    expect(usterkiSciezkiGlownegoRepo(STARY_BLOK.replace('      /*)', '      /*|[A-Za-z]:/*)'))).toEqual([]);
    expect(usterkiSciezkiGlownegoRepo(STARY_BLOK.replace('      /*)', '      /*|[[:alpha:]]:/*)'))).toEqual([]);
    // Opcja w wierszu wyżej, przed `\`, też jest przed `--git-common-dir`.
    expect(
      usterkiSciezkiGlownegoRepo('X=$(git -C "$ROOT" rev-parse --path-format=absolute \\\n  --git-common-dir)\ncd "$X/.."'),
    ).toEqual([]);
    // Pełny wiersz komentarza nie jest kodem.
    expect(usterkiSciezkiGlownegoRepo('# git rev-parse --git-common-dir podaje na Windowsie C:/…\nexit 0')).toEqual([]);
  });

  it('żaden skrypt ani hook nie liczy głównego katalogu po staremu', () => {
    const pliki = plikiPowloki().map((plik) => ({ plik, tresc: readFileSync(join(REPO, plik), 'utf8') }));
    const uzywajace = pliki.filter(({ tresc }) => tresc.includes('--git-common-dir'));
    // Skan widzi znane pliki: hook bez rozszerzenia .sh, bibliotekę i oba poprawne zapisy.
    expect(pliki.map(({ plik }) => plik)).toContain('.githooks/pre-push');
    expect(uzywajace.map(({ plik }) => plik)).toEqual(
      expect.arrayContaining([
        'scripts/dev/przygotuj-worktree.sh',
        'scripts/ops/coolify-wspolne.sh',
        'scripts/ops/kontrola-faktur-ksef.sh',
        'scripts/ops/ksef-pauza.sh',
      ]),
    );

    const usterki = uzywajace.flatMap(({ plik, tresc }) =>
      usterkiSciezkiGlownegoRepo(tresc).map((u) => `${plik}:${u}`),
    );
    expect(usterki).toEqual([]);
  });
});

// ─── 2. Prawdziwe skrypty w tymczasowym repozytorium ───────────────────

/** Ładują `.agents/infra.env` przez `source "$ENV_FILE"`. Przed `source` nie robią nic poza argumentami. */
const SKRYPTY_Z_INFRA_ENV = [
  'dopisz-dane-specjalne.sh',
  'faktway-inwentarz.sh',
  'kontrola-captcha-gotrue.sh',
  'kontrola-faktur-ksef.sh',
  'ksef-historia.sh',
  'ksef-pauza.sh',
  'oryginal-ksef-data-nadania.sh',
  'pojemnosc-db.sh',
  'rotacja-kluczy.sh',
  'stripe-blik-sprawdz.sh',
  'stripe-blik-wygas-sesje.sh',
  'zainstaluj-restore-drill.sh',
  'zwolnij-utknieta-wysylke.sh',
];
const ZNACZNIK = 'ZALADOWANY_INFRA_ENV_GLOWNEGO_KATALOGU';

/**
 * Katalogi repo względem `dir`. `bash` biegnie z `cwd: dir` i dostaje ścieżkę
 * względną, tak jak `./scripts/ops/…` w runbookach. Skrypt liczy `ROOT`
 * z `BASH_SOURCE` i `pwd`, więc dalej pracuje na ścieżce bezwzględnej. Ścieżka
 * z `tmpdir()` nie trafia do argumentów powłoki (alert CodeQL
 * `js/shell-command-injection-from-environment`), a test nie zależy od tego,
 * jak dana powłoka czyta `C:\…`.
 */
const GLOWNY = 'glowny';
const WORKTREE = 'glowny/.claude/worktrees/wt';

let dir = '';
let glowny = '';
let worktree = '';
let env: NodeJS.ProcessEnv = { NODE_ENV: 'test' }; // typ ProcessEnv z Next.js wymaga tego pola

/**
 * Środowisko bez zmiennych gita (np. `GIT_DIR` z hooka `pre-push`), bez
 * `FAKTFLOW_INFRA_ENV`, z atrapami w PATH i bez konfiguracji gita z komputera
 * (podpisywanie commitów, globalne hooki), która nie ma tu nic do rzeczy.
 */
function srodowisko(bin: string, gitconfig: string): NodeJS.ProcessEnv {
  const wynik: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const [klucz, wartosc] of Object.entries(process.env)) {
    const duze = klucz.toUpperCase();
    if (duze.startsWith('GIT_') || duze === 'PATH' || duze === 'FAKTFLOW_INFRA_ENV' || duze === 'ROTACJA_STAN') continue;
    wynik[klucz] = wartosc;
  }
  wynik.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
  wynik.GIT_CONFIG_GLOBAL = gitconfig;
  wynik.GIT_CONFIG_NOSYSTEM = '1';
  return wynik;
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.error?.message ?? r.stderr}`);
}

/** Kopia skryptu z końcami LF (checkout na Windowsie bywa CRLF). */
function skopiuj(nazwa: string, doKatalogu: string): void {
  mkdirSync(join(doKatalogu, 'scripts', 'ops'), { recursive: true });
  writeFileSync(join(doKatalogu, 'scripts', 'ops', nazwa), readFileSync(join(OPS, nazwa), 'utf8').replace(/\r\n/g, '\n'));
}

function bash(args: string[]) {
  const r = spawnSync('bash', args, { cwd: dir, encoding: 'utf8', env, timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** `katalog` to `GLOWNY` albo `WORKTREE`: ścieżka względem `dir`, z którego biegnie `bash`. */
const uruchom = (katalog: string, nazwa: string, args: string[] = []) =>
  bash([`${katalog}/scripts/ops/${nazwa}`, ...args]);

/** `infra.env` z testu: wypisał znacznik i zakończył powłokę z kodem 0, nic innego się nie wykonało. */
function zaladowalGlowny(r: { status: number | null; stdout: string; stderr: string }): void {
  expect(`${r.stdout}${r.stderr}`).not.toContain('ATRAPA');
  expect(r.stdout, r.stderr).toContain(ZNACZNIK);
  expect(r.status, r.stderr).toBe(0);
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'glowne-repo-')));
  glowny = join(dir, GLOWNY);
  worktree = join(dir, WORKTREE);
  const bin = join(dir, 'bin');
  mkdirSync(glowny);
  mkdirSync(bin);
  for (const atrapa of ['ssh', 'scp', 'docker', 'psql', 'curl']) {
    writeFileSync(join(bin, atrapa), '#!/usr/bin/env bash\necho "ATRAPA $(basename "$0") $*" >&2\nexit 97\n');
    chmodSync(join(bin, atrapa), 0o755);
  }
  writeFileSync(join(dir, 'gitconfig'), '');
  env = srodowisko(bin, join(dir, 'gitconfig'));

  git(glowny, 'init', '-q');
  git(glowny, 'commit', '-q', '--allow-empty', '-m', 'start');
  git(glowny, 'worktree', 'add', '-q', '-b', 'wt', worktree);
  // `.agents` tylko w głównym katalogu; worktree nie ma nawet dowiązania.
  mkdirSync(join(glowny, '.agents'));
  writeFileSync(join(glowny, '.agents', 'infra.env'), `echo "${ZNACZNIK}"\nexit 0\n`);
  for (const nazwa of [...SKRYPTY_Z_INFRA_ENV, 'coolify-wspolne.sh']) {
    skopiuj(nazwa, worktree);
    skopiuj(nazwa, glowny);
  }
  skopiuj('rotacja-generuj.sh', worktree);
}, 60_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/**
 * Z worktree git podaje ścieżkę do `.git` głównego katalogu (na Windowsie `C:/…`).
 * Z głównego katalogu podaje względne `.git`, a skrypt działa z innego katalogu
 * bieżącego (`cwd: dir`), więc ten bieg łapie gałąź względną bez `$ROOT/`.
 */
const MIEJSCA: Array<[string, string]> = [
  ['z worktree', WORKTREE],
  ['z głównego katalogu', GLOWNY],
];

describe.each(MIEJSCA)('skrypty ops uruchomione %s ładują infra.env głównego katalogu', (_miejsce, katalog) => {
  it.each(SKRYPTY_Z_INFRA_ENV)('%s', (nazwa) => {
    zaladowalGlowny(uruchom(katalog, nazwa));
  }, 60_000);

  it('coolify-wspolne.sh: zaladuj_infra_env', () => {
    // Tak jak `wdroz-produkcje.sh` i `coolify-zrodlo.sh` przed pierwszym wywołaniem
    // funkcji: bezwzględny `ROOT` z `cd … && pwd`.
    const skrypt =
      'set -euo pipefail; ROOT=$(cd "$1" && pwd); source "$ROOT/scripts/ops/coolify-wspolne.sh"; zaladuj_infra_env';
    zaladowalGlowny(bash(['-c', skrypt, 'coolify-wspolne', katalog]));
  }, 60_000);
});

describe('rotacja-generuj.sh z worktree', () => {
  it('zapisuje plik w .agents głównego katalogu', () => {
    const r = uruchom(WORKTREE, 'rotacja-generuj.sh', ['hex', 'TEST_SCIEZKA_GLOWNA']);
    expect(r.status, r.stderr).toBe(0);
    const pliki = readdirSync(join(glowny, '.agents', 'backup', 'rotacja-kluczy'));
    expect(pliki.some((plik) => plik.endsWith('-TEST_SCIEZKA_GLOWNA.env'))).toBe(true);
    expect(existsSync(join(worktree, '.agents'))).toBe(false);
  }, 60_000);
});
