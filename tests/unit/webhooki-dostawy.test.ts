import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * Krok 7.1, część 3: joby webhooków na prawdziwej ścieżce (runner → RPC →
 * próba dostawy), z atrapą bazy (RPC i odczyty), DNS i HTTP.
 *
 * Stan dostaw (jedna dostawa na webhook i zdarzenie, harmonogram ponowień,
 * wyłączenie po 20 nieudanych dostawach z rzędu) trzyma baza: funkcje z 00187
 * sprawdza `tests/rls-webhooki.test.ts` na prawdziwym PostgREST. Tu: że joby
 * wołają je z właściwymi danymi, nie wysyłają nic przy wyłączonej fladze
 * i nie wysyłają drugi raz zdarzenia, które ma już dostawę.
 */

type Row = Record<string, unknown>;

const m = vi.hoisted(() => ({
  flag: vi.fn(),
  resolve: vi.fn(),
  transport: vi.fn(),
  rpc: vi.fn(),
  tables: {} as Record<string, Row[]>,
  reads: [] as Array<{ table: string; select: string; filters: Array<[string, string, unknown]> }>,
}));

vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlag: m.flag, getGlobalFlagForExecution: m.flag }));
vi.mock('@/lib/webhooks/network', () => ({ resolveHost: m.resolve, httpsTransport: m.transport }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: m.rpc,
    from(table: string) {
      const read = { table, select: '', filters: [] as Array<[string, string, unknown]> };
      m.reads.push(read);
      const matches = () => (m.tables[table] ?? []).filter((row) => read.filters.every(([op, column, value]) => {
        if (op === 'eq') return row[column] === value;
        if (op === 'is') return row[column] === value;
        if (op === 'contains') return Array.isArray(row[column]) && (value as unknown[]).every((v) => (row[column] as unknown[]).includes(v));
        return true;
      }));
      const builder: Record<string, unknown> = {
        select(columns: string) { read.select = columns; return builder; },
        eq(column: string, value: unknown) { read.filters.push(['eq', column, value]); return builder; },
        is(column: string, value: unknown) { read.filters.push(['is', column, value]); return builder; },
        contains(column: string, value: unknown) { read.filters.push(['contains', column, value]); return builder; },
        limit() { return builder; },
        async maybeSingle() { return { data: matches()[0] ?? null, error: null }; },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          return Promise.resolve({ data: matches(), error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  }),
}));

const { runWebhookDeliveryTick, runWebhookEventFanOut } = await import('@/lib/jobs/runners/webhooks');
await import('@/lib/jobs/handlers/webhooks');
const { getRegisteredJobs } = await import('@/lib/jobs/registry');
const { encryptWebhookSecret } = await import('@/lib/webhooks/secret-box');
const { webhookEventId } = await import('@/lib/webhooks/event-id');
const { WEBHOOK_DISABLE_AFTER_FAILURES, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_SECONDS } = await import('@/lib/webhooks/types');

const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001';
const WEBHOOK = 'bbbbbbbb-0000-4000-8000-000000000002';
const INVOICE = '11111111-1111-4111-8111-111111111111';
const PAYMENT = '33333333-3333-4333-8333-333333333333';
const TEST_SIGNING_VALUE = `fwws_${'d'.repeat(43)}`;

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

function claimed(overrides: Row = {}): Row {
  return {
    delivery_id: 'dddddddd-0000-4000-8000-000000000003',
    tenant_id: TENANT,
    webhook_id: WEBHOOK,
    url: 'https://hooks.example.com/faktway',
    secret_ciphertext: encryptWebhookSecret(TEST_SIGNING_VALUE, { tenantId: TENANT, webhookId: WEBHOOK }),
    event_id: webhookEventId('invoice.ksef_accepted', INVOICE),
    event_type: 'invoice.ksef_accepted',
    occurred_at: '2026-11-11T09:30:00+00:00',
    data: { invoice: { id: INVOICE } },
    attempt: 1,
    ...overrides,
  };
}

/** RPC: przejęcie zwraca listę, zapis wyniku i utworzenie dostaw jak baza. */
function rpcHandlers(overrides: Partial<Record<string, (args: Row) => unknown>> = {}) {
  const handlers: Record<string, (args: Row) => unknown> = {
    webhook_claim_deliveries: () => [claimed()],
    webhook_record_attempt: () => ({ applied: true, status: 'succeeded' }),
    webhook_create_deliveries: () => ['dddddddd-0000-4000-8000-000000000003'],
    ...overrides,
  };
  m.rpc.mockImplementation(async (name: string, args: Row) => {
    const handler = handlers[name];
    if (!handler) return { data: null, error: { message: `nieznana funkcja ${name}` } };
    return { data: handler(args), error: null };
  });
}

const rpcCalls = (name: string) => m.rpc.mock.calls.filter(([n]) => n === name).map(([, args]) => args as Row);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('WEBHOOK_SECRETS_ENCRYPTION_KEY', 'k'.repeat(44));
  m.flag.mockResolvedValue(true);
  m.resolve.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  m.transport.mockResolvedValue({ status: 200 });
  m.reads.length = 0;
  m.tables = {
    webhook_endpoints: [{ id: WEBHOOK, tenant_id: TENANT, disabled_at: null, events: ['invoice.ksef_accepted', 'payment.recorded', 'expense.ksef_received'] }],
    invoices: [{
      id: INVOICE, tenant_id: TENANT, direction: 'outgoing', internal_number: 'FV/1/11/2026', invoice_kind: 'regular',
      issue_date: '2026-11-11', currency: 'PLN', net_total: '1000.00', vat_total: '230.00', gross_total: '1230.00',
      paid_amount: '1230.00', payment_status: 'paid',
      ksef_status: 'accepted', ksef_number: '1234567890-20261111-ABCDEF-12', ksef_accepted_at: '2026-11-11T09:30:00+00:00',
      ksef_environment: 'test', updated_at: '2026-11-11T09:31:00+00:00',
      // Pola, których zdarzenie NIE może zawierać:
      buyer_nip: '1234567890', buyer_name: 'Jan Kowalski', seller_name: 'Firma', notes: 'uwaga',
    }],
    payments: [{
      id: PAYMENT, tenant_id: TENANT, invoice_id: INVOICE, amount: '1230.00', payment_date: '2026-11-11',
      payment_method: 'other', match_method: 'manual', bank_import_id: null, created_at: '2026-11-11T10:00:00+00:00',
      bank_payer_name: 'Jan Kowalski', bank_payer_account: 'PL61109010140000071219812874',
    }],
    expenses: [],
  };
  rpcHandlers();
});

