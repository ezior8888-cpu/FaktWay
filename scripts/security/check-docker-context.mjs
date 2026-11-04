#!/usr/bin/env node
// CYB-DOCKER-CONTEXT-AGENTS: build only synthetic files, never the real repo context.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only synthetic names: private config, credential formats, and backup conventions.
const operatorFiles = [
  '.env', '.env.local', '.ENV.PRODUCTION', '.npmrc', '.NPMRC', 'faktflow-backup.env',
  '.ksef-test-certs/credentials.json', '.ksef-test-certs/server.pem',
  'server.pem', 'server.PEM', 'server.key', 'server.KEY', 'server.crt', 'server.CRT',
  'server.cer', 'server.CER', 'server.p12', 'server.P12', 'server.pfx', 'server.PFX',
  'backup_synthetic.sql', 'backup_synthetic.SQL', 'backup_synthetic.sql.gz',
  'faktflow-synthetic.dump', 'faktflow-synthetic.DUMP', 'faktflow-synthetic.dump.gz',
  '.partial-faktflow-synthetic.dump', 'faktflow-synthetic.dump.sha256',
  'faktflow-synthetic.roles.sql', 'faktflow-synthetic.roles.SQL',
  'faktflow-synthetic.roles.sql.gz', '.partial-faktflow-synthetic.roles.sql',
  'faktflow-synthetic.roles.sql.sha256', 'backups/db/synthetic.json.gz',
  '.outbox/synthetic-manifest.json',
];

export const privatePaths = [
  '.agents/infra.env', '.agents/README.md', '.codex/session.json', '.mcp.json', '.tmp/evidence.json',
  'local/.agents/infra.env', 'local/.codex/session.json', 'local/.mcp.json', 'local/.tmp/evidence.json',
  'local/session/.agents/infra.env', 'local/session/.codex/session.json',
  'local/session/.mcp.json', 'local/session/.tmp/evidence.json',
  ...['', 'local/', 'local/session/'].flatMap((prefix) => operatorFiles.map((name) => prefix + name)),
];
export const requiredPaths = [
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json',
  'app/globals.css', 'app/api/health/route.ts', 'lib/jobs/worker.ts', 'lib/jobs/server-only-hook.mjs',
  'lib/xml/schemas/fa3/schemat-local.xsd', 'lib/exports/schemas/jpk-v7m3/schemat-local.xsd',
  'lib/pdf/fonts/Roboto-Regular.ttf', 'content/help/pierwsze-kroki-w-faktway.mdx',
  'public/marketing/hero.jpg', 'README.md',
  'lib/backup/db-snapshot.ts', 'lib/auth/backup-codes.ts',
  'scripts/hetzner/db-backup.sh', 'scripts/hetzner/restore-drill.sh',
  'scripts/security/sql/01-rls-pokrycie.sql', 'public/favicon.zip',
  // Synthetic public dotfile: guard against over-broad exclusion of all hidden directories.
  'public/.well-known/security.txt',
];
const marker = 'SYNTHETIC-DOCKER-CONTEXT-CANARY\n';

function put(root, name, content = marker) {
  const target = join(root, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

export function createFixture(context, policy) {
  mkdirSync(context, { recursive: true });
  put(context, '.dockerignore', policy);
  // Built-in frontend + scratch: no registry image, frontend download, RUN, or network request.
  put(context, 'Dockerfile', 'FROM scratch\nCOPY . /app\n');
  for (const name of [...privatePaths, ...requiredPaths]) put(context, name);
}

export function verifyExport(output) {
  const app = join(output, 'app');
  for (const name of privatePaths) {
    assert.equal(existsSync(join(app, name)), false, `Private synthetic path entered context: ${name}`);
  }
  for (const name of requiredPaths) {
    assert.equal(readFileSync(join(app, name), 'utf8'), marker, `Required synthetic path missing: ${name}`);
  }
}

export function readPolicy(root, policyPath = join(root, '.dockerignore')) {
  // A production-specific file would override the policy exercised by this fixture.
  assert.equal(existsSync(join(root, 'Dockerfile.dockerignore')), false,
    'Dockerfile.dockerignore overrides the root policy; extend this check before adding it');
  return readFileSync(policyPath, 'utf8');
}

export function checkContext(policy) {
  const temporaryRoot = resolve(tmpdir());
  const fixtureRoot = mkdtempSync(join(temporaryRoot, 'ksef-docker-context-'));
  // Only delete the exact directory we created, directly under the system temp directory.
  assert.equal(dirname(resolve(fixtureRoot)), temporaryRoot);
  try {
    const context = join(fixtureRoot, 'context');
    const output = join(fixtureRoot, 'export');
    createFixture(context, policy);
    const result = spawnSync('docker', [
      'build', '--no-cache', '--progress=plain', '--output', `type=local,dest=${output}`,
      '--file', join(context, 'Dockerfile'), context,
    ], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, DOCKER_BUILDKIT: '1' },
    });
    if (result.error || result.status !== 0) {
      throw new Error('Docker context build failed; Docker/BuildKit must be available');
    }
    verifyExport(output);
    return { privatePaths: privatePaths.length, requiredPaths: requiredPaths.length };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(process.argv.length <= 3, 'Usage: check-docker-context.mjs [dockerignore-path]');
    const counts = checkContext(readPolicy(process.cwd(), process.argv[2]));
    // Fault injection: retaining only the earlier agent exclusions must still leak an env canary.
    // Builder/CLI failures do not satisfy the expected leak error.
    const agentsOnly = '**/.agents\n**/.codex\n**/.mcp.json\n**/.tmp\n';
    assert.throws(() => checkContext(agentsOnly), /Private synthetic path entered context: \.env/);
    console.log(`Docker context: PASS (${counts.privatePaths} private paths excluded; ${counts.requiredPaths} required paths retained; agents-only control rejected)`);
  } catch (error) {
    console.error(`Docker context: FAIL (${error instanceof Error ? error.message : 'validation failed'})`);
    process.exitCode = 1;
  }
}
