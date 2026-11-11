import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 6.2, PR 1: zdjęcie albo XML dokumentu kosztu w portalu księgowej.
 * Podgląd przy każdym poziomie dostępu, pobranie tylko przy „download”, plik
 * przez krótki podpisany adres magazynu (303). Te same zabezpieczenia co
 * XML faktury: token, wygasanie, cofnięcie, poziom, firma z tokenu, wpis
 * w audycie bez treści dokumentu, limit prób.
 */

type Call = { table: string; method: string; args: unknown[] };

const st = vi.hoisted(() => ({
  calls: [] as Call[],
  access: null as Record<string, unknown> | null,
  expense: null as Record<string, unknown> | null,
  invoice: null as Record<string, unknown> | null,
  xmlDoc: null as Record<string, unknown> | null,
  sign: vi.fn(),
  audit: vi.fn(),
  limit: vi.fn(),
}));

vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: st.audit }));
vi.mock('@/lib/auth/get-client-ip', () => ({ getClientIp: async () => '203.0.113.5' }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: st.limit }));
vi.mock('@/lib/storage/signed-file-url', () => ({ getSignedFileUrl: st.sign }));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'order', 'limit', 'update', 'is']) {
        chain[method] = (...args: unknown[]) => {
          st.calls.push({ table, method, args });
          return chain;
        };
      }
      const result = () => {
        if (table === 'accountant_access') return { data: st.access, error: null };
        if (table === 'expenses') return { data: st.expense, error: null };
        if (table === 'invoices') return { data: st.invoice, error: null };
        if (table === 'xml_documents') return { data: st.xmlDoc, error: null };
        return { data: null, error: null };
      };
      chain.maybeSingle = async () => result();
      chain.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, fail);
      return chain;
    },
  }),
}));

import { GET as downloadFile } from '@/app/accountant/[token]/expenses/[expenseId]/download/route';
import { GET as viewFile } from '@/app/accountant/[token]/expenses/[expenseId]/view/route';

const EXPENSE_ID = '6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';
const ACCESS = { id: 'acc-1', tenant_id: 'ten-1', access_level: 'read_only', expires_at: '2099-01-01T00:00:00Z', revoked_at: null };
const PHOTO = {
  id: EXPENSE_ID, tenant_id: 'ten-1', source: 'ocr_photo', document_number: 'PAR 7/2026',
  source_file_path: 'tenants/ten-1/expenses/2026/10/job-1.jpg', source_file_mime: 'image/jpeg', ksef_invoice_id: null,
};
const KSEF = {
  ...PHOTO, source: 'ksef_inbox', document_number: 'FV/10/2026', source_file_path: null, source_file_mime: null,
  ksef_invoice_id: 'inv-1',
};
const INVOICE = { id: 'inv-1', tenant_id: 'ten-1', xml_storage_path: 'ten-1/2026/10/inv-1.xml' };
const SIGNED = 'https://storage.example.test/bucket/key?X-Amz-Signature=abc';

const ctx = (expenseId = EXPENSE_ID, token = 'fake-test-token') => ({ params: Promise.resolve({ token, expenseId }) });
const req = () => new Request('https://app.example.test/');
const tables = () => new Set(st.calls.map((c) => c.table));

beforeEach(() => {
  st.calls = [];
  st.access = { ...ACCESS };
  st.expense = { ...PHOTO };
  st.invoice = { ...INVOICE };
  st.xmlDoc = { sha256_hash: 'fake-test-hash' };
  st.sign.mockReset();
  st.sign.mockResolvedValue(SIGNED);
  st.audit.mockReset();
  st.limit.mockReset();
  st.limit.mockResolvedValue({ allowed: true, remaining: 10, retryAfter: 0 });
});

describe('plik kosztu w portalu: poziomy dostępu', () => {
  it('podgląd zdjęcia przy „tylko podgląd”: 303 na krótki podpisany adres, w przeglądarce, bez cache i Referer', async () => {
    const res = await viewFile(req(), ctx());
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(SIGNED);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(st.sign).toHaveBeenCalledTimes(1);
    const [key, tenantId, options] = st.sign.mock.calls[0]!;
    expect(key).toBe(PHOTO.source_file_path);
    expect(tenantId).toBe('ten-1');
    expect(options).toMatchObject({ contentType: 'image/jpeg', contentDisposition: 'inline' });
    expect(options.expiresInSeconds).toBeGreaterThan(0);
    expect(options.expiresInSeconds).toBeLessThanOrEqual(120);
  });

  it('pobranie przy „tylko podgląd”: 403 z komunikatem, bez podpisu i bez audytu', async () => {
    const res = await downloadFile(req(), ctx());
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/tylko na podgląd/);
    expect(st.sign).not.toHaveBeenCalled();
    expect(st.audit).not.toHaveBeenCalled();
  });

  it('pobranie przy „download”: plik jako załącznik z nazwą z numeru dokumentu', async () => {
    st.access = { ...ACCESS, access_level: 'download' };
    const res = await downloadFile(req(), ctx());
    expect(res.status).toBe(303);
    const [, , options] = st.sign.mock.calls[0]!;
    expect(options).toMatchObject({ contentType: 'image/jpeg', contentDisposition: 'attachment; filename="PAR-7-2026.jpg"' });
  });

  it('XML kosztu z KSeF: podgląd jako tekst w przeglądarce, pobranie jako XML; plik powiązany w xml_documents', async () => {
    st.expense = { ...KSEF };
    st.access = { ...ACCESS, access_level: 'download' };

    const view = await viewFile(req(), ctx());
    expect(view.status).toBe(303);
    expect(st.sign.mock.calls[0]![0]).toBe(INVOICE.xml_storage_path);
    expect(st.sign.mock.calls[0]![2]).toMatchObject({ contentType: 'text/plain; charset=utf-8', contentDisposition: 'inline' });
    // Ten sam związek pliku z fakturą i firmą co przy XML faktury w portalu.
    const xmlFilters = st.calls.filter((c) => c.table === 'xml_documents' && c.method === 'eq').map((c) => c.args);
    expect(xmlFilters).toEqual(expect.arrayContaining([
      ['storage_path', INVOICE.xml_storage_path], ['tenant_id', 'ten-1'], ['invoice_id', 'inv-1'],
    ]));
    expect(st.calls.filter((c) => c.table === 'invoices' && c.method === 'eq').map((c) => c.args))
      .toEqual(expect.arrayContaining([['id', 'inv-1'], ['tenant_id', 'ten-1']]));

    const download = await downloadFile(req(), ctx());
    expect(download.status).toBe(303);
    expect(st.sign.mock.calls[1]![2]).toMatchObject({
      contentType: 'application/xml', contentDisposition: 'attachment; filename="FV-10-2026.xml"',
    });
  });

  it('XML bez wiersza xml_documents: 404, bez podpisu', async () => {
    st.expense = { ...KSEF };
    st.xmlDoc = null;
    const res = await viewFile(req(), ctx());
    expect(res.status).toBe(404);
    expect(st.sign).not.toHaveBeenCalled();
  });
});

