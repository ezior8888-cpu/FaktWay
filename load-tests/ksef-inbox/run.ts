/**
 * Test obciążenia odpytywania Skrzynki KSeF: jedna komenda, patrz README.
 *
 *   pnpm load:inbox --firms=3000 --minutes=18
 *   pnpm load:inbox --sprzataj          (usuwa firmy i schematy po przerwanym teście)
 *
 * Prawdziwe: worker pg-boss (`lib/jobs/worker.ts`), cron rozsyłki, runner, klient
 * HTTP KSeF, logowanie XAdES z podpisem, zapis do lokalnej bazy przez PostgREST.
 * Atrapa tylko po drugiej stronie HTTP (`atrapa-ksef.mjs`). Worker dostaje własny
 * schemat pg-boss i tylko jeden cron, bo lokalna baza jest wspólna.
 *
 * Nie uruchamia się poza pętlą zwrotną: adres bazy i Supabase muszą być 127.0.0.1.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encryptCredentials } from '../../lib/ksef/credentials-crypto';
import {
  INBOX_ALARM_OVERDUE_MS,
  INBOX_ACTIVITY_TIERS,
  INBOX_POLL_SLOTS_DEFAULT,
  INBOX_TIER_INTERVAL_MS,
  type InboxActivityTier,
} from '../../lib/ksef/inbox-schedule';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const DB_CONTAINER = 'supabase_db_ksef-saas';
const NAME_PREFIX = 'LOADTEST-INBOX-';
const SCHEMA_PREFIX = 'pgboss_load_';
const TIER_DIGIT: Record<InboxActivityTier, number> = { hot: 1, warm: 2, cold: 3, dormant: 4 };

interface Options {
  firms: number;
  minutes: number;
  slots: number | null;
  mix: Record<InboxActivityTier, number>;
  invoicesPerMonth: number;
  error429: number;
  error5xx: number;
  /** Wszystkie firmy należne naraz (po awarii), zamiast równomiernie w cyklu. */
  allDue: boolean;
  /** Stary kod: cron co 15 min bez harmonogramu; opóźnienie liczone od utworzenia zadania. */
  label: string;
  cleanupOnly: boolean;
}

function parseOptions(argv: string[]): Options {
  const args = new Map<string, string>();
  for (const raw of argv) {
    const match = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(raw);
    if (!match) throw new Error(`Nie znam argumentu: ${raw}`);
    args.set(match[1]!, match[2] ?? 'true');
  }
  const mixRaw = (args.get('mix') ?? '60,25,10,5').split(',').map(Number);
  if (mixRaw.length !== 4 || mixRaw.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error('--mix=gorąca,ciepła,zimna,uśpiona w procentach, np. 60,25,10,5');
  }
  const total = mixRaw.reduce((a, b) => a + b, 0);
  return {
    firms: Number(args.get('firms') ?? 1000),
    minutes: Number(args.get('minutes') ?? 18),
    slots: args.has('slots') ? Number(args.get('slots')) : null,
    mix: { hot: mixRaw[0]! / total, warm: mixRaw[1]! / total, cold: mixRaw[2]! / total, dormant: mixRaw[3]! / total },
    invoicesPerMonth: Number(args.get('faktur') ?? 60),
    error429: Number(args.get('blad-429') ?? 0.005),
    error5xx: Number(args.get('blad-5xx') ?? 0.005),
    allDue: args.get('wszystkie-naraz') === 'true',
    label: args.get('etykieta') ?? '',
    cleanupOnly: args.get('sprzataj') === 'true',
  };
}

type PgClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
};

function pgClient(): PgClient {
  const require = createRequire(import.meta.url);
  const pg = createRequire(require.resolve('pg-boss'))('pg') as { Client: new (config: { connectionString: string }) => PgClient };
  return new pg.Client({ connectionString: DB_URL });
}

