import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { getRlsTestDatabaseUrl, getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00186 (plan skalowania 3000, sesja 21) na prawdziwej bazie:
 *
 *  - wynik `ksef_lifecycle_violations()` ten sam co przed migracją: w jednej
 *    wycofywanej transakcji liczymy go po 00186, potem przywracamy
 *    `ksef_upo_expected` z 00155 i usuwamy nowe indeksy cronów (stan sprzed
 *    00186) i liczymy jeszcze raz;
 *  - `ksef_lifecycle_violations_without_i3()` = pełna funkcja bez wierszy I3;
 *  - planista wkleja `ksef_upo_expected` (w planie zostaje tylko funkcja
 *    pomocnicza) i używa nowych indeksów w zapytaniach cronów;
 *  - równoległe importy tej samej nowej pozycji tworzą jeden produkt;
 *  - kontrola dubli w migracji przerywa ją przy dublach katalogu.
 *
 * Czerwień przed naprawą: bez 00186 nie ma lekkiej funkcji (42883), indeksów
 * ani unikalności (cztery importy = cztery produkty); bez poprawki importu
 * przegrane importy zgłaszają „Produkty: insert — duplicate key”.
 * Silnik importu bierze klienta serwisowego tej bazy (atrapa modułów klienta).
 */

const supabaseMock = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => supabaseMock.client }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => supabaseMock.client }));

import type { ParsedInvoice } from '@/lib/import/fa3-parser';
import { processImportedInvoices } from '@/lib/import/import-engine';

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim() &&
    process.env.RLS_TEST_DATABASE_URL?.trim(),
);
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : (null as unknown as SupabaseClient);
supabaseMock.client = admin;

const ORG = '00186182-0000-4000-8000-000000000001';
const ORG_B = '00186182-0000-4000-8000-000000000002';
const ORG_P = '00186182-0000-4000-8000-000000000003';
const NIP = '9480000014';
const MIGRATIONS = join(process.cwd(), 'supabase/migrations');

/** Indeksy 00186 pod crony KSeF (invoices, ksef_submissions). */
const CRON_INDEXES = [
  'idx_invoices_ksef_status_in_flight',
  'idx_invoices_outgoing_number_not_accepted',
  'idx_invoices_last_error_code',
  'idx_invoices_inbox_pending_full_fetch',
  'idx_ksef_submissions_open_status',
] as const;

let counter = 0;
const ksefNumber = (n: number) => `${NIP}-20261001-000000186${String(n).padStart(3, '0')}-00`;

