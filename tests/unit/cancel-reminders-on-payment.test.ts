import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobContext } from '@/lib/jobs/registry';

/**
 * Krok 8.1, wariant „sam push”: job tylko powiadamia. Anulowanie przypomnień
 * po pełnej zapłacie robią funkcje bazy (00158, 00176), a wiersz `pending`
 * jest sygnałem watchdoga przypomnień, więc runner NIE dotyka
 * `payment_reminders` (atrapa rzuca na każdy dostęp do tej tabeli).
 * „Zapłacona w całości” liczy się od `payment_data.amountDue` (C-16, 00145).
 */

const store = vi.hoisted(() => ({
  invoice: null as Record<string, unknown> | null,
  payment: null as Record<string, unknown> | null,
  pushes: [] as Array<{ tenantId: string; payload: Record<string, unknown> }>,
  tables: [] as string[],
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      store.tables.push(table);
      if (table === 'invoices') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: store.invoice, error: null }) }) }) };
      }
      if (table === 'payments') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: store.payment, error: null }) }) }) };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

vi.mock('@/lib/push/sender', () => ({
  sendPushToTenant: vi.fn(async (tenantId: string, _kind: string, payload: Record<string, unknown>) => {
    store.pushes.push({ tenantId, payload });
    return { sent: 1, failed: 0 };
  }),
}));

import { runCancelRemindersOnPayment } from '@/lib/jobs/runners/cancel-reminders-on-payment';

const context: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_name, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

const event = { invoiceId: 'A', paymentId: 'pay-1' };

beforeEach(() => {
  store.invoice = null;
  store.payment = { amount: 100, voided_at: null };
  store.pushes = [];
  store.tables = [];
});

describe('runCancelRemindersOnPayment (sam push)', () => {
  it('pełna zapłata: push „Otrzymana płatność”, bez dotykania payment_reminders', async () => {
    store.invoice = {
      paid_amount: 4300, gross_total: 4300, tenant_id: 'ten-1', internal_number: 'FV/1',
      invoice_kind: 'regular', payment_data: null, buyer_data: { name: 'Acme' },
    };
    await runCancelRemindersOnPayment(event, context);

    expect(store.pushes).toHaveLength(1);
    expect(store.pushes[0]!.payload).toMatchObject({ title: 'Otrzymana płatność', tag: 'payment-pay-1' });
    expect(store.tables).not.toContain('payment_reminders');
  });

  it('wpłata częściowa: push „Wpłata częściowa”, bez dotykania payment_reminders', async () => {
    store.invoice = {
      paid_amount: 1000, gross_total: 4300, tenant_id: 'ten-1', internal_number: 'FV/1',
      invoice_kind: 'regular', payment_data: null, buyer_data: null,
    };
    await runCancelRemindersOnPayment(event, context);

    expect(store.pushes[0]!.payload).toMatchObject({ title: 'Wpłata częściowa' });
    expect(store.tables).not.toContain('payment_reminders');
  });

  it('ROZ: wpłata równa amountDue to pełna zapłata (C-16)', async () => {
    store.invoice = {
      paid_amount: 9840, gross_total: 12300, tenant_id: 'ten-1', internal_number: 'FV/ROZ-1',
      invoice_kind: 'final', payment_data: { amountDue: 9840 }, buyer_data: null,
    };
    await runCancelRemindersOnPayment(event, context);
    expect(store.pushes[0]!.payload).toMatchObject({ title: 'Otrzymana płatność' });
  });

  it('ROZ: amountDue zepsute liczy fail-safe od gross_total, więc wpłata częściowa', async () => {
    store.invoice = {
      paid_amount: 9840, gross_total: 12300, tenant_id: 'ten-1', internal_number: 'FV/ROZ-1',
      invoice_kind: 'final', payment_data: { amountDue: 'zepsute' }, buyer_data: null,
    };
    await runCancelRemindersOnPayment(event, context);
    expect(store.pushes[0]!.payload).toMatchObject({ title: 'Wpłata częściowa' });
  });

  it('ponowienie: drugie wykonanie wysyła push z tym samym tagiem (przeglądarka go zastępuje)', async () => {
    store.invoice = {
      paid_amount: 4300, gross_total: 4300, tenant_id: 'ten-1', internal_number: 'FV/1',
      invoice_kind: 'regular', payment_data: null, buyer_data: null,
    };
    await runCancelRemindersOnPayment(event, context);
    await runCancelRemindersOnPayment(event, context);

    expect(store.pushes).toHaveLength(2);
    expect(store.pushes[1]!.payload.tag).toBe(store.pushes[0]!.payload.tag);
    expect(store.tables).not.toContain('payment_reminders');
  });

  it('wpłata cofnięta: bez pusha', async () => {
    store.invoice = {
      paid_amount: 4300, gross_total: 4300, tenant_id: 'ten-1', internal_number: 'FV/1',
      invoice_kind: 'regular', payment_data: null, buyer_data: null,
    };
    store.payment = { amount: 4300, voided_at: '2026-11-10T10:00:00Z' };
    await runCancelRemindersOnPayment(event, context);
    expect(store.pushes).toHaveLength(0);
  });
});
