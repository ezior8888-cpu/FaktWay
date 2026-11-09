import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedInvoice } from '@/lib/import/fa3-parser';

const mocks = vi.hoisted(() => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: mocks.createAdminClient }));

import { processImportedInvoices } from '@/lib/import/import-engine';

type StoredInvoice = {
  id: string;
  tenant_id: string;
  direction: string;
  internal_number: string;
  issue_date: string;
  seller_nip: string | null;
  ksef_number: string | null;
  ksef_status: string;
  ksef_environment: string | null;
};

const parsedInvoice: ParsedInvoice = {
  ksefNumber: 'KSEF-TEST-1',
  invoiceNumber: 'FV/1/2026',
  issueDate: '2026-09-25',
  invoiceType: 'regular',
  seller: { name: 'Testowa firma', nip: '1234567890' },
  buyer: { name: 'Nabywca' },
  lines: [{
    position: 1, name: 'Usługa', unit: 'szt.', quantity: 1,
    unitPriceNet: 100, vatRate: '23', netAmount: 100,
  }],
  totals: { netTotal: 100, vatTotal: 23, grossTotal: 123 },
  warnings: [],
};

function storedInvoice(ksefNumber: string): StoredInvoice {
  return {
    id: 'stored-1', tenant_id: 'tenant', direction: 'outgoing',
    internal_number: parsedInvoice.invoiceNumber, issue_date: parsedInvoice.issueDate,
    seller_nip: '1234567890', ksef_number: ksefNumber,
    ksef_status: 'accepted', ksef_environment: 'test',
  };
}

function database(initialInvoices: StoredInvoice[] = [], initialLineInvoiceIds: string[] = []) {
  const invoices = [...initialInvoices];
  const lineInvoiceIds = [...initialLineInvoiceIds];
  const flags = {
    failLineInsert: false, failDelete: false, silentDelete: false,
    failLineCount: false, hideLineRows: false,
  };
  let invoiceInsertCount = 0;

  const client = {
    from(table: string) {
      let operation: 'select' | 'insert' | 'delete' = 'select';
      let inserted: Record<string, unknown> | Record<string, unknown>[] | null = null;
      let countRequested = false;
      const equals = new Map<string, unknown>();
      const ins = new Map<string, unknown[]>();
      // Odczyty duplikatów idą stronami po `id` (sesja 32 planu skalowania): gt / order / limit jak w bazie.
      const greater = new Map<string, unknown>();
      let sortById = false;
      let limitN: number | null = null;

      const matches = (row: Record<string, unknown>) =>
        [...equals].every(([field, value]) => row[field] === value) &&
        [...ins].every(([field, values]) => values.includes(row[field])) &&
        [...greater].every(([field, value]) => String(row[field]) > String(value));

      const result = () => {
        if (table === 'invoices') {
          if (operation === 'select') {
            let rows = invoices.filter((row) => matches(row));
            if (sortById) rows = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
            if (limitN !== null) rows = rows.slice(0, limitN);
            return { data: rows, error: null, count: null };
          }
          if (operation === 'insert') {
            const row = inserted as Record<string, unknown>;
            invoiceInsertCount++;
            const saved = { ...row, id: `inserted-${invoiceInsertCount}` } as StoredInvoice;
            invoices.push(saved);
            return { data: { id: saved.id }, error: null, count: null };
          }
          if (flags.failDelete) {
            return { data: null, error: { message: 'delete blocked' }, count: null };
          }
          if (flags.silentDelete) return { data: [], error: null, count: null };
          const deleted = invoices.filter((row) => matches(row));
          for (const row of deleted) invoices.splice(invoices.indexOf(row), 1);
          return { data: deleted.map((row) => ({ id: row.id })), error: null, count: null };
        }

        if (table === 'invoice_line_items') {
          if (operation === 'select' && countRequested) {
            return flags.failLineCount
              ? { data: null, error: { message: 'line read denied' }, count: null }
              : {
                  data: null, error: null,
                  count: flags.hideLineRows ? 0
                    : lineInvoiceIds.filter((id) => id === equals.get('invoice_id')).length,
                };
          }
          if (operation === 'insert') {
            if (flags.failLineInsert) {
              return { data: null, error: { message: 'line insert rejected' }, count: null };
            }
            for (const row of inserted as Record<string, unknown>[]) {
              lineInvoiceIds.push(String(row.invoice_id));
            }
          }
          return { data: [], error: null, count: null };
        }

        return { data: [], error: null, count: null };
      };

      const query = {
        select: (_columns: string, options?: { count?: string; head?: boolean }) => {
          countRequested = options?.count === 'exact' && options.head === true;
          return query;
        },
        eq: (field: string, value: unknown) => { equals.set(field, value); return query; },
        in: (field: string, values: unknown[]) => { ins.set(field, values); return query; },
        gt: (field: string, value: unknown) => { greater.set(field, value); return query; },
        order: (field: string) => { sortById = field === 'id'; return query; },
        limit: (n: number) => { limitN = n; return query; },
        insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
          operation = 'insert'; inserted = rows; return query;
        },
        delete: () => { operation = 'delete'; return query; },
        single: async () => result(),
        then: <T>(resolve: (value: ReturnType<typeof result>) => T) =>
          Promise.resolve(result()).then(resolve),
      };
      return query;
    },
  };

  return { client, invoices, lineInvoiceIds, flags, get invoiceInsertCount() { return invoiceInsertCount; } };
}

