import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resendSend: vi.fn(),
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mocks.resendSend };
  },
}));
vi.mock('@/lib/email/preferences', () => ({ canSendTo: async () => ({ ok: true }) }));

/**
 * AUD-86: maile z powiadomień szły do Resend bez klucza idempotencji.
 * Ponowienie zadania (pg-boss do 2×, Inngest per krok) albo odpowiedź
 * Resend zgubiona po przyjęciu maila = ten sam mail 2–3 razy.
 */

describe('wysyłka przez Resend z kluczem idempotencji', () => {
  beforeEach(() => {
    vi.stubEnv('RESEND_API_KEY', 're_test_klucz');
    vi.stubEnv('RESEND_DEV_TO_OVERRIDE', '');
    mocks.resendSend.mockReset();
    mocks.resendSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
  });

  it('klucz przekazany do Resend (nagłówek Idempotency-Key)', async () => {
    const { sendInvoiceAcceptedEmail } = await vi.importActual<typeof import('@/lib/email/send')>('@/lib/email/send');

    await sendInvoiceAcceptedEmail(
      'wlasciciel@example.test',
      { ksefNumber: '1234567890-20261002-0100001AF629-AF', invoiceId: 'inv-1' },
      { idempotencyKey: 'invoice-accepted/inv-1' },
    );

    expect(mocks.resendSend).toHaveBeenCalledTimes(1);
    expect(mocks.resendSend.mock.calls[0]![1]).toEqual({ idempotencyKey: 'invoice-accepted/inv-1' });
  });

  it('ostrzeżenie o certyfikacie KSeF — klucz przekazany do Resend (A5: ponowienie crona po błędzie odczytu adresu)', async () => {
    const { sendCertExpiryAlert } = await vi.importActual<typeof import('@/lib/email/send')>('@/lib/email/send');

    await sendCertExpiryAlert(
      'wlasciciel@example.test',
      { tenantName: 'Firma', daysRemaining: 7, expiryDate: '2026-10-09T06:00:00.000Z' },
      { idempotencyKey: 'cert-expiry/t1/1791525600000/7/7' },
    );

    expect(mocks.resendSend).toHaveBeenCalledTimes(1);
    expect(mocks.resendSend.mock.calls[0]![1]).toEqual({ idempotencyKey: 'cert-expiry/t1/1791525600000/7/7' });
  });

  it('bez klucza — jak dotąd, bez opcji', async () => {
    const { sendInvoiceFailedEmail } = await vi.importActual<typeof import('@/lib/email/send')>('@/lib/email/send');

    await sendInvoiceFailedEmail('wlasciciel@example.test', { invoiceId: 'inv-1', errorMessage: 'Błąd' });

    expect(mocks.resendSend.mock.calls[0]![1]).toBeUndefined();
  });
});