async function invoice(tenantId: string, patch: Record<string, unknown> = {}): Promise<string> {
  counter += 1;
  const id = `00186aaa-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  const number = `FV/00186/${counter}`;
  const { error } = await admin.from('invoices').insert({
    id, tenant_id: tenantId, direction: 'outgoing', internal_number: number, invoice_type: 'VAT',
    issue_date: '2026-10-01', seller_nip: NIP, buyer_nip: '1234567890',
    gross_total: 123, net_total: 100, vat_total: 23, ksef_status: 'draft',
    fa3_data: { internalNumber: number, type: 'VAT' }, seller_data: { nip: NIP }, buyer_data: { nip: '1234567890' },
    ...patch,
  });
  if (error) throw new Error(`faktura ${number}: ${error.message}`);
  return id;
}

async function submission(tenantId: string, invoiceId: string, patch: Record<string, unknown>) {
  counter += 1;
  const { error } = await admin.from('ksef_submissions').insert({
    tenant_id: tenantId, invoice_id: invoiceId, submission_type: 'online', status: 'sent',
    session_reference_number: `SES-00186-${counter}`, invoice_reference_number: `REF-00186-${counter}`,
    ...patch,
  });
  if (error) throw new Error(`ksef_submissions: ${error.message}`);
}

async function upo(tenantId: string, invoiceId: string, number: string) {
  // 00117: UPO przyjętej faktury niesie środowisko KSeF; data przyjęcia NOT NULL.
  const { error } = await admin.from('upo_receipts').insert({
    tenant_id: tenantId, invoice_id: invoiceId, ksef_number: number, ksef_environment: 'test',
    status: 'downloaded', ksef_acceptance_timestamp: '2026-10-01T10:00:00Z',
  });
  if (error) throw new Error(`upo_receipts: ${error.message}`);
}

/** Jak rls-cykl-faktury: wyzwalacze 00119 blokują DELETE poza szkicem — najpierw powrót do szkicu. */
async function cleanup(tenantId: string) {
  await admin.from('products').delete().eq('tenant_id', tenantId);
  await admin.from('upo_receipts').delete().eq('tenant_id', tenantId);
  await admin.from('ksef_submissions').delete().eq('tenant_id', tenantId);
  await admin.from('invoices').update({
    ksef_status: 'draft', ksef_send_owner: null, submitted_to_ksef_at: null, last_attempt_at: null,
    ksef_number: null, ksef_accepted_at: null, xml_storage_path: null,
  }).eq('tenant_id', tenantId).neq('ksef_status', 'accepted');
  await admin.from('invoices').delete().eq('tenant_id', tenantId);
  await admin.from('contractors').delete().eq('tenant_id', tenantId);
  await admin.from('audit_logs').delete().eq('tenant_id', tenantId);
}

// ─── połączenie Postgres (pula pg-boss, jak rls-xml-dowod-jeden-wiersz) ────

interface SqlRunner {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}
interface TransactionalDb extends SqlRunner {
  withTransaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

let boss: PgBoss;
const db = () => boss.getDb() as unknown as TransactionalDb;

const ROLLBACK = Symbol('rollback');

/** Transakcja cofnięta zawsze (także po sukcesie `fn`); błąd `fn` leci dalej. */
async function rolledBack<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
  let value: T | undefined;
  try {
    await db().withTransaction(async (tx) => {
      value = await fn(tx);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return value as T;
}

/** Treść 00186 bez własnej transakcji: uruchamiamy ją wewnątrz wycofywanej. */
const migrationBody = () => readFileSync(join(MIGRATIONS, '00186_cron_indexes_products_unique.sql'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/^BEGIN;$/m, '')
  .replace(/^COMMIT;$/m, '');

/** `ksef_upo_expected` z 00155 (SET search_path, EXISTS w ciele) — stan sprzed 00186. */
function upoExpectedFrom00155(): string {
  const sql = readFileSync(join(MIGRATIONS, '00155_ksef_history_sync.sql'), 'utf8').replace(/\r\n/g, '\n');
  const match = /CREATE OR REPLACE FUNCTION public\.ksef_upo_expected\(i public\.invoices\)[\s\S]*?\n\$\$;/.exec(sql);
  if (!match) throw new Error('00155: brak definicji ksef_upo_expected');
  return match[0];
}

type Violation = { invariant: string; invoice_id: string; tenant_id: string; detail: string };

async function violations(tx: SqlRunner, fn: 'ksef_lifecycle_violations' | 'ksef_lifecycle_violations_without_i3'): Promise<Violation[]> {
  const { rows } = await tx.executeSql(
    `SELECT invariant, invoice_id::text AS invoice_id, tenant_id::text AS tenant_id, detail::text AS detail
       FROM public.${fn}() ORDER BY 1, 2, 3, 4`,
  );
  return rows as Violation[];
}

async function upoExpected(tx: SqlRunner): Promise<Array<{ id: string; expected: boolean }>> {
  const { rows } = await tx.executeSql(
    'SELECT i.id::text AS id, public.ksef_upo_expected(i) AS expected FROM public.invoices i WHERE i.tenant_id = ANY($1::uuid[]) ORDER BY 1',
    [[ORG, ORG_B]],
  );
  return rows as Array<{ id: string; expected: boolean }>;
}

type PlanNode = { 'Index Name'?: string; Plans?: PlanNode[] };
const indexNames = (node: PlanNode): string[] => [
  ...(node['Index Name'] ? [node['Index Name']] : []),
  ...(node.Plans ?? []).flatMap(indexNames),
];

/** Zapytanie crona i indeks 00186, który ma je obsłużyć. */
type PlanCase = { index: string; sql: string; param?: unknown };

/** Indeksy w planie zapytania: plan na prawdziwej tabeli, po ANALYZE, bez skanu sekwencyjnego. */
async function planIndexes(tx: SqlRunner, { sql, param }: PlanCase): Promise<string[]> {
  await tx.executeSql('ANALYZE public.invoices, public.ksef_submissions, public.ksef_send_attempts, public.ocr_jobs, public.products');
  await tx.executeSql('SET LOCAL ROLE service_role');
  await tx.executeSql('SET LOCAL enable_seqscan = off');
  await tx.executeSql('SET LOCAL plan_cache_mode = force_custom_plan');
  let explained;
  if (param === undefined) {
    explained = await tx.executeSql(`EXPLAIN (FORMAT JSON) ${sql}`);
  } else {
    // PREPARE żyje w sesji puli, nie w transakcji: nazwa jednorazowa i DEALLOCATE.
    const name = `rls_00186_q_${Date.now()}`;
    await tx.executeSql(`PREPARE ${name}(text) AS ${sql}`);
    explained = await tx.executeSql(`EXPLAIN (FORMAT JSON) EXECUTE ${name}('${String(param)}')`);
    await tx.executeSql(`DEALLOCATE ${name}`);
  }
  const plan = explained.rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>;
  return indexNames(plan[0]!.Plan);
}

describe.skipIf(!hasDatabase)('00186: indeksy cronów, predykat UPO i katalog produktów', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    boss = new PgBoss({ connectionString: getRlsTestDatabaseUrl(), schema: 'pgboss', schedule: false, supervise: false });
    await boss.start();
    for (const org of [ORG, ORG_B, ORG_P]) await cleanup(org);
    await admin.from('tenants').delete().in('id', [ORG, ORG_B, ORG_P]);
    const { error } = await admin.from('tenants').insert([
      { id: ORG, nip: NIP, name: 'Firma 00186' },
      { id: ORG_B, nip: '9480000021', name: 'Firma B 00186' },
      { id: ORG_P, nip: NIP, name: 'Firma produkty 00186' },
    ]);
    if (error) throw error;
  }, 120_000);

  afterAll(async () => {
    if (!hasDatabase) return;
    for (const org of [ORG, ORG_B, ORG_P]) await cleanup(org);
    await admin.from('tenants').delete().in('id', [ORG, ORG_B, ORG_P]);
    await boss?.stop({ graceful: false, close: true });
  }, 60_000);

  describe('strażnik cyklu życia: wynik przed i po 00186', () => {
    const f: Record<string, string> = {};

    beforeAll(async () => {
      f.sending = await invoice(ORG, { ksef_status: 'sending' });
      f.queuedOld = await invoice(ORG, { ksef_status: 'queued', updated_at: '2026-09-01T10:00:00Z' });
      f.appNoUpo = await invoice(ORG, { ksef_status: 'accepted', ksef_number: ksefNumber(1), ksef_environment: 'test', xml_storage_path: 'a.xml' });
      f.appUpo = await invoice(ORG, { ksef_status: 'accepted', ksef_number: ksefNumber(2), ksef_environment: 'test', xml_storage_path: 'b.xml' });
      await upo(ORG, f.appUpo, ksefNumber(2));
      const history = (n: number, patch: Record<string, unknown> = {}) => invoice(ORG, {
        origin: 'ksef_import', ksef_status: 'accepted', ksef_number: ksefNumber(n), ksef_environment: 'test',
        xml_storage_path: `h${n}.xml`, ...patch,
      });
      f.historyAlone = await history(3);
      f.historyByOriginal = await history(4);
      f.historyByResponse = await history(5);
      f.historyByInvoice = await history(6);
      f.historyLinkedUpo = await history(7);
      f.historyNoXml = await history(8, { xml_storage_path: null });
      f.historyOtherTenant = await history(9);
      // Nasze wysyłki innych dokumentów wskazują numery historii (oryginał 440, numer odpowiedzi).
      const source = await invoice(ORG);
      await submission(ORG, source, { status: 'duplicate', original_ksef_number: ksefNumber(4) });
      await submission(ORG, source, { status: 'accepted', response_ksef_number: ksefNumber(5) });
      await submission(ORG, f.historyByInvoice, { status: 'accepted' });
      await submission(ORG, source, { status: 'duplicate', original_ksef_number: ksefNumber(7) });
      await upo(ORG, f.historyLinkedUpo, ksefNumber(7));
      // Ten sam numer w wysyłce INNEJ firmy nie czyni UPO oczekiwanym.
      const foreign = await invoice(ORG_B, { seller_nip: '9480000021', seller_data: { nip: '9480000021' } });
      await submission(ORG_B, foreign, { status: 'duplicate', original_ksef_number: ksefNumber(9) });

      f.failedOwner = await invoice(ORG, { ksef_status: 'failed', last_error_code: 'INFRA', ksef_send_owner: 'wisząca' });
      f.failedUnknown = await invoice(ORG, { ksef_status: 'failed', last_error_code: 'COS_DZIWNEGO' });
      f.failedOk = await invoice(ORG, { ksef_status: 'failed', last_error_code: 'KSEF_UNAVAILABLE' });
      f.staleSent = await invoice(ORG, { ksef_status: 'failed', last_error_code: 'RESULT_UNCERTAIN' });
      await submission(ORG, f.staleSent, { status: 'sent', attempted_at: '2026-09-01T10:00:00Z' });
      f.failedNumber = await invoice(ORG, { ksef_status: 'failed', last_error_code: 'INFRA', ksef_number: ksefNumber(10) });
      f.duplicate = await invoice(ORG, { ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE' });
      await submission(ORG, f.duplicate, { status: 'sent', original_ksef_number: ksefNumber(11) });
    });

    it('pełna funkcja identyczna przed i po (stary predykat, bez nowych indeksów); lekka = pełna bez I3; predykat bez zmian', async () => {
      const r = await rolledBack(async (tx) => {
        await tx.executeSql('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const after = await violations(tx, 'ksef_lifecycle_violations');
        const light = await violations(tx, 'ksef_lifecycle_violations_without_i3');
        const expectedAfter = await upoExpected(tx);
        for (const name of CRON_INDEXES) await tx.executeSql(`DROP INDEX public.${name}`);
        await tx.executeSql(upoExpectedFrom00155());
        const before = await violations(tx, 'ksef_lifecycle_violations');
        const expectedBefore = await upoExpected(tx);
        return { after, light, before, expectedAfter, expectedBefore };
      });

      expect(r.after).toEqual(r.before);
      expect(r.light).toEqual(r.after.filter((v) => v.invariant !== 'I3'));
      expect(r.expectedAfter).toEqual(r.expectedBefore);

      // Porównanie ma treść: nasze fikstury dają spodziewane naruszenia.
      const ours = new Map<string, string[]>();
      for (const v of r.after.filter((x) => x.tenant_id === ORG)) {
        ours.set(v.invoice_id, [...(ours.get(v.invoice_id) ?? []), v.invariant]);
      }
      expect(ours.get(f.sending)).toEqual(['I2']);
      expect(ours.get(f.appNoUpo)).toEqual(['I3']);
      expect(ours.get(f.appUpo)).toBeUndefined();
      expect(ours.get(f.historyAlone)).toBeUndefined();
      expect(ours.get(f.historyByOriginal)).toEqual(['I3']);
      expect(ours.get(f.historyByResponse)).toEqual(['I3']);
      expect(ours.get(f.historyByInvoice)).toEqual(['I3']);
      expect(ours.get(f.historyLinkedUpo)).toBeUndefined();
      expect(ours.get(f.historyNoXml)).toEqual(['I3']);
      expect(ours.get(f.historyOtherTenant)).toBeUndefined();
      expect(ours.get(f.failedOwner)).toEqual(['I4']);
      expect(ours.get(f.failedUnknown)).toEqual(['I4']);
      expect(ours.get(f.failedOk)).toBeUndefined();
      expect(ours.get(f.staleSent)).toEqual(['I5']);
      expect(ours.get(f.failedNumber)).toEqual(['I9']);

      const expected = new Map(r.expectedAfter.map((x) => [x.id, x.expected]));
      expect(expected.get(f.appNoUpo)).toBe(true);
      expect(expected.get(f.historyAlone)).toBe(false);
      expect(expected.get(f.historyByOriginal)).toBe(true);
      expect(expected.get(f.historyByResponse)).toBe(true);
      expect(expected.get(f.historyByInvoice)).toBe(true);
      expect(expected.get(f.historyOtherTenant)).toBe(false);
    });

    it('planista wkleja ksef_upo_expected (service_role): w planie zostaje tylko funkcja pomocnicza', async () => {
      const plan = await rolledBack(async (tx) => {
        await tx.executeSql('SET LOCAL ROLE service_role');
        const { rows } = await tx.executeSql(
          'EXPLAIN (VERBOSE, COSTS OFF) SELECT i.id FROM public.invoices i WHERE public.ksef_upo_expected(i)',
        );
        return rows.map((row) => String(row['QUERY PLAN'])).join('\n');
      });

      expect(plan).toContain('ksef_upo_expected_submission');
      expect(plan).not.toMatch(/ksef_upo_expected\(/);
    });

    it('lekka funkcja i predykat tylko dla service_role', async () => {
      const { rows } = await db().executeSql(
        `SELECT f AS fn, r AS role, has_function_privilege(r, f, 'EXECUTE') AS ok
           FROM unnest(ARRAY['public.ksef_lifecycle_violations_without_i3()',
                             'public.ksef_upo_expected(public.invoices)',
                             'public.ksef_upo_expected_submission(uuid, uuid, text)']) AS f,
                unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r
          ORDER BY 1, 2`,
      );
      expect(rows.filter((row) => row.ok !== (row.role === 'service_role'))).toEqual([]);
    });
  });

  describe('indeksy 00186 w zapytaniach cronów', () => {
    it('definicje: kolumny i warunki jak w migracji (nazwa nie jest zajęta przez inny indeks)', async () => {
      const { rows } = await db().executeSql(
        `SELECT c.relname AS name, i.indisunique AS "unique", i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
        [[...CRON_INDEXES, 'idx_ksef_send_attempts_invoice_id', 'idx_ocr_jobs_expense', 'idx_products_tenant_id', 'uq_products_tenant_catalog_key']],
      );
      const byName = new Map(rows.map((row) => [String(row.name), row]));
      const def = (name: string) => String(byName.get(name)?.def ?? '');

      expect(rows).toHaveLength(9);
      expect(rows.filter((row) => row.valid !== true)).toEqual([]);
      expect(def('idx_invoices_ksef_status_in_flight')).toMatch(/invoices USING btree \(ksef_status\) WHERE/);
      expect(def('idx_invoices_outgoing_number_not_accepted')).toMatch(/invoices USING btree \(tenant_id\) WHERE/);
      expect(def('idx_invoices_last_error_code')).toMatch(/invoices USING btree \(last_error_code\) WHERE \(last_error_code IS NOT NULL\)$/);
      expect(def('idx_invoices_inbox_pending_full_fetch')).toMatch(/invoices USING btree \(created_at\) WHERE .*_pendingFullFetch/);
      expect(def('idx_ksef_submissions_open_status')).toMatch(/ksef_submissions USING btree \(status, attempted_at\) WHERE/);
      expect(def('idx_ksef_send_attempts_invoice_id')).toMatch(/ksef_send_attempts USING btree \(invoice_id\)$/);
      expect(def('idx_ocr_jobs_expense')).toMatch(/ocr_jobs USING btree \(expense_id\) WHERE \(expense_id IS NOT NULL\)$/);
      expect(def('idx_products_tenant_id')).toMatch(/products USING btree \(tenant_id, id\)$/);
      expect(byName.get('uq_products_tenant_catalog_key')?.unique).toBe(true);
      expect(def('uq_products_tenant_catalog_key')).toMatch(/products USING btree \(tenant_id, md5\(/);
    });

    const ID = '00186aaa-0000-4000-8000-ffffffffffff';
    const CASES: ReadonlyArray<PlanCase> = [
      // ksef_lifecycle_violations I4 / I9
      { index: 'idx_invoices_ksef_status_in_flight', sql: "SELECT id FROM public.invoices WHERE direction = 'outgoing' AND ksef_status IN ('failed', 'rejected')" },
      // critical-alerts-monitor: sending bez znacznika przejęcia
      { index: 'idx_invoices_ksef_status_in_flight', sql: "SELECT count(*) FROM public.invoices WHERE ksef_status = 'sending' AND submitted_to_ksef_at IS NULL" },
      // ksef-lifecycle-reconcile: kandydaci ponowień, z parametrem jak PostgREST (plan dla wartości)
      { index: 'idx_invoices_ksef_status_in_flight', sql: "SELECT id FROM public.invoices WHERE direction = 'outgoing' AND ksef_status = $1", param: 'failed' },
      // critical-alerts-monitor: numer KSeF bez accepted
      { index: 'idx_invoices_outgoing_number_not_accepted', sql: "SELECT count(*) FROM public.invoices WHERE direction = 'outgoing' AND ksef_number IS NOT NULL AND (ksef_status IS NULL OR ksef_status <> 'accepted')" },
      // critical-alerts-monitor: ROZ_HOLD_RECONCILE
      { index: 'idx_invoices_last_error_code', sql: "SELECT count(*) FROM public.invoices WHERE direction = 'outgoing' AND last_error_code = 'ROZ_HOLD_RECONCILE' AND (ksef_status IS NULL OR ksef_status <> 'accepted')" },
      // inbox-backfill
      { index: 'idx_invoices_inbox_pending_full_fetch', sql: "SELECT id FROM public.invoices WHERE direction = 'incoming' AND origin = 'ksef_inbox' AND ksef_status = 'accepted' AND ksef_environment = 'test' AND (fa3_data ->> '_pendingFullFetch') = 'true' AND created_at < now() ORDER BY created_at LIMIT 50" },
      // ksef_lifecycle_violations I5
      { index: 'idx_ksef_submissions_open_status', sql: "SELECT invoice_id FROM public.ksef_submissions WHERE status IN ('sent', 'intent') AND attempted_at < now() - interval '48 hours'" },
      // klucze obce (DB-08): zapytania kaskady i SET NULL
      { index: 'idx_ksef_send_attempts_invoice_id', sql: `SELECT id FROM public.ksef_send_attempts WHERE invoice_id = '${ID}'` },
      { index: 'idx_ocr_jobs_expense', sql: `SELECT id FROM public.ocr_jobs WHERE expense_id = '${ID}'` },
      // import: katalog stronami po kluczu (readAllById)
      { index: 'idx_products_tenant_id', sql: `SELECT id, name, unit, use_count FROM public.products WHERE tenant_id = '${ORG_P}' AND id > '${ID}' ORDER BY id LIMIT 1000` },
    ];

    it.each(CASES)('$index: $sql', async (c) => {
      const used = await rolledBack((tx) => planIndexes(tx, c));

      expect(used).toContain(c.index);
    });

    // 12.11.2026 (#655): na wspólnej bazie testowej planista wybrał dla tych zapytań stary
    // `idx_invoices_tenant_payment_due` (00044, `WHERE direction = 'outgoing'`), choć indeks
    // 00186 pasował; w #652 i #654 tego samego dnia wybrał 00186. Wybór zależy od statystyk
    // tabeli, a te od danych innych plików testów. Rywal niżej robi to samo na pewno: pasuje
    // do zapytania dokładniej, więc planista na prawdziwej tabeli zawsze woli jego.
    it.each(CASES.filter((c) => c.index === 'idx_invoices_ksef_status_in_flight' && c.sql.includes("direction = 'outgoing'")))(
      'inny pasujący indeks na tabeli nie zmienia werdyktu: $sql',
      async (c) => {
        const used = await rolledBack(async (tx) => {
          await tx.executeSql(
            `CREATE INDEX rls_00186_rywal ON public.invoices (ksef_status) INCLUDE (id)
              WHERE direction = 'outgoing' AND ksef_status IN ('failed', 'rejected')`,
          );
          return planIndexes(tx, c);
        });

        expect(used).toContain(c.index);
      },
    );
  });

  describe('katalog produktów: UNIQUE na kluczu katalogu', () => {
    const products = async () => {
      const { data, error } = await admin.from('products').select('id, name, unit, use_count').eq('tenant_id', ORG_P);
      if (error) throw error;
      return data ?? [];
    };

    it('ten sam klucz (wielkość liter, odstępy) odpada 23505; inna jednostka to osobny produkt', async () => {
      await cleanup(ORG_P);
      expect((await admin.from('products').insert({ tenant_id: ORG_P, name: 'Szkolenie zespolu 00186', unit: 'usł.' })).error).toBeNull();

      const same = await admin.from('products').insert({ tenant_id: ORG_P, name: '  SZKOLENIE   zespolu 00186 ', unit: ' usł. ' });
      const otherUnit = await admin.from('products').insert({ tenant_id: ORG_P, name: 'Szkolenie zespolu 00186', unit: 'h' });

      expect(same.error?.code).toBe('23505');
      expect(otherUnit.error).toBeNull();
      expect(await products()).toHaveLength(2);
    });

    const parsed = (n: number, name: string): ParsedInvoice => ({
      invoiceNumber: `FV/00186/IMP/${n}`,
      issueDate: '2026-10-01',
      invoiceType: 'regular',
      seller: { nip: NIP, name: 'Firma produkty 00186' },
      buyer: { nip: '1234567890', name: 'Nabywca testowy' },
      lines: [{ position: 1, name, unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23', netAmount: 100 }],
      totals: { netTotal: 100, vatTotal: 23, grossTotal: 123 },
      warnings: [],
    });

    it('cztery równoległe importy tej samej nowej pozycji: jeden produkt, bez ostrzeżeń zapisu katalogu', async () => {
      await cleanup(ORG_P);
      const names = ['Wdrozenie systemu 00186', 'wdrozenie  systemu 00186', ' WDROZENIE systemu 00186', 'Wdrozenie systemu 00186 '];

      const runs = await Promise.all(names.map((name, i) => processImportedInvoices({
        tenantId: ORG_P,
        importJobId: `rls-00186-${i}`,
        invoices: [parsed(i, name)],
        source: 'csv',
        invoiceDirection: 'outgoing',
        invoiceKsefStatus: 'draft',
        catalogPolicy: { contractors: 'skip', products: 'upsert' },
      })));

      expect(await products()).toHaveLength(1);
      expect(runs.reduce((sum, run) => sum + run.productsCreated, 0)).toBe(1);
      expect(runs.flatMap((run) => run.warnings).filter((w) => w.startsWith('Produkt'))).toEqual([]);
    });
  });

  describe('kontrola dubli w samej migracji', () => {
    const indexState = async () => (await db().executeSql(
      "SELECT indisunique, indisvalid FROM pg_index WHERE indexrelid = to_regclass('public.uq_products_tenant_catalog_key')",
    )).rows;

    it('duble katalogu: migracja pada czytelnym błędem i niczego nie zmienia', async () => {
      await cleanup(ORG_P);

      await expect(db().withTransaction(async (tx) => {
        await tx.executeSql('DROP INDEX public.uq_products_tenant_catalog_key');
        await tx.executeSql(
          `INSERT INTO public.products (tenant_id, name, unit)
           VALUES ($1, 'Usluga  Wdrozeniowa 00186', 'szt.'), ($1, ' usluga wdrozeniowa 00186 ', ' SZT. ')`,
          [ORG_P],
        );
        await tx.executeSql(migrationBody());
      })).rejects.toThrow('products ma duble');

      expect(await indexState()).toEqual([{ indisunique: true, indisvalid: true }]);
      const { data } = await admin.from('products').select('id').eq('tenant_id', ORG_P);
      expect(data).toEqual([]);
    });

    it('bez dubli: ponowne wgranie przechodzi (IF NOT EXISTS, CREATE OR REPLACE), a po usunięciu indeksów tworzy je od nowa', async () => {
      const state = await rolledBack(async (tx) => {
        await tx.executeSql(migrationBody());
        for (const name of [...CRON_INDEXES, 'idx_ksef_send_attempts_invoice_id', 'idx_ocr_jobs_expense', 'idx_products_tenant_id', 'uq_products_tenant_catalog_key']) {
          await tx.executeSql(`DROP INDEX public.${name}`);
        }
        await tx.executeSql(migrationBody());
        const { rows } = await tx.executeSql(
          `SELECT count(*)::int AS n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
            WHERE c.relname = ANY($1::text[]) AND i.indisvalid`,
          [[...CRON_INDEXES, 'idx_ksef_send_attempts_invoice_id', 'idx_ocr_jobs_expense', 'idx_products_tenant_id', 'uq_products_tenant_catalog_key']],
        );
        return rows[0]!.n;
      });

      expect(state).toBe(9);
    });
  });
});
