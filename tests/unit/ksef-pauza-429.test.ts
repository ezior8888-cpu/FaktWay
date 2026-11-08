import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { KsefAuth } from '@/lib/ksef/auth';
import type { Invoice } from '@/types/invoice';

/**
 * L1a (plan „zero zgubionych faktur”, 08.11.2026): pauza firmy po 429.
 *
 * MF liczy limity na parę (NIP, adres IP), a cała platforma wysyła z jednego
 * adresu. Po 429 MF tymczasowo blokuje kolejne żądania, a powtórki wydłużają
 * blokadę (przy powtarzających się naruszeniach: zakres adresów IP, czyli
 * wszystkie firmy naraz). Do tej zmiany 429 nie zatrzymywał firmy: ponawiana
 * była tylko ta faktura (i zużywała zwykłą próbę), a kolejne zadania tej firmy
 * — wysyłka, UPO, skrzynka — dalej uderzały w limit.
 *
 * Atrapa KSeF to `fetch` (prawdziwy `ksefFetch`, kolejka per NIP, pamięć
 * sesji); zegar sztuczny. Runner wysyłki: atrapy tylko bazy i pełnego przebiegu
 * wysyłki (jak `ksef-uzgodnienie-runner.test.ts`).
 */

const NIP_A = '1234567890';
const NIP_B = '1234567891';
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const T0 = new Date('2026-11-09T09:00:00.000Z');

const m = vi.hoisted(() => ({
  fullFlow: vi.fn(),
  findOpen: vi.fn(),
  status: vi.fn(),
  rpc: vi.fn(),
  invoice: {} as Record<string, unknown>,
}));

vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: async () => false }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));
vi.mock('@/lib/auth/ksef-verification-guard', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/auth/ksef-verification-guard')>(),
  requireKsefVerificationForBackgroundJob: async () => undefined,
}));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: async () => ({ offline: false }) }));
vi.mock('@/lib/ksef/health-status', () => ({ isKsefHealthy: async () => true }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@/lib/ksef/submit-invoice-full', () => ({ submitInvoiceFullFlow: m.fullFlow }));
vi.mock('@/lib/ksef/submit-reference-boundary', () => ({ assertSubmitReferences: async () => 'regular' }));
vi.mock('@/lib/ksef/submit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ksef/submit')>(),
  checkInvoiceStatusByReference: m.status,
}));
vi.mock('@/lib/ksef/submission-log', () => ({
  findOpenKsefSubmissionIntents: vi.fn(async () => []),
  promoteKsefSubmissionIntent: vi.fn(async () => false),
  abandonKsefSubmissionIntent: vi.fn(),
  findKsefSessionRow: vi.fn(async () => null),
  findSubmissionPayloads: vi.fn(async () => []),
  findTenantInvoiceByKsefNumber: vi.fn(async () => null),
  findKsefNumberTaken: vi.fn(async () => null),
  closeKsefAttempt: vi.fn(),
  markKsefSubmissionsNumberTaken: vi.fn(),
  recordKsefDuplicateCheck: vi.fn(),
  recordKsefAcceptedSession: vi.fn(),
  markKsefAttemptDuplicatePending: vi.fn(),
  markKsefSubmission: vi.fn(),
  findOpenKsefSubmission: m.findOpen,
}));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn(), assertJobIdentity: vi.fn() }));
vi.mock('@/lib/supabase/admin-queries', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/supabase/admin-queries')>(),
  getTenantKsefCredentials: async (tenantId: string) =>
    ({ type: 'token', nip: tenantId === TENANT_B ? NIP_B : NIP_A, token: 't' }),
  updateInvoiceStatus: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: async () => {
    const q = {
      select: () => q, eq: () => q, in: () => q, or: () => q, update: () => q,
      maybeSingle: async () => ({ data: { ...m.invoice }, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return { from: () => q, rpc: m.rpc };
  },
}));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: vi.fn() }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@/lib/analytics/funnel', () => ({ recordFirstInvoiceAccepted: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));