function readEnvLocal(): Record<string, string> {
  const file = path.join(ROOT, '.env.local');
  if (!existsSync(file)) throw new Error('Brak .env.local: uruchom najpierw `pnpm db:local env`.');
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]!] = match[2]!.replace(/^["']|["']$/g, '');
  }
  return out;
}

function assertLocal(env: Record<string, string>): void {
  const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? '');
  if (url.hostname !== '127.0.0.1') {
    throw new Error('Test obciążenia działa tylko na lokalnej bazie (NEXT_PUBLIC_SUPABASE_URL = 127.0.0.1).');
  }
}

/** Certyfikat tylko dla atrapy: podpis XAdES musi się policzyć naprawdę. */
function testCertificate(): { certificatePem: string; privateKeyPem: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ksef-inbox-'));
  const key = path.join(dir, 'k.pem');
  const cert = path.join(dir, 'c.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '30', '-subj', '/CN=Atrapa KSeF test obciazenia/serialNumber=TINPL-1234567890',
  ], { stdio: 'ignore' });
  return { certificatePem: readFileSync(cert, 'utf8'), privateKeyPem: readFileSync(key, 'utf8') };
}

function ensureMigration(): void {
  const present = execFileSync('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-qtAc',
    "SELECT to_regclass('public.ksef_inbox_schedule') IS NOT NULL"]).toString().trim();
  if (present === 't') return;
  console.log('Wgrywam 00160 na lokalną bazę (bez wpisu w schema_migrations)...');
  execFileSync('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '--single-transaction'],
    { input: readFileSync(path.join(ROOT, 'supabase/migrations/00160_ksef_inbox_schedule.sql')), stdio: ['pipe', 'ignore', 'inherit'] });
  execFileSync('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-c', "NOTIFY pgrst, 'reload schema';"], { stdio: 'ignore' });
}

/** Tabele z kluczem obcym do `tenants`, także te z dopisywaniem jedynie (audyt). */
async function tenantChildTables(db: PgClient): Promise<Array<{ table: string; column: string }>> {
  const { rows } = await db.query(`
    SELECT c.conrelid::regclass::text AS tab, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.confrelid = 'public.tenants'::regclass AND array_length(c.conkey, 1) = 1`);
  return rows.map((row) => ({ table: row.tab as string, column: row.col as string }));
}

async function invoiceChildTables(db: PgClient): Promise<Array<{ table: string; column: string }>> {
  const { rows } = await db.query(`
    SELECT c.conrelid::regclass::text AS tab, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.confrelid = 'public.invoices'::regclass AND array_length(c.conkey, 1) = 1`);
  return rows.map((row) => ({ table: row.tab as string, column: row.col as string }));
}

/**
 * Sprzątanie po oznaczeniu w nazwie. Tryb `replica` wyłącza wyzwalacze dopisywania
 * (audyt) tylko w tej sesji, więc reszta bazy pracuje normalnie, ale też klucze obce:
 * dlatego usuwamy po kolei, od dzieci faktur do firm. Tylko firmy z tym oznaczeniem.
 */
async function cleanup(db: PgClient): Promise<{ firms: number; schemas: number }> {
  const { rows: tenantRows } = await db.query('SELECT id FROM public.tenants WHERE name LIKE $1', [`${NAME_PREFIX}%`]);
  const ids = tenantRows.map((row) => row.id as string);
  if (ids.length > 0) {
    const tenantChildren = await tenantChildTables(db);
    const invoiceChildren = await invoiceChildTables(db);
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL session_replication_role = 'replica'`);
      const { rows: invoiceRows } = await db.query('SELECT id FROM public.invoices WHERE tenant_id = ANY($1::uuid[])', [ids]);
      const invoiceIds = invoiceRows.map((row) => row.id as string);
      if (invoiceIds.length > 0) {
        for (const { table, column } of invoiceChildren) {
          await db.query(`DELETE FROM ${table} WHERE ${column} = ANY($1::uuid[])`, [invoiceIds]);
        }
      }
      for (const { table, column } of tenantChildren) {
        await db.query(`DELETE FROM ${table} WHERE ${column} = ANY($1::uuid[])`, [ids]);
      }
      await db.query('DELETE FROM public.tenants WHERE id = ANY($1::uuid[])', [ids]);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  }
  const { rows: schemaRows } = await db.query(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`,
    [`${SCHEMA_PREFIX}%`],
  );
  for (const row of schemaRows) {
    await db.query(`DROP SCHEMA IF EXISTS ${row.nspname as string} CASCADE`);
  }
  // Przebiegi zapisane przez ten worker (bez firmy, tylko nazwa kolejki i id joba).
  await db.query(`SET session_replication_role = 'replica'`);
  await db.query(`DELETE FROM public.inngest_run_log WHERE run_id LIKE 'loadtest-%'`).catch(() => undefined);
  await db.query(`SET session_replication_role = 'origin'`);
  return { firms: ids.length, schemas: schemaRows.length };
}

