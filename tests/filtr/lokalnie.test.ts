import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KATALOG_REPO } from '@/scripts/filtr/mapa.mjs';

/**
 * `pnpm filtr:lokalnie` (scripts/filtr/lokalnie.mjs) ma naprawdę uruchomić
 * testy filtra przez `pnpm exec vitest …`, także na Windows. Tam `pnpm` to
 * skrypt `pnpm.cmd`: spawn bez powłoki go nie znajduje (ENOENT, status null),
 * więc krok testów kończył się kodem 1, zanim cokolwiek wystartowało, i skrypt
 * był na Windows zawsze czerwony (PR #652, ustalenie 7).
 */

const TESTY_FILTRA = ['exec', 'vitest', 'run', '--config', 'vitest.filtr.config.ts'];

let katalog = '';
afterEach(() => {
  if (katalog) rmSync(katalog, { recursive: true, force: true });
  katalog = '';
});

/**
 * Prawdziwy skrypt z atrapą pnpm na początku PATH. Atrapa zapisuje swoje
 * argumenty i kończy się kodem 0, więc testy filtra nie uruchamiają się
 * rekurencyjnie. Na Windows atrapa to `pnpm.cmd`, jak prawdziwy pnpm z npm.
 */
function uruchomZAtrapaPnpm() {
  katalog = mkdtempSync(join(tmpdir(), 'filtr-lokalnie-'));
  const naWindows = process.platform === 'win32';
  const atrapa = join(katalog, naWindows ? 'pnpm.cmd' : 'pnpm');
  const zapis = join(katalog, 'wywolanie');
  writeFileSync(atrapa, naWindows ? `@echo %* > "${zapis}"\r\n` : `#!/bin/sh\necho "$@" > "${zapis}"\n`);
  chmodSync(atrapa, 0o755);
  // Na Windows zmienna nazywa się zwykle `Path`: bez usunięcia starego klucza w env byłyby
  // dwa (Path i PATH) i to, który wygra, zależałoby od Node, a nie od testu.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const klucz of Object.keys(env)) if (/^path$/i.test(klucz)) delete env[klucz];
  env.PATH = `${katalog}${delimiter}${process.env.PATH ?? ''}`;
  const wynik = spawnSync(process.execPath, ['scripts/filtr/lokalnie.mjs', 'HEAD'], {
    cwd: KATALOG_REPO,
    encoding: 'utf8',
    timeout: 50_000,
    env,
  });
  return { ...wynik, pnpm: existsSync(zapis) ? readFileSync(zapis, 'utf8').trim() : null };
}

/** Wywołania spawnSync, które skrypt robi na udawanej platformie (bez uruchamiania czegokolwiek). */
async function wywolaniaNaPlatformie(platforma: NodeJS.Platform) {
  const wywolania: unknown[][] = [];
  vi.doMock('node:child_process', async (oryginal) => ({
    ...(await oryginal<typeof import('node:child_process')>()),
    spawnSync: (...argumenty: unknown[]) => {
      wywolania.push(argumenty);
      return { status: 0, stdout: JSON.stringify({ poziom: 'R0' }) };
    },
  }));
  const opisPlatformy = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!opisPlatformy) throw new Error('process.platform bez deskryptora');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const blad = vi.spyOn(console, 'error').mockImplementation(() => {});
  const poprzedniKod = process.exitCode;
  Object.defineProperty(process, 'platform', { ...opisPlatformy, value: platforma });
  try {
    vi.resetModules();
    await import('@/scripts/filtr/lokalnie.mjs');
  } finally {
    Object.defineProperty(process, 'platform', opisPlatformy);
    log.mockRestore();
    blad.mockRestore();
    vi.doUnmock('node:child_process');
    vi.resetModules();
    process.exitCode = poprzedniKod;
  }
  return wywolania;
}

describe('pnpm filtr:lokalnie', () => {
  it('krok testów filtra naprawdę uruchamia pnpm exec vitest z konfiguracją filtra', () => {
    const r = uruchomZAtrapaPnpm();
    expect(r.error).toBeUndefined();
    expect(r.stdout).toContain('[FILTR] Testy filtra (vitest.filtr.config.ts)');
    expect(r.pnpm, `pnpm nie wystartował.\n${r.stdout}\n${r.stderr}`).toBe(TESTY_FILTRA.join(' '));
  }, 60_000);

  it.each([
    ['win32', true],
    ['linux', false],
    ['darwin', false],
  ] as const)('%s: pnpm przez powłokę tylko na Windows (pnpm.cmd bez powłoki to ENOENT, a sam .cmd to EINVAL)', async (platforma, przezPowloke) => {
    const wywolania = await wywolaniaNaPlatformie(platforma);
    const pnpm = wywolania.find(([polecenie]) => String(polecenie).split(' ')[0] === 'pnpm');
    expect(pnpm, JSON.stringify(wywolania)).toBeDefined();
    const [polecenie, argumentyAlboOpcje, opcje] = pnpm ?? [];
    const argumenty = Array.isArray(argumentyAlboOpcje) ? argumentyAlboOpcje : [];
    const ustawienia = (Array.isArray(argumentyAlboOpcje) ? opcje : argumentyAlboOpcje) as { shell?: unknown; cwd?: unknown };
    expect([polecenie, ...argumenty].join(' ')).toBe(['pnpm', ...TESTY_FILTRA].join(' '));
    expect(Boolean(ustawienia?.shell)).toBe(przezPowloke);
    expect(ustawienia?.cwd).toBe(KATALOG_REPO);
  });
});
