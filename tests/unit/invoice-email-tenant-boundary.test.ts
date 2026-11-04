import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  generatePdf: vi.fn(),
  verifyPdf: vi.fn(),
  loadInvoice: vi.fn(),
  sendEmail: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: mocks.requireAuth,
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('@/lib/pdf/invoice-pdf', () => ({
  generateInvoicePdf: mocks.generatePdf,
  verifyInvoicePdfDeliveryState: mocks.verifyPdf,
}));
vi.mock('@/lib/pdf/invoice-data', () => ({ loadInvoiceForPdf: mocks.loadInvoice }));
vi.mock('@/lib/email/send', () => ({ sendInvoiceEmail: mocks.sendEmail }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/storage/r2', () => ({ downloadInvoiceXml: vi.fn() }));

import { emailInvoiceAction } from '@/components/invoices/actions-detail';
import { ActionAuthError } from '@/lib/supabase/auth-context';

const invoiceId = '11111111-1111-4111-8111-111111111111';
const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const foreignTenant = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAuth.mockResolvedValue({ user: { id: 'user-1' }, tenantId });
  mocks.generatePdf.mockResolvedValue({ success: true, pdf: Buffer.from('pdf'), filename: 'invoice.pdf', qrStateKey: 'qr-state' });
  mocks.verifyPdf.mockResolvedValue(null);
  mocks.loadInvoice.mockResolvedValue({
    tenantId,
    invoice: {
      internalNumber: 'FV/1',
      seller: { name: 'Fixture seller' },
      grossTotal: 123,
      payment: { dueDate: '2026-10-01' },
    },
  });
  mocks.sendEmail.mockResolvedValue({ sent: true });
});

describe('wysyłka PDF faktury e-mailem', () => {
  it.each([
    'Wymagana weryfikacja dwuetapowa',
    'Brak dostępu do aktywnej organizacji',
  ])('odmawia przy niezweryfikowanej sesji lub członkostwie: %s', async (reason) => {
    mocks.requireAuth.mockRejectedValueOnce(new ActionAuthError(reason));

    expect(await emailInvoiceAction(invoiceId, 'buyer@example.test')).toEqual({ success: false, error: reason });
    expect(mocks.generatePdf).not.toHaveBeenCalled();
    expect(mocks.loadInvoice).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('przekazuje zweryfikowaną organizację do obu odczytów PDF', async () => {
    expect(await emailInvoiceAction(invoiceId, 'buyer@example.test')).toEqual({ success: true });
    expect(mocks.generatePdf).toHaveBeenCalledExactlyOnceWith(invoiceId, tenantId);
    expect(mocks.loadInvoice).toHaveBeenCalledExactlyOnceWith(invoiceId, tenantId);
    // D-A4-1b-3 PR B: mail odmawia szkicu z numerem zajętym w KSeF (pobranie PDF — nie).
    expect(mocks.verifyPdf).toHaveBeenCalledExactlyOnceWith(invoiceId, tenantId, 'qr-state', { refuseRetiredDraft: true });
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ tenantId, entityId: invoiceId }));
  });

  it('nie wysyła PDF, gdy loader zwróci fakturę z obcej organizacji', async () => {
    mocks.loadInvoice.mockResolvedValueOnce({
      tenantId: foreignTenant,
      invoice: { internalNumber: 'FOREIGN' },
    });
    expect(await emailInvoiceAction(invoiceId, 'buyer@example.test')).toEqual({
      success: false,
      error: 'Faktura nie istnieje.',
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('nie wysyła nabywcy podglądu bez kodu QR KOD I (B14)', async () => {
    mocks.generatePdf.mockResolvedValueOnce({
      success: true, pdf: Buffer.from('pdf'), filename: 'invoice.pdf', qrStateKey: 'qr-state', missingKodI: true,
    });
    const result = await emailInvoiceAction(invoiceId, 'buyer@example.test');
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('kodu QR') });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('nie wysyła PDF, gdy faktura wejdzie do Offline24 tuż przed wysyłką', async () => {
    mocks.verifyPdf.mockResolvedValueOnce({
      success: false, code: 'OFFLINE_QR_UNAVAILABLE', error: 'Brak KODU II',
    });
    expect(await emailInvoiceAction(invoiceId, 'buyer@example.test')).toEqual({
      success: false, error: 'Brak KODU II',
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
