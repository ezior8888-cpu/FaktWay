import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Granice modułów synchronizacji historii KSeF (decyzja Bartosza 22.10.2026,
 * punkt 13 krytyki i inwariant 21):
 *   - `lib/ksef/history-sync/constants.ts` i `lib/ksef/hwm.ts` są CZYSTE —
 *     bez importów spoza swojego folderu (ekran importuje stałe; zegar, baza
 *     i KSeF nie mogą wejść tędy do paczki klienta),
 *   - `windows.ts` — tylko stałe i `lib/ksef/hwm`,
 *   - runner i cały `lib/ksef/history-sync/` (także przechodnio) nie sięgają
 *     ścieżki wysyłki: `lib/ksef/submit*`, `submit-invoice-full`,
 *     `send-attempt-ledger`, runnery wysyłki.
 */

const ROOT = process.cwd();
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|^import\s+)['"]([^'"]+)['"]/gm;

function imports(file: string): string[] {
  const source = readFileSync(join(ROOT, file), 'utf8');
  return [...source.matchAll(IMPORT_RE)].map((m) => m[1]!);
}

function resolveImport(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = relative(ROOT, resolve(ROOT, dirname(from), spec));
  else return null;
  for (const suffix of ['.ts', '.tsx', '/index.ts', '']) {
    const candidate = base + suffix;
    if (existsSync(join(ROOT, candidate)) && candidate.match(/\.tsx?$/)) return candidate.split('\\').join('/');
  }
  return null;
}

function reachable(start: string): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const file = queue.shift()!;
    for (const spec of imports(file)) {
      const target = resolveImport(spec, file);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

const HISTORY_DIR = 'lib/ksef/history-sync';
const HISTORY_FILES = readdirSync(join(ROOT, HISTORY_DIR)).filter((f) => f.endsWith('.ts')).map((f) => `${HISTORY_DIR}/${f}`);
const RUNNER = 'lib/jobs/runners/ksef-history-sync.ts';

const SEND_PATH = [
  /^lib\/ksef\/submit[^/]*\.ts$/,
  /^lib\/ksef\/submit-invoice-full\.ts$/,
  /^lib\/ksef\/send-attempt-ledger\.ts$/,
  /^lib\/jobs\/runners\/submit-invoice\.ts$/,
  /^lib\/jobs\/runners\/process-offline-queue\.ts$/,
  /^lib\/jobs\/runners\/self-invoice-payment\.ts$/,
];

describe('czystość stałych i okien', () => {
  it('constants.ts — bez importów spoza folderu (ani jednego)', () => {
    expect(imports(`${HISTORY_DIR}/constants.ts`)).toEqual([]);
  });

  it('lib/ksef/hwm.ts — bez importów', () => {
    expect(imports('lib/ksef/hwm.ts')).toEqual([]);
  });

  it('windows.ts — tylko stałe i lib/ksef/hwm', () => {
    expect(imports(`${HISTORY_DIR}/windows.ts`).sort()).toEqual(['./constants', '@/lib/ksef/hwm']);
  });
});

describe('historia nie sięga ścieżki wysyłki (przechodnio)', () => {
  it.each([RUNNER, ...HISTORY_FILES])('%s', (file) => {
    const reached = [...reachable(file)].filter((f) => SEND_PATH.some((re) => re.test(f)));
    expect(reached).toEqual([]);
  });

  it('strażnik widzi pliki historii (sanity)', () => {
    expect(HISTORY_FILES).toEqual(expect.arrayContaining([
      `${HISTORY_DIR}/budget.ts`, `${HISTORY_DIR}/classify.ts`, `${HISTORY_DIR}/client-pause.ts`, `${HISTORY_DIR}/constants.ts`,
      `${HISTORY_DIR}/db.ts`, `${HISTORY_DIR}/errors.ts`, `${HISTORY_DIR}/query.ts`, `${HISTORY_DIR}/status.ts`, `${HISTORY_DIR}/windows.ts`,
    ]));
    expect(reachable(RUNNER).size).toBeGreaterThan(20);
  });
});
