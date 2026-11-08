import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  alertCritical: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: mocks.captureException }));
vi.mock('@/lib/alerts/slack', () => ({ alertCritical: mocks.alertCritical }));
vi.mock('@/lib/cache', () => ({ cacheGet: mocks.cacheGet, cacheSet: mocks.cacheSet }));
vi.mock('@/lib/supabase/admin', () => ({
  // `rpc`: strażnik cyklu życia (PR 4b) pyta `ksef_lifecycle_violations()` — tu bez naruszeń.
  createAdminClient: () => ({ from: mocks.from, rpc: async () => ({ data: [], error: null }) }),
}));
vi.mock('@/lib/jobs/events', () => ({
  inngest: { createFunction: vi.fn() },
}));

import {
  checkStaleBillingVatEnqueues,
  checkKsefReconciliationAnomalies,
  runCriticalAlertsMonitor,
} from '@/lib/jobs/runners/critical-alerts-monitor';

interface InvoiceFixture {
  id: string;
  direction: 'incoming' | 'outgoing';
  ksef_status: string | null;
  ksef_number: string | null;
  last_error_code: string | null;
}

type InvoiceCountResult = { count: number | null; error: Error | null };

function invoiceCountQueries(
  rows: InvoiceFixture[],
  resultOverride?: (queryIndex: number) => InvoiceCountResult,
) {
  const queries: Array<{
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    not: ReturnType<typeof vi.fn>;
    or: ReturnType<typeof vi.fn>;
  }> = [];
  mocks.from.mockImplementation((table: string) => {
    if (table !== 'invoices') throw new Error(`Unexpected table: ${table}`);
    const queryIndex = queries.length;
    const filters: Array<(row: InvoiceFixture) => boolean> = [];
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      not: vi.fn(),
      or: vi.fn(),
      then: vi.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockImplementation((column: keyof InvoiceFixture, value: string) => {
      filters.push((row) => row[column] === value);
      return query;
    });
    query.not.mockImplementation((column: keyof InvoiceFixture, operator: string, value: null) => {
      if (operator !== 'is' || value !== null) throw new Error('Unexpected not filter');
      filters.push((row) => row[column] !== null);
      return query;
    });
    query.or.mockImplementation((expression: string) => {
      if (expression !== 'ksef_status.is.null,ksef_status.neq.accepted') {
        throw new Error(`Unexpected OR filter: ${expression}`);
      }
      filters.push((row) => row.ksef_status === null || row.ksef_status !== 'accepted');
      return query;
    });
    query.then.mockImplementation((resolve: (value: InvoiceCountResult) => void) =>
      Promise.resolve(resultOverride?.(queryIndex) ?? {
        count: rows.filter((row) => filters.every((filter) => filter(row))).length,
        error: null,
      }).then(resolve));
    queries.push(query);
    return query;
  });
  return queries;
}

