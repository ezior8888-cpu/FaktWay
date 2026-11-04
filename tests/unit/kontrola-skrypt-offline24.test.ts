import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createScriptHarness, KONTROLA_SCRIPT, labelRows, type ScriptHarness } from '../helpers/kontrola-skrypt';

/**
 * `scripts/ops/kontrola-faktur-ksef.sh`, sekcja 4a: zaległości Offline24
 * (A5, luka #4). Automatyczny Offline24 jest wyłączony od 02.10.2026
 * (`lib/ksef/offline24-policy.ts`), ale kwarantanna crona kolejki zostawia
 * fakturę w `offline_queued` bez wyjścia — sekcja ma pokazać, czy na
 * produkcji coś tak stoi (decyzja o luce #5).
 *
 * Uruchamiany jest PRAWDZIWY skrypt (`tests/helpers/kontrola-skrypt.ts`:
 * atrapa `ssh` → `bash -c`, jak sshd). Atrapa `docker` zapisuje, co
 * faktycznie dostał `psql -c`. Semantykę zapytań na bazie z pełnym
 * łańcuchem migracji sprawdza `tests/rls-kontrola-offline24.test.ts`; tu:
 * miejsce sekcji, etykiety i to, że zapytania są tylko do odczytu i nie
 * zmieniają się po drodze przez dwie powłoki.
 */

const FAKE_DOCKER = `#!/usr/bin/env bash
# Atrapa docker: psql zapisuje SQL z -c (rozdzielone NUL); reszta: nic (brak kontenerów).
[ "$1" = exec ] && [ "$3" = psql ] || exit 0
sql=""; prev=""
for a in "$@"; do [ "$prev" = "-c" ] && sql=$a; prev=$a; done
printf '%s\\0' "$sql" >> "$FAKE_DIR/sql"
exit 0
`;

/** Etykiety sekcji 4a w kolejności (początki, jak w `labelRows`). */
const LABELS = [
  '(a) kolejka ksef_offline_queue wg stanu',
  '(b) otwarte wpisy kolejki',
  '(c) faktury offline_queued',
  '(d) faktury offline_queued do uzgodnienia z KSeF',
  '(e) failed/rejected z kodem OFFLINE_',
  '(f) inny ślad Offline24',
  '(g) wpisy kolejki zamknięte',
  '(h) przebiegi crona',
];

let harness: ScriptHarness;

beforeEach(() => {
  harness = createScriptHarness(FAKE_DOCKER);
});

afterEach(() => {
  harness.cleanup();
});

function runScript(env: Record<string, string> = {}) {
  const result = harness.run(env);
  const log = join(harness.dir, 'sql');
  const sql = existsSync(log) ? readFileSync(log, 'utf8').split('\0').slice(0, -1) : [];
  return { ...result, sql };
}

/** Wyjście sekcji 4a (od nagłówka do następnej sekcji); `null`, gdy jej nie ma. */
function section4a(stdout: string): string | null {
  const start = stdout.indexOf('\n=== 4a.');
  if (start === -1) return null;
  const next = stdout.indexOf('\n=== ', start + 1);
  return stdout.slice(start, next === -1 ? undefined : next);
}