function importHistory(invoices: ParsedInvoice[]) {
  return processImportedInvoices({
    tenantId: 'tenant', importJobId: 'job', source: 'ksef_history',
    invoiceDirection: 'outgoing', invoiceKsefStatus: 'accepted', ksefEnvironment: 'test',
    invoices,
  });
}

beforeEach(() => vi.clearAllMocks());

describe('magic KSeF import completeness', () => {
  it('counts a stored invoice number with a different KSeF number as a failure', async () => {
    const db = database([storedInvoice('KSEF-OTHER')], ['stored-1']);
    mocks.createAdminClient.mockReturnValue(db.client);

    const result = await importHistory([parsedInvoice]);

    expect(result).toMatchObject({ invoicesImported: 0, invoicesFailed: 1 });
    expect(result.warnings).toContainEqual(expect.stringContaining('konflikt numeru faktury'));
    expect(db.invoiceInsertCount).toBe(0);
  });

  it('counts two KSeF numbers with the same outgoing number in one batch as a failure', async () => {
    const db = database();
    mocks.createAdminClient.mockReturnValue(db.client);

    const result = await importHistory([
      parsedInvoice,
      { ...parsedInvoice, ksefNumber: 'KSEF-TEST-2' },
    ]);

    expect(result).toMatchObject({ invoicesImported: 1, invoicesFailed: 1 });
    expect(result.warnings).toContainEqual(expect.stringContaining('w imporcie'));
    expect(db.invoiceInsertCount).toBe(1);
  });

  it('does not treat one KSeF number with two invoice numbers in a batch as exact', async () => {
    const db = database();
    mocks.createAdminClient.mockReturnValue(db.client);

    const result = await importHistory([
      parsedInvoice,
      { ...parsedInvoice, invoiceNumber: 'FV/2/2026' },
    ]);

    expect(result).toMatchObject({ invoicesImported: 1, invoicesFailed: 1 });
    expect(result.warnings).toContainEqual(expect.stringContaining('ma inny numer faktury'));
  });

  it('keeps a complete, exact KSeF duplicate benign', async () => {
    const db = database([storedInvoice('KSEF-TEST-1')], ['stored-1']);
    mocks.createAdminClient.mockReturnValue(db.client);

    const result = await importHistory([parsedInvoice]);

    expect(result).toMatchObject({ invoicesImported: 0, invoicesFailed: 0 });
    expect(result.warnings).toContainEqual(expect.stringContaining('Pominięto duplikat (DB, KSeF)'));
    expect(db.invoiceInsertCount).toBe(0);
  });

  it('does not accept a matching KSeF number when the line read sees no rows', async () => {
    const db = database([storedInvoice('KSEF-TEST-1')], ['stored-1']);
    db.flags.hideLineRows = true;
    mocks.createAdminClient.mockReturnValue(db.client);

    const result = await importHistory([parsedInvoice]);

    expect(result).toMatchObject({ invoicesImported: 0, invoicesFailed: 1 });
    expect(result.warnings).toContainEqual(expect.stringContaining('nie można potwierdzić kompletności'));
  });

  it('keeps a failed line insert with failed cleanup visible on retry', async () => {
    const db = database();
    db.flags.failLineInsert = true;
    db.flags.failDelete = true;
    mocks.createAdminClient.mockReturnValue(db.client);

    const first = await importHistory([parsedInvoice]);
    expect(first).toMatchObject({ invoicesImported: 0, invoicesFailed: 1 });
    expect(first.warnings).toContainEqual(expect.stringContaining('nie potwierdzono usunięcia'));
    expect(db.invoices).toHaveLength(1);
    expect(db.lineInvoiceIds).toHaveLength(0);

    db.flags.failLineInsert = false;
    db.flags.failDelete = false;
    const retry = await importHistory([parsedInvoice]);
    expect(retry).toMatchObject({ invoicesImported: 0, invoicesFailed: 1 });
    expect(retry.warnings).toContainEqual(expect.stringContaining('nie można potwierdzić kompletności'));
    expect(db.invoiceInsertCount).toBe(1);
  });

  it('does not mistake silent cleanup or an unreadable line count for success', async () => {
    const db = database();
    db.flags.failLineInsert = true;
    db.flags.silentDelete = true;
    mocks.createAdminClient.mockReturnValue(db.client);

    const first = await importHistory([parsedInvoice]);
    expect(first.warnings).toContainEqual(expect.stringContaining('nie potwierdzono usunięcia'));
    db.flags.failLineInsert = false;
    db.flags.failLineCount = true;
    const retry = await importHistory([parsedInvoice]);
    expect(retry).toMatchObject({ invoicesImported: 0, invoicesFailed: 1 });
    expect(retry.warnings).toContainEqual(expect.stringContaining('line read denied'));
  });
});
