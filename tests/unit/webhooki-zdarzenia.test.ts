import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * Krok 7.1, część 3: skąd biorą się zdarzenia webhooków. Prawdziwe miejsca,
 * w których te rzeczy się dzieją, zlecają job `webhooks/event.emitted`
 * (atrapa tylko kolejki pg-boss, bazy i flag):
 *
 * - nowa faktura kosztowa ze skrzynki KSeF: job `auto-categorize-inbox` po
 *   utworzeniu kosztu (także gdy koszt już był: ponowienie po awarii),
 * - wpłata zapisana: akcja „Zapłacone” po zapisie wpłaty,
 * - faktura przyjęta w KSeF: zdarzenie `invoice/submit.succeeded` ma trzecią
 *   kolejkę (`tests/unit/webhooki-dostawy.test.ts`, `jobs-foundation.test.ts`).
 *
 * Zlecenie jest „fail-open”: awaria kolejki nie cofa kosztu ani wpłaty.
 * Przy wyłączonej fladze `publicApiEnabled` nic się nie zleca.
 */

type Row = Record<string, unknown>;

const m = vi.hoisted(() => ({
  send: vi.fn(),
  flag: vi.fn(),
  rpc: vi.fn(),
  requireOrgRole: vi.fn(),
  existingExpense: null as Row | null,
  inserts: [] as Row[],
}));

vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: m.send, sendJobEvents: m.send }));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlag: m.flag, getGlobalFlagForExecution: m.flag }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  return { ActionAuthError, requireOrgRole: m.requireOrgRole };
});
vi.mock('@/lib/ksef/inbox-xml', () => ({ archiveInboxInvoiceXml: async () => ({ archived: false, reason: 'not-applicable' }) }));
vi.mock('@/lib/ksef/inbox-pending', () => ({
  INBOX_PENDING_FLAG: '_pendingFullFetch',
  fa3Record: (value: unknown) => (value && typeof value === 'object' ? value : {}),
  markInboxInvoiceProcessed: vi.fn(async () => undefined),
}));
vi.mock('@/lib/categorization', () => ({
  categorizeExpense: async () => ({ kpir_column: 'k13_other_expenses', category_label: 'Usługi', method: 'rule', confidence: 0.95 }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let insertRow: Row | null = null;
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        limit: () => q,
        insert: (r: Row) => { insertRow = r; m.inserts.push(r); return q; },
        single: async () => {
          if (table === 'invoices') {
            return {
              data: {
                id: INVOICE, tenant_id: TENANT, direction: 'incoming', ksef_number: '5260001246-20260925-000000000001-00',
                internal_number: 'FV 1/2026', issue_date: '2026-09-25', seller_data: { name: 'Dostawca', nip: '5260001246' },
                seller_nip: '5260001246', gross_total: 123, net_total: 100, vat_total: 23, currency: 'PLN', fa3_data: {},
                invoice_line_items: [],
              },
              error: null,
            };
          }
          return { data: insertRow ? { id: 'exp-1' } : null, error: null };
        },
        maybeSingle: async () => {
          if (table === 'invoices') {
            return {
              data: {
                id: INVOICE, tenant_id: TENANT, fa3_data: { _pendingFullFetch: true },
                expenses: m.existingExpense ? [m.existingExpense] : [],
              },
              error: null,
            };
          }
          if (table === 'expenses') return { data: m.existingExpense, error: null };
          if (table === 'memberships') return { data: { user_id: 'u-1' }, error: null };
          return { data: null, error: null };
        },
      });
      return q;
    },
  }),
}));

const INVOICE = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAYMENT = '33333333-3333-4333-8333-333333333333';

const { emitWebhookEvent } = await import('@/lib/webhooks/emit');
const { markInvoicePaidAction } = await import('@/app/actions/invoice-payments');
const { runAutoCategorizeInbox } = await import('@/lib/jobs/runners/auto-categorize-inbox');

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

const webhookEvents = () => m.send.mock.calls
  .map(([event]) => event as { name: string; data: Row })
  .filter((event) => event.name === 'webhooks/event.emitted');

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  m.flag.mockResolvedValue(true);
  m.send.mockResolvedValue({ ids: ['job-1'] });
  m.existingExpense = null;
  m.inserts = [];
  m.requireOrgRole.mockResolvedValue({ supabase: { rpc: m.rpc }, tenantId: TENANT, user: { id: 'u-1' }, role: 'member' });
});
afterEach(() => vi.unstubAllEnvs());

