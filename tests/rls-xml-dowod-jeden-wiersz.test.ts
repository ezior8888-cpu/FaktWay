import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getRlsTestDatabaseUrl, getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * C-12 (00164) na prawdziwej bazie: jeden wiersz `xml_documents` na fakturę.
 * Test jednostkowy z atrapą bazy nie dowodzi unikalności — to indeks rozstrzyga
 * dwa równoległe joby, które nie widzą jeszcze wiersza.
 *
 * Czerwień przed naprawą: bez 00164 drugi wiersz przechodzi (brak 23505),
 * a `recordXmlDocument` nadpisuje istniejący dowód. Przez PostgREST kluczem
 * serwisowym, jak w runnerze; atrapa tylko dla magazynu.
 */

const supabaseMock = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => supabaseMock.client }));
vi.mock('@/lib/storage/r2', () => ({ downloadFromR2: vi.fn(), downloadInvoiceXmlUnchecked: vi.fn() }));

import { recordXmlDocument } from '@/lib/storage/xml-documents';

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

const ORG = '00164164-0000-4000-8000-000000000001';
const NIP = '9480000014';
let counter = 0;

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');
const pathOf = (invoiceId: string, name = 'proba') => `${ORG}/2026/10/${invoiceId}/${name}.xml`;

async function newInvoice(): Promise<string> {
  counter += 1;
  const id = `00164aaa-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  const number = `FV/C12/${counter}`;
  const { error } = await admin.from('invoices').insert({
    id,
    tenant_id: ORG,
    direction: 'outgoing',
    internal_number: number,
    invoice_type: 'VAT',
    invoice_kind: 'regular',
    issue_date: '2026-10-01',
    seller_nip: NIP,
    buyer_nip: '1234567890',
    gross_total: 123,
    net_total: 100,
    vat_total: 23,
    ksef_status: 'draft',
    fa3_data: { internalNumber: number, type: 'VAT' },
    seller_data: { nip: NIP },
    buyer_data: { nip: '1234567890' },
  });
  if (error) throw new Error(`faktura ${number}: ${error.message}`);
  return id;
}

async function rowsOf(invoiceId: string) {
  const { data, error } = await admin.from('xml_documents')
    .select('id, storage_path, sha256_hash, file_size_bytes, created_at')
    .eq('invoice_id', invoiceId);
  if (error) throw error;
  return data ?? [];
}

async function cleanup() {
  await admin.from('invoices').delete().eq('tenant_id', ORG);
}

describe.skipIf(!hasDatabase)('00164: jeden dowód XML na fakturę na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    await cleanup();
    await admin.from('tenants').delete().eq('id', ORG);
    const { error } = await admin.from('tenants').insert({ id: ORG, nip: NIP, name: 'Firma C-12' });
    if (error) throw error;
  });

  beforeEach(cleanup);

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await admin.from('tenants').delete().eq('id', ORG);
  });

  const row = (invoiceId: string, hash: string) => ({
    invoice_id: invoiceId,
    tenant_id: ORG,
    storage_provider: 'r2',
    storage_path: pathOf(invoiceId),
    sha256_hash: hash,
    file_size_bytes: 10,
  });

  it('drugi wiersz tej samej faktury odpada kodem 23505; pierwszy zostaje bez zmian', async () => {
    const invoiceId = await newInvoice();
    const first = await admin.from('xml_documents').insert(row(invoiceId, hashOf('a')));
    expect(first.error).toBeNull();

    const second = await admin.from('xml_documents').insert(row(invoiceId, hashOf('b')));

    expect(second.error?.code).toBe('23505');
    expect((await rowsOf(invoiceId)).map((r) => r.sha256_hash)).toEqual([hashOf('a')]);
  });

  it('indeks jest na fakturę, nie na firmę: druga faktura dostaje własny wiersz', async () => {
    const [one, two] = [await newInvoice(), await newInvoice()];
    expect((await admin.from('xml_documents').insert(row(one, hashOf('a')))).error).toBeNull();
    expect((await admin.from('xml_documents').insert(row(two, hashOf('a')))).error).toBeNull();
  });

  const record = (invoiceId: string, content: string, sizeBytes?: number) => recordXmlDocument({
    tenantId: ORG,
    invoiceId,
    storagePath: pathOf(invoiceId),
    sha256Hash: hashOf(content),
    sizeBytes,
  });

  it('pięć równoległych zapisów tego samego pliku: jeden wiersz, żaden nie pada', async () => {
    const invoiceId = await newInvoice();

    await expect(Promise.all(Array.from({ length: 5 }, () => record(invoiceId, 'plik', 4)))).resolves.toHaveLength(5);

    expect(await rowsOf(invoiceId)).toHaveLength(1);
  });

  it('równoległe zapisy RÓŻNYCH plików: wygrywa jeden, reszta dostaje konflikt, wiersz nie jest przepisywany', async () => {
    const invoiceId = await newInvoice();

    const results = await Promise.allSettled(['a', 'b', 'c'].map((content) => record(invoiceId, content, 1)));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await rowsOf(invoiceId);
    expect(rows).toHaveLength(1);
    const winner = results.findIndex((r) => r.status === 'fulfilled');
    expect(rows[0]!.sha256_hash).toBe(hashOf(['a', 'b', 'c'][winner]!));
  });

  it('ponowienie tego samego pliku nie rusza wiersza', async () => {
    const invoiceId = await newInvoice();
    await record(invoiceId, 'plik', 4);
    const before = await rowsOf(invoiceId);

    await record(invoiceId, 'plik', 4);

    expect(await rowsOf(invoiceId)).toEqual(before);
  });

  it('inny plik przy istniejącym wierszu: błąd i dowód bez zmian', async () => {
    const invoiceId = await newInvoice();
    await record(invoiceId, 'plik', 4);
    const before = await rowsOf(invoiceId);

    await expect(record(invoiceId, 'inny', 4)).rejects.toThrow('napisz do pomocy FaktWay');

    expect(await rowsOf(invoiceId)).toEqual(before);
  });

  it('wiersz bez rozmiaru: nie konflikt i rozmiar nie jest dopisywany', async () => {
    const invoiceId = await newInvoice();
    await record(invoiceId, 'plik');
    const before = await rowsOf(invoiceId);
    expect(before[0]!.file_size_bytes).toBeNull();

    await record(invoiceId, 'plik', 4);

    expect(await rowsOf(invoiceId)).toEqual(before);
  });

  describe('kontrola dubli w samej migracji', () => {
    interface SqlRunner {
      executeSql(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
    }
    interface TransactionalDb extends SqlRunner {
      withTransaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>;
    }

    let boss: PgBoss;
    const db = () => boss.getDb() as unknown as TransactionalDb;

    beforeAll(async () => {
      boss = new PgBoss({ connectionString: getRlsTestDatabaseUrl(), schema: 'pgboss', schedule: false, supervise: false });
      await boss.start();
    }, 60_000);

    afterAll(async () => {
      await boss?.stop({ graceful: false, close: true });
    });

    /** Treść pliku bez własnej transakcji: uruchamiamy ją wewnątrz wycofywanej. */
    const migrationBody = () => readFileSync(join(process.cwd(), 'supabase/migrations/00164_xml_documents_one_per_invoice.sql'), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/^BEGIN;$/m, '')
      .replace(/^COMMIT;$/m, '');

    const indexState = async () => (await db().executeSql(`
      SELECT indisunique, indisvalid, pg_get_indexdef(indexrelid) AS definition
        FROM pg_index
       WHERE indexrelid = to_regclass('public.uq_xml_documents_tenant_invoice')`)).rows;

    it('indeks jest unikalny, ważny i obejmuje (tenant_id, invoice_id)', async () => {
      const [state] = await indexState();
      expect(state).toMatchObject({ indisunique: true, indisvalid: true });
      expect(String(state!.definition)).toContain('(tenant_id, invoice_id)');
    });

    it('duble w tabeli: migracja pada czytelnym błędem i niczego nie usuwa', async () => {
      const invoiceId = await newInvoice();
      const insert = `
        INSERT INTO public.xml_documents (invoice_id, tenant_id, storage_path, sha256_hash)
        VALUES ('${invoiceId}', '${ORG}', '${pathOf(invoiceId)}', '${hashOf('a')}')`;

      await expect(db().withTransaction(async (tx) => {
        await tx.executeSql('DROP INDEX public.uq_xml_documents_tenant_invoice');
        await tx.executeSql(insert);
        await tx.executeSql(insert);
        await tx.executeSql(migrationBody());
      })).rejects.toThrow('xml_documents ma wiele wierszy');

      expect(await indexState()).toHaveLength(1);
      expect(await rowsOf(invoiceId)).toEqual([]);
    });
  });
});
