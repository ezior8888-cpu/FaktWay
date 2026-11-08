import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

const mocks = vi.hoisted(() => ({
  accepted: vi.fn(),
  failed: vi.fn(),
}));

vi.mock('@/lib/email/send', () => ({
  sendInvoiceAcceptedEmail: mocks.accepted,
  sendInvoiceFailedEmail: mocks.failed,
}));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn(async () => undefined) }));
vi.mock('@/lib/supabase/admin-queries', () => ({
  readTenantOwnerContact: async () => ({ ownerUserId: null, email: 'wlasciciel@example.test' }),
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToUser: vi.fn() }));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    const q: Record<string, unknown> = {};
    Object.assign(q, {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({
        data: { internal_number: 'FV/1', ksef_status: 'rejected', ksef_number: null, last_error_code: '450', updated_at: '2026-10-02T08:00:00Z' },
        error: null,
      }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ count: 1, error: null }).then(ok),
    });
    return { from: () => q };
  },
}));

import { runNotifyFailure, runNotifySuccess } from '@/lib/jobs/runners/notify-user';

/**
 * AUD-86, strona zadania: klucz zależy od zdarzenia, nie od próby —
 * ponowienie wysyła z tym samym kluczem, więc Resend odrzuca dubel.
 */

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVOICE = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  mocks.accepted.mockReset().mockResolvedValue({ sent: true });
  mocks.failed.mockReset().mockResolvedValue({ sent: true });
});

describe('powiadomienia o wysyłce faktury — klucz idempotencji', () => {
  it('przyjęta: klucz z numeru faktury, ten sam przy ponowieniu', async () => {
    const data = { tenantId: TENANT, invoiceId: INVOICE, environment: 'test' as const, ksefNumber: '1234567890-20261002-0100001AF629-AF' };
    await runNotifySuccess(data, ctx);
    await runNotifySuccess(data, { ...ctx, attempt: 1 });

    const keys = mocks.accepted.mock.calls.map((c) => (c[2] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual([`invoice-accepted/${INVOICE}`, `invoice-accepted/${INVOICE}`]);
  });

  it('odrzucona: ten sam błąd — ten sam klucz; inny błąd — inny klucz', async () => {
    await runNotifyFailure({ tenantId: TENANT, invoiceId: INVOICE, environment: 'test' as const, error: 'Błąd 450: niepoprawny NIP' }, ctx);
    await runNotifyFailure({ tenantId: TENANT, invoiceId: INVOICE, environment: 'test' as const, error: 'Błąd 450: niepoprawny NIP' }, { ...ctx, attempt: 1 });
    await runNotifyFailure({ tenantId: TENANT, invoiceId: INVOICE, environment: 'test' as const, error: 'Błąd 440: duplikat' }, ctx);

    const keys = mocks.failed.mock.calls.map((c) => (c[2] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toMatch(new RegExp(`^invoice-failed/${INVOICE}/[0-9a-f]{16}$`));
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});
