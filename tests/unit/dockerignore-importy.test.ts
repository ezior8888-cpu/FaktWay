import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Obraz Dockera nie ma katalogów ani plików z `.dockerignore`, a `next build` sprawdza
 * typy wszystkich plików z `tsconfig.json`: `scripts/` i pliki w katalogu głównym też.
 * Import czegoś, czego w obrazie nie ma, przechodzi więc lokalnie i w CI (pełna kopia
 * repo), a pada dopiero po kilkunastu minutach budowania obrazu. Tak padło:
 * - wdrożenie #363: `scripts/test-ksef-kreator.ts` importował z `tests/`;
 * - budowanie obrazu po scaleniu #504 (11.11): `vitest.filtr.config.ts` importował
 *   `./vitest.config`, który `.dockerignore` pomija. Stary strażnik tego nie widział,
 *   bo czytał tylko listę katalogów i sprawdzał tylko importy z pominiętych katalogów.
 *
 * Dlatego skan obejmuje wszystko, co trafia do obrazu, zamiast listy katalogów, która
 * po cichu się starzeje. Reguły z `*` i `!` są pomijane: skan może przez to objąć plik,
 * którego w obrazie nie ma (fałszywy alarm), ale nie przeoczy pliku, który w nim jest.
 */
const ROOT = path.resolve(__dirname, '../..');
const TS_FILE = /\.(?:tsx?|mts|cts)$/;
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)['"]([^'"]+)['"]/g;
/** Co TypeScript dokleja do importu bez rozszerzenia, szukając pliku. */
const RESOLVED_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx'];
/**
 * Pominięte w `.dockerignore`, ale odtwarzane w obrazie przez `next build` przed
 * sprawdzeniem typów (np. `next-env.d.ts` importuje `./.next/types/routes.d.ts`).
 */
const BUILT_IN_IMAGE = ['.next'];

type IgnoreRules = { dirs: string[]; files: Set<string> };

/** Ścieżka od katalogu głównego z `/`, jak w `.dockerignore` (także na Windowsie). */
function fromRoot(full: string): string {
  return path.relative(ROOT, full).split(path.sep).join('/');
}

function ignoreRules(): IgnoreRules {
  const lines = readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')
    .split('\n')
    // `docs/` i `/docs` znaczą w `.dockerignore` to samo co `docs`.
    .map((line) => (line.trim().startsWith('#') ? '#' : line.trim().replace(/^\/+|\/+$/g, '')))
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!') && !line.includes('*'));
  return {
    dirs: lines.filter((line) => existsSync(path.join(ROOT, line)) && statSync(path.join(ROOT, line)).isDirectory()),
    files: new Set(lines),
  };
}

/**
 * Pliki TypeScript w obrazie: wszystko oprócz reguł z `.dockerignore`, `node_modules`
 * i nazw z kropką na początku (tych `tsconfig` i tak nie dopasowuje, a `.claude/`
 * w głównej kopii trzyma całe worktree).
 */
function imageFiles(dir: string, rules: IgnoreRules): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || rules.files.has(fromRoot(full))) return [];
    if (entry.isDirectory()) return imageFiles(full, rules);
    return TS_FILE.test(entry.name) ? [full] : [];
  });
}

/** Pliki w obrazie, które importują coś, czego w obrazie nie ma: katalog albo plik z `.dockerignore`. */
function importsOfIgnoredPaths(): string[] {
  const rules = ignoreRules();
  const within = (target: string, dir: string) => target === dir || target.startsWith(`${dir}/`);
  const ignored = (target: string) =>
    !BUILT_IN_IMAGE.some((dir) => within(target, dir)) &&
    (rules.dirs.some((dir) => within(target, dir)) ||
      RESOLVED_SUFFIXES.some((suffix) => rules.files.has(`${target}${suffix}`)));
  const found: string[] = [];
  for (const file of imageFiles(ROOT, rules)) {
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const specifier = match[1];
      const target = specifier.startsWith('@/')
        ? specifier.slice(2)
        : specifier.startsWith('.')
          ? fromRoot(path.resolve(path.dirname(file), specifier))
          : null;
      if (target && ignored(target)) found.push(`${fromRoot(file)} → ${specifier}`);
    }
  }
  return found;
}

describe('.dockerignore a importy w kodzie budowanym w obrazie', () => {
  it('reguły obejmują katalogi z testami', () => {
    expect(ignoreRules().dirs).toEqual(expect.arrayContaining(['tests', 'e2e']));
  });

  it('skan obejmuje kod z obrazu, także pliki w katalogu głównym, i pomija testy', () => {
    const scanned = imageFiles(ROOT, ignoreRules()).map(fromRoot);
    expect(scanned).toEqual(expect.arrayContaining(['next.config.ts', 'proxy.ts', 'lib/supabase/server.ts']));
    expect(scanned.filter((file) => file.startsWith('tests/') || file === 'vitest.config.ts')).toEqual([]);
  });

  it('żaden plik w obrazie nie importuje katalogu ani pliku pominiętego w obrazie', () => {
    expect(importsOfIgnoredPaths()).toEqual([]);
  });
});