function tierForIndex(index: number, options: Options): InboxActivityTier {
  const position = index / options.firms;
  let edge = 0;
  for (const tier of INBOX_ACTIVITY_TIERS) {
    edge += options.mix[tier];
    if (position < edge) return tier;
  }
  return 'dormant';
}

/**
 * Zasiew firm. Poziom wynika z danych (subskrypcja, ostatnia faktura, aktywność),
 * więc pierwszy przebieg policzy ten sam poziom z tej samej funkcji co produkcja.
 * Terminy równomiernie w cyklu poziomu: to stan ustalony, a nie sztuczna fala.
 */
async function seed(db: PgClient, runId: string, options: Options): Promise<void> {
  const { certificatePem, privateKeyPem } = testCertificate();
  const started = Date.now();
  const chunkSize = 500;
  const now = Date.now();
  for (let from = 0; from < options.firms; from += chunkSize) {
    const rows = Array.from({ length: Math.min(chunkSize, options.firms - from) }, (_, offset) => {
      const index = from + offset;
      const tier = tierForIndex(index, options);
      const id = randomUUID();
      const nip = `9${TIER_DIGIT[tier]}${String(index).padStart(8, '0')}`;
      const blob = encryptCredentials(
        { type: 'xades', nip, certificatePem, privateKeyPem },
        id,
      );
      return { id, nip, tier, blob: `\\x${blob.toString('hex')}` };
    });

    await db.query(`
      INSERT INTO public.tenants (id, name, nip, ksef_credentials_encrypted, ksef_verified_at, ksef_verified_environment, stripe_customer_id)
      SELECT id, $1 || nip, nip, blob::bytea, now(), 'test', CASE WHEN tier <> 'dormant' THEN 'cus_loadtest_' || id END
        FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[]) AS x(id, nip, blob, tier)`,
      [`${NAME_PREFIX}${runId}-`, rows.map((r) => r.id), rows.map((r) => r.nip), rows.map((r) => r.blob), rows.map((r) => r.tier)]);

    const paying = rows.filter((r) => r.tier !== 'dormant');
    await db.query(`
      INSERT INTO public.subscriptions (tenant_id, stripe_subscription_id, stripe_customer_id, stripe_price_id, status, plan)
      SELECT id, 'sub_loadtest_' || id, 'cus_loadtest_' || id, 'price_loadtest', 'active', 'monthly'
        FROM unnest($1::uuid[]) AS x(id)`, [paying.map((r) => r.id)]);

    // Stan ustalony: termin losowo w cyklu poziomu, HWM o jeden cykl wstecz.
    const schedule = rows.map((r) => {
      const interval = INBOX_TIER_INTERVAL_MS[r.tier];
      const due = options.allDue ? now - Math.random() * 60_000 : now + Math.random() * interval;
      return {
        id: r.id,
        tier: r.tier,
        due: new Date(due).toISOString(),
        hwm: new Date(due - interval).toISOString(),
        invoiceAt: r.tier === 'hot' ? new Date(now - 86_400_000).toISOString()
          : r.tier === 'warm' ? new Date(now - 15 * 86_400_000).toISOString()
            : null,
        activityAt: r.tier === 'cold' ? new Date(now - 60 * 86_400_000).toISOString() : null,
      };
    });
    await db.query(`
      UPDATE public.ksef_inbox_schedule s
         SET next_poll_at = x.due, activity_tier = x.tier, last_invoice_at = x.invoice_at, last_activity_at = x.activity_at, nudged_at = NULL
        FROM unnest($1::uuid[], $2::timestamptz[], $3::text[], $4::timestamptz[], $5::timestamptz[]) AS x(id, due, tier, invoice_at, activity_at)
       WHERE s.tenant_id = x.id`,
      [schedule.map((s) => s.id), schedule.map((s) => s.due), schedule.map((s) => s.tier), schedule.map((s) => s.invoiceAt), schedule.map((s) => s.activityAt)]);
    await db.query(`
      INSERT INTO public.ksef_inbox_cursor (tenant_id, window_to, last_page_at)
      SELECT id, hwm, hwm FROM unnest($1::uuid[], $2::timestamptz[]) AS x(id, hwm)`,
      [schedule.map((s) => s.id), schedule.map((s) => s.hwm)]);
  }
  await db.query('ANALYZE public.ksef_inbox_schedule');
  console.log(`Zasiew: ${options.firms} firm w ${Math.round((Date.now() - started) / 1000)} s`);
}

