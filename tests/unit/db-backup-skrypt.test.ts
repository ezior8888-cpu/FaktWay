import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Plan skalowania, sesja 22 (BCK-01, DBC-01, BCK-04): nocny zrzut
 * `scripts/hetzner/db-backup.sh` leży na db-1 na tym samym dysku 40 GB co
 * Postgres. Nieudany albo zbyt duży zrzut zapełnia dysk i zatrzymuje bazę
 * dla wszystkich firm, a błąd wysyłki na Storage Box blokował retencję.
 *
 * Uruchamiany jest PRAWDZIWY skrypt: kopia z końcami LF w katalogu
 * tymczasowym (checkout na Windowsie ma CRLF, na którym bash pada). Atrapy
 * w PATH: `docker` (pg_dump, pg_dumpall, pg_restore -l), `df`, `rclone`,
 * `curl` (pingi Healthchecks) i `flock`. Każda dopisuje wywołanie do
 * `$FAKE_DIR/calls`, więc test widzi kolejność kroków. `sha256sum`, `find`,
 * `stat` i `mv` są prawdziwe.
 */

const SCRIPT = resolve(__dirname, '../../scripts/hetzner/db-backup.sh');
const HC = 'https://hc.example.test/ping/db-backup';
const GB = 1_000_000_000;
const ROLES = 'CREATE ROLE anon;\n';

const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;

const FAKE_DOCKER = `#!/usr/bin/env bash
# Atrapa: docker exec [-i] <kontener> pg_dump | pg_dumpall | pg_restore -l.
printf 'docker %s\\n' "$*" >> "$FAKE_DIR/calls"
[ "$1" = exec ] || exit 0
shift
[ "$1" = -i ] && shift
case "$2" in
  pg_dump)
    head -c "\${FAKE_DUMP_BYTES:-4096}" /dev/zero | tr '\\0' 'd'
    case "\${FAKE_FAIL:-}" in
      pg_dump) echo 'pg_dump: error: connection to server lost' >&2; exit 1 ;;
      pg_dump-term) kill -TERM "$PPID"; sleep 1 ;;
    esac ;;
  pg_dumpall)
    printf -- '--\\n-- PostgreSQL database cluster dump\\n--\\n'
    if [ "\${FAKE_FAIL:-}" = pg_dumpall ]; then echo 'pg_dumpall: error: query failed' >&2; exit 1; fi
    printf 'CREATE ROLE anon;\\nCREATE ROLE authenticated;\\n' ;;
  pg_restore)
    cat > /dev/null
    if [ "\${FAKE_FAIL:-}" = pg_restore ]; then echo 'pg_restore: error: input file is too short' >&2; exit 1; fi
    printf ';\\n; Archive created at 2026-10-27\\n1; 2615 2200 SCHEMA - public postgres\\n2; 1259 16390 TABLE public invoices postgres\\n' ;;
esac
exit 0
`;

const FAKE_DF = `#!/usr/bin/env bash
# Atrapa df: wolne miejsce i rozmiar systemu plików (w bajtach) z FAKE_DF_AVAIL i FAKE_DF_SIZE.
# Pusty FAKE_DF_AVAIL: FAKE_DF_FREE minus to, co leży w katalogu kopii (sprzątanie zwalnia miejsce).
# Jednostki i kolejność kolumn jak w prawdziwym df: -B1 / --block-size=1 i --output=pola.
printf 'df %s\\n' "$*" >> "$FAKE_DIR/calls"
if [ -n "\${FAKE_DF_BROKEN:-}" ]; then echo 'df: cannot read table of mounted file systems' >&2; exit 1; fi
unit=1024; fields=""
for a in "$@"; do
  case "$a" in
    -B1|--block-size=1) unit=1 ;;
    --output=*) fields=\${a#--output=} ;;
  esac
done
[ -n "$fields" ] || { echo 'df: atrapa obsługuje tylko --output=' >&2; exit 1; }
avail=\${FAKE_DF_AVAIL:-}
if [ -z "$avail" ]; then
  used=$(find "$FAKE_BACKUP_DIR" -type f -printf '%s\\n' | awk '{ s += $1 } END { print s + 0 }')
  avail=$(( FAKE_DF_FREE - used ))
fi
header=""; row=""
IFS=, read -ra cols <<< "$fields"
for c in "\${cols[@]}"; do
  case "$c" in
    avail) header+=" Avail"; row+=" $(( avail / unit ))" ;;
    size) header+=" Size"; row+=" $(( FAKE_DF_SIZE / unit ))" ;;
    *) echo "df: atrapa nie zna pola $c" >&2; exit 1 ;;
  esac
done
printf '%s\\n%s\\n' "$header" "$row"
`;

