import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `scripts/ops/rotacja-kluczy.sh` (runbook docs/runbooks/rotacja-kluczy.md):
 * kontrola po każdym kroku rotacji. Uruchamiany jest PRAWDZIWY skrypt
 * z atrapami `ssh` (komenda zdalna przez `bash`, ze stdin — jak sshd),
 * `docker` i `curl`. Pilnujemy trzech rzeczy: żaden sekret nie trafia na
 * ekran ani do argumentów `curl`, rozjazd wartości między kontenerami to
 * kod 1, a zmiana od poprzedniej kontroli jest widoczna.
 */

const SCRIPT = resolve(__dirname, '../../scripts/ops/rotacja-kluczy.sh');

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

// ps: kontenery zależne od hosta; inspect: env, stan albo etykieta;
// exec: sonda (stdin) albo podgląd przeszyfrowania KSeF.
const FAKE_DOCKER = `#!/usr/bin/env bash
host=$(cat "$FAKE_DIR/host")
case "$1" in
  ps)
    if [ "$host" = root@app.example.test ]; then echo apptest-abc123; echo workertest-def456
    elif [ -f "$FAKE_DIR/db-down" ]; then :
    else echo supabase-auth-xyz; echo supabase-rest-xyz; echo supabase-kong-xyz; echo supabase-db-xyz; fi ;;
  inspect)
    fmt=$3; c=$4
    case "$fmt" in
      *Config.Env*)
        case "$c" in
          apptest-*) cat "$FAKE_DIR/env-app" ;;
          workertest-*) cat "$FAKE_DIR/env-worker" ;;
          supabase-auth-*) cat "$FAKE_DIR/env-auth" ;;
          supabase-rest-*) cat "$FAKE_DIR/env-rest" ;;
          supabase-kong-*) cat "$FAKE_DIR/env-kong" ;;
        esac ;;
      *State*) if [ -f "$FAKE_DIR/stan-$c" ]; then cat "$FAKE_DIR/stan-$c"; else echo "healthy 2026-11-08T10:00:00Z"; fi ;;
      *Labels*) echo "projekt-supabase-test" ;;
    esac ;;
  exec)
    case "$*" in
      *reencrypt*--apply*) touch "$FAKE_DIR/apply-called"; echo "Przeczytano: 3 (w bazie: 3). Przeszyfrowano: 2"; exit 0 ;;
      *reencrypt*) cat "$FAKE_DIR/ksef-out"; exit "$(cat "$FAKE_DIR/ksef-code")" ;;
      *psql*) printf 'production:1\ntest:2\n' ;;
      *)
        rola=$(printf '%s\\n' "$@" | sed -n 's/^ROTACJA_ROLA=//p')
        cat > "$FAKE_DIR/sonda-stdin-$rola"
        cat "$FAKE_DIR/probe-$rola" ;;
    esac ;;
esac
`;

// Zapisuje argumenty i stdin (konfiguracja z hasłem SMTP) do plików.
const FAKE_CURL = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/curl-args"
out=""; prev=""; stdin_cfg=0
for a in "$@"; do
  [ "$prev" = "-o" ] && out=$a
  [ "$prev" = "-K" ] && [ "$a" = "-" ] && stdin_cfg=1
  prev=$a
done
[ "$stdin_cfg" = 1 ] && cat > "$FAKE_DIR/curl-stdin"
case "$*" in
  *smtp://*) printf '250' ;;
  */api/health*) printf '{"status":"healthy"}' > "$out"; printf '200' ;;
  *provider=google*) printf '302 https://accounts.google.com/o/oauth2/v2/auth?client_id=x' ;;
  *) printf '000' ;;
esac
`;

function jwt(role: string, iat: number, tail: string) {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ role, iss: 'supabase', iat })}.podpis-${tail}`;
}