describe('cron.webhooks-deliver: należne dostawy', () => {
  it('flaga publicApiEnabled wyłączona: ani bazy, ani sieci', async () => {
    m.flag.mockResolvedValue(false);
    expect(await runWebhookDeliveryTick(ctx)).toMatchObject({ skipped: 'api_disabled' });
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.transport).not.toHaveBeenCalled();
    expect(m.resolve).not.toHaveBeenCalled();
  });

  it('sukces: przejęcie należnych, jedno żądanie, zapis wyniku z numerem próby i kodem', async () => {
    const summary = await runWebhookDeliveryTick(ctx);

    expect(rpcCalls('webhook_claim_deliveries')).toEqual([{ p_delivery_ids: null, p_limit: 30 }]);
    expect(m.transport).toHaveBeenCalledTimes(1);
    expect(rpcCalls('webhook_record_attempt')).toEqual([expect.objectContaining({
      p_delivery_id: 'dddddddd-0000-4000-8000-000000000003', p_attempt: 1, p_succeeded: true, p_status_code: 200,
      p_error: null, p_counts_toward_disable: true, p_duration_ms: expect.any(Number),
    })]);
    expect(summary).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
  });

  it('porażka: zapis z kodem odpowiedzi i rodzajem błędu (harmonogram ponowień liczy baza)', async () => {
    rpcHandlers({ webhook_claim_deliveries: () => [claimed({ attempt: 3 })], webhook_record_attempt: () => ({ applied: true, status: 'pending' }) });
    m.transport.mockResolvedValue({ status: 503 });

    const summary = await runWebhookDeliveryTick(ctx);

    expect(rpcCalls('webhook_record_attempt')).toEqual([expect.objectContaining({
      p_attempt: 3, p_succeeded: false, p_status_code: 503, p_error: 'http_status', p_counts_toward_disable: true,
    })]);
    expect(summary).toMatchObject({ claimed: 1, succeeded: 0, failed: 1 });
  });

  it('błąd po stronie FaktWay (brak klucza szyfrowania) nie liczy się do wyłączenia webhooka', async () => {
    const stored = claimed();
    rpcHandlers({ webhook_claim_deliveries: () => [stored] });
    vi.stubEnv('WEBHOOK_SECRETS_ENCRYPTION_KEY', '');
    await runWebhookDeliveryTick(ctx);
    expect(m.transport).not.toHaveBeenCalled();
    expect(rpcCalls('webhook_record_attempt')).toEqual([expect.objectContaining({
      p_succeeded: false, p_error: 'signing_unavailable', p_counts_toward_disable: false,
    })]);
  });

  it('przejęcie nieudane: job pada (następny przebieg za minutę), nic nie wysłane', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: 'connection reset' } });
    await expect(runWebhookDeliveryTick(ctx)).rejects.toThrow();
    expect(m.transport).not.toHaveBeenCalled();
  });

  it('zapis wyniku nieudany albo spóźniony (dzierżawa przejęta): bez wyjątku, reszta dostaw idzie dalej', async () => {
    const second = claimed({ delivery_id: 'dddddddd-0000-4000-8000-000000000004' });
    rpcHandlers({
      webhook_claim_deliveries: () => [claimed(), second],
      webhook_record_attempt: (args) => (args.p_delivery_id === second.delivery_id ? { applied: false } : null),
    });
    await expect(runWebhookDeliveryTick(ctx)).resolves.toMatchObject({ claimed: 2 });
    expect(m.transport).toHaveBeenCalledTimes(2);
  });
});