import { decideRetry, MAX_WAIT_RETRIES } from '@/lib/jobs/retry';
import { KSEF_MAX_RETRIES, KSEF_TENANT_CONCURRENCY_LIMIT, getKsefRetryDelay } from '@/lib/jobs/retry-schedule';
import { parseDurationMs } from '@/lib/jobs/duration';
import { runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import { KsefApiError, ksefFetch } from '@/lib/ksef/client';
import { queryReceivedInvoices } from '@/lib/ksef/inbox';
import { ksefRateLimiter } from '@/lib/ksef/rate-limiter';
import { describeSendAttemptFailure } from '@/lib/ksef/send-attempt-ledger';
import { submitInvoice } from '@/lib/ksef/submit';
import { downloadUpoFromKsef } from '@/lib/ksef/upo-client';

const policy = { maxRetries: KSEF_MAX_RETRIES, getDelayMs: (a: number) => parseDurationMs(getKsefRetryDelay(a)) };
const authA = { type: 'token', nip: NIP_A, token: 't' } as KsefAuth;
const authB = { type: 'token', nip: NIP_B, token: 't' } as KsefAuth;

/** Atrapa KSeF: 429 z `Retry-After`, dopóki `limited`; potem 503 (byle nie 2xx). */
const atrapa = { limited: true, retryAfter: '30', calls: [] as string[] };
function stubKsef() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    atrapa.calls.push(String(url));
    if (atrapa.limited) {
      atrapa.limited = false;
      return new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': atrapa.retryAfter } });
    }
    return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
  }));
}

const settle = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => e);
const at = (seconds: number) => vi.setSystemTime(new Date(T0.getTime() + seconds * 1000));

const ctx = (attempt = 0): JobContext => ({
  attempt,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
});
const event = (tenantId: string, invoiceId: string) => ({
  invoiceId, tenantId, nip: tenantId === TENANT_B ? NIP_B : NIP_A, environment: 'test' as const, sendAttemptId: ATTEMPT,
  invoice: { type: 'VAT', internalNumber: 'FV/1', issueDate: '2026-11-09' } as Invoice,
});
const ACCEPTED = { ksefNumber: 'K-1', xmlStoragePath: 'x.xml', xmlSha256Hash: 'h', xmlSizeBytes: 1, sessionReferenceNumber: 'S-2', invoiceReferenceNumber: 'R-2' };
const claimCalls = () => m.rpc.mock.calls.filter(([fn]) => fn === 'claim_ksef_send');
const uuid = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.stubEnv('KSEF_ENV', 'test');
  atrapa.limited = true;
  atrapa.retryAfter = '30';
  atrapa.calls = [];
  stubKsef();
  m.fullFlow.mockResolvedValue(ACCEPTED);
  m.findOpen.mockResolvedValue(null);
  m.rpc.mockImplementation(async (fn: string) =>
    fn === 'claim_ksef_send' ? { data: '2026-11-09T09:00:00.000000+00:00', error: null } : { data: false, error: null });
  m.invoice = { id: uuid(1), direction: 'outgoing', ksef_status: 'queued', ksef_number: null, ksef_environment: 'test', invoice_type: 'VAT', invoice_kind: 'regular', fa3_data: {} };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('atrapa KSeF: 429 z Retry-After: 30 zatrzymuje całą firmę', () => {
  it('przez 30 s nie idzie żadne żądanie firmy A (wysyłka, skrzynka, UPO), a firma B idzie bez czekania', async () => {
    // Pierwsze żądanie firmy A dostaje 429 z Retry-After: 30.
    const first = await settle(ksefRateLimiter.enqueue(NIP_A, () => ksefFetch('/sessions/online', { method: 'POST', env: 'test' })));
    expect(first).toBeInstanceOf(KsefApiError);
    expect((first as KsefApiError).status).toBe(429);
    expect(atrapa.calls).toHaveLength(1);

    // 10 s później: wysyłka, skrzynka i UPO firmy A — bez żadnego żądania do KSeF.
    at(10);
    await settle(submitInvoice('<Faktura/>', authA, 'test'));
    await settle(queryReceivedInvoices(authA, new Date('2026-11-01'), new Date('2026-11-09'), 'test'));
    const upo = await downloadUpoFromKsef(TENANT_A, 'K-A', { env: 'test', sessionReferenceNumber: 'S-A' });
    expect(atrapa.calls).toHaveLength(1);
    // UPO w pauzie czeka (ponowienie), nie kończy się błędem ostatecznym.
    expect(upo).toMatchObject({ success: false, retryable: true });

    // Firma B w tym samym czasie: żądanie wychodzi od razu.
    await settle(submitInvoice('<Faktura/>', authB, 'test'));
    expect(atrapa.calls.length).toBeGreaterThan(1);

    // Po 30 s firma A znów pyta KSeF.
    const before = atrapa.calls.length;
    at(31);
    await settle(queryReceivedInvoices(authA, new Date('2026-11-01'), new Date('2026-11-09'), 'test'));
    expect(atrapa.calls.length).toBeGreaterThan(before);
  });
});

