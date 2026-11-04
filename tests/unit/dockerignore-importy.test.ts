import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Obraz Dockera nie ma katalogów z `.dockerignore`, a `next build` sprawdza typy
 * wszystkich plików z `tsconfig.json`, także `scripts/`. Import z `tests/` przechodzi
 * więc lokalnie i w CI (pełna kopia repo), a pada dopiero po 16 minutach budowania
 * na produkcji. Tak padło wdrożenie #363 przez `scripts/test-ksef-kreator.ts`.
 */
const ROOT = path.resolve(__dirname, '../..');
const SOURCE_DIRS = ['app', 'components', 'lib', 'scripts', 'types', 'hooks', 'emails'];
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)['"]([^'"]+)['"]/g;

function ignoreRules(): { dirs: string[]; files: Set<string> } {
  const lines = readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!') && !line.includes('*'));
  return {
    dirs: lines.filter((line) => existsSync(path.join(ROOT, line)) && statSync(path.join(ROOT, line)).isDirectory()),
    files: new Set(lines),
  };
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Pliki w obrazie, które importują coś z katalogu pominiętego w obrazie. */
function importsOfIgnoredDirs(): string[] {
  const { dirs, files } = ignoreRules();
  const found: string[] = [];
  for (const file of SOURCE_DIRS.flatMap((dir) => sourceFiles(path.join(ROOT, dir)))) {
    const relative = path.relative(ROOT, file);
    if (files.has(relative)) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const specifier = match[1];
      const target = specifier.startsWith('@/')
        ? specifier.slice(2)
        : specifier.startsWith('.')
          ? path.relative(ROOT, path.resolve(path.dirname(file), specifier))
          : null;
      if (target && dirs.some((dir) => target === dir || target.startsWith(`${dir}/`))) {
        found.push(`${relative} → ${specifier}`);
      }
    }
  }
  return found;
}

describe('.dockerignore a importy w kodzie budowanym w obrazie', () => {
  it('reguły obejmują katalogi z testami', () => {
    expect(ignoreRules().dirs).toEqual(expect.arrayContaining(['tests', 'e2e']));
  });

  it('żaden plik w obrazie nie importuje z katalogu pominiętego w obrazie', () => {
    expect(importsOfIgnoredDirs()).toEqual([]);
  });
});
