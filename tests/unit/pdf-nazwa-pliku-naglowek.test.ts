import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), pdf: vi.fn(), capture: vi.fn() }));

vi.mock('@/lib/supabase/auth-context', () => ({ resolveApiUserAndActiveOrg: mocks.auth }));
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: mocks.pdf }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.capture }));

import { GET } from '@/app/api/invoices/[id]/pdf/route';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ ok: true, tenantId: 'tenant-a' });
});

describe('F12-E7: nazwa pliku PDF z literą spoza Latin-1', () => {
  it('daje 200 i nagłówek RFC 6266 z zapasem ASCII', async () => {
    mocks.pdf.mockResolvedValue({ success: true, pdf: Buffer.from('pdf'), filename: 'Faktura_FV_Ł_1.pdf' });
    const response = await GET(new Request('https://example.test/api/invoices/x/pdf'), {
      params: Promise.resolve({ id: 'x' }),
    });
    expect(response.status).toBe(200);
    const cd = response.headers.get('Content-Disposition') ?? '';
    expect(cd).toContain('filename="Faktura_FV_L_1.pdf"');
    expect(cd).toContain("filename*=UTF-8''Faktura_FV_%C5%81_1.pdf");
  });
});
