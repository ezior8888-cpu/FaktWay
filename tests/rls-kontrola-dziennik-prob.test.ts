import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { effectiveStatus, recoveryState, type AttemptStatus, type RecoveryState } from '@/lib/admin/centrum/send-errors';
import { createScriptHarness, labelRows, scriptSection, type ScriptHarness } from './helpers/kontrola-skrypt';
import { getRlsTestDatabaseUrl } from './helpers/rls-environment';

/**
 * `scripts/ops/kontrola-faktur-ksef.sh`, sekcja 12, na prawdziwej bazie z 00150.
 *
 * Cały skrypt idzie przez atrapę `ssh` (`bash -c`, jak sshd), a atrapa
 * `docker` przekazuje polecenie `psql` skryptu do lokalnej bazy testowej —
 * te same argumenty co w kontenerze na db-1 (bez `-U`/`-d`; bazę wskazują
 * zmienne PG*). Wyrocznia to czyste funkcje dashboardu
 * (`effectiveStatus`, `recoveryState` z lib/admin/centrum/send-errors.ts)
 * na surowych wierszach: skrypt ma liczyć tak samo jak /admin/centrum/bledy.
 *
 * Wymaga `RLS_TEST_DATABASE_URL` i programu `psql`. Dane: własna firma,
 * kody błędów `KONTROLA_*` i etap `kontrola` (odróżnialne od danych innych
 * testów); sprzątanie usuwa faktury (dziennik znika kaskadą).
 */

const hasDatabase = Boolean(process.env.RLS_TEST_DATABASE_URL?.trim());
if (hasDatabase && process.env.RLS_TEST_ALLOW_DESTRUCTIVE !== 'isolated-local-database') {
  throw new Error('RLS_TEST_ALLOW_DESTRUCTIVE wymaga potwierdzenia isolated-local-database: test tworzy i usuwa dane.');
}

function pgEnv(url: string): Record<string, string> {
  const u = new URL(url);
  return {
    PGHOST: u.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username || 'postgres'),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.replace(/^\//, '') || 'postgres',
    PGCONNECT_TIMEOUT: '10',
  };
}
const pg = hasDatabase ? pgEnv(getRlsTestDatabaseUrl()) : {};

const FAKE_DOCKER = `#!/usr/bin/env bash
# Atrapa docker: \`exec <kontener> psql …\` → psql do lokalnej bazy testowej
# (PG* z testu); -U/-d skryptu pominięte. Reszta: nic (brak kontenerów).
[ "$1" = exec ] && [ "$3" = psql ] || exit 0
shift 3
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    -U|-d) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
exec psql "\${args[@]}"
`;

