import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createScriptHarness, labelRows, scriptSection, type ScriptHarness } from '../helpers/kontrola-skrypt';

/**
 * `scripts/ops/kontrola-go-live-ksef.sh` — kontrola przełączenia KSeF z TEST
 * na PROD (runbook `docs/runbooks/go-live-ksef-prod.md`, karta F1 planu
 * „zero zgubionych faktur”). Skrypt łączy się z db-1 jako `postgres` i czyta
 * zmienne kontenerów na app-1, więc test pilnuje, że:
 * - każde wywołanie psql ma transakcję tylko do odczytu i limit czasu, każde
 *   zapytanie to SELECT i dociera do psql bez zmian przez dwie powłoki;
 * - ze zmiennych kontenerów wychodzą tylko nazwy z listy, a GUS_API_KEY tylko
 *   jako „ustawione” albo „brak”;
 * - w źródle nie ma adresów IP (repo jest publiczne);
 * - bramka zero i lista przypomnień liczą to samo co kod (stałe z `lib/`).
 *
 * Uruchamiany jest PRAWDZIWY skrypt w katalogu atrap z
 * `tests/helpers/kontrola-skrypt.ts` (atrapa `ssh` → `bash -c`, jak sshd).
 */

const ROOT = join(__dirname, '..', '..');
const SCRIPT = resolve(ROOT, 'scripts/ops/kontrola-go-live-ksef.sh');

const OFFICIAL_PROD_URL = 'https://api.ksef.mf.gov.pl/v2';

const FAKE_DOCKER = `#!/usr/bin/env bash
# Atrapa docker: ps — kontener workera i aplikacji (bez nich przy FAKE_NO_CONTAINERS);
# inspect — zmienne z sekretami, które nie mogą wyjść z serwera; KSEF_PROD_URL
# z FAKE_PROD_URL (domyślnie oficjalny adres, puste też się liczy), bez KSEF_ENV
# przy FAKE_NO_KSEF_ENV;
# exec psql — zapis SQL z -c (rozdzielone NUL).
case "$1" in
  ps) [ -n "\${FAKE_NO_CONTAINERS:-}" ] || printf 'workertest-1\\napptest-1\\n'; exit 0 ;;
  inspect)
    [ -n "\${FAKE_NO_KSEF_ENV:-}" ] || printf 'KSEF_ENV=production\\n'
    printf 'KSEF_PROD_URL=%s\\nJPK_MF_ENV=test\\nSECRET_KEY=tajne-123\\nGUS_API_KEY=klucz-gus-456\\nDATABASE_URL=postgres://u:haslo-789@db/x\\n' "\${FAKE_PROD_URL-${OFFICIAL_PROD_URL}}"
    exit 0 ;;
  exec) ;;
  *) exit 0 ;;
esac
shift; [ "$1" = -e ] && { export "$2"; shift 2; }
[ "$2" = psql ] || exit 0
sql=""; prev=""
for a in "$@"; do [ "$prev" = "-c" ] && sql=$a; prev=$a; done
printf '%s\\0' "$sql" >> "$FAKE_DIR/sql"
exit 0
`;

let harness: ScriptHarness;

beforeEach(() => {
  harness = createScriptHarness(FAKE_DOCKER);
});

afterEach(() => {
  harness.cleanup();
});

/**
 * `harness.run` uruchamia tylko `kontrola-faktur-ksef.sh`, więc skrypt go-live
 * startuje tutaj: w katalogu atrap z tego samego `createScriptHarness` i z tym
 * samym środowiskiem co `harness.run`, plus argumenty (np. `--sprawdz`).
 */
