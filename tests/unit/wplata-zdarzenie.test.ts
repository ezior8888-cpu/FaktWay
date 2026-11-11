import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobContext } from '@/lib/jobs/registry';

/**
 * Krok 8.1 planu kompletnej aplikacji, część 1: zdarzenie o wpłacie
 * (`invoice/payment.received` z `paymentId`) i powiadomienie „Otrzymana płatność”.
 * Prawdziwe akcje i prawdziwy runner; atrapy tylko dla sesji, RPC, bazy i HTTP (push).
 */

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  requireOrgRole: vi.fn(),
  send: vi.fn(),
  push: vi.fn(),
  invoice: null as Record<string, unknown> | null,
  payment: null as Record<string, unknown> | null,
  reminders: [] as Array<{ id: string; status: string }>,
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: m.send }));
vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  return { ActionAuthError, requireOrgRole: m.requireOrgRole };
});
vi.mock('@/lib/push/sender', () => ({ sendPushToTenant: m.push }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === 'invoices') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: m.invoice, error: null }) }) }) };
      }
      if (table === 'payments') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: m.payment, error: null }) }) }) };
      }
      if (table === 'payment_reminders') {
        return {
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: async () => {
                  const pending = m.reminders.filter((r) => r.status === 'pending');
                  for (const r of pending) r.status = 'cancelled';
                  return { data: pending.map((r) => ({ id: r.id })), error: null };
                },
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

const { recordInvoicePaymentAction, markInvoicePaidAction } = await import('@/app/actions/invoice-payments');
const { runCancelRemindersOnPayment } = await import('@/lib/jobs/runners/cancel-reminders-on-payment');

const INVOICE = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const KEY = '44444444-4444-4444-8444-444444444444';
const PAYMENT = '55555555-5555-4555-8555-555555555555';
const NBSP = /[  ]/g;
const plain = (t: string) => t.replace(NBSP, ' ');

const context: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

const record = () =>
  recordInvoicePaymentAction({ invoiceId: INVOICE, idempotencyKey: KEY, amount: '300,00', paidOn: '2020-01-02' });

beforeEach(() => {
  vi.clearAllMocks();
  m.send.mockResolvedValue({ ids: ['j1'] });
  m.push.mockResolvedValue({ sent: 1, failed: 0 });
  m.requireOrgRole.mockResolvedValue({ supabase: { rpc: m.rpc }, tenantId: TENANT, user: { id: 'u' }, role: 'member' });
  m.invoice = {
    paid_amount: 1000, gross_total: 1230, tenant_id: TENANT, internal_number: 'FV/1/2026',
    invoice_kind: 'regular', payment_data: null, buyer_data: { name: 'Acme Sp. z o.o.' },
  };
  m.payment = { amount: 300, voided_at: null };
  m.reminders = [{ id: 'r1', status: 'pending' }];
});

describe('akcje wysyłają zdarzenie wpłaty', () => {
  it('recordInvoicePaymentAction: po „recorded” zdarzenie z paymentId i kluczem payment:<id>', async () => {
    m.rpc.mockResolvedValue({
      data: { status: 'recorded', payment_id: PAYMENT, amount: 300, paid_on: '2020-01-02', remaining: 930, payment_status: 'partial', internal_number: 'FV/1/2026' },
      error: null,
    });
    await record();
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.send).toHaveBeenCalledWith(
      { name: 'invoice/payment.received', data: { invoiceId: INVOICE, paymentId: PAYMENT }, singletonKey: `payment:${PAYMENT}` },
    );
  });

  it('recordInvoicePaymentAction: „already_recorded” i odmowa nie wysyłają zdarzenia', async () => {
    m.rpc.mockResolvedValue({
      data: { status: 'already_recorded', payment_id: PAYMENT, amount: 300, paid_on: '2020-01-02', remaining: 930, payment_status: 'partial' },
      error: null,
    });
    await record();
    m.rpc.mockResolvedValue({ data: { status: 'refused', code: 'over_remaining', remaining: 10 }, error: null });
    await record();
    expect(m.send).not.toHaveBeenCalled();
  });

  it('markInvoicePaidAction: po „marked” zdarzenie z paymentId; „already_paid” bez zdarzenia', async () => {
    m.rpc.mockResolvedValue({
      data: { status: 'marked', amount: 1230, paid_on: '2026-11-02', payment_id: PAYMENT, internal_number: 'FV/1/2026' },
      error: null,
    });
    await markInvoicePaidAction(INVOICE);
    expect(m.send).toHaveBeenCalledWith(
      { name: 'invoice/payment.received', data: { invoiceId: INVOICE, paymentId: PAYMENT }, singletonKey: `payment:${PAYMENT}` },
    );
    m.send.mockClear();
    m.rpc.mockResolvedValue({ data: { status: 'already_paid', internal_number: 'FV/1/2026' }, error: null });
    await markInvoicePaidAction(INVOICE);
    expect(m.send).not.toHaveBeenCalled();
  });

  it('błąd kolejki nie psuje zapisanej wpłaty', async () => {
    m.send.mockRejectedValue(new Error('kolejka niedostępna'));
    m.rpc.mockResolvedValue({
      data: { status: 'recorded', payment_id: PAYMENT, amount: 300, paid_on: '2020-01-02', remaining: 930, payment_status: 'partial' },
      error: null,
    });
    expect(await record()).toMatchObject({ success: true, status: 'recorded' });
  });
});

describe('runner po wpłacie', () => {
  it('wpłata częściowa: przypomnienia zostają, push „Wpłata częściowa” z kwotą, numerem i resztą', async () => {
    const result = await runCancelRemindersOnPayment({ invoiceId: INVOICE, paymentId: PAYMENT }, context);
    expect(m.reminders[0]!.status).toBe('pending');
    expect(result).toMatchObject({ push: { sent: 1 } });
    expect(m.push).toHaveBeenCalledTimes(1);
    const [tenant, type, payload] = m.push.mock.calls[0]!;
    expect(tenant).toBe(TENANT);
    expect(type).toBe('payment_received');
    expect(plain(payload.body)).toBe('Wpłata częściowa: 300,00 zł za FV/1/2026, zostało 230,00 zł');
    expect(payload.tag).toBe(`payment-${PAYMENT}`);
  });

  it('pełna zapłata: push „Otrzymana płatność” z kwotą, numerem i nabywcą, przypomnienia bez zmian (anuluje baza)', async () => {
    m.invoice = { ...m.invoice, paid_amount: 1230 };
    m.payment = { amount: 230, voided_at: null };
    await runCancelRemindersOnPayment({ invoiceId: INVOICE, paymentId: PAYMENT }, context);
    expect(m.reminders[0]!.status).toBe('pending');
    const payload = m.push.mock.calls[0]![2];
    expect(plain(payload.body)).toBe('Otrzymana płatność: 230,00 zł za FV/1/2026 od Acme Sp. z o.o.');
    expect(payload.title).toBe('Otrzymana płatność');
    expect(JSON.stringify(payload)).not.toMatch(/[—–]/);
  });

  it('ponowienie od zera: ten sam tag pusha, anulowanie bez skutków ubocznych', async () => {
    m.invoice = { ...m.invoice, paid_amount: 1230 };
    await runCancelRemindersOnPayment({ invoiceId: INVOICE, paymentId: PAYMENT }, context);
    const again = await runCancelRemindersOnPayment({ invoiceId: INVOICE, paymentId: PAYMENT }, context);
    expect(again).toMatchObject({ push: { sent: 1 } });
    // Ten sam tag: przeglądarka zastępuje powiadomienie, nie dokłada drugiego.
    expect(m.push.mock.calls.map((c) => c[2].tag)).toEqual([`payment-${PAYMENT}`, `payment-${PAYMENT}`]);
  });

  it('push prowadzi do strony faktury, nie do nieistniejącego /payments (pełna i częściowa)', async () => {
    await runCancelRemindersOnPayment({ invoiceId: INVOICE, paymentId: PAYMENT }, context);
    m.invoice = { ...m.invoice, paid_amount: 1230 };
    await runCancelRemindersOnPayment({ invoiceId: INVOICE, paymentId: PAYMENT }, context);
    expect(m.push.mock.calls.map((c) => c[2].url)).toEqual([`/invoices/${INVOICE}`, `/invoices/${INVOICE}`]);
  });

  it('faktura w EUR: kwoty z kodem waluty, bez „zł” (częściowa i pełna)', async () => {
    m.invoice = { ...m.invoice, currency: 'EUR' };
    await runCancelRemindersOnPayment({ invoiceId: INVOICE, paymentId: PAYMENT }, context);
    expect(plain(m.push.mock.calls[0]![2].body)).toBe('Wpłata częściowa: 300,00 EUR za FV/1/2026, zostało 230,00 EUR');
    m.invoice = { ...m.invoice, paid_amount: 1230 };
    m.payment = { amount: 1230, voided_at: null };
    await runCancelRemindersOnPayment({ invoiceId: INVOICE, paymentId: PAYMENT }, context);
    const body = plain(m.push.mock.calls[1]![2].body);
    expect(body).toBe('Otrzymana płatność: 1230,00 EUR za FV/1/2026 od Acme Sp. z o.o.');
    expect(body).not.toContain('zł');
  });

  it('wpłata cofnięta, zanim job ruszył: bez pusha', async () => {
    m.payment = { amount: 300, voided_at: '2026-11-09T10:00:00Z' };
    const result = await runCancelRemindersOnPayment({ invoiceId: INVOICE, paymentId: PAYMENT }, context);
    expect(m.push).not.toHaveBeenCalled();
    expect(result).toMatchObject({ push: { skipped: true, reason: 'payment-voided' } });
  });
});