const IAT = 1786665600; // 2026-08-14
// Wartości losowane przy każdym przebiegu: żadna nie jest wpisana w kod, więc
// skaner sekretów (Secret scan, gitleaks) nie ma czego znaleźć w historii.
const fake = (label: string) => `${label}-${randomBytes(12).toString('hex')}`;
const S = {
  service: jwt('service_role', IAT, fake('service')),
  anon: jwt('anon', IAT, fake('anon')),
  ksef: fake('ksef'),
  unsub: fake('wypis'),
  resend: fake('resend'),
  webhook: fake('webhook'),
  turnstile: fake('turnstile'),
  slack: `https://example.test/slack/${fake('slack')}`,
  r2id: fake('minio-id'),
  r2secret: fake('minio'),
  jwtSecret: fake('jwt'),
};

const fp = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

const PROBE_OK = [
  'SONDA|gotrue-anon|ok|klucz anon przyjęty (200), Google: włączony',
  'SONDA|gotrue-serwis|ok|klucz service_role przyjęty przez GoTrue (200)',
  'SONDA|postgrest-serwis|ok|klucz service_role przyjęty przez PostgREST (200)',
  'SONDA|mail|ok|Resend przyjął mail do delivered@resend.dev (id abc)',
  'SONDA|minio|ok|zapis, odczyt i usunięcie obiektu próbnego w buckecie pliki',
].join('\n');

const KSEF_OK =
  'Przeczytano: 3 (w bazie: 3). Do przeszyfrowania (podgląd): 0, już na bieżącym kluczu: 3, zmienione w trakcie: 0, błędy: 0';

let dir: string;

interface Opts {
  app?: Record<string, string>;
  worker?: Record<string, string>;
  kong?: Record<string, string>;
  probeApp?: string;
  ksef?: { out: string; code: number };
}

