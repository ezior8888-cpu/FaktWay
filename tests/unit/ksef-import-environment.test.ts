import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedInvoice } from '@/lib/import/fa3-parser';

const mocks = vi.hoisted(() => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: mocks.createAdminClient }));

import { processImportedInvoices } from '@/lib/import/import-engine';

const invoice: ParsedInvoice = {
  ksefNumber: 'KSEF-TEST-1',
  invoiceNumber: 'TEST/1/2026',
  issueDate: '2026-09-25',
  invoiceType: 'regular',
  seller: { name: 'Test seller' },
  buyer: { name: 'Test buyer' },
  lines: [],
  totals: { netTotal: 100, vatTotal: 23, grossTotal: 123 },
  warnings: ['Brak pozycji'],
};

function database(rejectNegativeGross = false) {
  const invoiceInserts: Record<string, unknown>[] = [];
  const client = {
    from(table: string) {
      let operation: 'select' | 'insert' = 'select';
      let inserted: Record<string, unknown> | null = null;
      const result = () => rejectNegativeGross && operation === 'insert' &&
        table === 'invoices' && Number(inserted?.gross_total) < 0
        ? { data: null, error: { message: 'check_paid_amount_valid' } }
        : {
            data: operation === 'insert' && table === 'invoices' ? { id: 'stored-invoice' } : [],
            error: null,
          };
      const query = {
        select: () => query,
        eq: () => query,
        in: () => query,
        // Odczyty duplikatów stronami po `id` (sesja 32 planu skalowania); odczyty tu i tak zwracają [].
        gt: () => query,
        order: () => query,
        limit: () => query,
        insert: (row: Record<string, unknown>) => {
          operation = 'insert';
          inserted = row;
          if (table === 'invoices') invoiceInserts.push(row);
          return query;
        },
        single: async () => result().error
          ? result()
          : { ...result(), data: table === 'invoices' ? { id: 'stored-invoice' } : inserted },
        then: <T>(resolve: (value: ReturnType<typeof result>) => T) => Promise.resolve(result()).then(resolve),
      };
      return query;
    },
  };
  return { client, invoiceInserts };
}

beforeEach(() => vi.clearAllMocks());

describe('KSeF import environment provenance', () => {
  it('rejects accepted history without a known environment before any database effect', async () => {
    await expect(processImportedInvoices({
      tenantId: 'tenant', importJobId: 'job', invoices: [invoice],
      source: 'ksef_history', invoiceKsefStatus: 'accepted',
    })).rejects.toThrow('requires verified environment provenance');
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it('persists the environment on an accepted imported invoice', async () => {
    const { client, invoiceInserts } = database();
    mocks.createAdminClient.mockReturnValue(client);
    const result = await processImportedInvoices({
      tenantId: 'tenant', importJobId: 'job', invoices: [invoice],
      source: 'ksef_history', invoiceKsefStatus: 'accepted', ksefEnvironment: 'test',
    });
    expect(result.invoicesImported).toBe(1);
    expect(result.invoicesFailed).toBe(0);
    expect(invoiceInserts).toHaveLength(1);
    expect(invoiceInserts[0]).toMatchObject({
      tenant_id: 'tenant', origin: 'ksef_import', ksef_status: 'accepted', ksef_environment: 'test',
      ksef_number: 'KSEF-TEST-1',
    });
  });

  it('counts a negative KOR rejected by the paid-amount constraint as an import failure', async () => {
    const { client, invoiceInserts } = database(true);
    mocks.createAdminClient.mockReturnValue(client);
    const result = await processImportedInvoices({
      tenantId: 'tenant', importJobId: 'job', source: 'ksef_history',
      invoiceDirection: 'outgoing', invoiceKsefStatus: 'accepted', ksefEnvironment: 'test',
      invoices: [{
        ...invoice, invoiceType: 'correction', invoiceNumber: 'KOR/1/2026',
        totals: { netTotal: -10, vatTotal: -2.3, grossTotal: -12.3 },
      }],
    });
    expect(invoiceInserts).toHaveLength(1);
    expect(result).toMatchObject({ invoicesImported: 0, invoicesFailed: 1 });
    expect(result.warnings).toContainEqual(expect.stringContaining('check_paid_amount_valid'));
  });

  it('rejects an incoming KSeF number without environment before writing contractors', async () => {
    await expect(processImportedInvoices({
      tenantId: 'tenant', importJobId: 'job', invoices: [invoice],
      source: 'file_import', invoiceDirection: 'incoming', invoiceKsefStatus: 'draft',
    })).rejects.toThrow('Incoming KSeF number requires verified environment provenance');
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it('keeps incoming invoices from different sellers with the same issuer number', async () => {
    const { client, invoiceInserts } = database();
    mocks.createAdminClient.mockReturnValue(client);
    const result = await processImportedInvoices({
      tenantId: 'tenant', importJobId: 'job', source: 'ksef_inbox',
      invoiceDirection: 'incoming', invoiceKsefStatus: 'accepted', ksefEnvironment: 'test',
      invoices: [
        { ...invoice, seller: { name: 'Seller 1', nip: '1111111111' } },
        { ...invoice, ksefNumber: 'KSEF-TEST-2', seller: { name: 'Seller 2', nip: '2222222222' } },
      ],
    });

    expect(result.invoicesImported).toBe(2);
    expect(invoiceInserts).toHaveLength(2);
    expect(invoiceInserts.every((row) => row.origin === 'ksef_inbox')).toBe(true);
  });
});
