import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Plan usprawnień 3.4: cotygodniowa próba odtworzenia z alarmem.
 * `scripts/hetzner/restore-drill.sh` wydaje werdykt (kod wyjścia, linia
 * `WYNIK:`), a `restore-drill-tydzien.sh` bierze najnowszy kompletny zrzut
 * z db-backup.sh, sprawdza sumy, miejsce i obraz, i pinguje Healthchecks.
 *
 * Uruchamiane są PRAWDZIWE skrypty (kopie z końcami LF). Atrapy w PATH:
 * `docker` (psql, pg_restore, inspect, info), `curl` (pingi), `flock`, `df`.
 * `sha256sum`, `find`, `join`, `comm`, `awk` są prawdziwe.
 */

const DRILL = resolve(__dirname, '../../scripts/hetzner/restore-drill.sh');
const WEEKLY = resolve(__dirname, '../../scripts/hetzner/restore-drill-tydzien.sh');
const HC = 'https://hc.example.test/ping/restore-drill';
const PROD_IMAGE = 'supabase/postgres:15.8.1.999';

// Oczekiwane 4 błędy pg_restore przy wgraniu do świeżego obrazu (runbook § 4).
const EXPECTED_ERRORS = [
  'pg_restore: error: could not execute query: ERROR:  schema "storage" already exists',
  'pg_restore: error: could not execute query: ERROR:  cannot drop schema storage because other objects depend on it',
  'pg_restore: error: could not execute query: ERROR:  cannot drop constraint users_pkey on table auth.users because other objects depend on it',
  'pg_restore: error: could not execute query: ERROR:  function graphql_public.graphql(text, text, jsonb, jsonb) does not exist',
].join('\n');
const TOC = [
  ';',
  '; Archive created at 2026-11-07 01:30:00 UTC',
  '4000; 0 16400 TABLE DATA auth users supabase_auth_admin',
  '4001; 0 16500 TABLE DATA public tenants postgres',
  '4002; 0 16501 TABLE DATA public invoices postgres',
  '4003; 0 16600 TABLE DATA extensions pg_stat_x postgres',
].join('\n');
const COUNTS = ['auth.users|3', 'public.invoices|10', 'public.tenants|2'].join('\n');
const STRUCT = ['polityki RLS|71', 'tabele public z RLS|67', 'ostatnia migracja|20261101000000'].join('\n');

const FAKE_DOCKER = `#!/usr/bin/env bash
# Atrapa docker. Odpowiedzi z plików $FAKE_DIR/<nazwa> (testy je nadpisują).
printf 'docker %s\\n' "$*" >> "$FAKE_DIR/calls"
f() { cat "$FAKE_DIR/$1" 2>/dev/null; }
case "$1" in
  ps) f ps; exit 0 ;;
  run) echo cid; exit 0 ;;
  rm|cp|logs) exit 0 ;;
  inspect) f image; [ -s "$FAKE_DIR/image" ] || exit 1; exit 0 ;;
  info) echo "$FAKE_DIR"; exit 0 ;;
  exec) ;;
  *) exit 0 ;;
esac
args="$*"
case "$args" in
  *"pg_roles"*) echo 1 ;;
  *"pg_restore -l"*) f toc ;;
  *"pg_restore"*) f restore-errors >&2; exit 1 ;;
  *"information_schema.tables"*) f counts ;;
  *"polityki RLS"*) f struct ;;
  *"psql"*" -q"*) cat > /dev/null; f role-out ;;
esac
exit 0
`;

const FAKE_CURL = `#!/usr/bin/env bash
# Atrapa curl: adres pingu (ostatni argument) i treść (--data-raw).
body=""; prev=""
for a; do [ "$prev" = --data-raw ] && body=$a; prev=$a; url=$a; done
printf '%s %s\\n' "$url" "$body" >> "$FAKE_DIR/pings"
`;

