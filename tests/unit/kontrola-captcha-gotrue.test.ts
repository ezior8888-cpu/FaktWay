import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `scripts/ops/kontrola-captcha-gotrue.sh` (krok 2 po #330): stan
 * przełącznika w aplikacji, captcha w GoTrue i sonda logowania bez tokenu.
 * Uruchamiany jest PRAWDZIWY skrypt z atrapami `ssh` (komenda zdalna przez
 * `bash`, ze stdin — jak sshd), `docker` i `curl`. Sekrety nie mogą wyjść
 * na ekran, a stan D (GoTrue wymusza, aplikacja zużywa token) to kod 1.
 */

const SCRIPT = resolve(__dirname, '../../scripts/ops/kontrola-captcha-gotrue.sh');

const FAKE_SSH = `#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in
    -i|-o|-p|-l|-F) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
host=$1; shift
echo "$host" > "$FAKE_DIR/host"
exec bash -c "$*"
`;

// ps: kontener zależny od hosta; inspect: env aplikacji albo GoTrue.
const FAKE_DOCKER = `#!/usr/bin/env bash
host=$(cat "$FAKE_DIR/host")
case "$1" in
  ps) if [ "$host" = root@app.example.test ]; then echo apptest-abc123; echo workertest-def456; else echo supabase-auth-xyz; fi ;;
  inspect) if [ "$host" = root@app.example.test ]; then cat "$FAKE_DIR/env-app"; else cat "$FAKE_DIR/env-auth"; fi ;;
esac
`;

const FAKE_CURL = `#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out=$a; prev=$a; done
printf '%s\\n' "$*" > "$FAKE_DIR/curl-args"
printf '%s' "$FAKE_CURL_BODY" > "$out"
printf '%s' "$FAKE_CURL_CODE"
`;

const APP_SECRET = 'app-secret-value-should-never-print';
const ANON = 'anon-key-should-never-print';
const INVALID = { code: '400', body: '{"code":"invalid_credentials","message":"Invalid login credentials"}' };
const CAPTCHA = { code: '500', body: '{"code":"unexpected_failure","message":"captcha verification process failed"}' };

let dir: string;

function env(lines: string[]) {
  return lines.join('\n') + '\n';
}

function run(opts: { appSwitch?: string; gotrue?: string[]; probe: { code: string; body: string } }) {
  writeFileSync(join(dir, 'env-app'), env([
    'NODE_ENV=production',
    `NEXT_PUBLIC_SUPABASE_URL=https://auth.example.test`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON}`,
    `TURNSTILE_SECRET_KEY=${APP_SECRET}`,
    ...(opts.appSwitch !== undefined ? [`AUTH_CAPTCHA_IN_GOTRUE=${opts.appSwitch}`] : []),
  ]));
  writeFileSync(join(dir, 'env-auth'), env(['GOTRUE_SITE_URL=https://app.example.test', ...(opts.gotrue ?? [])]));
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      NODE_ENV: 'test',
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: dir,
      LANG: 'C.UTF-8',
      FAKTFLOW_INFRA_ENV: join(dir, 'infra.env'),
      FAKE_DIR: dir,
      FAKE_CURL_CODE: opts.probe.code,
      FAKE_CURL_BODY: opts.probe.body,
    },
  });
  return { out: result.stdout + result.stderr, status: result.status };
}

const gotrueOn = (secret = APP_SECRET) => [
  'GOTRUE_SECURITY_CAPTCHA_ENABLED=true',
  'GOTRUE_SECURITY_CAPTCHA_PROVIDER=turnstile',
  `GOTRUE_SECURITY_CAPTCHA_SECRET=${secret}`,
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kontrola-captcha-'));
  mkdirSync(join(dir, 'bin'));
  for (const [name, body] of [['ssh', FAKE_SSH], ['docker', FAKE_DOCKER], ['curl', FAKE_CURL]] as const) {
    writeFileSync(join(dir, 'bin', name), body);
    chmodSync(join(dir, 'bin', name), 0o755);
  }
  writeFileSync(join(dir, 'infra.env'), env(['K=/nie/ma/klucza', 'APP=app.example.test', 'DB=db.example.test', 'APP_PREFIX=apptest']));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('kontrola-captcha-gotrue.sh', () => {
  it('A: przed krokiem 2', () => {
    const { out, status } = run({ probe: INVALID });
    expect(out).toContain('A: przed krokiem 2');
    expect(status).toBe(0);
  });

  it('B: przełącznik włączony, GoTrue jeszcze nie', () => {
    const { out, status } = run({ appSwitch: 'true', probe: INVALID });
    expect(out).toContain('B: przejściowy');
    expect(status).toBe(0);
  });

  it('C: stan docelowy, sekrety zgodne', () => {
    const { out, status } = run({ appSwitch: 'true', gotrue: gotrueOn(), probe: CAPTCHA });
    expect(out).toContain('C: stan docelowy');
    expect(out).toContain('taki sam jak TURNSTILE_SECRET_KEY');
    expect(status).toBe(0);
  });

  it('D: GoTrue wymusza, a aplikacja zużywa token sama — kod 1 i co zrobić', () => {
    const { out, status } = run({ gotrue: gotrueOn(), probe: CAPTCHA });
    expect(out).toContain('D: ŹLE');
    expect(out).toContain('AUTH_CAPTCHA_IN_GOTRUE=true');
    expect(status).toBe(1);
  });

  it('inny sekret w GoTrue niż w aplikacji — ostrzeżenie i kod 1', () => {
    const { out, status } = run({ appSwitch: 'true', gotrue: gotrueOn('inny-sekret'), probe: CAPTCHA });
    expect(out).toContain('INNY niż TURNSTILE_SECRET_KEY');
    expect(out).toContain('GoTrue odrzuci tokeny');
    expect(status).toBe(1);
  });

  it('nie wypisuje sekretów ani klucza anon; sonda bez tokenu captcha na nieistniejące konto', () => {
    const { out } = run({ appSwitch: 'true', gotrue: gotrueOn(), probe: CAPTCHA });
    expect(out).not.toContain(APP_SECRET);
    expect(out).not.toContain(ANON);
    const args = readFileSync(join(dir, 'curl-args'), 'utf8');
    expect(args).toContain('https://auth.example.test/auth/v1/token?grant_type=password');
    expect(args).toContain('kontrola-captcha@example.invalid');
    expect(args).not.toMatch(/captcha_token|gotrue_meta_security/);
  });
});
