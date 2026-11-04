import { beforeEach, expect, it, vi } from 'vitest';

/**
 * Faktura `zw` odrzucona przez KSeF (np. brak P_19A) to błąd TREŚCI: nie ma
 * „wyślij ponownie” bez poprawy — wraca do szkicu (decyzja D2 cyklu życia).
 */

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  enqueue: vi.fn(),
  status: 'rejected',
  filters: [] as Array<[string, unknown]>,
}));

vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: mocks.requireAuth,
  requireOrgRole: mocks.requireAuth,
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: mocks.enqueue }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: vi.fn() }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/storage/r2', () => ({ downloadInvoiceXml: vi.fn() }));
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: vi.fn() }));
vi.mock('@/lib/pdf/invoice-data', () => ({ loadInvoiceForPdf: vi.fn() }));
vi.mock('@/lib/email/send', () => ({ sendInvoiceEmail: vi.fn() }));

import { resendInvoiceAction } from '@/components/invoices/actions-detail';
import { KSEF_SEND_MESSAGES } from '@/lib/invoices/ksef-send-policy';

const invoiceId = '11111111-1111-4111-8111-111111111111';
const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.filters = [];
  mocks.status = 'rejected';
  mocks.requireAuth.mockImplementation(async () => {
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => {
        mocks.filters.push([key, value]);
        return query;
      },
      maybeSingle: async () => ({
        data: {
          ksef_status: mocks.status, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT',
          last_error_code: 'KSEF_REJECTED', issue_date: '2026-10-01', fa3_data: {}, special_data: null,
        },
        error: null,
      }),
    };
    return { supabase: { from: () => query }, tenantId, user: { id: 'user-1' }, role: 'owner' };
  });
});

it('faktura zw odrzucona przez KSeF wraca do szkicu; P_19A nie upoważnia do replay', async () => {
  expect(await resendInvoiceAction(invoiceId)).toEqual({
    success: false,
    error: KSEF_SEND_MESSAGES.rejected,
  });
  expect(mocks.filters).toContainEqual(['tenant_id', tenantId]);
  expect(mocks.enqueue).not.toHaveBeenCalled();
});
