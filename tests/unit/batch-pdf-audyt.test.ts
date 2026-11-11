import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 2.8 (wydruk zbiorczy): pobranie paczki PDF zostawia ślad w audit_logs
 * (zbiorcze pobranie danych fakturowych), a odmowa (obca faktura, brak faktur)
 * nie zostawia wpisu o pobraniu.
 */

const s = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; tenant_id: string; direction: string; internal_number: string }>,
  audit: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: s.audit }));
vi.mock('@/lib/supabase/auth-context', () => ({
  resolveApiUserAndActiveOrg: async () => ({ ok: true, userId: 'u-1', tenantId: 'ten-audyt', role: 'owner' }),
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: async () => ({ allowed: true, remaining: 2, retryAfter: 0 }) }));
vi.mock('@/lib/pdf/invoice-pdf', () => ({
  generateInvoicePdf: async (id: string) => ({ success: true, pdf: Buffer.from('%PDF'), filename: `${id}.pdf` }),
}));
vi.mock('@/lib/exports/zip-packager', () => ({ packageZip: async () => Buffer.from('zip') }));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => {
    const preds: Array<(r: (typeof s.rows)[number]) => boolean> = [];
    const q = {
      select: () => q,
      eq: (k: 'tenant_id' | 'direction', v: string) => { preds.push((r) => r[k] === v); return q; },
      gte: () => q,
      lte: () => q,
      in: (_k: string, v: string[]) => { preds.push((r) => v.includes(r.id)); return q; },
      limit: async (n: number) => ({ data: s.rows.filter((r) => preds.every((p) => p(r))).slice(0, n), error: null }),
    };
    return { from: () => q };
  },
}));

import { GET } from '@/app/api/invoices/batch-pdf/route';

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const B1 = '33333333-3333-4333-8333-333333333333';
const req = (qs: string) => new Request(`https://app.example.test/api/invoices/batch-pdf?${qs}`);

beforeEach(() => {
  s.audit.mockReset().mockResolvedValue(undefined);
  s.rows = [
    { id: A1, tenant_id: 'ten-audyt', direction: 'outgoing', internal_number: 'FV/1' },
    { id: A2, tenant_id: 'ten-audyt', direction: 'outgoing', internal_number: 'FV/2' },
    { id: B1, tenant_id: 'ten-b', direction: 'outgoing', internal_number: 'FV/OBCA' },
  ];
});

describe('paczka PDF zaznaczonych: audyt', () => {
  it('udane pobranie zapisuje wpis z firmą, użytkownikiem, liczbą i identyfikatorami', async () => {
    const res = await GET(req(`ids=${A1},${A2}`));
    expect(res.status).toBe(200);
    expect(s.audit).toHaveBeenCalledTimes(1);
    expect(s.audit).toHaveBeenCalledWith({
      action: 'invoice.batch_pdf_downloaded',
      tenantId: 'ten-audyt',
      userId: 'u-1',
      entityType: 'invoice',
      metadata: { mode: 'ids', count: 2, invoiceIds: [A1, A2] },
    });
  });

  it('obca faktura w zaznaczeniu (404) nie zostawia wpisu o pobraniu', async () => {
    const res = await GET(req(`ids=${A1},${B1}`));
    expect(res.status).toBe(404);
    expect(s.audit).not.toHaveBeenCalled();
  });

  it('pusta lista (brak faktur w miesiącu, 404) nie zostawia wpisu', async () => {
    s.rows = [];
    const res = await GET(req('from=2020-01-01&to=2020-01-31'));
    expect(res.status).toBe(404);
    expect(s.audit).not.toHaveBeenCalled();
  });

  it('pobranie miesiąca zapisuje tryb range z okresem', async () => {
    const res = await GET(req('from=2026-09-01&to=2026-09-30'));
    expect(res.status).toBe(200);
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice.batch_pdf_downloaded',
      metadata: { mode: 'range', count: 2, from: '2026-09-01', to: '2026-09-30' },
    }));
  });

  it('błąd zapisu audytu nie psuje pobrania', async () => {
    s.audit.mockRejectedValue(new Error('baza'));
    const res = await GET(req(`ids=${A1}`));
    expect(res.status).toBe(200);
  });
});