const FAKE_RCLONE = `#!/usr/bin/env bash
# Atrapa rclone. copy kopiuje pliki pasujące do --include do $FAKE_DIR/remote/<ścieżka po dwukropku>
# i zapisuje, co w chwili wysyłki leżało w katalogu kopii. FAKE_FAIL=rclone-<polecenie> = błąd.
printf 'rclone %s\\n' "$*" >> "$FAKE_DIR/calls"
cmd=$1; shift
include=""; pos=()
while [ $# -gt 0 ]; do
  case "$1" in
    --include) include=$2; shift 2 ;;
    --retries|--min-age|--max-age) shift 2 ;;
    -*) shift ;;
    *) pos+=("$1"); shift ;;
  esac
done
if [ "\${FAKE_FAIL:-}" = "rclone-$cmd" ]; then echo "rclone $cmd: Failed: connection reset by peer" >&2; exit 1; fi
case "$cmd" in
  config) printf '[%s]\\ntype = %s\\nremote = box:faktflow\\n' "\${pos[1]}" "\${FAKE_RCLONE_TYPE:-crypt}" ;;
  copy)
    ls -A "$FAKE_BACKUP_DIR" > "$FAKE_DIR/dir-at-copy"
    dest="$FAKE_DIR/remote/\${pos[1]#*:}"
    mkdir -p "$dest"
    pattern=\${include#/}
    shopt -s nullglob
    for f in "\${pos[0]}"/\${pattern:-*}; do [ -f "$f" ] && cp "$f" "$dest/"; done ;;
  about)
    if [ -n "\${FAKE_ABOUT:-}" ]; then printf '%s\\n' "$FAKE_ABOUT"
    else printf '{\\n\\t"total": %s,\\n\\t"used": %s,\\n\\t"free": 0\\n}\\n' "\${FAKE_REMOTE_TOTAL:-1000}" "\${FAKE_REMOTE_USED:-100}"; fi ;;
esac
exit 0
`;

const FAKE_CURL = `#!/usr/bin/env bash
# Atrapa curl: zapisuje adres pingu Healthchecks (ostatni argument).
for url; do :; done
printf '%s\\n' "$url" >> "$FAKE_DIR/pings"
`;

const FAKE_FLOCK = `#!/usr/bin/env bash
printf 'flock %s\\n' "$*" >> "$FAKE_DIR/calls"
exit "\${FAKE_FLOCK_RC:-0}"
`;

/** Ścieżka dla basha także na Windowsie (Git Bash rozumie C:/…, nie zawsze C:\…). */
function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

interface Run {
  status: number | null;
  /** stdout + stderr — cron pisze oba do /var/log/faktflow-db-backup.log. */
  out: string;
  calls: string[];
  pings: string[];
}

function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'db-backup-'));
  const bin = join(dir, 'bin');
  const backups = join(dir, 'backups');
  const script = join(dir, 'db-backup.sh');
  const configFile = join(dir, 'faktflow-backup.env');
  mkdirSync(bin);
  mkdirSync(backups);
  writeFileSync(script, readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n'));

  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  fake('docker', FAKE_DOCKER);
  fake('df', FAKE_DF);
  fake('rclone', FAKE_RCLONE);
  fake('curl', FAKE_CURL);
  fake('flock', FAKE_FLOCK);

  // Jak /etc/faktflow-backup.env na db-1; testy dopisują i usuwają klucze.
  const config: Record<string, string> = {
    PGC: 'pgc-test',
    BACKUP_DIR: posix(backups),
    KEEP: '3',
    MIN_BYTES: '1000',
    HC_URL: HC,
    LOCK_FILE: posix(join(dir, 'db-backup.lock')),
  };

  return {
    dir,
    backups,
    config,
    fake,
    run(env: Record<string, string> = {}): Run {
      writeFileSync(configFile, Object.entries(config).map(([k, v]) => `${k}=${v}\n`).join(''));
      for (const f of ['calls', 'pings', 'dir-at-copy']) rmSync(join(dir, f), { force: true });
      // Windows: bez SYSTEMROOT itp. Git Bash potrafi nie wystartować; reszta środowiska celowo pusta.
      const windows = Object.fromEntries(
        ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])),
      );
      const result = spawnSync('bash', [posix(script)], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...windows,
          NODE_ENV: 'test',
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
          HOME: dir,
          LANG: 'C.UTF-8',
          FAKTFLOW_BACKUP_CONFIG: posix(configFile),
          FAKE_DIR: posix(dir),
          FAKE_BACKUP_DIR: posix(backups),
          FAKE_DF_AVAIL: String(20 * GB),
          FAKE_DF_SIZE: String(40 * GB),
          ...env,
        },
      });
      const lines = (f: string) =>
        existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean) : [];
      return { status: result.status, out: `${result.stdout}${result.stderr}`, calls: lines('calls'), pings: lines('pings') };
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let h: ReturnType<typeof createHarness>;

