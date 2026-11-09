import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobContext } from '@/lib/jobs/registry';

/**
 * C-16 (00145) — anulowanie przypomnień po wpłacie musi liczyć „zapłacona
 * w całości" od `payment_data.amountDue` (ROZ), nie od `gross_total`.
 * Inaczej ROZ z rozliczoną zaliczką nigdy nie odwołałaby swoich przypomnień,
 * choć klient wpłacił już wszystko, czego ta faktura jeszcze żądała.
 */

const store = vi.hoisted(() => ({
  invoice: null as Record<string, unknown> | null,
  reminders: [] as Array<{ id: string; invoice_id: string; status: string }>,
  pushCalls: 0,
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === 'invoices') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: store.invoice, error: null }),
            }),
          }),
        };
      }
      if (table === 'payment_reminders') {
        return {
          update: (patch: Record<string, unknown>) => ({
            eq: () => ({
              eq: () => ({
                select: async () => {
                  const cancelled = store.reminders.filter((r) => r.status === 'pending');
                  for (const r of cancelled) Object.assign(r, patch);
                  return { data: cancelled.map((r) => ({ id: r.id })), error: null };
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

vi.mock('@/lib/push/sender', () => ({
  sendPushToTenant: vi.fn(async () => {
    store.pushCalls++;
    return { sent: 1, failed: 0 };
  }),
}));

import { runCancelRemindersOnPayment } from '@/lib/jobs/runners/cancel-reminders-on-payment';

const context: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_name, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

beforeEach(() => {
  store.invoice = null;
  store.reminders = [];
  store.pushCalls = 0;
});

describe('runCancelRemindersOnPayment', () => {
  it('regular/ZAL: odwołuje tylko gdy paid >= gross_total, jak dotąd', async () => {
    store.invoice = {
      paid_amount: 4300, gross_total: 4300, tenant_id: 'ten-1', internal_number: 'FV/1',
      invoice_kind: 'regular', payment_data: null,
    };
    store.reminders = [{ id: 'r1', invoice_id: 'A', status: 'pending' }];

    const result = await runCancelRemindersOnPayment({ invoiceId: 'A' }, context);

    expect(result).toMatchObject({ cancelled: 1 });
    expect(store.reminders[0]!.status).toBe('cancelled');
  });

  it('regular: wpłata częściowa (paid < gross_total) nie odwołuje', async () => {
    store.invoice = {
      paid_amount: 1000, gross_total: 4300, tenant_id: 'ten-1', internal_number: 'FV/1',
      invoice_kind: 'regular', payment_data: null,
    };
    store.reminders = [{ id: 'r1', invoice_id: 'A', status: 'pending' }];

    const result = await runCancelRemindersOnPayment({ invoiceId: 'A' }, context);

    // Wpłata częściowa: nic nie anulowane (push idzie osobno, gdy zdarzenie ma paymentId).
    expect(result).toMatchObject({ cancelled: 0 });
    expect(store.reminders[0]!.status).toBe('pending');
  });

  it('ROZ: wpłata 9 840 odwołuje przypomnienia, choć gross_total (12 300) nie jest pokryte (C-16, 00145)', async () => {
    store.invoice = {
      paid_amount: 9840, gross_total: 12300, tenant_id: 'ten-1', internal_number: 'FV/ROZ-1',
      invoice_kind: 'final', payment_data: { amountDue: 9840 },
    };
    store.reminders = [{ id: 'r1', invoice_id: 'A', status: 'pending' }];

    const result = await runCancelRemindersOnPayment({ invoiceId: 'A' }, context);

    expect(result).toMatchObject({ cancelled: 1 });
    expect(store.reminders[0]!.status).toBe('cancelled');
  });

  it('ROZ: wpłata poniżej amountDue nie odwołuje, choćby już bliska gross_total', async () => {
    store.invoice = {
      // 9000 < amountDue (9840), choć znacznie więcej niż samo udziałowa zaliczka.
      paid_amount: 9000, gross_total: 12300, tenant_id: 'ten-1', internal_number: 'FV/ROZ-1',
      invoice_kind: 'final', payment_data: { amountDue: 9840 },
    };
    store.reminders = [{ id: 'r1', invoice_id: 'A', status: 'pending' }];

    const result = await runCancelRemindersOnPayment({ invoiceId: 'A' }, context);

    // Wpłata częściowa: nic nie anulowane (push idzie osobno, gdy zdarzenie ma paymentId).
    expect(result).toMatchObject({ cancelled: 0 });
    expect(store.reminders[0]!.status).toBe('pending');
  });

  it('ROZ: amountDue zepsute/brakujące liczy fail-safe od gross_total (zgodnie z amountDueOf)', async () => {
    store.invoice = {
      paid_amount: 9840, gross_total: 12300, tenant_id: 'ten-1', internal_number: 'FV/ROZ-1',
      invoice_kind: 'final', payment_data: { amountDue: 'zepsute' },
    };
    store.reminders = [{ id: 'r1', invoice_id: 'A', status: 'pending' }];

    const result = await runCancelRemindersOnPayment({ invoiceId: 'A' }, context);

    // Fail-safe → due = gross_total (12300); 9840 < 12300, więc nie odwołujemy.
    // Wpłata częściowa: nic nie anulowane (push idzie osobno, gdy zdarzenie ma paymentId).
    expect(result).toMatchObject({ cancelled: 0 });
    expect(store.reminders[0]!.status).toBe('pending');
  });
});
