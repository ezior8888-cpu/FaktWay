import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 6.2, PR 1: limit prób portalu księgowej. Do tej pory portal nie miał
 * żadnego limitu (strona, XML faktury, eksport). Jeden kubełek na adres IP
 * dla stron i plików portalu; odmowa przed odczytem tokenu z bazy.
 * Eksport (`/api/portal/exports/generate`) dostaje limit w osobnym PR po #522.
 */

const st = vi.hoisted(() => ({
  from: vi.fn(),
  limit: vi.fn(),
  download: vi.fn(),
  audit: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({ notFound: st.notFound, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/auth/get-client-ip', () => ({ getClientIp: async () => '203.0.113.5' }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: st.limit }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: st.audit }));
vi.mock('@/lib/storage/r2', () => ({ downloadInvoiceXml: st.download }));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      st.from(table);
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'range', 'limit', 'update', 'is']) {
        chain[method] = () => chain;
      }
      chain.maybeSingle = async () => ({ data: null, error: null });
      chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null, count: 0 }).then(ok);
      return chain;
    },
  }),
}));

import AccountantExpensesPage from '@/app/accountant/[token]/expenses/page';
import { GET as downloadInvoiceXml } from '@/app/accountant/[token]/download/[invoiceId]/route';
import AccountantPortalPage from '@/app/accountant/[token]/page';
import { ACCOUNTANT_PORTAL_RATE_LIMIT } from '@/lib/rate-limit/accountant-portal';

beforeEach(() => {
  st.from.mockReset();
  st.limit.mockReset();
  st.limit.mockResolvedValue({ allowed: false, remaining: 0, retryAfter: 120 });
  st.download.mockReset();
  st.audit.mockReset();
});

describe('portal księgowej: limit prób', () => {
  it('strona dokumentów: komunikat zamiast listy, bez odczytu tokenu', async () => {
    const html = renderToStaticMarkup(
      await AccountantPortalPage({ params: Promise.resolve({ token: 'tok' }), searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain('Za dużo otwarć portalu z tego adresu');
    expect(html).toContain('Spróbuj ponownie za kilka minut');
    expect(st.from).not.toHaveBeenCalled();
  });

  it('strona kosztów: komunikat zamiast listy, bez odczytu tokenu', async () => {
    const html = renderToStaticMarkup(
      await AccountantExpensesPage({ params: Promise.resolve({ token: 'tok' }), searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain('Za dużo otwarć portalu z tego adresu');
    expect(st.from).not.toHaveBeenCalled();
  });

  it('XML faktury: 429 z Retry-After, bez odczytu tokenu i pliku', async () => {
    const res = await downloadInvoiceXml(new Request('https://app.example.test/'), {
      params: Promise.resolve({ token: 'tok', invoiceId: 'invoice-a' }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('120');
    expect(st.from).not.toHaveBeenCalled();
    expect(st.download).not.toHaveBeenCalled();
  });

  it('jeden kubełek na adres IP; odmowa nie wydłuża blokady', async () => {
    await downloadInvoiceXml(new Request('https://app.example.test/'), {
      params: Promise.resolve({ token: 'tok', invoiceId: 'invoice-a' }),
    });
    expect(st.limit).toHaveBeenCalledWith({
      bucket: 'accountant_portal',
      identifier: '203.0.113.5',
      limit: ACCOUNTANT_PORTAL_RATE_LIMIT.limit,
      windowSeconds: ACCOUNTANT_PORTAL_RATE_LIMIT.windowSeconds,
      countDenied: false,
    });
  });

  it('limit w pamięci procesu (bez Redisa) nie zamyka portalu', async () => {
    st.limit.mockResolvedValue({ allowed: true, remaining: 5, retryAfter: 0, fallback: true });
    const res = await downloadInvoiceXml(new Request('https://app.example.test/'), {
      params: Promise.resolve({ token: 'tok', invoiceId: 'invoice-a' }),
    });
    // Dalej zwykła ścieżka: nieznany token to 403, nie 429.
    expect(res.status).toBe(403);
    expect(st.from).toHaveBeenCalledWith('accountant_access');
  });
});