describe('plik kosztu w portalu: token i firma', () => {
  it.each([
    ['wygasły', { expires_at: '2026-01-01T00:00:00Z' }],
    ['cofnięty', { revoked_at: '2026-10-01T00:00:00Z' }],
  ])('token %s: 403 bez odczytu kosztu', async (_name, patch) => {
    st.access = { ...ACCESS, access_level: 'download', ...patch };
    for (const handler of [viewFile, downloadFile]) {
      const res = await handler(req(), ctx());
      expect(res.status).toBe(403);
    }
    expect(tables().has('expenses')).toBe(false);
    expect(st.sign).not.toHaveBeenCalled();
  });

  it('nieznany token: 403', async () => {
    st.access = null;
    const res = await viewFile(req(), ctx());
    expect(res.status).toBe(403);
    expect(tables().has('expenses')).toBe(false);
  });

  it('koszt czytany tylko w firmie z tokenu; koszt innej firmy to 404', async () => {
    st.expense = null;
    const res = await viewFile(req(), ctx());
    expect(res.status).toBe(404);
    expect(st.calls.filter((c) => c.table === 'expenses' && c.method === 'eq').map((c) => c.args))
      .toEqual(expect.arrayContaining([['id', EXPENSE_ID], ['tenant_id', 'ten-1']]));
    expect(st.sign).not.toHaveBeenCalled();
  });

  it('ścieżka pliku spoza folderu firmy: 404, bez podpisu', async () => {
    st.expense = { ...PHOTO, source_file_path: 'tenants/ten-2/expenses/2026/10/job-9.jpg' };
    const res = await viewFile(req(), ctx());
    expect(res.status).toBe(404);
    expect(st.sign).not.toHaveBeenCalled();
  });

  it('identyfikator, który nie jest UUID: 404 bez zapytania o koszt', async () => {
    const res = await viewFile(req(), ctx('../../etc'));
    expect(res.status).toBe(404);
    expect(tables().has('expenses')).toBe(false);
  });
});

describe('plik kosztu w portalu: audyt i limit prób', () => {
  it('wpis w audycie bez treści dokumentu i bez ścieżki magazynu', async () => {
    st.access = { ...ACCESS, access_level: 'download' };
    await viewFile(req(), ctx());
    await downloadFile(req(), ctx());
    expect(st.audit).toHaveBeenCalledTimes(2);
    const [viewed, downloaded] = st.audit.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(viewed).toMatchObject({ action: 'accountant.expense_file_viewed', tenantId: 'ten-1', entityType: 'expense', entityId: EXPENSE_ID });
    expect(downloaded).toMatchObject({ action: 'accountant.expense_file_downloaded', tenantId: 'ten-1', entityType: 'expense', entityId: EXPENSE_ID });
    expect(viewed!.metadata).toMatchObject({ via: 'accountant_access', accessId: 'acc-1', file: 'photo' });
    expect(JSON.stringify(st.audit.mock.calls)).not.toMatch(/tenants\/|X-Amz|PAR 7/);
  });

  it('limit prób: 429 z Retry-After, przed odczytem tokenu', async () => {
    st.limit.mockResolvedValue({ allowed: false, remaining: 0, retryAfter: 90 });
    const res = await viewFile(req(), ctx());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('90');
    expect(await res.text()).toMatch(/Spróbuj ponownie za kilka minut/);
    expect(st.calls).toEqual([]);
    expect(st.limit).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'accountant_portal', identifier: '203.0.113.5' }));
  });

  it('podpis się nie udał: 503 z komunikatem, bez audytu', async () => {
    st.sign.mockRejectedValue(new Error('storage down'));
    const res = await viewFile(req(), ctx());
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/chwilowo niedostępny/);
    expect(st.audit).not.toHaveBeenCalled();
  });
});