describe('emitWebhookEvent', () => {
  it('flaga włączona: jedno zlecenie webhooks/event.emitted z firmą, typem i obiektem', async () => {
    await emitWebhookEvent({ tenantId: TENANT, type: 'payment.recorded', entityId: PAYMENT });
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.send).toHaveBeenCalledWith({
      name: 'webhooks/event.emitted',
      data: { tenantId: TENANT, type: 'payment.recorded', entityId: PAYMENT },
    });
  });

  it('flaga wyłączona: nic się nie zleca', async () => {
    m.flag.mockResolvedValue(false);
    await emitWebhookEvent({ tenantId: TENANT, type: 'payment.recorded', entityId: PAYMENT });
    expect(m.send).not.toHaveBeenCalled();
  });

  it('awaria kolejki: bez wyjątku (zdarzenie aplikacji jest ważniejsze niż webhook)', async () => {
    m.send.mockRejectedValue(new Error('Queue webhooks.event.emitted does not exist'));
    await expect(emitWebhookEvent({ tenantId: TENANT, type: 'payment.recorded', entityId: PAYMENT })).resolves.toBeUndefined();
  });
});

describe('wpłata zapisana: akcja „Zapłacone”', () => {
  it('nowa wpłata: zlecenie payment.recorded z identyfikatorem wpłaty z bazy', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'marked', amount: 1230, paid_on: '2026-11-11', payment_id: PAYMENT, internal_number: 'FV/1' }, error: null });
    const result = await markInvoicePaidAction(INVOICE);
    expect(result.success).toBe(true);
    expect(webhookEvents()).toEqual([{ name: 'webhooks/event.emitted', data: { tenantId: TENANT, type: 'payment.recorded', entityId: PAYMENT } }]);
  });

  it('„już zapłacona” albo odmowa: bez zlecenia', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'already_paid', internal_number: 'FV/1' }, error: null });
    await markInvoicePaidAction(INVOICE);
    m.rpc.mockResolvedValue({ data: { status: 'refused', code: 'not_accepted', internal_number: 'FV/1' }, error: null });
    await markInvoicePaidAction(INVOICE);
    expect(webhookEvents()).toEqual([]);
  });

  it('awaria kolejki nie zmienia wyniku akcji: wpłata jest zapisana', async () => {
    m.send.mockRejectedValue(new Error('connection refused'));
    m.rpc.mockResolvedValue({ data: { status: 'marked', amount: 10, paid_on: '2026-11-11', payment_id: PAYMENT }, error: null });
    await expect(markInvoicePaidAction(INVOICE)).resolves.toMatchObject({ success: true, status: 'marked' });
  });
});

describe('nowa faktura kosztowa ze skrzynki: job auto-categorize-inbox', () => {
  const DANE = { invoiceId: INVOICE, tenantId: TENANT, environment: 'test' as const };

  it('po utworzeniu kosztu: zlecenie expense.ksef_received dla faktury ze skrzynki', async () => {
    await runAutoCategorizeInbox(DANE, ctx);
    expect(m.inserts).toHaveLength(1);
    expect(webhookEvents()).toEqual([{ name: 'webhooks/event.emitted', data: { tenantId: TENANT, type: 'expense.ksef_received', entityId: INVOICE } }]);
  });

  it('koszt już był (ponowienie po awarii między zapisem a zleceniem): zlecenie jeszcze raz, dostawę deduplikuje baza', async () => {
    m.existingExpense = { id: 'exp-0' };
    await runAutoCategorizeInbox(DANE, ctx);
    expect(m.inserts).toEqual([]);
    expect(webhookEvents()).toEqual([{ name: 'webhooks/event.emitted', data: { tenantId: TENANT, type: 'expense.ksef_received', entityId: INVOICE } }]);
  });

  it('flaga wyłączona: koszt powstaje, zlecenia nie ma', async () => {
    m.flag.mockResolvedValue(false);
    await runAutoCategorizeInbox(DANE, ctx);
    expect(m.inserts).toHaveLength(1);
    expect(webhookEvents()).toEqual([]);
  });

  it('awaria kolejki nie wywraca joba: koszt zostaje', async () => {
    m.send.mockRejectedValue(new Error('connection refused'));
    await expect(runAutoCategorizeInbox(DANE, ctx)).resolves.toMatchObject({ success: true });
    expect(m.inserts).toHaveLength(1);
  });
});