function startProcess(command: string, args: string[], env: NodeJS.ProcessEnv, logFile: string): ChildProcess {
  const child = spawn(command, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: string[] = [];
  const flush = () => {
    if (chunks.length) writeFileSync(logFile, chunks.splice(0).join(''), { flag: 'a' });
  };
  const timer = setInterval(flush, 2000);
  timer.unref();
  const sink = (data: Buffer) => { chunks.push(data.toString()); };
  child.stdout?.on('data', sink);
  child.stderr?.on('data', sink);
  child.on('exit', () => { clearInterval(timer); flush(); });
  return child;
}

async function waitForPort(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Atrapa KSeF nie wstała')), 10_000);
    child.stdout?.once('data', (data: Buffer) => {
      clearTimeout(timer);
      resolve((JSON.parse(data.toString().split('\n')[0]!) as { port: number }).port);
    });
  });
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.at(-1) ?? null };
}

function readJsonLines(file: string): Array<Record<string, number>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, number>);
}

async function report(db: PgClient, ctx: {
  runId: string; options: Options; schema: string; workerLog: string; samplesFile: string; startedAt: number; endedAt: number; atrapaPort: number; slots: number;
}) {
  const { schema, options } = ctx;
  const minutes = (ctx.endedAt - ctx.startedAt) / 60_000;
  const atrapa = await (await fetch(`http://127.0.0.1:${ctx.atrapaPort}/__stats`)).json() as Record<string, unknown> & { gapsByTier: unknown; logins: number; refreshes: number; queries: number };

  const { rows: jobRows } = await db.query(`
    SELECT extract(epoch FROM started_on) * 1000 AS started,
           extract(epoch FROM completed_on) * 1000 AS completed,
           extract(epoch FROM created_on) * 1000 AS created,
           data->>'dueAt' AS due,
           state
      FROM ${schema}.job
     WHERE name = 'inbox.poll.tenant'`);
  const jobs = jobRows.map((row) => ({
    started: row.started === null ? null : Number(row.started),
    completed: row.completed === null ? null : Number(row.completed),
    created: Number(row.created),
    due: row.due ? Date.parse(row.due as string) : null,
    state: row.state as string,
  }));
  const startedJobs = jobs.filter((job) => job.started !== null);
  const done = jobs.filter((job) => job.completed !== null);
  const lagSeconds = (job: (typeof jobs)[number]) => Math.max(0, (job.started! - (job.due ?? job.created)) / 1000);
  const lagAll = summarize(startedJobs.map(lagSeconds));
  // Po rozruchu: bez pierwszego cyklu firm gorących, kiedy wszystkie logują się od zera.
  const warmupEnd = ctx.startedAt + 15 * 60_000;
  const lagAfterWarmup = summarize(startedJobs.filter((job) => job.started! >= warmupEnd).map(lagSeconds));
  const durationSeconds = summarize(done.filter((job) => job.started !== null).map((job) => (job.completed! - job.started!) / 1000));
  // Po rozruchu większość firm gorących odświeża sesję zamiast logować się od zera.
  const durationAfterWarmup = summarize(done.filter((job) => job.started !== null && job.started >= warmupEnd).map((job) => (job.completed! - job.started!) / 1000));

  const perMinute = new Map<number, number>();
  for (const job of done) {
    const minute = Math.floor(job.completed! / 60_000);
    perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
  }
  const waiting = jobs.filter((job) => job.started === null).length;

  const { rows: failedRows } = await db.query(
    `SELECT count(*) AS n FROM ${schema}.job WHERE name = 'inbox.poll.tenant' AND state = 'failed'`);

  // Takt: linia `ksef.inbox.dispatch` (nowy kod) albo czas zadania crona (stary kod).
  const log = existsSync(ctx.workerLog) ? readFileSync(ctx.workerLog, 'utf8') : '';
  const dispatchLines = log.split('\n').filter((line) => line.includes('"msg":"ksef.inbox.dispatch"')).map((line) => {
    try { return JSON.parse(line.slice(line.indexOf('{'))) as Record<string, number>; } catch { return null; }
  }).filter((line): line is Record<string, number> => line !== null);
  const { rows: tickRows } = await db.query(`
    SELECT extract(epoch FROM completed_on - started_on) * 1000 AS ms
      FROM ${schema}.job WHERE name = 'cron.inbox-polling' AND completed_on IS NOT NULL`);
  const tickMs = summarize(tickRows.map((row) => Number(row.ms)));

  const samples = readJsonLines(ctx.samplesFile);
  const first = samples[0];
  const last = samples.at(-1);
  // RSS na Macu skacze przez kompresję pamięci (test widział 80-420 MB przy stałej stercie),
  // więc obok niego sterta: ona pokazuje, ile pamięci naprawdę trzyma worker.
  const rss = samples.map((s) => s.rss!);
  const heap = samples.map((s) => s.heapUsed!);
  const queryCounters = first && last
    ? {
        postgrest: last.postgrest! - first.postgrest!,
        pg: last.pg! - first.pg!,
        spanMinutes: (last.at! - first.at!) / 60_000,
      }
    : null;
  const cpuPercent = first && last ? ((last.cpuMs! - first.cpuMs!) / (last.at! - first.at!)) * 100 : null;
  const loopP99 = summarize(samples.map((s) => s.loopP99Ms!));

  const { rows: lateRows } = await db.query(`
    SELECT count(*) FILTER (WHERE s.next_poll_at < now() - make_interval(secs => $2)) AS overdue_alarm,
           count(*) FILTER (WHERE s.next_poll_at < now() - interval '5 minutes') AS overdue_5m,
           count(*) FILTER (WHERE s.last_success_at IS NULL) AS never_success,
           count(*) AS firms
      FROM public.ksef_inbox_schedule s
      JOIN public.tenants t ON t.id = s.tenant_id
     WHERE t.name LIKE $1`, [`${NAME_PREFIX}${ctx.runId}-%`, INBOX_ALARM_OVERDUE_MS / 1000]);
  const { rows: tierRows } = await db.query(`
    SELECT s.activity_tier AS tier, count(*) AS n
      FROM public.ksef_inbox_schedule s
      JOIN public.tenants t ON t.id = s.tenant_id
     WHERE t.name LIKE $1 GROUP BY 1 ORDER BY 1`, [`${NAME_PREFIX}${ctx.runId}-%`]);

  const result = {
    runId: ctx.runId,
    label: options.label,
    firms: options.firms,
    minutes: Math.round(minutes * 10) / 10,
    slots: ctx.slots,
    mix: options.mix,
    allDue: options.allDue,
    tiersAtEnd: Object.fromEntries(tierRows.map((row) => [row.tier, Number(row.n)])),
    tick: {
      runs: tickMs.count,
      p50_ms: tickMs.p50 === null ? null : Math.round(tickMs.p50),
      max_ms: tickMs.max === null ? null : Math.round(tickMs.max),
      dispatchLines: dispatchLines.length,
      sentTotal: dispatchLines.reduce((sum, line) => sum + (line.sent ?? 0), 0),
      dueMax: Math.max(0, ...dispatchLines.map((line) => line.due ?? 0)),
      oldestLagMax_s: Math.max(0, ...dispatchLines.map((line) => line.oldestLagSeconds ?? 0)),
    },
    jobs: {
      total: jobs.length,
      started: startedJobs.length,
      completed: done.length,
      waitingAtEnd: waiting,
      failed: Number(failedRows[0]?.n ?? 0),
      perMinuteAvg: Math.round(done.length / minutes),
      perMinuteMax: Math.max(0, ...perMinute.values()),
      duration_s: durationSeconds,
      durationAfterWarmup_s: durationAfterWarmup,
    },
    lag_s: { all: lagAll, afterWarmup: lagAfterWarmup },
    ksef: {
      logins: atrapa.logins,
      refreshes: atrapa.refreshes,
      queries: atrapa.queries,
      limit429: atrapa.limitErrors429,
      random429: atrapa.randomErrors429,
      random5xx: atrapa.randomErrors5xx,
      inFlightMax: atrapa.inFlightMax,
      firmsQueried: atrapa.firmsQueried,
      invoicesServed: atrapa.invoicesServed,
      xmlDownloads: atrapa.xmlDownloads,
      authStatusBezBearer: atrapa.authStatusBezBearer,
      gapsByTier: atrapa.gapsByTier,
    },
    worker: {
      rssMaxMb: rss.length ? Math.round(Math.max(...rss) / 1048576) : null,
      rssLastMb: last ? Math.round(last.rss! / 1048576) : null,
      heapP95Mb: heap.length ? Math.round(percentile([...heap].sort((a, b) => a - b), 95)! / 1048576) : null,
      cpuPercent: cpuPercent === null ? null : Math.round(cpuPercent),
      loopP99Ms: loopP99,
      dbQueriesPerMinute: queryCounters
        ? {
            postgrest: Math.round(queryCounters.postgrest / queryCounters.spanMinutes),
            pg: Math.round(queryCounters.pg / queryCounters.spanMinutes),
          }
        : null,
    },
    notKeepingUp: {
      overdueAlarm: Number(lateRows[0]?.overdue_alarm ?? 0),
      overdue5m: Number(lateRows[0]?.overdue_5m ?? 0),
      neverSuccess: Number(lateRows[0]?.never_success ?? 0),
      firms: Number(lateRows[0]?.firms ?? 0),
    },
  };
  return result;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const envLocal = readEnvLocal();
  assertLocal(envLocal);
  const db = pgClient();
  await db.connect();

  // Klucz tylko na czas testu: szyfrogramy firm testowych znikają razem z nimi.
  const encryptionKey = randomBytes(32).toString('hex');
  process.env.KSEF_CREDENTIALS_ENCRYPTION_KEY = encryptionKey;

  if (options.cleanupOnly) {
    const removed = await cleanup(db);
    console.log(`Usunięto ${removed.firms} firm i ${removed.schemas} schematów kolejki.`);
    await db.end();
    return;
  }

  ensureMigration();
  const left = await cleanup(db);
  if (left.firms > 0) console.log(`Usunięto ${left.firms} firm po poprzednim teście.`);

  const runId = `${Date.now().toString(36)}`;
  const schema = `${SCHEMA_PREFIX}${runId}`;
  const outDir = path.join(HERE, 'wyniki');
  mkdirSync(outDir, { recursive: true });
  const workerLog = path.join(outDir, `${runId}-worker.log`);
  const samplesFile = path.join(outDir, `${runId}-probki.jsonl`);

  const children: ChildProcess[] = [];
  let cleaned = false;
  const finish = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const child of children) child.kill('SIGTERM');
    await sleep(3000);
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    const removed = await cleanup(db);
    console.log(`Sprzątanie: ${removed.firms} firm, ${removed.schemas} schematów.`);
    await db.end();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { void finish().finally(() => process.exit(130)); });
  }

  try {
    await seed(db, runId, options);

    const baseEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'development',
    };
    const atrapa = startProcess(process.execPath, [path.join(HERE, 'atrapa-ksef.mjs')], {
      ...baseEnv,
      ATRAPA_PORT: '0',
      ATRAPA_BLAD_429: String(options.error429),
      ATRAPA_BLAD_5XX: String(options.error5xx),
      ATRAPA_FAKTUR_NA_MIESIAC: String(options.invoicesPerMonth),
    }, path.join(outDir, `${runId}-atrapa.log`));
    children.push(atrapa);
    const atrapaPort = await waitForPort(atrapa);

    const workerEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      KSEF_ENV: 'test',
      KSEF_TEST_URL: `http://127.0.0.1:${atrapaPort}/v2`,
      DATABASE_URL: DB_URL,
      NEXT_PUBLIC_SUPABASE_URL: envLocal.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: envLocal.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: envLocal.SUPABASE_SERVICE_ROLE_KEY,
      KSEF_CREDENTIALS_ENCRYPTION_KEY: encryptionKey,
      JOBS_PGBOSS_SCHEMA: schema,
      WORKER_ONLY_CRONS: 'cron.inbox-polling',
      WORKER_HEALTH_PORT: String(18000 + Math.floor(Math.random() * 1000)),
      LICZNIK_PLIK: samplesFile,
      ...(options.slots ? { KSEF_INBOX_POLL_SLOTS: String(options.slots) } : {}),
    };
    const worker = startProcess(process.execPath, [
      '--conditions=react-server',
      '--import', 'tsx',
      '--import', path.join(HERE, 'licznik-procesu.mjs'),
      'lib/jobs/worker.ts',
    ], workerEnv, workerLog);
    children.push(worker);

    const startedAt = Date.now();
    const endAt = startedAt + options.minutes * 60_000;
    console.log(`Worker i atrapa działają. Koniec za ${options.minutes} min. Log: ${workerLog}`);
    while (Date.now() < endAt) {
      if (worker.exitCode !== null) throw new Error(`Worker padł (kod ${worker.exitCode}), log: ${workerLog}`);
      await sleep(30_000);
      const { rows } = await db.query(`
        SELECT count(*) FILTER (WHERE started_on IS NOT NULL) AS started, count(*) FILTER (WHERE started_on IS NULL) AS waiting
          FROM ${schema}.job WHERE name = 'inbox.poll.tenant'`).catch(() => ({ rows: [{ started: '?', waiting: '?' }] }));
      const minute = ((Date.now() - startedAt) / 60_000).toFixed(1);
      console.log(`[${minute} min] przebiegi: ${String(rows[0]?.started)} czeka: ${String(rows[0]?.waiting)}`);
    }
    const endedAt = Date.now();

    const result = await report(db, {
      runId, options, schema, workerLog, samplesFile, startedAt, endedAt, atrapaPort,
      slots: options.slots ?? INBOX_POLL_SLOTS_DEFAULT,
    });
    const resultFile = path.join(outDir, `${runId}-wynik.json`);
    writeFileSync(resultFile, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    console.log(`Wynik: ${resultFile}`);
  } finally {
    await finish();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