function runScript(env: Record<string, string> = {}, args: string[] = []) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      NODE_ENV: 'test',
      PATH: `${join(harness.dir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: harness.dir,
      LANG: 'C.UTF-8',
      FAKTFLOW_INFRA_ENV: join(harness.dir, 'infra.env'),
      FAKE_DIR: harness.dir,
      ...env,
    },
  });
  const log = join(harness.dir, 'sql');
  const sql = existsSync(log) ? readFileSync(log, 'utf8').split('\0').slice(0, -1) : [];
  return { stdout: result.stdout, stderr: result.stderr, status: result.status, sql };
}

function source(): string {
  return readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');
}

/** Linie źródła bez komentarzy powłoki. */
function codeLines(): string[] {
  return source()
    .split('\n')
    .filter((line) => !/^\s*#/.test(line));
}

/** `sql "etykieta" "zapytanie"` ze źródła skryptu, w kolejności. */
function declaredQueries(): string[] {
  const re = /^\s*sql "(?:[^"\\]|\\.)*"\s*(?:\\\n\s*)?"((?:[^"\\]|\\.)*)"/gm;
  return [...source().matchAll(re)].map((m) => m[1]!);
}

/** Wartości stałej `NAZWA = ['a', 'b'] as const` z pliku w repo. */
function constList(file: string, name: string): string[] {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const m = text.match(new RegExp(`${name} = \\[([^\\]]*)\\] as const`));
  expect(m, `${file}: ${name}`).not.toBeNull();
  return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

const sqlList = (values: string[]) => `(${values.map((v) => `'${v}'`).join(',')})`;

// Każdy test uruchamia cały skrypt (20 zapytań przez atrapy ssh i bash). Na
// Windows to kilka sekund, więcej niż domyślne 5 s Vitesta.
describe('kontrola-go-live-ksef.sh — kontrola przełączenia KSeF TEST → PROD (F1)', { timeout: 60_000 }, () => {
  it('sekcje 1–10 w kolejności; koniec bez błędu i ze zdaniem, że skrypt niczego nie zmienił', () => {
    const run = runScript();
    expect(run.status, run.stderr).toBe(0);
    const positions = Array.from({ length: 10 }, (_, i) => run.stdout.indexOf(`\n=== ${i + 1}. `));
    for (const [i, p] of positions.entries()) expect(p, `sekcja ${i + 1}`).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(run.stdout).toContain('Koniec. Skrypt niczego nie zmienił.');
  });

  it('sekcja 1: ze zmiennych kontenerów wychodzą tylko nazwy z listy, GUS_API_KEY bez wartości', () => {
    const run = runScript();
    const out = scriptSection(run.stdout, 1);
    expect(out, 'brak sekcji 1').not.toBeNull();
    for (const label of ['worker (Coolify id=2)', 'aplikacja (Coolify id=1)']) {
      expect(labelRows(out!, label)).toEqual([
        'KSEF_ENV=production',
        `KSEF_PROD_URL=${OFFICIAL_PROD_URL}`,
        'JPK_MF_ENV=test',
        '  GUS_API_KEY: ustawione',
      ]);
    }
    for (const secret of ['tajne-123', 'klucz-gus-456', 'haslo-789', 'SECRET_KEY', 'DATABASE_URL']) {
      expect(run.stdout).not.toContain(secret);
    }
  });

  // lib/ksef/client.ts: `KSEF_PROD_URL ?? oficjalny` nie zastępuje pustego
  // napisu, `new URL('')` rzuca, a PROD wymaga adresu co do znaku, więc
  // configuredKsefEnvironment() zwraca null (lib/ksef/claim-environment.ts).
  it.each([
    ['puste', ''],
    ['z ukośnikiem na końcu', `${OFFICIAL_PROD_URL}/`],
    ['inny host', 'https://ksef.example.test/v2'],
  ])('sekcja 1: KSEF_PROD_URL %s → ostrzeżenie o nieustawionym środowisku', (_, url) => {
    const run = runScript({ FAKE_PROD_URL: url });
    const rows = labelRows(scriptSection(run.stdout, 1)!, 'worker (Coolify id=2)');
    expect(rows).toContain(`KSEF_PROD_URL=${url}`);
    expect(rows.filter((r) => r.startsWith('  UWAGA: KSEF_PROD_URL inne niż oficjalny adres'))).toHaveLength(1);
  });

  it('sekcja 1: brak KSEF_ENV → ostrzeżenie', () => {
    const rows = labelRows(scriptSection(runScript({ FAKE_NO_KSEF_ENV: '1' }).stdout, 1)!, 'aplikacja (Coolify id=1)');
    expect(rows).toContain('  UWAGA: brak KSEF_ENV, środowisko nieustawione (runbook §2.3)');
  });

  it('sekcja 1: KSEF_ENV i oficjalny KSEF_PROD_URL → bez ostrzeżeń', () => {
    const rows = labelRows(scriptSection(runScript().stdout, 1)!, 'aplikacja (Coolify id=1)');
    expect(rows.filter((r) => r.includes('UWAGA'))).toEqual([]);
  });

  it('sekcja 1 bez kontenerów: „brak kontenera”, skrypt idzie dalej', () => {
    const run = runScript({ FAKE_NO_CONTAINERS: '1' });
    expect(run.status).toBe(0);
    const out = scriptSection(run.stdout, 1);
    expect(out).not.toBeNull();
    expect(labelRows(out!, 'worker (Coolify id=2)')).toEqual(['  (brak kontenera)']);
    expect(labelRows(out!, 'aplikacja (Coolify id=1)')).toEqual(['  (brak kontenera)']);
    expect(run.stdout).toContain('Koniec. Skrypt niczego nie zmienił.');
  });

  it('psql tylko w transakcji do odczytu z limitem; każde zapytanie to SELECT bez cudzysłowów, $ i ` i dociera do psql bez zmian', () => {
    const psqlCalls = codeLines().filter((line) => line.includes('psql '));
    expect(psqlCalls.length).toBeGreaterThanOrEqual(1);
    for (const line of psqlCalls) {
      expect(line).toContain("docker exec -e 'PGOPTIONS=-c statement_timeout=30s -c default_transaction_read_only=on'");
    }

    const declared = declaredQueries();
    // Każde wywołanie `sql "…"` zostało odczytane (regex niczego nie pominął).
    expect(declared).toHaveLength(codeLines().filter((line) => /^\s*sql "/.test(line)).length);
    for (const q of declared) {
      expect(q.trimStart()).toMatch(/^SELECT /);
      expect(q).not.toMatch(/["$`\\]/);
      expect(q).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY|CALL)\b/i);
    }

    const run = runScript();
    expect(run.sql).toEqual(declared);
  });

  it('bramka zero (sekcja 3a): pięć warunków kroku 5, otwarte wpisy jak OPEN_SUBMISSION_STATUSES', () => {
    const gate = declaredQueries().find((q) => q.includes("name='invoice.submit.requested'"));
    expect(gate, 'brak zapytania bramki').toBeDefined();
    expect(gate).toContain("direction='outgoing' AND ksef_status IN ('queued','sending','offline_queued')");
    expect(gate).toContain("state IN ('created','retry','active')");
    expect(gate).toContain("FROM ksef_offline_queue WHERE status IN ('queued','sending')");
    expect(gate).toContain("i.ksef_status='failed' AND c.class IS DISTINCT FROM 'terminal'");
    const open = constList('lib/ksef/duplicate-recheck.ts', 'OPEN_SUBMISSION_STATUSES');
    expect(gate).toContain(`s.status IN ${sqlList(open)} AND i.ksef_status IN ('failed','rejected')`);
  });

  it('przypomnienia (sekcja 7c): rodzaje faktur jak CHASEABLE_INVOICE_KINDS harmonogramu', () => {
    const reminders = declaredQueries().find((q) => q.includes('reminders_paused'));
    expect(reminders, 'brak zapytania o przypomnienia').toBeDefined();
    const kinds = constList('lib/reminders/scheduler.ts', 'CHASEABLE_INVOICE_KINDS');
    expect(reminders).toContain(`i.invoice_kind IN ${sqlList(kinds)}`);
    expect(reminders).toContain("i.ksef_environment IS DISTINCT FROM 'production'");
  });

  it('w źródle nie ma adresów IP (repo jest publiczne)', () => {
    expect(source()).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  });

  it('brak połączenia z db-1: każde zapytanie mówi „zapytanie nieudane”, skrypt kończy się normalnie', () => {
    const run = runScript({ FAKE_SSH_FAIL_HOST: 'root@db.example.test' });
    expect(run.status).toBe(0);
    expect(run.stdout.match(/zapytanie nieudane/g)).toHaveLength(declaredQueries().length);
    expect(run.stdout).toContain('Koniec. Skrypt niczego nie zmienił.');
  });

  it('--sprawdz: tylko konfiguracja, bez łączenia z serwerami', () => {
    const run = runScript({}, ['--sprawdz']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Konfiguracja: ');
    expect(run.stdout).not.toContain('\n=== 1.');
    expect(run.sql).toEqual([]);
  });
});
