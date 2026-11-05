import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `pnpm db:push:prod` to pozostałość po Supabase Cloud (`supabase db push`).
 * Na self-hosted db-1 migracje wgrywa `scripts/ops/wgraj-migracje.sh`
 * (schema_migrations, NOTIFY pgrst, kontrola PostgREST-a). Skrypt ma kończyć
 * się błędem z odnośnikiem, a nie wypychać migracji, nawet gdy ktoś ustawi
 * SUPABASE_DB_URL (np. przez tunel do db-1).
 */

const SCRIPTS = {
  mjs: resolve(__dirname, '../../scripts/supabase-push-production.mjs'),
  sh: resolve(__dirname, '../../scripts/supabase-push-production.sh'),
};
const hasBash = spawnSync('bash', ['--version']).status === 0;
let dir = '';

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function run(kind: keyof typeof SCRIPTS, args: string[] = []) {
  dir = mkdtempSync(join(tmpdir(), 'db-push-prod-'));
  // Atrapa npx: zapisuje wywołanie zamiast pobierać Supabase CLI.
  const npx = join(dir, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  writeFileSync(npx, process.platform === 'win32' ? `@echo %* > "${dir}\\calls"\r\n` : `#!/bin/sh\necho "$@" > "${dir}/calls"\n`);
  chmodSync(npx, 0o755);
  const result = spawnSync(kind === 'mjs' ? process.execPath : 'bash', [SCRIPTS[kind], ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
      SUPABASE_DB_URL: 'postgresql://atrapa@127.0.0.1:1/atrapa',
    },
  });
  const calls = join(dir, 'calls');
  return { ...result, npx: existsSync(calls) ? readFileSync(calls, 'utf8') : null };
}

describe('pnpm db:push:prod', () => {
  it.each([
    ['mjs', []],
    ['mjs', ['--dry-run']],
    ...(hasBash ? ([['sh', []], ['sh', ['--dry-run']]] as const) : []),
  ] as const)('%s %j z SUPABASE_DB_URL nie woła supabase db push i odsyła do wgraj-migracje.sh', (kind, args) => {
    const r = run(kind, [...args]);
    expect(r.npx).toBeNull();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('scripts/ops/wgraj-migracje.sh');
  });
});