function lines(o: Record<string, string>) {
  return Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

function run(opts: Opts = {}, args: string[] = []) {
  const shared = {
    NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: S.anon,
    SUPABASE_SERVICE_ROLE_KEY: S.service,
    KSEF_CREDENTIALS_ENCRYPTION_KEY: S.ksef,
    EMAIL_UNSUBSCRIBE_SECRET: S.unsub,
    RESEND_API_KEY: S.resend,
    SLACK_WEBHOOK_URGENT: S.slack,
    R2_ACCESS_KEY_ID: S.r2id,
    R2_SECRET_ACCESS_KEY: S.r2secret,
  };
  writeFileSync(join(dir, 'env-app'), lines({
    NODE_ENV: 'production',
    NEXT_PUBLIC_APP_URL: 'https://app.example.test',
    ...shared,
    RESEND_WEBHOOK_SECRET: S.webhook,
    TURNSTILE_SECRET_KEY: S.turnstile,
    ...opts.app,
  }));
  writeFileSync(join(dir, 'env-worker'), lines({ ...shared, ...opts.worker }));
  writeFileSync(join(dir, 'env-auth'), lines({
    GOTRUE_JWT_SECRET: S.jwtSecret,
    GOTRUE_SMTP_HOST: 'smtp.resend.com',
    GOTRUE_SMTP_PORT: '587',
    GOTRUE_SMTP_USER: 'resend',
    GOTRUE_SMTP_PASS: S.resend,
    GOTRUE_SMTP_ADMIN_EMAIL: 'no-reply@example.test',
    GOTRUE_EXTERNAL_GOOGLE_ENABLED: 'true',
  }));
  writeFileSync(join(dir, 'env-rest'), lines({ PGRST_JWT_SECRET: S.jwtSecret }));
  writeFileSync(join(dir, 'env-kong'), lines({ SUPABASE_ANON_KEY: S.anon, SUPABASE_SERVICE_KEY: S.service, ...opts.kong }));
  writeFileSync(join(dir, 'probe-app'), (opts.probeApp ?? PROBE_OK) + '\n');
  writeFileSync(join(dir, 'probe-worker'), PROBE_OK + '\n');
  writeFileSync(join(dir, 'ksef-out'), (opts.ksef?.out ?? KSEF_OK) + '\n');
  writeFileSync(join(dir, 'ksef-code'), String(opts.ksef?.code ?? 0));
  rmSync(join(dir, 'curl-args'), { force: true });

  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      NODE_ENV: 'test',
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: dir,
      LANG: 'C.UTF-8',
      FAKTFLOW_INFRA_ENV: join(dir, 'infra.env'),
      ROTACJA_STAN: join(dir, 'stan'),
      FAKE_DIR: dir,
    },
  });
  return { out: result.stdout + result.stderr, status: result.status };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rotacja-kluczy-'));
  mkdirSync(join(dir, 'bin'));
  for (const [name, body] of [['ssh', FAKE_SSH], ['docker', FAKE_DOCKER], ['curl', FAKE_CURL]] as const) {
    writeFileSync(join(dir, 'bin', name), body);
    chmodSync(join(dir, 'bin', name), 0o755);
  }
  writeFileSync(join(dir, 'infra.env'), [
    'K=/nie/ma/klucza', 'APP=app.example.test', 'DB=db.example.test',
    'APP_PREFIX=apptest', 'WORKER_PREFIX=workertest', 'RESTC=supabase-rest', 'PGC=supabase-db-xyz', '',
  ].join('\n'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('rotacja-kluczy.sh', () => {
  it('wszystko spójne i działa: kod 0, odciski zamiast wartości, wiek kluczy z JWT', () => {
    const { out, status } = run();
    expect(out).toContain('Wszystko OK.');
    expect(status).toBe(0);
    expect(out).toContain(fp(S.service));
    expect(out).toContain(fp(S.resend));
    expect(out).toContain('SUPABASE_SERVICE_ROLE_KEY: rola service_role, wystawiony 2026-08-14');
    expect(out).toContain('GoTrue i PostgREST: ten sam sekret JWT');
    expect(out).toContain('klucz anon aplikacji = klucz w Kongu');
    expect(out).toContain('SMTP GoTrue używa tego samego klucza Resend');
    expect(out).toContain('[GoTrue] smtp: serwer SMTP przyjął mail (250)');
    expect(out).toContain('KSeF: wszystkie zapisy odszyfrowują się');
    expect(out).toContain('(pierwszy zapis)');
    expect(out).toContain('firmy z zapisanymi danymi KSeF (środowisko: liczba): production:1 test:2');
    expect(existsSync(join(dir, 'apply-called'))).toBe(false);
  });

  it('nie wypisuje żadnego sekretu, a hasło SMTP podaje curl przez stdin, nie w argumentach', () => {
    const { out } = run();
    for (const secret of Object.values(S)) expect(out).not.toContain(secret);
    const args = readFileSync(join(dir, 'curl-args'), 'utf8');
    for (const secret of Object.values(S)) expect(args).not.toContain(secret);
    expect(readFileSync(join(dir, 'curl-stdin'), 'utf8')).toContain(`user = "resend:${S.resend}"`);
    // Sonda dostaje kod przez stdin docker exec, a rola i adres przez -e.
    expect(readFileSync(join(dir, 'sonda-stdin-app'), 'utf8')).toContain('SONDA|');
    expect(existsSync(join(dir, 'sonda-stdin-worker'))).toBe(true);
  });

  it('zapis odcisków: następna kontrola pokazuje, który klucz się zmienił', () => {
    run();
    const nowy = fake('resend-nowy');
    const { out } = run({ app: { RESEND_API_KEY: nowy }, worker: { RESEND_API_KEY: nowy } });
    expect(out).toMatch(/RESEND_API_KEY\s+\S+\s+\S+\s+ZMIENIONY/);
    expect(out).toMatch(/EMAIL_UNSUBSCRIBE_SECRET\s+\S+\s+\S+\s+bez zmian/);
    expect(out).not.toContain(nowy);
    const stan = readFileSync(join(dir, 'stan', 'odciski.txt'), 'utf8');
    expect(stan).toContain(`app.RESEND_API_KEY=${fp(nowy)}`);
    expect(stan).not.toContain(nowy);
  });

  it('worker z innym sekretem wypisu niż aplikacja: BŁĄD i kod 1', () => {
    const { out, status } = run({ worker: { EMAIL_UNSUBSCRIBE_SECRET: fake('inny-wypis') } });
    expect(out).toContain('BŁĄD   EMAIL_UNSUBSCRIBE_SECRET: aplikacja i worker mają RÓŻNE wartości');
    expect(status).toBe(1);
  });

  it('nowy klucz service_role w aplikacji, stary w Kongu: BŁĄD i kod 1', () => {
    const { out, status } = run({ kong: { SUPABASE_SERVICE_KEY: jwt('service_role', IAT, 'stary') } });
    expect(out).toContain('klucz service_role aplikacji różni się od klucza w Kongu');
    expect(status).toBe(1);
  });

  it('sonda zgłasza błąd (np. MinIO odrzuca klucz): BŁĄD z nazwą kontroli i kod 1', () => {
    const { out, status } = run({
      probeApp: PROBE_OK.replace(/SONDA\|minio\|ok\|.*/, 'SONDA|minio|blad|InvalidAccessKeyId'),
    });
    expect(out).toContain('BŁĄD   [app] minio: InvalidAccessKeyId');
    expect(status).toBe(1);
  });

  it('KSeF: zapis, którego nie da się odszyfrować kluczami z env, to BŁĄD', () => {
    const { out, status } = run({
      ksef: {
        out: 'Przeczytano: 3 (w bazie: 3). Do przeszyfrowania (podgląd): 0, już na bieżącym kluczu: 2, zmienione w trakcie: 0, błędy: 1\n'
          + 'firma 00000000-0000-0000-0000-000000000001: błąd odszyfrowania',
        code: 1,
      },
    });
    expect(out).toMatch(/BŁĄD {3}KSeF: Przeczytano: 3/);
    expect(out).toContain('błąd odszyfrowania');
    expect(status).toBe(1);
  });

  it('KSeF w trakcie rotacji: poprzedni klucz ustawiony w obu kontenerach, zapisy do przeszyfrowania jako informacja', () => {
    const prev = fake('ksef-stary');
    const { out, status } = run({
      app: { KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS: prev },
      worker: { KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS: prev },
      ksef: {
        out: 'Przeczytano: 3 (w bazie: 3). Do przeszyfrowania (podgląd): 2, już na bieżącym kluczu: 1, zmienione w trakcie: 0, błędy: 0',
        code: 0,
      },
    });
    expect(out).toContain('trwa rotacja klucza KSeF');
    expect(out).toContain('KSeF: 2 zapisów na starym kluczu');
    expect(out).not.toContain(prev);
    expect(status).toBe(0);
  });

  it('przeszyfruj-ksef: zapis w workerze tylko przy zielonej spójności', () => {
    const { out, status } = run({}, ['przeszyfruj-ksef']);
    expect(existsSync(join(dir, 'apply-called'))).toBe(true);
    expect(out).toContain('KSeF: przeszyfrowanie zakończone kompletnie');
    expect(status).toBe(0);
  });

  it('przeszyfruj-ksef przy różnych kluczach KSeF w aplikacji i workerze: bez zapisu, BŁĄD', () => {
    const { out, status } = run({ worker: { KSEF_CREDENTIALS_ENCRYPTION_KEY: fake('ksef-inny') } }, ['przeszyfruj-ksef']);
    expect(existsSync(join(dir, 'apply-called'))).toBe(false);
    expect(out).toContain('przeszyfrowanie pominięte: najpierw popraw błędy spójności');
    expect(status).toBe(1);
  });

  it('nieznany argument: użycie i kod 1, bez połączeń z serwerami', () => {
    const { out, status } = run({}, ['rotuj-wszystko']);
    expect(out).toContain('Użycie:');
    expect(status).toBe(1);
    expect(existsSync(join(dir, 'host'))).toBe(false);
  });

  it('nieudany odczyt db-1 nie kasuje punktu odniesienia dla kluczy Supabase', () => {
    run();
    writeFileSync(join(dir, 'db-down'), '');
    const { status } = run();
    expect(status).toBe(1);
    rmSync(join(dir, 'db-down'));
    const { out } = run();
    expect(out).toMatch(/gotrue\.GOTRUE_JWT_SECRET\s+\S+\s+bez zmian/);
    expect(out).toMatch(/kong\.SUPABASE_SERVICE_KEY\s+\S+\s+bez zmian/);
  });

  it('worker tuż po Restarcie (starting): informacja, nie BŁĄD', () => {
    writeFileSync(join(dir, 'stan-workertest-def456'), 'starting 2026-11-08T10:00:00Z\n');
    const { out, status } = run();
    expect(out).toContain('kontener worker: dopiero startuje');
    expect(status).toBe(0);
  });
});
