import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Uruchomienie PRAWDZIWEGO `scripts/ops/kontrola-faktur-ksef.sh` bez serwerów.
 *
 * Atrapa `ssh` pomija opcje i host, a komendę zdalną wykonuje `bash -c` —
 * tak jak sshd po stronie serwera, więc SQL przechodzi przez obie powłoki jak
 * na produkcji. Atrapę `docker` podaje test: zapis SQL (testy jednostkowe)
 * albo `psql` do lokalnej bazy testowej (testy na bazie).
 */

export const KONTROLA_SCRIPT = resolve(__dirname, '../../scripts/ops/kontrola-faktur-ksef.sh');

const FAKE_SSH = `#!/usr/bin/env bash
# Atrapa ssh: opcje i host pominięte; reszta złączona spacją idzie do powłoki (jak sshd).
while [ $# -gt 0 ]; do
  case "$1" in
    -i|-o|-p|-l|-F) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
host=$1; shift
if [ -n "\${FAKE_SSH_FAIL_HOST:-}" ] && [ "$host" = "$FAKE_SSH_FAIL_HOST" ]; then exit 255; fi
exec bash -c "$*"
`;

export interface ScriptRun {
  stdout: string;
  stderr: string;
  status: number | null;
}

export interface ScriptHarness {
  /** Katalog roboczy atrap (`FAKE_DIR` w atrapach). */
  dir: string;
  run(env?: Record<string, string>): ScriptRun;
  cleanup(): void;
}

export function createScriptHarness(fakeDocker: string): ScriptHarness {
  const dir = mkdtempSync(join(tmpdir(), 'kontrola-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'ssh'), FAKE_SSH);
  writeFileSync(join(dir, 'bin', 'docker'), fakeDocker);
  chmodSync(join(dir, 'bin', 'ssh'), 0o755);
  chmodSync(join(dir, 'bin', 'docker'), 0o755);
  writeFileSync(
    join(dir, 'infra.env'),
    [
      'K=/nie/ma/klucza',
      'APP=app.example.test',
      'DB=db.example.test',
      'PGC=pgc-test',
      'RESTC=rest-test',
      'APP_PREFIX=apptest',
      'WORKER_PREFIX=workertest',
    ].join('\n'),
  );

  return {
    dir,
    run(env = {}) {
      const result = spawnSync('bash', [KONTROLA_SCRIPT], {
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          NODE_ENV: 'test',
          PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
          HOME: dir,
          LANG: 'C.UTF-8',
          FAKTFLOW_INFRA_ENV: join(dir, 'infra.env'),
          FAKE_DIR: dir,
          ...env,
        },
      });
      return { stdout: result.stdout, stderr: result.stderr, status: result.status };
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Wyjście od nagłówka sekcji `n` do następnej sekcji (albo końca); `null`, gdy sekcji nie ma. */
export function scriptSection(stdout: string, n: number): string | null {
  const start = stdout.indexOf(`\n=== ${n}.`);
  if (start === -1) return null;
  const next = stdout.indexOf('\n=== ', start + 1);
  return stdout.slice(start, next === -1 ? undefined : next);
}

/** Wiersze wyniku pod etykietą `--- <początek etykiety>` aż do następnej etykiety. */
export function labelRows(section: string, labelStart: string): string[] {
  const lines = section.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`--- ${labelStart}`));
  if (at === -1) throw new Error(`brak etykiety „${labelStart}” w sekcji`);
  const rows: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith('--- ') || line.startsWith('=== ')) break;
    if (line.trim()) rows.push(line);
  }
  return rows;
}