/** Nazwa starego zrzutu: 2020-01-NN, zawsze starszy niż ten z bieżącego przebiegu. */
const OLD = (n: number) => `faktflow-202001${String(n).padStart(2, '0')}T013000Z`;

function seedDump(name: string, opts: { complete?: boolean; bytes?: number } = {}) {
  writeFileSync(join(h.backups, `${name}.dump`), 'x'.repeat(opts.bytes ?? 2000));
  writeFileSync(join(h.backups, `${name}.roles.sql`), ROLES);
  if (opts.complete !== false) writeFileSync(join(h.backups, `${name}.sha256`), `abc  ${name}.dump\n`);
}

const entries = () => readdirSync(h.backups).sort();
/** Kompletne zrzuty (z plikiem .sha256), od najstarszego. */
const complete = () =>
  entries()
    .filter((f) => /^faktflow-.*\.sha256$/.test(f))
    .map((f) => f.slice(0, -'.sha256'.length));
const dumped = (run: Run) => run.calls.some((c) => / pg_dump /.test(c));
const files = (name: string) => [`${name}.dump`, `${name}.roles.sql`, `${name}.sha256`];

/** Jak `sha256sum -c`, ale bez powłoki: plik sum ma wpisy dokładnie dla .dump i .roles.sql, z poprawnymi sumami. */
function expectValidSums(name: string) {
  const rows = readFileSync(join(h.backups, `${name}.sha256`), 'utf8').split('\n').filter(Boolean);
  // GNU pisze „hash  plik”, Git Bash „hash *plik”.
  const listed = rows.map((row) => {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(row);
    expect(m, `wiersz pliku sum: ${row}`).not.toBeNull();
    return [m![2], m![1]];
  });
  const expected = [`${name}.dump`, `${name}.roles.sql`].map((f) => [
    f,
    createHash('sha256').update(readFileSync(join(h.backups, f))).digest('hex'),
  ]);
  expect(listed).toEqual(expected);
}