/** Zapytanie testu (nie skryptu): wiersze rozdzielone NUL, pola tabulatorem. */
function query(sql: string): string[][] {
  const r = spawnSync('psql', ['-X', '-q', '-At', '-F', '\t', '-R', '\x01', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
    env: { ...process.env, ...pg },
  });
  if (r.error) throw new Error(`psql niedostępny: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
  const out = r.stdout.replace(/\n$/, '');
  return out ? out.split('\x01').map((row) => row.split('\t')) : [];
}

const T = 'c1200000-0000-4000-8000-000000000001';
const inv = (s: string) => `c1200000-0000-4000-8000-0000000000${s}`;
const run = (s: string) => `c1200000-0000-4000-8000-0000000f000${s}`;
const [A, B, C, D, E, F, G, H] = ['a1', 'b1', 'c1', 'd1', 'e1', 'f1', 'a2', 'a3'].map(inv);
const RUNS = ['1', '2', '3', '4'].map(run);

const SEED = `
INSERT INTO tenants (id, name, nip) VALUES ('${T}', 'Kontrola sekcja 12', '1234567890');
INSERT INTO invoices (id, tenant_id, direction, internal_number, invoice_type, invoice_kind, issue_date, seller_nip, buyer_nip, gross_total, net_total, vat_total, ksef_status, ksef_environment, submitted_to_ksef_at, fa3_data, seller_data, buyer_data) VALUES
 ('${A}','${T}','outgoing','FV/KONTROLA/A','VAT','regular',current_date,'1234567890','1234567890',123,100,23,'failed','test',NULL,'{}','{}','{}'),
 ('${B}','${T}','outgoing','FV/KONTROLA/B','VAT','regular',current_date,'1234567890','1234567890',123,100,23,'accepted','test',NULL,'{}','{}','{}'),
 ('${C}','${T}','outgoing','FV/KONTROLA/C','VAT','regular',current_date,'1234567890','1234567890',123,100,23,'draft',NULL,NULL,'{}','{}','{}'),
 ('${D}','${T}','outgoing','FV/KONTROLA/D','VAT','regular',current_date,'1234567890','1234567890',123,100,23,'sending','test',now()-interval '40 minutes','{}','{}','{}'),
 ('${E}','${T}','outgoing','FV/KONTROLA/E','VAT','regular',current_date,'1234567890','1234567890',123,100,23,'sending','test',now()-interval '5 minutes','{}','{}','{}'),
 ('${F}','${T}','outgoing','FV/KONTROLA/F','VAT','regular',current_date,'1234567890','1234567890',123,100,23,'queued',NULL,NULL,'{}','{}','{}'),
 ('${G}','${T}','outgoing','FV/KONTROLA/G','VAT','regular',current_date,'1234567890','1234567890',123,100,23,'failed','test',NULL,'{}','{}','{}'),
 ('${H}','${T}','outgoing','FV/KONTROLA/H','VAT','regular',current_date,'1234567890','1234567890',123,100,23,'sending','test',now()-interval '25 minutes','{}','{}','{}');
INSERT INTO ksef_send_attempts (tenant_id, invoice_id, job_id, status, stage, result, error_code, error_class, error_message, ksef_http_status, ksef_code, execution, started_at, finished_at) VALUES
 ('${T}','${B}','${RUNS[0]}','succeeded','finalize','accepted',NULL,NULL,NULL,NULL,NULL,2,now()-interval '1 hour',now()-interval '59 minutes'),
 ('${T}','${A}',NULL,'failed','credentials',NULL,'KONTROLA_SETUP','setup',E'NonRetriableError: brak certyfikatu\\ndruga linia | kreska',NULL,NULL,0,now()-interval '2 hours',now()-interval '2 hours'),
 ('${T}','${A}',NULL,'failed','ksef',NULL,'KONTROLA_KSEF','reconcile','Duplikat',400,440,1,now()-interval '90 minutes',now()-interval '90 minutes'),
 ('${T}','${B}',NULL,'failed','ksef',NULL,'KONTROLA_TRANSIENT','transient','KSeF 503',503,NULL,0,now()-interval '3 hours',now()-interval '3 hours'),
 ('${T}','${B}',NULL,'failed','ksef',NULL,'KONTROLA_TRANSIENT','transient','KSeF 503',503,NULL,1,now()-interval '150 minutes',now()-interval '150 minutes'),
 ('${T}','${C}',NULL,'refused','enqueue',NULL,'KONTROLA_MFA','setup','Wymagane MFA',NULL,NULL,0,now()-interval '4 hours',now()-interval '4 hours'),
 ('${T}','${F}',NULL,'refused','enqueue',NULL,'KONTROLA_MFA','setup','Wymagane MFA',NULL,NULL,0,now()-interval '5 hours',now()-interval '5 hours'),
 ('${T}','${D}',NULL,'started','kontrola',NULL,NULL,NULL,NULL,NULL,NULL,0,now()-interval '25 minutes',NULL),
 ('${T}','${E}',NULL,'started','kontrola',NULL,NULL,NULL,NULL,NULL,NULL,0,now()-interval '5 minutes',NULL),
 ('${T}','${F}',NULL,'waiting','health',NULL,'KONTROLA_HOLD','hold',NULL,NULL,NULL,0,now()-interval '1 hour',now()-interval '1 hour'),
 ('${T}','${G}',NULL,'failed','xml',NULL,'KONTROLA_STARY','terminal','stary',NULL,NULL,0,now()-interval '30 hours',now()-interval '30 hours'),
 ('${T}','${G}',NULL,'started','kontrola',NULL,NULL,NULL,NULL,NULL,NULL,0,now()-interval '3 days',NULL),
 ('${T}','${H}',NULL,'failed','ksef',NULL,'KONTROLA_W_TOKU','transient','KSeF 503',NULL,NULL,0,now()-interval '27 minutes',now()-interval '26 minutes');
INSERT INTO inngest_run_log (event_name, run_id, status, created_at) VALUES
 ('invoice.submit.requested','${RUNS[0]}','succeeded',now()-interval '58 minutes'),
 ('invoice.submit.requested','${RUNS[1]}','failed',now()-interval '2 hours'),
 ('cron.ops-heartbeat','${RUNS[2]}','succeeded',now()-interval '1 minute'),
 ('invoice.submit.requested','${RUNS[3]}','failed',now()-interval '30 hours');
`;

function cleanup(): void {
  query(`DELETE FROM inngest_run_log WHERE run_id IN (${RUNS.map((r) => `'${r}'`).join(',')})`);
  // Wyzwalacz 00132 nie usuwa faktur w wysyłce ani ze znacznikiem przejęcia —
  // najpierw szkic (jak cleanupInvoices w rls-cykl-faktury.test.ts).
  query(`UPDATE invoices SET ksef_status = 'draft', submitted_to_ksef_at = NULL, ksef_send_owner = NULL WHERE tenant_id = '${T}' AND ksef_status <> 'accepted'`);
  query(`DELETE FROM invoices WHERE tenant_id = '${T}'`);
  query(`DELETE FROM tenants WHERE id = '${T}'`);
}

const BUCKET: Record<RecoveryState, number> = { accepted: 0, open: 1, stuck: 2, in_progress: 3, draft: 4, unknown: 4 };
const STAN = (s: ReturnType<typeof effectiveStatus>) => (s === 'interrupted' ? 'przerwane' : s);
const dash = (v: string) => (v === '' ? '-' : v);

let harness: ScriptHarness;
let section = '';

describe.skipIf(!hasDatabase)('kontrola-faktur-ksef.sh, sekcja 12 na bazie z 00150 — liczy jak /admin/centrum/bledy', () => {
  beforeAll(() => {
    cleanup();
    query(SEED);
    harness = createScriptHarness(FAKE_DOCKER);
    const result = harness.run(pg);
    expect(result.status, result.stderr).toBe(0);
    section = scriptSection(result.stdout, 12) ?? '';
    expect(section, 'brak sekcji 12').not.toBe('');
  }, 120_000);

  afterAll(() => {
    harness?.cleanup();
    if (hasDatabase) cleanup();
  });

  /** Surowe wiersze dziennika z 24 h wg zegara bazy (jak skrypt). */
  function ledger24h(where = 'true') {
    const now = new Date(Number(query('SELECT extract(epoch FROM now()) * 1000')[0][0]));
    const rows = query(
      `SELECT a.status, extract(epoch FROM a.started_at) * 1000, coalesce((extract(epoch FROM a.finished_at) * 1000)::text, ''), a.invoice_id, a.tenant_id, a.stage, coalesce(a.error_code, ''), coalesce(a.error_class, ''), coalesce(a.ksef_http_status::text, ''), coalesce(a.ksef_code::text, ''), coalesce(i.ksef_status, ''), coalesce((extract(epoch FROM i.submitted_to_ksef_at) * 1000)::text, '')
         FROM ksef_send_attempts a JOIN invoices i ON i.id = a.invoice_id
        WHERE a.started_at > now() - interval '24 hours' AND ${where}`,
    ).map(([status, startedAt, finishedAt, invoiceId, tenantId, stage, code, cls, http, kod, invoiceStatus, submittedAt]) => {
      const iso = (v: string) => (v ? new Date(Number(v)).toISOString() : null);
      const row = { status: status as AttemptStatus, startedAt: iso(startedAt)!, finishedAt: iso(finishedAt) };
      return {
        stan: STAN(effectiveStatus(row, now)),
        invoiceId, tenantId, stage, code, cls, http, kod,
        recovery: recoveryState(invoiceStatus || null, iso(submittedAt), now),
      };
    });
    return rows;
  }

  it('wykonania z 24 h wg stanu = effectiveStatus dashboardu na wszystkich wierszach', () => {
    const counts = new Map<string, { n: number; invoices: Set<string> }>();
    for (const r of ledger24h()) {
      const c = counts.get(r.stan) ?? { n: 0, invoices: new Set<string>() };
      c.n += 1;
      c.invoices.add(r.invoiceId);
      counts.set(r.stan, c);
    }
    const expected = [...counts].map(([stan, c]) => `${stan} | ${c.n} | ${c.invoices.size}`).sort();
    expect(labelRows(section, 'wykonania z 24 h wg stanu').sort()).toEqual(expected);
    // Seed ma każdy stan, także „started” świeży (5 min) obok „przerwane” (25 min).
    expect(expected.map((l) => l.split(' | ')[0])).toEqual(
      expect.arrayContaining(['failed', 'przerwane', 'refused', 'started', 'succeeded', 'waiting']),
    );
  });

  it('błędy, odmowy i przerwane wg kodu: liczby i stan faktur teraz = recoveryState dashboardu', () => {
    const errors = ledger24h(`a.tenant_id = '${T}'`).filter((r) => ['failed', 'refused', 'przerwane'].includes(r.stan));
    const groups = new Map<string, { prob: number; invoices: Map<string, RecoveryState>; tenants: Set<string> }>();
    for (const r of errors) {
      const key = [r.stan, r.stage, dash(r.code), dash(r.cls), dash(r.http), dash(r.kod)].join(' | ');
      const g = groups.get(key) ?? { prob: 0, invoices: new Map(), tenants: new Set<string>() };
      g.prob += 1;
      g.invoices.set(r.invoiceId, r.recovery);
      g.tenants.add(r.tenantId);
      groups.set(key, g);
    }
    expect(groups.size).toBe(6);
    const rows = labelRows(section, 'błędy, odmowy i przerwane z 24 h wg kodu');
    for (const [key, g] of groups) {
      const buckets = [0, 0, 0, 0, 0];
      for (const state of g.invoices.values()) buckets[BUCKET[state]] += 1;
      const prefix = `${key} | ${g.prob} | ${g.invoices.size} | ${g.tenants.size} | ${buckets.join(' | ')} | `;
      expect(rows.filter((row) => row.startsWith(prefix)), prefix).toHaveLength(1);
    }
    // Kotwice niezależne od wyroczni: dwa błędy przejściowe faktury potem przyjętej,
    // przerwane z fakturą w `sending` od 40 min (utknęła, I2), błąd faktury w `sending`
    // od 25 min (jeszcze w toku — próg 30 min), odmowy szkicu i faktury w kolejce.
    expect(rows).toContainEqual(expect.stringMatching(/^failed \| ksef \| KONTROLA_TRANSIENT \| transient \| 503 \| - \| 2 \| 1 \| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \| /));
    expect(rows).toContainEqual(expect.stringMatching(/^przerwane \| kontrola \| - \| - \| - \| - \| 1 \| 1 \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \| /));
    expect(rows).toContainEqual(expect.stringMatching(/^failed \| ksef \| KONTROLA_W_TOKU \| transient \| - \| - \| 1 \| 1 \| 1 \| 0 \| 0 \| 0 \| 1 \| 0 \| /));
    expect(rows).toContainEqual(expect.stringMatching(/^refused \| enqueue \| KONTROLA_MFA \| setup \| - \| - \| 2 \| 2 \| 1 \| 0 \| 0 \| 0 \| 1 \| 1 \| /));
    expect(rows.join('\n')).not.toMatch(/KONTROLA_STARY|KONTROLA_HOLD|^started \| kontrola/m);
  });

  it('lista ostatnich: przerwane i błędy z 24 h, treść w jednym wierszu, bez świeżego started i starych', () => {
    const rows = labelRows(section, 'ostatnie błędy, odmowy i przerwane z 24 h');
    const mine = rows.filter((row) => row.includes('c1200000-'));
    expect(mine).toHaveLength(8);
    expect(mine).toContainEqual(expect.stringContaining(`| przerwane | kontrola | - | - | - | ${D} | FV/KONTROLA/D | 0 | sending | -`));
    expect(mine).toContainEqual(
      expect.stringContaining(`| ${A} | FV/KONTROLA/A | 0 | failed | NonRetriableError: brak certyfikatu druga linia | kreska`),
    );
    expect(mine.join('\n')).not.toContain(E);
    expect(mine.join('\n')).not.toContain(G);
  });

  it('wykonania joba z inngest_run_log bez wiersza w dzienniku (czy dziennik pisze)', () => {
    const runs = query(
      `SELECT run_id FROM inngest_run_log WHERE event_name='invoice.submit.requested' AND created_at > now() - interval '24 hours'`,
    ).map(([r]) => r);
    const jobs = new Set(
      query(`SELECT job_id::text FROM ksef_send_attempts WHERE job_id IS NOT NULL AND started_at > now() - interval '25 hours'`).map(([j]) => j),
    );
    const missing = runs.filter((r) => !jobs.has(r)).length;
    expect(runs).toEqual(expect.arrayContaining([RUNS[0], RUNS[1]]));
    expect(missing).toBeGreaterThanOrEqual(1);
    expect(labelRows(section, 'wykonania joba wysyłki z 24 h')).toEqual([`${runs.length} | ${missing}`]);
  });

  it('zakres dziennika: liczba wierszy z 24 h zgodna z bazą', () => {
    const [od, , z24] = labelRows(section, 'zakres dziennika')[0].split(' | ');
    expect(od).not.toBe('(pusty)');
    expect(Number(z24)).toBe(ledger24h().length);
  });
});
