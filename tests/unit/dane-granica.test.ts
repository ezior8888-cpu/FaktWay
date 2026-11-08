import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * T1 (PLAN-PRAWDZIWE-DANE §5.2, §8): granica „przykład ↔ prawda”. Dane
 * przykładowe żyją wyłącznie w `lib/demo/*`; spoza tego katalogu wolno
 * importować tylko `lib/demo/tryb-danych` — jedno miejsce, które decyduje,
 * czy strona dostaje prawdziwy klient, czy atrapę. Pilnuje tego skan
 * importów i reguła ESLint `no-restricted-imports` (wyjątek: `lib/demo/**`
 * i `tests/**`).
 */

const ROOT = resolve(__dirname, '../..');
const DEMO_DIR = join(ROOT, 'lib/demo');
const DOZWOLONY = join(DEMO_DIR, 'tryb-danych');

function pliki(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : pliki(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}

/** Ścieżka bez rozszerzenia, do której prowadzi specyfikator (`@/…` albo względny). */
function cel(file: string, spec: string): string | null {
  if (spec.startsWith('@/')) return join(ROOT, spec.slice(2));
  if (spec.startsWith('.')) return resolve(dirname(file), spec);
  return null;
}

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

describe('granica importów lib/demo', () => {
  it('poza lib/demo/ nikt nie importuje danych przykładowych ani atrapy — tylko tryb-danych', () => {
    const naruszenia: string[] = [];
    for (const top of ['app', 'components', 'lib']) {
      for (const file of pliki(join(ROOT, top))) {
        if (file.startsWith(DEMO_DIR + '/')) continue;
        for (const [, spec] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
          const target = cel(file, spec!)?.replace(/\.(ts|tsx)$/, '');
          if (!target || !target.startsWith(DEMO_DIR + '/')) continue;
          if (target === DOZWOLONY) continue;
          naruszenia.push(`${relative(ROOT, file)} → ${spec}`);
        }
      }
    }
    expect(naruszenia).toEqual([]);
  });

  it('ESLint: no-restricted-imports zatrzymuje import lib/demo/* spoza lib/demo i testów', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const zakazane = async (filePath: string, code: string) => {
      const [result] = await eslint.lintText(code, { filePath: join(ROOT, filePath) });
      return result!.messages.filter((m) => m.ruleId === 'no-restricted-imports').length;
    };

    expect(await zakazane('app/(dashboard)/proba/page.tsx', "export { DEMO_TENANT } from '@/lib/demo/analizy-przykladowe';\n")).toBe(1);
    expect(await zakazane('components/proba.tsx', "import { fakePostgrest } from '@/lib/demo/fake-postgrest';\nexport const x = fakePostgrest;\n")).toBe(1);
    expect(await zakazane('lib/dashboard/proba.ts', "import { kpirPrzykladowe } from '../demo/kpir-przykladowe';\nexport const x = kpirPrzykladowe;\n")).toBe(1);
    expect(await zakazane('components/proba.tsx', "import { ZNACZNIKI_PRZYKLADU } from '@/lib/demo/znaczniki';\nexport const x = ZNACZNIKI_PRZYKLADU;\n")).toBe(1);

    expect(await zakazane('app/(dashboard)/proba/page.tsx', "import { kontekstDanych } from '@/lib/demo/tryb-danych';\nexport const x = kontekstDanych;\n")).toBe(0);
    expect(await zakazane('lib/demo/proba.ts', "import { fakePostgrest } from '@/lib/demo/fake-postgrest';\nexport const x = fakePostgrest;\n")).toBe(0);
    expect(await zakazane('tests/unit/proba.test.ts', "import { DEMO_TENANT } from '@/lib/demo/analizy-przykladowe';\nexport const x = DEMO_TENANT;\n")).toBe(0);
  }, 60_000);
});