describe('webhooks.event.emitted: zdarzenie → dostawy → pierwsza próba', () => {
  it('flaga wyłączona: nic nie czyta i nic nie wysyła', async () => {
    m.flag.mockResolvedValue(false);
    expect(await runWebhookEventFanOut({ tenantId: TENANT, type: 'invoice.ksef_accepted', entityId: INVOICE }, ctx)).toMatchObject({ skipped: 'api_disabled' });
    expect(m.reads).toEqual([]);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.transport).not.toHaveBeenCalled();
  });

  it('firma bez webhooka na to zdarzenie: bez odczytu faktury i bez dostaw', async () => {
    m.tables.webhook_endpoints = [{ id: WEBHOOK, tenant_id: TENANT, disabled_at: null, events: ['payment.recorded'] }];
    expect(await runWebhookEventFanOut({ tenantId: TENANT, type: 'invoice.ksef_accepted', entityId: INVOICE }, ctx)).toMatchObject({ skipped: 'no_webhooks' });
    expect(m.reads.map((r) => r.table)).toEqual(['webhook_endpoints']);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('faktura przyjęta w KSeF: dane bez danych osobowych, stały identyfikator zdarzenia, dostawa i od razu próba', async () => {
    await runWebhookEventFanOut({ tenantId: TENANT, type: 'invoice.ksef_accepted', entityId: INVOICE }, ctx);

    const [create] = rpcCalls('webhook_create_deliveries');
    expect(create).toEqual({
      p_tenant_id: TENANT,
      p_event_type: 'invoice.ksef_accepted',
      p_event_id: webhookEventId('invoice.ksef_accepted', INVOICE),
      p_occurred_at: '2026-11-11T09:30:00+00:00',
      p_data: {
        invoice: {
          id: INVOICE, number: 'FV/1/11/2026', direction: 'outgoing', kind: 'regular', issue_date: '2026-11-11', currency: 'PLN',
          net_total: '1000.00', vat_total: '230.00', gross_total: '1230.00', ksef_status: 'accepted',
          ksef_number: '1234567890-20261111-ABCDEF-12', ksef_accepted_at: '2026-11-11T09:30:00+00:00', ksef_environment: 'test',
        },
      },
    });
    expect(JSON.stringify(create)).not.toMatch(/Kowalski|uwaga|buyer|seller|nip/i);
    // Odczyt faktury tylko w firmie zdarzenia.
    expect(m.reads.find((r) => r.table === 'invoices')?.filters).toEqual(expect.arrayContaining([['eq', 'tenant_id', TENANT], ['eq', 'id', INVOICE]]));
    expect(rpcCalls('webhook_claim_deliveries')).toEqual([{ p_delivery_ids: ['dddddddd-0000-4000-8000-000000000003'], p_limit: 1 }]);
    expect(m.transport).toHaveBeenCalledTimes(1);
  });

  it('to samo zdarzenie drugi raz (ponowienie joba, druga emisja): dostawa już jest, nic nie wychodzi', async () => {
    rpcHandlers({ webhook_create_deliveries: () => [] });
    await runWebhookEventFanOut({ tenantId: TENANT, type: 'invoice.ksef_accepted', entityId: INVOICE }, ctx);
    expect(rpcCalls('webhook_create_deliveries')).toHaveLength(1);
    expect(rpcCalls('webhook_claim_deliveries')).toEqual([]);
    expect(m.transport).not.toHaveBeenCalled();
  });

  it('faktura nieprzyjęta, zakupu albo z innej firmy: bez zdarzenia', async () => {
    for (const patch of [{ ksef_status: 'queued' }, { direction: 'incoming' }, { tenant_id: 'cccccccc-0000-4000-8000-000000000009' }, { ksef_number: null }]) {
      m.tables.invoices = [{ ...m.tables.invoices![0], ...patch }];
      m.rpc.mockClear();
      await runWebhookEventFanOut({ tenantId: TENANT, type: 'invoice.ksef_accepted', entityId: INVOICE }, ctx);
      expect(rpcCalls('webhook_create_deliveries'), JSON.stringify(patch)).toEqual([]);
    }
  });

  it('wpłata zapisana: kwota, dzień i stan faktury, bez danych płatnika', async () => {
    await runWebhookEventFanOut({ tenantId: TENANT, type: 'payment.recorded', entityId: PAYMENT }, ctx);
    const [create] = rpcCalls('webhook_create_deliveries');
    expect(create).toMatchObject({
      p_event_type: 'payment.recorded',
      p_event_id: webhookEventId('payment.recorded', PAYMENT),
      p_occurred_at: '2026-11-11T10:00:00+00:00',
      p_data: {
        payment: { id: PAYMENT, invoice_id: INVOICE, amount: '1230.00', currency: 'PLN', payment_date: '2026-11-11', method: 'other', source: 'manual' },
        invoice: { id: INVOICE, number: 'FV/1/11/2026', gross_total: '1230.00', paid_amount: '1230.00', payment_status: 'paid' },
      },
    });
    expect(JSON.stringify(create)).not.toMatch(/Kowalski|PL61|payer/i);
  });

  it('nowa faktura kosztowa ze skrzynki: kwoty w walucie jak karta kosztu, bez nazwy i NIP-u dostawcy', async () => {
    m.tables.invoices = [{ id: INVOICE, tenant_id: TENANT, direction: 'incoming', ksef_number: '9999999999-20261110-AAAAAA-01', currency: 'EUR' }];
    m.tables.expenses = [{
      id: 'eeeeeeee-0000-4000-8000-000000000005', tenant_id: TENANT, ksef_invoice_id: INVOICE, source: 'ksef_inbox',
      document_number: 'ZEW/7/2026', document_type: 'invoice', issue_date: '2026-11-10', net_amount: '100.00', vat_amount: '0.00',
      gross_amount: '100.00', is_reviewed: false, ocr_source: 'ksef_inbox', ocr_currency: 'EUR', ocr_fx: null,
      created_at: '2026-11-10T12:00:00+00:00', seller_name: 'Dostawca Jan Nowak', seller_nip: '1234567890',
    }];
    await runWebhookEventFanOut({ tenantId: TENANT, type: 'expense.ksef_received', entityId: INVOICE }, ctx);
    const [create] = rpcCalls('webhook_create_deliveries');
    expect(create).toMatchObject({
      p_event_type: 'expense.ksef_received',
      p_event_id: webhookEventId('expense.ksef_received', INVOICE),
      p_occurred_at: '2026-11-10T12:00:00+00:00',
      p_data: {
        expense: {
          id: 'eeeeeeee-0000-4000-8000-000000000005', document_number: 'ZEW/7/2026', document_type: 'invoice', issue_date: '2026-11-10',
          currency: 'EUR', net_amount: '100.00', vat_amount: '0.00', gross_amount: '100.00', review_status: 'unreviewed',
          source: 'ksef_inbox', invoice_id: INVOICE,
        },
        invoice: { id: INVOICE, ksef_number: '9999999999-20261110-AAAAAA-01' },
      },
    });
    expect(JSON.stringify(create)).not.toMatch(/Nowak|1234567890|seller/i);
  });

  it('błąd zapisu dostaw: job pada (ponowienie od zera jest bezpieczne, bo dostawa ma UNIQUE)', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: 'deadlock' } });
    await expect(runWebhookEventFanOut({ tenantId: TENANT, type: 'invoice.ksef_accepted', entityId: INVOICE }, ctx)).rejects.toThrow();
    expect(m.transport).not.toHaveBeenCalled();
  });
});