describe('runner wysyłki w pauzie firmy', () => {
  it('429 z KSeF: ponowienie po pełnym Retry-After (bez obcięcia do 3600 s), bez zużycia próby', async () => {
    m.fullFlow.mockRejectedValueOnce(new KsefApiError(429, '{}', 'KSeF API POST /sessions/online failed: 429', 7_200_000));
    const error = await settle(runSubmitInvoice(event(TENANT_A, uuid(1)), ctx(KSEF_MAX_RETRIES))) as Error;
    expect(error.name).toBe('RetryAfterError');
    expect((error as Error & { retryAfterMs: number }).retryAfterMs).toBeGreaterThanOrEqual(7_200_000);
    // Ostatnia próba (attempt = maxRetries) nie kończy faktury.
    expect(decideRetry(error, KSEF_MAX_RETRIES, policy, MAX_WAIT_RETRIES)).toMatchObject({
      action: 'retry', nextAttempt: KSEF_MAX_RETRIES, nextWaits: MAX_WAIT_RETRIES,
    });
  });

  it('kolejna faktura tej firmy czeka PRZED przejęciem wysyłki (bez `sending`), druga firma wychodzi od razu', async () => {
    m.fullFlow.mockRejectedValueOnce(new KsefApiError(429, '{}', 'KSeF API POST /sessions/online failed: 429', 30_000));
    await settle(runSubmitInvoice(event(TENANT_A, uuid(1)), ctx()));
    m.rpc.mockClear();
    m.fullFlow.mockClear();

    at(5);
    const waiting = await settle(runSubmitInvoice(event(TENANT_A, uuid(2)), ctx())) as Error;
    expect(waiting.name).toBe('RetryAfterError');
    // Czeka do końca pauzy (25 s zostało), z rozrzutem w górę.
    expect((waiting as Error & { retryAfterMs: number }).retryAfterMs).toBeGreaterThanOrEqual(25_000);
    expect(claimCalls()).toHaveLength(0);
    expect(m.fullFlow).not.toHaveBeenCalled();

    // Firma B: bez czekania na serię firmy A.
    await expect(runSubmitInvoice(event(TENANT_B, uuid(3)), ctx())).resolves.toMatchObject({ success: true });
    expect(m.fullFlow).toHaveBeenCalledTimes(1);
  });

  it('30 kolejnych pauz nie kończy faktury w `failed`: ani próba, ani budżet odczekań', async () => {
    let attempt = 0;
    let waits = 0;
    for (let i = 0; i < 30; i += 1) {
      at(i * 60);
      m.fullFlow.mockRejectedValueOnce(new KsefApiError(429, '{}', 'KSeF 429', 60_000));
      await settle(runSubmitInvoice(event(TENANT_A, uuid(10)), ctx(attempt)));
      // Następne zadanie tej samej faktury trafia w pauzę.
      at(i * 60 + 1);
      const error = await settle(runSubmitInvoice(event(TENANT_A, uuid(10)), ctx(attempt)));
      const decision = decideRetry(error, attempt, policy, waits);
      expect(decision.action).toBe('retry');
      if (decision.action !== 'retry') return;
      attempt = decision.nextAttempt;
      waits = decision.nextWaits;
    }
    expect(attempt).toBe(0);
    expect(waits).toBe(0);
  });

  it('pauza w trakcie wysyłki tej faktury (`sending` po wcześniejszym wykonaniu): czekanie w kawałkach z odświeżoną dzierżawą, bez alarmu I2', async () => {
    m.fullFlow.mockRejectedValueOnce(new KsefApiError(429, '{}', 'KSeF 429', 3_600_000));
    await settle(runSubmitInvoice(event(TENANT_A, uuid(20)), ctx()));
    m.rpc.mockClear();
    m.invoice = { ...m.invoice, id: uuid(20), ksef_status: 'sending', ksef_send_owner: ATTEMPT };

    at(60);
    const error = await settle(runSubmitInvoice(event(TENANT_A, uuid(20)), ctx())) as Error & { retryAfterMs: number };
    expect(error.name).toBe('RetryAfterError');
    // I2 alarmuje po 30 min od `submitted_to_ksef_at` — kawałek oczekiwania krótszy.
    expect(error.retryAfterMs).toBeLessThanOrEqual(10 * 60_000);
    expect(claimCalls()).toHaveLength(1);
    expect(claimCalls()[0]![1]).toMatchObject({ p_owner: ATTEMPT });
    expect(m.fullFlow).not.toHaveBeenCalled();
  });

  it('uzgodnienie po referencji: 429 czeka na Retry-After (nie stały harmonogram) i nie zużywa próby', async () => {
    m.findOpen.mockResolvedValue({ sessionReferenceNumber: 'SES-1', invoiceReferenceNumber: 'REF-1', attemptedAt: T0.toISOString() });
    m.status.mockRejectedValueOnce(new KsefApiError(429, '{}', 'KSeF 429', 600_000));
    const error = await settle(runSubmitInvoice(event(TENANT_A, uuid(30)), ctx(2))) as Error & { retryAfterMs: number };
    expect(error.name).toBe('RetryAfterError');
    expect(error.retryAfterMs).toBeGreaterThanOrEqual(600_000);
    expect(decideRetry(error, 2, policy, 0)).toMatchObject({ action: 'retry', nextAttempt: 2, nextWaits: 0 });
  });
});

describe('dziennik prób i limit na firmę', () => {
  it('429 przy pobraniu oryginału po 440 trafia do dziennika prób jako HTTP 429', async () => {
    m.findOpen.mockResolvedValue({
      sessionReferenceNumber: 'SES-1', invoiceReferenceNumber: 'REF-1', attemptedAt: T0.toISOString(),
      originalKsefNumber: '1234567890-20261109-0123456789AB-01', payloadHash: null,
    });
    // Pobranie oryginału: prawdziwy klient, atrapa KSeF odpowiada 429.
    const error = await settle(runSubmitInvoice(event(TENANT_A, uuid(40)), ctx()));
    const row = describeSendAttemptFailure(error, 'reconcile');
    expect(row.ksef_http_status).toBe(429);
    expect(row.status).toBe('waiting');
  });

  it('jedna firma nie zajmuje wszystkich slotów wysyłki: limit na firmę 2–3', () => {
    expect(KSEF_TENANT_CONCURRENCY_LIMIT).toBeGreaterThanOrEqual(2);
    expect(KSEF_TENANT_CONCURRENCY_LIMIT).toBeLessThanOrEqual(3);
  });
});