/** `sql "etykieta" "zapytanie"` ze źródła sekcji 4a skryptu, w kolejności. */
function declaredSection4aQueries(): string[] {
  const source = readFileSync(KONTROLA_SCRIPT, 'utf8');
  const start = source.indexOf('\nsection "4a.');
  expect(start, 'brak sekcji 4a w źródle skryptu').toBeGreaterThan(-1);
  const end = source.indexOf('\nsection "', start + 1);
  const body = source.slice(start, end);
  const re = /^\s*sql "(?:[^"\\]|\\.)*"\s*(?:\\\n\s*)?"((?:[^"\\]|\\.)*)"/gm;
  return [...body.matchAll(re)].map((m) => m[1]);
}

describe('kontrola-faktur-ksef.sh — sekcja 4a: zaległości Offline24', () => {
  it('sekcja 4a stoi między fakturami wychodzącymi (4) a UPO (5) i ma wszystkie etykiety w kolejności', () => {
    const run = runScript();
    expect(run.status).toBe(0);
    const out = section4a(run.stdout);
    expect(out, 'brak sekcji 4a w wyjściu skryptu').not.toBeNull();
    expect(out).toContain('Offline24');

    const at4 = run.stdout.indexOf('\n=== 4. ');
    const at4a = run.stdout.indexOf('\n=== 4a.');
    const at5 = run.stdout.indexOf('\n=== 5. ');
    expect(at4).toBeGreaterThan(-1);
    expect(at4 < at4a && at4a < at5).toBe(true);

    const positions = LABELS.map((label) => out!.indexOf(`--- ${label}`));
    for (const [i, p] of positions.entries()) expect(p, LABELS[i]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // Pusta baza (atrapa bez wierszy): każda etykieta bez wierszy wyniku.
    for (const label of LABELS) expect(labelRows(out!, label)).toEqual([]);
    // KSEF_ENV workera na początku sekcji (cron bierze tylko wpisy z tym środowiskiem); atrapa: brak kontenerów.
    expect(labelRows(out!, 'KSEF_ENV workera')).toEqual(['  (brak kontenera workera)']);
    expect(run.stdout).toContain('Koniec. Skrypt niczego nie zmienił.');
  });

  it('psql dostaje każde zapytanie sekcji dokładnie tak, jak w skrypcie; tylko SELECT, bez cudzysłowów, $ i `', () => {
    const run = runScript();
    const declared = declaredSection4aQueries();
    expect(declared).toHaveLength(LABELS.length);
    for (const q of declared) {
      expect(q.trimStart()).toMatch(/^SELECT /);
      expect(q).not.toMatch(/["$`\\]/);
      expect(q).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/i);
    }
    // Kolejność zapytań w całym skrypcie zachowana, a sekcja 4a dociera do psql bez zmian.
    const at = run.sql.indexOf(declared[0]!);
    expect(at, 'pierwsze zapytanie sekcji 4a nie dotarło do psql').toBeGreaterThan(-1);
    expect(run.sql.slice(at, at + declared.length)).toEqual(declared);
  });

  it('zapytania sekcji: kolejka po statusie bez LIKE na kodach, najnowszy wpis na fakturę, lista z limitem', () => {
    const declared = declaredSection4aQueries();
    const joined = declared.join('\n');
    // `_` w LIKE to symbol wieloznaczny — prefiks kodu porównujemy wprost.
    expect(joined).not.toMatch(/LIKE/i);
    expect(declared.filter((q) => q.includes("left(i.last_error_code, 8) = 'OFFLINE_'"))).toHaveLength(1);
    // Kilka wpisów kolejki na fakturę jest możliwe (brak UNIQUE na invoice_id) — zawsze najnowszy.
    const lateral = declared.filter((q) => q.includes('LEFT JOIN LATERAL'));
    expect(lateral.length).toBeGreaterThanOrEqual(4);
    for (const q of lateral) expect(q).toContain('ORDER BY x.created_at DESC, x.id LIMIT 1');
    // Lista robocza ma limit i NIP firmy (kontekst wyszukiwania w KSeF).
    expect(declared[3]).toMatch(/LIMIT 50$/);
    expect(declared[3]).toContain('JOIN tenants t ON t.id = i.tenant_id');
    // Przebiegi crona z inngest_run_log (wynik i błąd handlera); pgboss.job ma zawsze completed bez wyniku (run-job.ts).
    expect(declared[7]).toContain('FROM inngest_run_log');
    expect(declared[7]).toContain("event_name='cron.process-offline-queue'");
    expect(declared[7]).not.toContain('pgboss');
    expect(declared[7]).toMatch(/LIMIT 5$/);
  });

  it('brak połączenia z db-1: sekcja mówi „zapytanie nieudane”, skrypt kończy się normalnie', () => {
    const run = runScript({ FAKE_SSH_FAIL_HOST: 'root@db.example.test' });
    expect(run.status).toBe(0);
    const out = section4a(run.stdout);
    expect(out).not.toBeNull();
    expect(out!.match(/zapytanie nieudane/g)).toHaveLength(LABELS.length);
    expect(run.stdout).toContain('Koniec. Skrypt niczego nie zmienił.');
  });
});
