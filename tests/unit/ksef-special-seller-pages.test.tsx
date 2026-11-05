import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const pageMocks = vi.hoisted(() => ({
  finalFormProps: [] as Array<{ advanceInvoices: Array<{ id: string }>; tenantId: string }>,
  advanceFormProps: [] as Array<{ tenantId: string }>,
}));

vi.mock('@/lib/invoices/load-tenant-seller', () => ({
  loadTenantSellerForForms: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/supabase/active-org', () => ({
  getActiveOrgIdFromCookies: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
}));
vi.mock('@/components/invoices/advance-form', () => ({
  AdvanceInvoiceForm: (props: { tenantId: string }) => {
    pageMocks.advanceFormProps.push(props);
    return null;
  },
}));
vi.mock('@/components/invoices/final-form', () => ({
  FinalInvoiceForm: (props: { advanceInvoices: Array<{ id: string }>; tenantId: string }) => {
    pageMocks.finalFormProps.push(props);
    return null;
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => { throw new Error('No invoice query when seller is incomplete'); }),
}));

import NewAdvanceInvoicePage from '@/app/(dashboard)/invoices/new/advance/page';
import NewFinalInvoicePage from '@/app/(dashboard)/invoices/new/final/page';
import { loadTenantSellerForForms } from '@/lib/invoices/load-tenant-seller';
import { createClient } from '@/lib/supabase/server';

describe('special invoice pages with an incomplete company profile', () => {
  it.each([
    ['ZAL', NewAdvanceInvoicePage],
    ['ROZ', NewFinalInvoicePage],
  ])('blocks %s issuance and points to the existing company profile', async (_kind, page) => {
    const html = renderToStaticMarkup(await page());
    expect(html).toContain('Wystawianie faktury jest wstrzymane');
    expect(html).toContain('profil istniejącej firmy');
    expect(html).toContain('href="/settings"');
    expect(html).not.toContain('/onboarding');
  });
});

describe('ZAL page passes the company it rendered the seller for (UX-01)', () => {
  it('form gets the tenant of the loaded seller — the save sends it back as expectedTenantId', async () => {
    vi.mocked(loadTenantSellerForForms).mockResolvedValueOnce({
      tenantId: '22222222-2222-4222-8222-222222222222',
      seller: {
        nip: '1234567890', name: 'Sprzedawca testowy',
        address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
      },
    });
    pageMocks.advanceFormProps.length = 0;

    renderToStaticMarkup(await NewAdvanceInvoicePage());

    expect(pageMocks.advanceFormProps.at(-1)?.tenantId).toBe('22222222-2222-4222-8222-222222222222');
  });
});

describe('ROZ page lists only advances not settled by another ROZ (AUD-67)', () => {
  it('hides an advance already pointed to by a live ROZ', async () => {
    const free = { id: 'adv-free', internal_number: 'ZAL/1' };
    const taken = { id: 'adv-taken', internal_number: 'ZAL/2' };
    vi.mocked(loadTenantSellerForForms).mockResolvedValueOnce({
      tenantId: '11111111-1111-4111-8111-111111111111',
      seller: {
        nip: '1234567890', name: 'Sprzedawca testowy',
        address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
      },
    });
    vi.mocked(createClient).mockImplementationOnce(async () => ({
      from: () => {
        let columns = '';
        const chain = {
          select: (c: string) => { columns = c; return chain; },
          eq: () => chain, or: () => chain, overlaps: () => chain, order: () => chain,
          limit: async () => ({ data: [free, taken], error: null }),
          then: <T,>(resolve: (v: { data: unknown; error: null }) => T) => Promise.resolve({
            data: columns.includes('advance_invoice_ids')
              ? [{ id: 'roz-1', internal_number: 'ROZ/1', advance_invoice_ids: ['adv-taken'] }]
              : [],
            error: null,
          }).then(resolve),
        };
        return chain;
      },
    }) as unknown as Awaited<ReturnType<typeof createClient>>);
    pageMocks.finalFormProps.length = 0;

    renderToStaticMarkup(await NewFinalInvoicePage());

    expect(pageMocks.finalFormProps.at(-1)?.advanceInvoices.map((a) => a.id)).toEqual(['adv-free']);
    // UX-01: firma, z której wczytano sprzedawcę i zaliczki, idzie do formularza.
    expect(pageMocks.finalFormProps.at(-1)?.tenantId).toBe('11111111-1111-4111-8111-111111111111');
  });
});