const FAKE_FLOCK = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/flock-calls"
exit "\${FAKE_FLOCK_RC:-0}"
`;

const FAKE_DF = `#!/usr/bin/env bash
# df -Pk: kolumny jak POSIX, wartości w KB z FAKE_DF_AVAIL_KB i FAKE_DF_SIZE_KB.
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/sda1 %s 0 %s 50%% /\\n' "$FAKE_DF_SIZE_KB" "$FAKE_DF_AVAIL_KB"
`;

const posix = (p: string) => p.replace(/\\/g, '/');

interface Run {
  status: number | null;
  out: string;
  calls: string[];
  pings: string[];
}

function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'restore-drill-'));
  const bin = join(dir, 'bin');
  const backups = join(dir, 'backups');
  mkdirSync(bin);
  mkdirSync(backups);
  const drill = join(dir, 'restore-drill.sh');
  const weekly = join(dir, 'restore-drill-tydzien.sh');
  writeFileSync(drill, readFileSync(DRILL, 'utf8').replace(/\r\n/g, '\n'));
  writeFileSync(weekly, readFileSync(WEEKLY, 'utf8').replace(/\r\n/g, '\n'));
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  fake('docker', FAKE_DOCKER);
  fake('curl', FAKE_CURL);
  fake('flock', FAKE_FLOCK);
  fake('df', FAKE_DF);

  const answers: Record<string, string> = {
    toc: TOC,
    'restore-errors': EXPECTED_ERRORS,
    counts: COUNTS,
    struct: STRUCT,
    'role-out': 'ERROR:  role "anon" already exists\nERROR:  role "authenticated" already exists',
    image: PROD_IMAGE,
    ps: '',
  };
  // Jak /etc/faktflow-backup.env (z HC_URL zrzutu, którego próba nie może użyć)
  // i /etc/faktflow-restore-drill.env.
  const backupConfig: Record<string, string> = { PGC: 'pgc-test', BACKUP_DIR: posix(backups), HC_URL: 'https://hc.example.test/ping/db-backup' };
  const drillConfig: Record<string, string> = { DRILL_HC_URL: HC, DRILL_SCRIPT: posix(drill), LOCK_FILE: posix(join(dir, 'lock')) };

  const env = (extra: Record<string, string>) => ({
    NODE_ENV: 'test' as const,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    HOME: dir,
    LANG: 'C.UTF-8',
    FAKE_DIR: posix(dir),
    FAKE_DF_AVAIL_KB: String(20 * 1024 * 1024),
    FAKE_DF_SIZE_KB: String(40 * 1024 * 1024),
    READY_PAUSE: '0',
    ...extra,
  });
  const collect = (result: ReturnType<typeof spawnSync>): Run => {
    const lines = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean) : []);
    return { status: result.status, out: `${result.stdout}${result.stderr}`, calls: lines('calls'), pings: lines('pings') };
  };
  const prepare = () => {
    for (const [k, v] of Object.entries(answers)) writeFileSync(join(dir, k), v);
    for (const f of ['calls', 'pings']) rmSync(join(dir, f), { force: true });
  };

  return {
    dir,
    backups,
    answers,
    backupConfig,
    drillConfig,
    /** restore-drill.sh wprost (jak w comiesięcznej próbie). */
    drill(args: string[], extra: Record<string, string> = {}): Run {
      prepare();
      return collect(spawnSync('bash', [posix(drill), ...args], { encoding: 'utf8', timeout: 60_000, env: env(extra) }));
    },
    /** restore-drill-tydzien.sh (jak timer systemd). */
    weekly(extra: Record<string, string> = {}): Run {
      prepare();
      const bc = join(dir, 'faktflow-backup.env');
      const dc = join(dir, 'faktflow-restore-drill.env');
      writeFileSync(bc, Object.entries(backupConfig).map(([k, v]) => `${k}=${v}\n`).join(''));
      writeFileSync(dc, Object.entries(drillConfig).map(([k, v]) => `${k}=${v}\n`).join(''));
      return collect(
        spawnSync('bash', [posix(weekly)], {
          encoding: 'utf8',
          timeout: 60_000,
          env: env({ FAKTFLOW_BACKUP_CONFIG: posix(bc), FAKTFLOW_DRILL_CONFIG: posix(dc), ...extra }),
        }),
      );
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let h: ReturnType<typeof createHarness>;

/** Kompletny zrzut jak z db-backup.sh: .dump, .roles.sql i plik sum na końcu. */
function seedDump(name: string, opts: { complete?: boolean; badSum?: boolean; ageHours?: number } = {}) {
  const files = { [`${name}.dump`]: `dump ${name}`, [`${name}.roles.sql`]: 'CREATE ROLE anon;\n' };
  for (const [f, c] of Object.entries(files)) writeFileSync(join(h.backups, f), c);
  if (opts.complete === false) return;
  const sums = Object.entries(files)
    .map(([f, c]) => `${opts.badSum ? '0'.repeat(64) : createHash('sha256').update(c).digest('hex')}  ${f}`)
    .join('\n');
  const sha = join(h.backups, `${name}.sha256`);
  writeFileSync(sha, `${sums}\n`);
  if (opts.ageHours) {
    const t = Date.now() / 1000 - opts.ageHours * 3600;
    utimesSync(sha, t, t);
  }
}

describe('restore-drill.sh: werdykt próby', { timeout: 60_000 }, () => {
  beforeEach(() => {
    h = createHarness();
    seedDump('faktflow-20261107T013000Z');
  });
  afterEach(() => h.cleanup());
  const args = () => [posix(join(h.backups, 'faktflow-20261107T013000Z.dump')), posix(join(h.backups, 'faktflow-20261107T013000Z.roles.sql'))];

  it('4 oczekiwane błędy, komplet tabel, polityki i migracja: WYNIK OK, kod 0, kontener usunięty', () => {
    const run = h.drill(args());
    expect(run.status, run.out).toBe(0);
    expect(run.out).toMatch(/WYNIK: OK, 4 oczekiwanych błędów pg_restore, ostatnia migracja 20261101000000\n/);
    expect(run.calls.at(-1)).toMatch(/^docker rm -f faktflow-restore-drill/);
  });

  it('błąd pg_restore spoza listy: BŁĄD, kod 1', () => {
    h.answers['restore-errors'] = `${EXPECTED_ERRORS}\npg_restore: error: could not execute query: ERROR:  out of shared memory`;
    const run = h.drill(args());
    expect(run.status).toBe(1);
    expect(run.out).toContain('WYNIK: BŁĄD (1): pg_restore: 1 błędów spoza 4 oczekiwanych');
  });

  it('tabela ze spisu zrzutu nie powstała (schemat spoza listy pominięty): BŁĄD z nazwą', () => {
    h.answers.counts = ['auth.users|3', 'public.tenants|2'].join('\n');
    const run = h.drill(args());
    expect(run.status).toBe(1);
    expect(run.out).toContain('tabele ze zrzutu nie powstały: public.invoices');
    expect(run.out).not.toContain('extensions.pg_stat_x');
  });

  it('pusta auth.users, brak polityk i migracji, błąd ról inny niż „already exists”: wszystkie w werdykcie', () => {
    h.answers.counts = ['auth.users|0', 'public.invoices|10', 'public.tenants|2'].join('\n');
    h.answers.struct = 'polityki RLS|0\nostatnia migracja|';
    h.answers['role-out'] = 'ERROR:  role "anon" already exists\nERROR:  permission denied to alter role';
    const run = h.drill(args());
    expect(run.status).toBe(1);
    expect(run.out).toContain('WYNIK: BŁĄD (4):');
    for (const m of ['plik ról: 1 błędów', 'auth.users pusta', 'brak polityk RLS', 'brak wpisu w supabase_migrations']) expect(run.out).toContain(m);
  });

  it('z plikiem liczb z produkcji: różnica wierszy to informacja, brak tabeli to BŁĄD', () => {
    const expected = join(h.dir, 'counts.txt');
    writeFileSync(expected, ['auth.users|3', 'public.invoices|12', 'public.tenants|2'].join('\n'));
    const ok = h.drill([...args(), posix(expected)]);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out).toContain('public.invoices|12|10');

    writeFileSync(expected, ['auth.users|3', 'public.invoices|10', 'public.payments|5', 'public.tenants|2'].join('\n'));
    const gone = h.drill([...args(), posix(expected)]);
    expect(gone.status).toBe(1);
    expect(gone.out).toContain('tabele z produkcji nie istnieją po odtworzeniu: public.payments');
  });
});

describe('restore-drill-tydzien.sh: cotygodniowa próba z alarmem Healthchecks', { timeout: 60_000 }, () => {
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(() => h.cleanup());

  it('najnowszy KOMPLETNY zrzut, obraz z kontenera produkcji, ping start i sukces z wynikiem', () => {
    seedDump('faktflow-20261105T013000Z');
    seedDump('faktflow-20261106T013000Z');
    seedDump('faktflow-20261107T013000Z', { complete: false }); // trwa albo przerwany
    const run = h.weekly();
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('próba: faktflow-20261106T013000Z, obraz supabase/postgres:15.8.1.999');
    expect(run.calls.find((c) => c.startsWith('docker run'))).toContain(PROD_IMAGE);
    expect(run.calls.some((c) => c.includes('docker cp') && c.includes('faktflow-20261106T013000Z.dump'))).toBe(true);
    expect(run.pings).toEqual([
      `${HC}/start `,
      `${HC} WYNIK: OK, 4 oczekiwanych błędów pg_restore, ostatnia migracja 20261101000000 (zrzut faktflow-20261106T013000Z)`,
    ]);
    // HC_URL nocnego zrzutu nie jest używany
    expect(run.pings.join('\n')).not.toContain('db-backup');
  });

  it('próba nieudana: /fail z powodem z linii WYNIK, kod 1', () => {
    seedDump('faktflow-20261107T013000Z');
    h.answers['restore-errors'] = 'pg_restore: error: could not execute query: ERROR:  relation "x" does not exist';
    const run = h.weekly();
    expect(run.status).toBe(1);
    expect(run.pings.at(-1)).toMatch(/^https:\/\/hc\.example\.test\/ping\/restore-drill\/fail BŁĄD: WYNIK: BŁĄD \(1\): pg_restore: 1 błędów spoza/);
  });

  it('sumy kontrolne się nie zgadzają: /fail, próba się nie zaczyna', () => {
    seedDump('faktflow-20261107T013000Z', { badSum: true });
    const run = h.weekly();
    expect(run.status).toBe(1);
    expect(run.pings.at(-1)).toContain('/fail BŁĄD: sumy kontrolne zrzutu faktflow-20261107T013000Z');
    expect(run.calls.some((c) => c.startsWith('docker run'))).toBe(false);
  });

  it('brak kompletnego zrzutu: /fail', () => {
    seedDump('faktflow-20261107T013000Z', { complete: false });
    const run = h.weekly();
    expect(run.status).toBe(1);
    expect(run.pings.at(-1)).toContain('/fail BŁĄD: brak kompletnego zrzutu');
  });

  it('za mało miejsca dla odtworzonej bazy: /fail, próba się nie zaczyna', () => {
    seedDump('faktflow-20261107T013000Z');
    // 2 GiB minimum + 10% z 40 GiB = 6 GiB; wolne 5 GiB
    const run = h.weekly({ FAKE_DF_AVAIL_KB: String(5 * 1024 * 1024) });
    expect(run.status).toBe(1);
    expect(run.pings.at(-1)).toContain('/fail BŁĄD: za mało miejsca na próbę');
    expect(run.calls.some((c) => c.startsWith('docker run'))).toBe(false);
  });

  it('obrazu produkcji nie da się odczytać (PGC po przebudowie): /fail z podpowiedzią', () => {
    seedDump('faktflow-20261107T013000Z');
    h.answers.image = '';
    const run = h.weekly();
    expect(run.status).toBe(1);
    expect(run.pings.at(-1)).toContain('nie odczytałem obrazu kontenera pgc-test');
  });

  it('stary zrzut: próba idzie, w logu uwaga (alarm o starym zrzucie to check db-backup)', () => {
    seedDump('faktflow-20261101T013000Z', { ageHours: 72 });
    const run = h.weekly();
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('ma ponad 48 h');
  });

  it('poprzednia próba trwa (flock): /fail, bez drugiego kontenera', () => {
    seedDump('faktflow-20261107T013000Z');
    const run = h.weekly({ FAKE_FLOCK_RC: '1' });
    expect(run.status).toBe(1);
    expect(run.pings.at(-1)).toContain('/fail BŁĄD: poprzednia próba wciąż trwa');
    expect(run.calls.some((c) => c.startsWith('docker run'))).toBe(false);
  });

  it('kontener po przerwanej próbie jest usuwany przed nową; obraz bez pobierania (--pull never)', () => {
    seedDump('faktflow-20261107T013000Z');
    h.answers.ps = 'faktflow-restore-drill';
    const run = h.weekly();
    // atrapa `ps` zwraca kontener także w restore-drill.sh, więc ten przebieg tam stanie;
    // liczy się, że wrapper usunął kontener, zanim go wywołał
    const rm = run.calls.findIndex((c) => c === 'docker rm -f faktflow-restore-drill');
    expect(rm, run.out).toBeGreaterThanOrEqual(0);
    expect(run.out).toContain('usuwam kontener po przerwanej próbie');
    h.answers.ps = '';
    const ok = h.weekly();
    expect(ok.status, ok.out).toBe(0);
    expect(ok.calls.find((c) => c.startsWith('docker run'))).toContain('--pull never');
  });

  it('nocny zrzut w toku: próba czeka na jego blokadę, potem idzie', () => {
    seedDump('faktflow-20261107T013000Z');
    const lock = join(h.dir, 'backup.lock');
    writeFileSync(lock, '');
    const run = h.weekly({ BACKUP_LOCK: posix(lock) });
    expect(run.status, run.out).toBe(0);
    expect(readFileSync(join(h.dir, 'flock-calls'), 'utf8')).toContain('-w 3600 8');
  });

  it('bez DRILL_HC_URL: próba idzie, głośne ostrzeżenie, zero pingów', () => {
    seedDump('faktflow-20261107T013000Z');
    delete h.drillConfig.DRILL_HC_URL;
    const run = h.weekly();
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('UWAGA: brak DRILL_HC_URL');
    expect(run.pings).toEqual([]);
  });
});

describe('harmonogram i instalacja', () => {
  const root = resolve(__dirname, '../..');
  it('timer: raz w tygodniu, po nocnym zrzucie, Persistent; service woła wrapper z /usr/local/sbin', () => {
    const timer = readFileSync(join(root, 'scripts/hetzner/systemd/faktflow-restore-drill.timer'), 'utf8');
    const service = readFileSync(join(root, 'scripts/hetzner/systemd/faktflow-restore-drill.service'), 'utf8');
    expect(timer).toMatch(/^OnCalendar=Sun \*-\*-\* 03:30:00 UTC$/m);
    expect(timer).toMatch(/^Persistent=true$/m);
    expect(service).toMatch(/^ExecStart=\/usr\/local\/sbin\/faktflow-restore-drill-tydzien$/m);
    const install = readFileSync(join(root, 'scripts/ops/zainstaluj-restore-drill.sh'), 'utf8');
    expect(install).toContain('/usr/local/sbin/faktflow-restore-drill-tydzien');
    expect(install).toContain('scripts/hetzner/systemd/$UNIT.timer');
  });
});