describe.skipIf(!hasBash)('db-backup.sh — nocny zrzut bazy na db-1 (sesja 22)', { timeout: 60_000 }, () => {
  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  describe('udany przebieg', () => {
    it('jeden kompletny zrzut z poprawnymi sumami, ping start i sukces, bez śladów po drodze', () => {
      const run = h.run();
      expect(run.status, run.out).toBe(0);
      const [name, ...rest] = complete();
      expect(rest).toEqual([]);
      expect(name).toMatch(/^faktflow-\d{8}T\d{6}Z$/);
      expect(entries()).toEqual(files(name!));
      expectValidSums(name!);
      expect(run.pings).toEqual([`${HC}/start`, HC]);
      expect(run.calls.some((c) => c.startsWith('rclone'))).toBe(false);
      expect(run.out).toMatch(/OK\s*$/);
    });

    it('brak HC_URL: głośne ostrzeżenie w logu, kopia i tak powstaje', () => {
      delete h.config.HC_URL;
      const run = h.run();
      expect(run.status, run.out).toBe(0);
      expect(run.pings).toEqual([]);
      expect(run.out).toMatch(/UWAGA: brak HC_URL/);
      expect(complete()).toHaveLength(1);
    });
  });

  describe('kontrola miejsca przed pg_dump (BCK-01, DBC-01)', () => {
    // Bez poprzedniego zrzutu: MIN_DUMP_SPACE (domyślnie 1 GiB) + 10% systemu plików.
    const FS = 40 * GB;
    const FIRST_NEED = 1024 ** 3 + FS / 10;

    it('pierwszy zrzut przy za małym zapasie: fail z opisem, zrzut się nie zaczyna', () => {
      const run = h.run({ FAKE_DF_AVAIL: String(FIRST_NEED - 1), FAKE_DF_SIZE: String(FS) });
      expect(run.status).toBe(1);
      expect(run.pings).toEqual([`${HC}/start`, `${HC}/fail`]);
      expect(dumped(run)).toBe(false);
      expect(entries()).toEqual([]);
      expect(run.out).toContain('za mało miejsca');
    });

    it('pierwszy zrzut: dokładnie tyle wolnego, ile trzeba, wystarcza', () => {
      const run = h.run({ FAKE_DF_AVAIL: String(FIRST_NEED), FAKE_DF_SIZE: String(FS) });
      expect(run.status, run.out).toBe(0);
      expect(complete()).toHaveLength(1);
    });

    it('z poprzednimi zrzutami: wolne ≥ 2 × NAJNOWSZY kompletny + 10% systemu plików; niekompletny się nie liczy', () => {
      h.config.MIN_DUMP_SPACE = '1000';
      seedDump(OLD(1), { bytes: 300_000 });
      seedDump(OLD(2), { bytes: 50_000 });
      seedDump(OLD(3), { bytes: 900_000, complete: false });
      const need = 2 * (50_000 + ROLES.length) + 1_000_000 / 10;

      const short = h.run({ FAKE_DF_AVAIL: String(need - 1), FAKE_DF_SIZE: '1000000' });
      expect(short.status).toBe(1);
      expect(short.pings.at(-1)).toBe(`${HC}/fail`);
      expect(dumped(short)).toBe(false);
      expect(short.out).toContain('za mało miejsca');

      const enough = h.run({ FAKE_DF_AVAIL: String(need), FAKE_DF_SIZE: '1000000' });
      expect(enough.status, enough.out).toBe(0);
      expect(complete()).toHaveLength(3);
    });

    it.each([
      ['0', 0],
      ['25', 250_000],
    ])('DISK_RESERVE_PCT=%s: zapas to dokładnie ten procent systemu plików', (pct, reserve) => {
      h.config.MIN_DUMP_SPACE = '1000';
      h.config.DISK_RESERVE_PCT = pct;
      const need = 1000 + reserve;
      const short = h.run({ FAKE_DF_AVAIL: String(need - 1), FAKE_DF_SIZE: '1000000' });
      expect(short.status).toBe(1);
      expect(dumped(short)).toBe(false);
      const enough = h.run({ FAKE_DF_AVAIL: String(need), FAKE_DF_SIZE: '1000000' });
      expect(enough.status, enough.out).toBe(0);
    });

    it('DISK_RESERVE_PCT ponad 90 odrzucony przed zrzutem', () => {
      h.config.DISK_RESERVE_PCT = '91';
      const run = h.run();
      expect(run.status).toBe(1);
      expect(run.pings.at(-1)).toBe(`${HC}/fail`);
      expect(dumped(run)).toBe(false);
    });

    it('df nie odpowiada: fail, zrzut się nie zaczyna', () => {
      const run = h.run({ FAKE_DF_BROKEN: '1' });
      expect(run.status).toBe(1);
      expect(run.pings.at(-1)).toBe(`${HC}/fail`);
      expect(dumped(run)).toBe(false);
      expect(entries()).toEqual([]);
    });

    it('mierzy system plików katalogu kopii, przed pg_dump', () => {
      const run = h.run();
      const df = run.calls.findIndex((c) => c.startsWith('df '));
      const dump = run.calls.findIndex((c) => / pg_dump /.test(c));
      expect(df).toBeGreaterThan(-1);
      expect(df).toBeLessThan(dump);
      expect(run.calls[df]).toContain(posix(h.backups));
    });

    it('pozostałości po przerwanym przebiegu (np. OOM) znikają, zanim skrypt zmierzy miejsce', () => {
      h.config.MIN_DUMP_SPACE = '1000';
      writeFileSync(join(h.backups, '.partial-faktflow-20200101T013000Z.dump'), 'x'.repeat(200_000));
      // Potrzeba 1000 + 10% z 1 000 000. Z pozostałością wolne 50 000, bez niej 250 000.
      const run = h.run({ FAKE_DF_AVAIL: '', FAKE_DF_FREE: '250000', FAKE_DF_SIZE: '1000000' });
      expect(run.status, run.out).toBe(0);
      expect(entries().filter((f) => f.startsWith('.'))).toEqual([]);
      expect(complete()).toHaveLength(1);
    });
  });

  describe('sprzątanie przy błędzie (BCK-01)', () => {
    it.each([
      ['pg_dump urwany w połowie', { FAKE_FAIL: 'pg_dump' }],
      ['pg_dumpall nieudany', { FAKE_FAIL: 'pg_dumpall' }],
      ['pg_restore nie czyta zrzutu', { FAKE_FAIL: 'pg_restore' }],
      ['zrzut mniejszy niż MIN_BYTES', { FAKE_DUMP_BYTES: '10' }],
      ['SIGTERM w trakcie pg_dump', { FAKE_FAIL: 'pg_dump-term' }],
    ])('%s: fail i w katalogu nie zostaje .partial ani niekompletny zrzut', (_, env) => {
      seedDump(OLD(1));
      const run = h.run(env);
      expect(run.status).not.toBe(0);
      expect(run.pings.at(-1)).toBe(`${HC}/fail`);
      expect(entries()).toEqual(files(OLD(1)));
    });

    it('błąd przy sumach kontrolnych: nie zostaje ucięty .sha256, który udawałby kompletny zrzut', () => {
      h.fake(
        'sha256sum',
        "#!/usr/bin/env bash\nprintf 'e3b0c442  faktflow\\n'\necho 'sha256sum: write error: No space left on device' >&2\nexit 1\n",
      );
      const run = h.run();
      expect(run.status).toBe(1);
      expect(run.pings.at(-1)).toBe(`${HC}/fail`);
      expect(entries()).toEqual([]);
    });

    it('sumy liczone, zanim zrzut dostanie docelową nazwę: twarde zabicie w trakcie zostawia tylko .partial', () => {
      // Atrapa zapisuje stan katalogu i woła prawdziwy sha256sum (PATH bez katalogu atrap).
      h.fake(
        'sha256sum',
        '#!/usr/bin/env bash\nls -A "$FAKE_BACKUP_DIR" > "$FAKE_DIR/dir-at-sha256"\nPATH=${PATH#*:}\nexec sha256sum "$@"\n',
      );
      const run = h.run();
      expect(run.status, run.out).toBe(0);
      const atSha = readFileSync(join(h.dir, 'dir-at-sha256'), 'utf8').split('\n').filter(Boolean);
      expect(atSha.length).toBeGreaterThan(0);
      for (const f of atSha) expect(f).toMatch(/^\.partial-faktflow-/);
      const [name] = complete();
      expectValidSums(name!);
    });

    it('przebieg zablokowany przez trwający: fail i nie rusza plików trwającego przebiegu', () => {
      const running = '.partial-faktflow-20261027T013000Z.dump';
      writeFileSync(join(h.backups, running), 'x');
      const run = h.run({ FAKE_FLOCK_RC: '1' });
      expect(run.status).toBe(1);
      expect(run.pings).toEqual([`${HC}/fail`]);
      expect(dumped(run)).toBe(false);
      expect(entries()).toEqual([running]);
    });
  });

  describe('retencja lokalna przed wysyłką (BCK-04)', () => {
    it('zostawia KEEP najnowszych kompletnych; niekompletnych nie liczy i nie kasuje', () => {
      for (let i = 1; i <= 5; i++) seedDump(OLD(i));
      seedDump(OLD(6), { complete: false });
      const run = h.run();
      expect(run.status, run.out).toBe(0);
      const kept = complete();
      expect(kept).toHaveLength(3);
      expect(kept.slice(0, 2)).toEqual([OLD(4), OLD(5)]);
      expect(existsSync(join(h.backups, `${OLD(6)}.dump`))).toBe(true);
      for (const i of [1, 2, 3]) expect(entries().some((f) => f.startsWith(OLD(i)))).toBe(false);
    });

    it('BACKUP_DIR jako dowiązanie do innego wolumenu: retencja i kontrola miejsca widzą zrzuty', () => {
      const link = join(h.dir, 'dowiazanie');
      symlinkSync(h.backups, link, 'junction');
      h.config.BACKUP_DIR = posix(link);
      h.config.MIN_DUMP_SPACE = '1000';
      for (let i = 1; i <= 4; i++) seedDump(OLD(i), { bytes: 50_000 });
      // Ostatni kompletny ma 50 000 B, więc potrzeba 2 × ok. 50 000 + 100 000; LAST=0 dałby tylko 101 000.
      const short = h.run({ FAKE_DF_AVAIL: '150000', FAKE_DF_SIZE: '1000000' });
      expect(short.status).toBe(1);
      expect(dumped(short)).toBe(false);
      const run = h.run({ FAKE_DF_AVAIL: '300000', FAKE_DF_SIZE: '1000000' });
      expect(run.status, run.out).toBe(0);
      expect(complete()).toHaveLength(3);
      expect(run.out).toContain('retencja: usunięto');
    });

    it('wysyłka padła: retencja i tak zrobiona, a po przebiegu nie ma .outbox', () => {
      h.config.RCLONE_REMOTE = 'boxcrypt:db';
      for (let i = 1; i <= 5; i++) seedDump(OLD(i));
      const run = h.run({ FAKE_FAIL: 'rclone-copy' });
      expect(run.status).toBe(1);
      expect(run.pings.at(-1)).toBe(`${HC}/fail`);
      expect(complete()).toHaveLength(3);
      expect(entries().filter((f) => f.startsWith('.'))).toEqual([]);
    });

    it('nieudany zrzut nie uruchamia retencji: seria awarii nie wypycha dobrych kopii', () => {
      for (let i = 1; i <= 5; i++) seedDump(OLD(i));
      const run = h.run({ FAKE_FAIL: 'pg_dump' });
      expect(run.status).toBe(1);
      expect(complete()).toEqual([1, 2, 3, 4, 5].map(OLD));
    });

    it.each(['0', '-1', 'dużo'])('KEEP=%s odrzucony przed zrzutem: bieżący zrzut musi zostać', (keep) => {
      h.config.KEEP = keep;
      seedDump(OLD(1));
      const run = h.run();
      expect(run.status).toBe(1);
      expect(run.pings.at(-1)).toBe(`${HC}/fail`);
      expect(dumped(run)).toBe(false);
      expect(complete()).toEqual([OLD(1)]);
    });
  });

  describe('wysyłka bez drugiej kopii na dysku (BCK-01, DBC-01)', () => {
    beforeEach(() => {
      h.config.RCLONE_REMOTE = 'boxcrypt:db';
    });

    it('rclone copy wprost z katalogu kopii, tylko pliki nowego zrzutu; w chwili wysyłki bez .outbox i już po retencji', () => {
      for (let i = 1; i <= 4; i++) seedDump(OLD(i));
      const run = h.run();
      expect(run.status, run.out).toBe(0);
      const name = complete().at(-1)!;

      const copy = run.calls.find((c) => c.startsWith('rclone copy '));
      expect(copy).toContain(' --immutable ');
      expect(copy).toContain(` --include /${name}.* `);
      expect(copy!.endsWith(` ${posix(h.backups)} boxcrypt:db/${name}`)).toBe(true);
      const atCopy = readFileSync(join(h.dir, 'dir-at-copy'), 'utf8').split('\n').filter(Boolean);
      expect(atCopy).not.toContain('.outbox');
      expect(atCopy.filter((f) => f.endsWith('.sha256'))).toHaveLength(3);
      expect(readdirSync(join(h.dir, 'remote', 'db', name)).sort()).toEqual(files(name));

      const check = run.calls.find((c) => c.startsWith('rclone cryptcheck '));
      expect(check).toContain(' --one-way ');
      expect(check).toContain(` --include /${name}.* `);
      expect(check!.endsWith(` ${posix(h.backups)} boxcrypt:db/${name}`)).toBe(true);

      expect(run.pings).toEqual([`${HC}/start`, HC]);
      expect(entries().filter((f) => f.startsWith('.'))).toEqual([]);
      expect(run.out).toContain(`kopia poza serwerem: boxcrypt:db/${name}`);
    });

    it('zdalny bez szyfrowania: odmowa wysyłki, lokalny zrzut zostaje', () => {
      const run = h.run({ FAKE_RCLONE_TYPE: 'sftp' });
      expect(run.status).toBe(1);
      expect(run.pings.at(-1)).toBe(`${HC}/fail`);
      expect(run.calls.some((c) => c.startsWith('rclone copy'))).toBe(false);
      expect(complete()).toHaveLength(1);
      expect(run.out).toContain('nie jest typu crypt');
    });
  });

  describe('retencja i zajętość Storage Boxa (BCK-04)', () => {
    beforeEach(() => {
      h.config.RCLONE_REMOTE = 'boxcrypt:db';
    });

    it('po udanym cryptcheck: delete --min-age 60d tylko w katalogach zrzutów, rmdirs --leave-root, potem about', () => {
      const run = h.run();
      expect(run.status, run.out).toBe(0);
      const at = (re: RegExp) => run.calls.findIndex((c) => re.test(c));
      const steps = [/^rclone copy /, /^rclone cryptcheck /, /^rclone delete /, /^rclone rmdirs /, /^rclone about /].map(at);
      for (const s of steps) expect(s).toBeGreaterThan(-1);
      expect([...steps].sort((a, b) => a - b)).toEqual(steps);

      const del = run.calls[steps[2]!]!;
      expect(del).toContain(' --min-age 60d ');
      expect(del).toContain(' --include /faktflow-*/faktflow-* ');
      expect(del).toMatch(/ boxcrypt:db$/);
      expect(run.calls[steps[3]!]).toBe('rclone rmdirs --leave-root boxcrypt:db');
      expect(run.out).toContain('Storage Box: zajęte 10,0%');
    });

    it('REMOTE_RETENTION_DAYS=30: krótszy cykl na Storage Box', () => {
      h.config.REMOTE_RETENTION_DAYS = '30';
      const run = h.run();
      expect(run.status, run.out).toBe(0);
      expect(run.calls.find((c) => c.startsWith('rclone delete '))).toContain(' --min-age 30d ');
    });

    it.each(['61', '0', 'x'])('REMOTE_RETENTION_DAYS=%s (umowa powierzenia: ≤ 60 dni) odrzucony przed zrzutem', (days) => {
      h.config.REMOTE_RETENTION_DAYS = days;
      const run = h.run();
      expect(run.status).toBe(1);
      expect(run.pings.at(-1)).toBe(`${HC}/fail`);
      expect(dumped(run)).toBe(false);
    });

    it('nieudany cryptcheck: nic nie kasuje na Storage Box', () => {
      const run = h.run({ FAKE_FAIL: 'rclone-cryptcheck' });
      expect(run.status).toBe(1);
      expect(run.pings.at(-1)).toBe(`${HC}/fail`);
      expect(run.calls.some((c) => /^rclone (delete|rmdirs|purge) /.test(c))).toBe(false);
    });

    it.each(['delete', 'rmdirs'])('nieudane rclone %s: fail z opisem', (cmd) => {
      const run = h.run({ FAKE_FAIL: `rclone-${cmd}` });
      expect(run.status).toBe(1);
      expect(run.pings.at(-1)).toBe(`${HC}/fail`);
      expect(run.out).toContain('retencja na boxcrypt:db');
    });

    it('Storage Box zajęty w ponad 80%: ping /fail z opisem, a zrzut wysłany i obie retencje zrobione', () => {
      for (let i = 1; i <= 4; i++) seedDump(OLD(i));
      const run = h.run({ FAKE_REMOTE_TOTAL: '1000', FAKE_REMOTE_USED: '801' });
      expect(run.status).toBe(1);
      expect(run.pings).toEqual([`${HC}/start`, `${HC}/fail`]);
      expect(run.out).toContain('zajęty w 80,1% (> 80%)');
      expect(complete()).toHaveLength(3);
      expect(run.calls.some((c) => c.startsWith('rclone delete '))).toBe(true);
      expect(readdirSync(join(h.dir, 'remote', 'db'))).toHaveLength(1);
    });

    it('dokładnie 80% to jeszcze nie alarm', () => {
      const run = h.run({ FAKE_REMOTE_TOTAL: '1000', FAKE_REMOTE_USED: '800' });
      expect(run.status, run.out).toBe(0);
      expect(run.pings.at(-1)).toBe(HC);
    });

    it('rclone about bez liczb: ostrzeżenie w logu, przebieg udany', () => {
      const run = h.run({ FAKE_ABOUT: '{}' });
      expect(run.status, run.out).toBe(0);
      expect(run.out).toMatch(/UWAGA: .*zajętości/);
      expect(run.pings.at(-1)).toBe(HC);
    });
  });
});
