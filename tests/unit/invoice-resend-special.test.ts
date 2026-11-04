import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Granice „Wyślij ponownie” (PR 3b cyklu życia): akcja nie dotyka faktury ani
 * kolejki bez sesji/MFA, nie zdradza cudzej faktury, odmawia dla stanów innych
 * niż `failed`, a `rejected` zawsze odsyła do szkicu (D2). Historyczny
 * `failed` bez kodu (sprzed katalogu 00131) wolno ponowić — runner zaczyna od
 * uzgodnienia po referencji, więc nie wyśle faktury, którą KSeF już ma.
 */

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  row: { ksef_status: 'failed' } as Record<string, unknown> | null,
  eq: vi.fn(),
  enqueue: vi.fn(),
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
import { ActionAuthError } from '@/lib/supabase/auth-context';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';

const INVOICE_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const snapshot = finalizeInvoice({
  internalNumber: 'FV 1/10/2026',
  type: 'VAT',
  issueDate: '2026-10-01',
  saleDate: '2026-10-01',
  seller: { nip: '5260001246', name: 'Firma', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
  buyer: { nip: '5252241585', name: 'Klient', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' } },
  lines: [{ ordinal: 1, name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
  payment: { currency: 'PLN', dueDate: '2026-10-15', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
});

function historical(status: string) {
  return {
    ksef_status: status, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', last_error_code: null,
    issue_date: '2026-10-01', fa3_data: snapshot, special_data: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.row = historical('failed');
  mocks.enqueue.mockResolvedValue({ ok: true, mode: 'online_queued' });
  mocks.requireAuth.mockImplementation(async () => {
    const query = (table: string) => {
      const q = {
        select: () => q,
        eq: (column: string, value: unknown) => {
          mocks.eq(column, value);
          return q;
        },
        maybeSingle: async () => ({ data: table === 'tenants' ? { nip: '5260001246' } : mocks.row, error: null }),
      };
      return q;
    };
    return {
      supabase: { from: query },
      tenantId: TENANT_ID,
      user: { id: 'user' },
      role: 'owner',
    };
  });
});

describe('historical KSeF resend boundary', () => {
  it('historyczny failed bez kodu: ponowienie przez requeue (runner zaczyna od uzgodnienia)', async () => {
    expect(await resendInvoiceAction(INVOICE_ID)).toEqual({ success: true });
    expect(mocks.eq).toHaveBeenCalledWith('tenant_id', TENANT_ID);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: INVOICE_ID,
      mode: { kind: 'requeue', actorUserId: 'user' },
    }));
  });

  it('rejected nigdy nie jest wysyłana ponownie — wraca do szkicu (D2)', async () => {
    mocks.row = historical('rejected');
    expect(await resendInvoiceAction(INVOICE_ID)).toEqual({ success: false, error: KSEF_SEND_MESSAGES.rejected });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('does not access the invoice or enqueue when MFA or membership fails', async () => {
    mocks.requireAuth.mockRejectedValueOnce(new ActionAuthError('Wymagana weryfikacja dwuetapowa'));
    expect(await resendInvoiceAction(INVOICE_ID)).toEqual({
      success: false,
      error: 'Wymagana weryfikacja dwuetapowa',
    });
    expect(mocks.eq).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('does not disclose a foreign invoice or publish a job', async () => {
    mocks.row = null;
    expect(await resendInvoiceAction(INVOICE_ID)).toMatchObject({
      success: false,
      error: KSEF_SEND_MESSAGES.notFound,
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('rejects replay from other statuses before publishing', async () => {
    mocks.row = historical('accepted');
    // Dokładny komunikat odmowy statusu — sam `success: false` przeszedłby też przy ogólnym błędzie z catch.
    expect(await resendInvoiceAction(INVOICE_ID)).toEqual({ success: false, error: KSEF_SEND_MESSAGES.status });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('does not disclose an unexpected DB error to the caller', async () => {
    mocks.requireAuth.mockRejectedValueOnce(new Error('PRIVATE-DB-DIAGNOSTIC'));
    expect(await resendInvoiceAction(INVOICE_ID)).toEqual({
      success: false,
      error: 'Nie można sprawdzić możliwości ponownej wysyłki. Spróbuj później.',
    });
  });
});