function queryResult(count: number | null, error: Error | null = null) {
  const query = {
    select: vi.fn(),
    not: vi.fn(),
    is: vi.fn(),
    lt: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.not.mockReturnValue(query);
  query.is.mockReturnValue(query);
  query.lt.mockResolvedValue({ count, error });
  mocks.from.mockReturnValue(query);
  return query;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'));
  mocks.cacheGet.mockResolvedValue(null);
  mocks.cacheSet.mockResolvedValue(undefined);
  mocks.alertCritical.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('stale billing VAT enqueue alert', () => {
  it('counts VAT-linked payments older than 15 minutes using the invoice creation time', async () => {
    const query = queryResult(2);

    await expect(checkStaleBillingVatEnqueues()).resolves.toEqual({
      type: 'stale_billing_vat_enqueues', fired: true,
    });

    expect(mocks.from).toHaveBeenCalledExactlyOnceWith('stripe_payments');
    expect(query.select).toHaveBeenCalledExactlyOnceWith(
      'id, invoices!stripe_payments_vat_invoice_id_fkey!inner(created_at)',
      { count: 'exact', head: true },
    );
    expect(query.not).toHaveBeenCalledExactlyOnceWith('vat_invoice_id', 'is', null);
    expect(query.is).toHaveBeenCalledExactlyOnceWith('vat_invoice_submitted_at', null);
    expect(query.lt).toHaveBeenCalledExactlyOnceWith(
      'invoices.created_at', '2026-09-25T11:45:00.000Z',
    );
    expect(mocks.cacheSet).toHaveBeenCalledExactlyOnceWith(
      'alerts:critical:lastsent:stale_billing_vat_enqueues',
      '2026-09-25T12:00:00.000Z',
      30 * 60,
    );
    const alert = JSON.stringify(mocks.alertCritical.mock.calls[0]);
    expect(alert).toContain('kolejki i KSeF');
    expect(alert).toContain('nie wysyłaj zlecenia automatycznie ponownie');
    expect(alert).not.toContain('payment_id');
    expect(alert).not.toContain('invoice_id');
  });

  it('stays quiet with no stale links or an active dedup claim', async () => {
    queryResult(0);
    await expect(checkStaleBillingVatEnqueues()).resolves.toEqual({
      type: 'stale_billing_vat_enqueues', fired: false,
    });
    expect(mocks.cacheGet).not.toHaveBeenCalled();
    expect(mocks.alertCritical).not.toHaveBeenCalled();

    queryResult(1);
    mocks.cacheGet.mockResolvedValue('already-sent');
    await expect(checkStaleBillingVatEnqueues()).resolves.toEqual({
      type: 'stale_billing_vat_enqueues', fired: false, reason: 'dedup',
    });
    expect(mocks.alertCritical).not.toHaveBeenCalled();
  });

  it('fails closed when the count query errors or returns null', async () => {
    const failure = new Error('database unavailable');
    queryResult(null, failure);
    await expect(checkStaleBillingVatEnqueues()).rejects.toBe(failure);

    queryResult(null);
    await expect(checkStaleBillingVatEnqueues()).rejects.toThrow(
      'Stale billing VAT enqueue count unavailable',
    );
    expect(mocks.cacheGet).not.toHaveBeenCalled();
    expect(mocks.alertCritical).not.toHaveBeenCalled();
  });

  it('runs the VAT check in the shared monitor used by both job backends', async () => {
    const query = {
      select: vi.fn(), eq: vi.fn(), not: vi.fn(), is: vi.fn(),
      in: vi.fn(), gte: vi.fn(), lt: vi.fn(), order: vi.fn(),
      or: vi.fn(), limit: vi.fn(), maybeSingle: vi.fn(), then: vi.fn(),
    };
    for (const name of ['select', 'eq', 'not', 'is', 'in', 'gte', 'lt', 'or', 'limit', 'order'] as const) {
      query[name].mockReturnValue(query);
    }
    // Świeża kopia bazy — alarm o kopii ma milczeć (wcześniej test przechodził,
    // bo zapytanie o kopię padało na braku `limit` w atrapie).
    query.maybeSingle.mockResolvedValue({ data: { started_at: new Date().toISOString() }, error: null });
    query.then.mockImplementation((resolve: (value: unknown) => void) =>
      Promise.resolve({ count: 0, error: null, data: [] }).then(resolve));
    mocks.from.mockReturnValue(query);
    const step = {
      run: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
    } as unknown as JobContext['step'];

    const result = await runCriticalAlertsMonitor({ step } as JobContext);

    expect(step.run).toHaveBeenCalledWith('check-stale-billing-vat-enqueues', expect.any(Function));
    expect(step.run).toHaveBeenCalledWith('check-ksef-reconciliation', expect.any(Function));
    expect(step.run).toHaveBeenCalledWith('check-stale-ksef-sending-invoices', expect.any(Function));
    expect(step.run).toHaveBeenCalledWith('check-checkout-attempts', expect.any(Function));
    expect(step.run).toHaveBeenCalledWith('check-stale-backup', expect.any(Function));
    // 14 → 15: osierocone próby utworzenia klienta Stripe (#62, przeniesione 02.10).
    expect(step.run).toHaveBeenCalledWith('check-customer-attempts', expect.any(Function));
    // 13 → 14: płatność opłacona bez faktury VAT (AUD-40).
    expect(step.run).toHaveBeenCalledWith('check-paid-without-vat-invoice', expect.any(Function));
    // 15 → 16: kolejka offline w innym środowisku KSeF (#63 Codexa).
    expect(step.run).toHaveBeenCalledWith('check-offline-environment', expect.any(Function));
    // 16 → 17: faktura w `sending` bez wyniku po przejęciu wysyłki (#71).
    // 17 → 18: strażnik cyklu życia faktury I1–I9 (PR 4b, 03.10.2026).
    expect(step.run).toHaveBeenCalledWith('check-ksef-lifecycle', expect.any(Function));
    // 18 → 21: historia KSeF (stoi / do operatora / 429), decyzja Bartosza 22.10.2026.
    expect(step.run).toHaveBeenCalledWith('check-stale-ksef-history-sync', expect.any(Function));
    expect(step.run).toHaveBeenCalledWith('check-ksef-history-blocked', expect.any(Function));
    expect(step.run).toHaveBeenCalledWith('check-ksef-history-rate-limited', expect.any(Function));
    expect(result).toMatchObject({ checked: 21, fired: 0 });
    expect(result.details).toContainEqual({ type: 'offline_environment_blocked', fired: false });
  });
});

describe('KSeF reconciliation alert', () => {
  it('is quiet when there is nothing to reconcile', async () => {
    invoiceCountQueries([]);

    await expect(checkKsefReconciliationAnomalies()).resolves.toEqual({
      type: 'ksef_reconciliation', fired: false,
    });
    expect(mocks.alertCritical).not.toHaveBeenCalled();
    expect(mocks.cacheSet).not.toHaveBeenCalled();
  });

  it('counts outgoing invoices with a KSeF number and failed or legacy NULL status, plus held ROZ', async () => {
    const queries = invoiceCountQueries([
      { id: 'outgoing-failed', direction: 'outgoing', ksef_status: 'failed', ksef_number: 'KSEF-1', last_error_code: null },
      { id: 'outgoing-null', direction: 'outgoing', ksef_status: null, ksef_number: 'KSEF-2', last_error_code: null },
      { id: 'incoming-received', direction: 'incoming', ksef_status: 'received', ksef_number: 'KSEF-3', last_error_code: null },
      { id: 'outgoing-accepted', direction: 'outgoing', ksef_status: 'accepted', ksef_number: 'KSEF-4', last_error_code: null },
      { id: 'held-roz', direction: 'outgoing', ksef_status: 'failed', ksef_number: null, last_error_code: 'ROZ_HOLD_RECONCILE' },
      { id: 'both-signals', direction: 'outgoing', ksef_status: 'failed', ksef_number: 'KSEF-5', last_error_code: 'ROZ_HOLD_RECONCILE' },
    ]);

    await expect(checkKsefReconciliationAnomalies()).resolves.toEqual({
      type: 'ksef_reconciliation', fired: true,
    });
    expect(mocks.from).toHaveBeenCalledTimes(2);
    for (const query of queries) {
      expect(query.select).toHaveBeenCalledExactlyOnceWith('id', { count: 'exact', head: true });
    }
    expect(queries.some((query) =>
      query.eq.mock.calls.some(([column, value]) => column === 'direction' && value === 'outgoing') &&
      query.not.mock.calls.some(([column, operator, value]) => column === 'ksef_number' && operator === 'is' && value === null) &&
      query.or.mock.calls.some(([expression]) => expression === 'ksef_status.is.null,ksef_status.neq.accepted'),
    )).toBe(true);
    expect(queries.some((query) =>
      query.eq.mock.calls.some(([column, value]) => column === 'last_error_code' && value === 'ROZ_HOLD_RECONCILE'),
    )).toBe(true);
    expect(mocks.alertCritical).toHaveBeenCalledOnce();
    const alert = mocks.alertCritical.mock.calls[0];
    expect(alert?.[2]?.fields.map((field: { value: string }) => field.value))
      .toEqual(['3', '2']);
    const serialized = JSON.stringify(alert);
    expect(serialized).toMatch(/ręczn/i);
    expect(serialized).not.toContain('outgoing-failed');
    expect(serialized).not.toContain('KSEF-1');
    expect(mocks.cacheSet).toHaveBeenCalledOnce();
  });

  it('does not send again while the delivered alert is deduplicated', async () => {
    invoiceCountQueries([{ id: 'held', direction: 'outgoing', ksef_status: 'failed', ksef_number: null, last_error_code: 'ROZ_HOLD_RECONCILE' }]);
    mocks.cacheGet.mockResolvedValue('already-delivered');

    await expect(checkKsefReconciliationAnomalies()).resolves.toEqual({
      type: 'ksef_reconciliation', fired: false, reason: 'dedup',
    });
    expect(mocks.alertCritical).not.toHaveBeenCalled();
    expect(mocks.cacheSet).not.toHaveBeenCalled();
  });

  it('alerts immediately when a second anomaly category appears', async () => {
    const delivered = new Set<string>();
    mocks.cacheGet.mockImplementation(async (key: string) => delivered.has(key) ? 'sent' : null);
    mocks.cacheSet.mockImplementation(async (key: string) => { delivered.add(key); });
    invoiceCountQueries([{ id: 'held', direction: 'outgoing', ksef_status: 'failed', ksef_number: null, last_error_code: 'ROZ_HOLD_RECONCILE' }]);

    await expect(checkKsefReconciliationAnomalies()).resolves.toMatchObject({ fired: true });
    invoiceCountQueries([{ id: 'held-with-number', direction: 'outgoing', ksef_status: 'failed', ksef_number: 'KSEF-1', last_error_code: 'ROZ_HOLD_RECONCILE' }]);
    await expect(checkKsefReconciliationAnomalies()).resolves.toMatchObject({ fired: true });

    expect(mocks.alertCritical).toHaveBeenCalledTimes(2);
    expect([...delivered]).toEqual([
      'alerts:critical:lastsent:ksef_reconciliation:none:roz',
      'alerts:critical:lastsent:ksef_reconciliation:number:roz',
    ]);
  });

  it.each([0, 1])('does not treat failed database count %i as a clean state', async (failingIndex) => {
    const failure = new Error('database unavailable');
    invoiceCountQueries([], (index) => index === failingIndex
      ? { count: null, error: failure }
      : { count: 0, error: null });

    await expect(checkKsefReconciliationAnomalies()).rejects.toBe(failure);
    expect(mocks.alertCritical).not.toHaveBeenCalled();
    expect(mocks.cacheSet).not.toHaveBeenCalled();
  });

  it('deduplicates only after Slack confirms delivery', async () => {
    invoiceCountQueries([{ id: 'held', direction: 'outgoing', ksef_status: 'failed', ksef_number: null, last_error_code: 'ROZ_HOLD_RECONCILE' }]);
    mocks.alertCritical.mockRejectedValueOnce(new Error('Slack delivery unconfirmed'));

    await expect(checkKsefReconciliationAnomalies()).rejects.toThrow('Slack delivery unconfirmed');
    expect(mocks.cacheSet).not.toHaveBeenCalled();

    await expect(checkKsefReconciliationAnomalies()).resolves.toMatchObject({ fired: true });
    expect(mocks.alertCritical).toHaveBeenCalledTimes(2);
    expect(mocks.cacheSet).toHaveBeenCalledOnce();
  });
});