describe('faktura przyjęta w KSeF: trzecia kolejka zdarzenia invoice/submit.succeeded', () => {
  it('job invoice.submit.succeeded.webhook zamienia wynik wysyłki na zdarzenie invoice.ksef_accepted', async () => {
    const job = getRegisteredJobs().find((j) => j.queue === 'invoice.submit.succeeded.webhook');
    expect(job).toBeDefined();
    await job!.handler({ tenantId: TENANT, invoiceId: INVOICE, ksefNumber: '1234567890-20261111-ABCDEF-12', environment: 'test' } as never, ctx);
    expect(rpcCalls('webhook_create_deliveries')).toEqual([expect.objectContaining({
      p_tenant_id: TENANT, p_event_type: 'invoice.ksef_accepted', p_event_id: webhookEventId('invoice.ksef_accepted', INVOICE),
    })]);
  });

  it('zły kształt danych zdarzenia: walidacja na granicy kolejki', () => {
    const job = getRegisteredJobs().find((j) => j.queue === 'webhooks.event.emitted');
    expect(job?.schema?.safeParse({ tenantId: TENANT, type: 'invoice.deleted', entityId: INVOICE }).success).toBe(false);
    expect(job?.schema?.safeParse({ tenantId: 'x', type: 'payment.recorded', entityId: INVOICE }).success).toBe(false);
    expect(job?.schema?.safeParse({ tenantId: TENANT, type: 'payment.recorded', entityId: PAYMENT }).success).toBe(true);
  });
});

describe('harmonogram w kodzie i w bazie', () => {
  it('1 min, 5 min, 30 min, 2 h, 12 h, potem „nieudana” (6 prób); wyłączenie po 20 nieudanych dostawach z rzędu', () => {
    expect([...WEBHOOK_RETRY_DELAYS_SECONDS]).toEqual([60, 300, 1800, 7200, 43200]);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(6);
    expect(WEBHOOK_DISABLE_AFTER_FAILURES).toBe(20);
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/00187_webhooks.sql'), 'utf8');
    expect(sql).toContain("ARRAY['1 minute', '5 minutes', '30 minutes', '2 hours', '12 hours']::interval[]");
    expect(sql).toMatch(/attempts BETWEEN 0 AND 6/);
    expect(sql).toMatch(/consecutive_failures >= 20/);
  });
});
