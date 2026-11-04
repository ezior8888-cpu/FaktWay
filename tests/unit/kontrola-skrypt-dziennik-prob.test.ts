import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createScriptHarness, KONTROLA_SCRIPT, scriptSection, type ScriptHarness } from '../helpers/kontrola-skrypt';

/**
 * `scripts/ops/kontrola-faktur-ksef.sh`, sekcja 12: dziennik prób wysyłki
 * (A5, `ksef_send_attempts` z 00150) — błędy i odmowy z 24 h, wykonania
 * przerwane (`started` bez wyniku po 20 min, jak `/admin/centrum/bledy`)
 * i nieudane zapisy dziennika w logach.
 *
 * Uruchamiany jest PRAWDZIWY skrypt (`tests/helpers/kontrola-skrypt.ts`:
 * atrapa `ssh` → `bash -c`, jak sshd). Atrapa `docker` zapisuje, co
 * faktycznie dostał `psql -c`, i odpowiada na sondę tabeli. Semantykę
 * zapytań na bazie z 00150 sprawdza `tests/rls-kontrola-dziennik-prob.test.ts`;
 * tu: gałęzie skryptu, komunikaty i to, że żadne zapytanie nie zmienia się
 * po drodze.
 */

const LEDGER_TABLE = 'ksef_send_attempts';
const WORKER = 'workertest-abc123';
const APP = 'apptest-def456';

const FAKE_DOCKER = `#!/usr/bin/env bash
# Atrapa docker. psql: zapisuje SQL z -c (rozdzielone NUL); sonda tabeli odpowiada
# FAKE_REGCLASS w formacie prawdziwego psql (samo t/f tylko z -At).
# logs: jak docker logs bez TTY — ostrzeżenia i błędy kontenera (console.warn/error) na stderr.
case "$1" in
  ps) [ -n "\${FAKE_CONTAINERS:-}" ] && printf '%s\\n' $FAKE_CONTAINERS; exit 0 ;;
  inspect) case "$*" in *State.StartedAt*) echo 2026-10-13T13:20:00Z ;; esac; exit 0 ;;
  logs)
    f="$FAKE_DIR/log-\${!#}"; [ -f "$f" ] || exit 0
    grep -vE ' WARN | ERROR |^\\[ksef\\.send-attempts\\]' "$f"
    grep -E ' WARN | ERROR |^\\[ksef\\.send-attempts\\]' "$f" >&2
    exit 0 ;;
  exec)
    [ "$3" = psql ] || exit 0
    sql=""; prev=""; at=0
    for a in "$@"; do [ "$prev" = "-c" ] && sql=$a; [ "$a" = -At ] && at=1; prev=$a; done
    printf '%s\\0' "$sql" >> "$FAKE_DIR/sql"
    case "$sql" in
      *"to_regclass('public.${LEDGER_TABLE}')"*)
        [ -n "\${FAKE_REGCLASS:-}" ] || exit 1
        if [ $at = 1 ]; then printf '%s\\n' "$FAKE_REGCLASS"
        else printf ' ?column? \\n----------\\n %s\\n(1 row)\\n\\n' "$FAKE_REGCLASS"; fi ;;
    esac
    exit 0 ;;
esac
exit 0
`;

let harness: ScriptHarness;
let dir: string;

beforeEach(() => {
  harness = createScriptHarness(FAKE_DOCKER);
  dir = harness.dir;
});

afterEach(() => {
  harness.cleanup();
});

interface Run {
  stdout: string;
  sql: string[];
  status: number | null;
}

function runScript(env: Record<string, string> = {}): Run {
  const result = harness.run(env);
  const log = join(dir, 'sql');
  const sql = existsSync(log) ? readFileSync(log, 'utf8').split('\0').slice(0, -1) : [];
  return { stdout: result.stdout, sql, status: result.status };
}

function section12(stdout: string): string {
  const section = scriptSection(stdout, 12);
  expect(section, 'brak sekcji 12 w wyjściu skryptu').not.toBeNull();
  return section!;
}

const ledgerQueries = (sql: string[]) =>
  sql.filter((q) => q.includes(LEDGER_TABLE) && !q.includes('to_regclass'));

