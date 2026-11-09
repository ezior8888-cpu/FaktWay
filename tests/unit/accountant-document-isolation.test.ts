import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  admin: vi.fn(), download: vi.fn(), audit: vi.fn(),
  xmlFilters: [] as Array<[string, string]>,
  invoicePath: 'tenant-a/2026/09/invoice.xml',
}));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: mocks.admin }));
vi.mock('@/lib/storage/r2', () => ({ downloadInvoiceXml: mocks.download }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: mocks.audit }));
// Limit prób portalu (krok 6.2): tu zawsze przepuszcza.
vi.mock('@/lib/auth/get-client-ip', () => ({ getClientIp: async () => '203.0.113.5' }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: async () => ({ allowed: true, remaining: 10, retryAfter: 0 }) }));

import { GET as downloadXml } from '@/app/accountant/[token]/download/[invoiceId]/route';

const context = { params: Promise.resolve({ token: 'fake-test-token', invoiceId: 'invoice-a' }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.xmlFilters = [];
  mocks.invoicePath = 'tenant-a/2026/09/invoice.xml';
  mocks.download.mockResolvedValue('<Invoice>own-tenant-fixture</Invoice>');
  mocks.admin.mockReturnValue({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: (key: string, value: string) => {
          if (table === 'xml_documents') mocks.xmlFilters.push([key, value]);
          return chain;
        },
        maybeSingle: async () => {
          if (table === 'accountant_access') {
            return { data: { id: 'access-a', tenant_id: 'tenant-a', access_level: 'download', revoked_at: null, expires_at: '2099-01-01' } };
          }
          if (table === 'invoices') {
            return { data: { id: 'invoice-a', internal_number: 'FV/1', xml_storage_path: mocks.invoicePath } };
          }
          return { data: { sha256_hash: 'fake-test-hash' } };
        },
      };
      return chain;
    },
  });
});

describe('accountant XML download', () => {
  it('rejects a foreign object key in an otherwise authorized invoice row', async () => {
    mocks.invoicePath = 'tenant-b/2026/09/victim.xml';
    const response = await downloadXml(new Request('https://app.example.test/'), context);
    expect(response.status).toBe(404);
    expect(mocks.xmlFilters).toEqual([]);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('binds XML metadata to the authorized invoice and tenant, and forbids caching', async () => {
    const response = await downloadXml(new Request('https://app.example.test/'), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.xmlFilters).toEqual([
      ['storage_path', mocks.invoicePath], ['tenant_id', 'tenant-a'], ['invoice_id', 'invoice-a'],
    ]);
    expect(mocks.download).toHaveBeenCalledWith(mocks.invoicePath, 'fake-test-hash', 'tenant-a');
    expect(await response.text()).toContain('own-tenant-fixture');
  });
});