describe('kontrola-faktur-ksef.sh — sekcja 12: dziennik prób wysyłki', () => {
  it('z tabelą: zakres dziennika, stany z 24 h, błędy wg kodu ze stanem faktur teraz i lista ostatnich', () => {
    const run = runScript({ FAKE_REGCLASS: 't' });
    expect(run.status).toBe(0);
    const out = section12(run.stdout);

    expect(out).toContain('dziennik prób wysyłki');
    expect(out).toContain('zakres dziennika');
    expect(out).toContain('bez wiersza w dzienniku');
    expect(out).toContain('wykonania z 24 h wg stanu');
    expect(out).toContain('błędy, odmowy i przerwane z 24 h wg kodu');
    expect(out).toContain('ostatnie błędy, odmowy i przerwane z 24 h');
    expect(out).not.toContain('BRAK TABELI');
    expect(out).toContain('(brak kontenerów aplikacji i workera)');

    const queries = ledgerQueries(run.sql);
    expect(queries).toHaveLength(5);
    // Czy dziennik pisze: wykonania joba wysyłki z inngest_run_log bez wiersza w dzienniku.
    expect(
      queries.filter((q) => q.includes('FROM inngest_run_log') && q.includes("event_name='invoice.submit.requested'")),
    ).toHaveLength(1);
    // Te same progi co /admin/centrum/bledy: okno 24 h, przerwane po 20 min,
    // „utknęła” po 30 min w `sending` (I2).
    for (const q of queries) expect(q).toContain("interval '24 hours'");
    expect(queries.filter((q) => q.includes("interval '20 minutes'"))).toHaveLength(3);
    expect(queries.some((q) => q.includes("interval '30 minutes'"))).toBe(true);
    const minuteThresholds = new Set(queries.flatMap((q) => [...q.matchAll(/interval '(\d+) min/g)].map((m) => m[1])));
    expect(minuteThresholds).toEqual(new Set(['20', '30']));
    // Tylko odczyt.
    for (const q of queries) expect(q.trimStart()).toMatch(/^SELECT /);
  });

  it('bez tabeli (00150 niewgrana): jeden komunikat zamiast serii „zapytanie nieudane”, bez zapytań do dziennika', () => {
    const run = runScript({ FAKE_REGCLASS: 'f' });
    expect(run.status).toBe(0);
    const out = section12(run.stdout);

    expect(out).toContain('BRAK TABELI ksef_send_attempts');
    expect(out).toContain('00150');
    expect(out).not.toContain('zapytanie nieudane');
    expect(ledgerQueries(run.sql)).toEqual([]);
    expect(run.stdout).toContain('Koniec. Skrypt niczego nie zmienił.');
  });

  it('sonda tabeli nieudana: „nie wiadomo”, a nie pusty dziennik', () => {
    const run = runScript();
    expect(run.status).toBe(0);
    const out = section12(run.stdout);

    expect(out).toContain('nie wiadomo');
    expect(out).not.toContain('BRAK TABELI');
    expect(ledgerQueries(run.sql)).toEqual([]);
  });

  it('brak połączenia z db-1: skrypt kończy się i mówi „nie wiadomo”', () => {
    const run = runScript({ FAKE_REGCLASS: 't', FAKE_SSH_FAIL_HOST: 'root@db.example.test' });
    expect(run.status).toBe(0);
    expect(section12(run.stdout)).toContain('nie wiadomo');
    expect(run.stdout).toContain('Koniec. Skrypt niczego nie zmienił.');
  });

  it('logi: wpisy ksef.send.attempt i nieudane zapisy dziennika osobno dla workera i aplikacji', () => {
    writeFileSync(
      join(dir, `log-${WORKER}`),
      [
        '[worker] ksef.send.attempt {"status":"succeeded","stage":"finalize"}',
        '[worker] ksef.send.attempt {"status":"failed","stage":"credentials","code":"NO_CERTIFICATE"}',
        '[worker] WARN Dziennik prób wysyłki KSeF: zapis nieudany (wysyłka trwa dalej) {"op":"start"}',
        '[worker] WARN Dziennik prób wysyłki KSeF: opis porażki nieudany (wysyłka bez zmian) {}',
        '[worker] cron.ops-heartbeat ok',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, `log-${APP}`),
      [
        // Odmowa przed kolejką zapisuje akcja serwera (aplikacja); `[ksef.send-attempts]`
        // to nie jest wpis wyniku wykonania.
        '[ksef.send-attempts] zapis odmowy przed kolejką nieudany { code: "MFA_REQUIRED" }',
      ].join('\n'),
    );
    const run = runScript({ FAKE_REGCLASS: 't', FAKE_CONTAINERS: `${WORKER} ${APP}` });
    const out = section12(run.stdout);

    // Okno logów to czas od startu kontenera (wdrożenie usuwa stary kontener z logami).
    expect(out).toContain(`${WORKER} (start 2026-10-13T13:20:00Z): ksef.send.attempt 2, zapis nieudany 2`);
    expect(out).toContain(`${APP} (start 2026-10-13T13:20:00Z): ksef.send.attempt 0, zapis nieudany 1`);
  });
});

describe('kontrola-faktur-ksef.sh — zapytania przechodzą przez dwie powłoki bez zmian', () => {
  /** `sql "etykieta" "zapytanie"` ze źródła skryptu, w kolejności (zmienna okna sekcji 9 rozwinięta). */
  function declaredQueries(): string[] {
    const source = readFileSync(KONTROLA_SCRIPT, 'utf8');
    const re = /^\s*sql "(?:[^"\\]|\\.)*"\s*(?:\\\n\s*)?"((?:[^"\\]|\\.)*)"/gm;
    return [...source.matchAll(re)].map((m) => m[1].replaceAll('$A4B_HOURS', '24'));
  }

  it('psql dostaje każde zapytanie dokładnie tak, jak jest w skrypcie (bez cudzysłowów, $ i ` po drodze)', () => {
    const run = runScript({ FAKE_REGCLASS: 't' });
    const declared = declaredQueries();
    const received = run.sql.filter((q) => !q.includes('to_regclass'));

    expect(declared.length).toBeGreaterThan(30);
    expect(received).toEqual(declared);
    for (const q of declared) expect(q.trimStart()).toMatch(/^SELECT /);
  });
});
