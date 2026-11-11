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

type Query = {
  table: string;
  op: 'select' | 'update';
  payload?: Record<string, unknown>;
  filters: Record<string, unknown>;
  /** Krok runnera, w którym padło zapytanie (`step.run`). */
  step: string | null;
};

const m = vi.hoisted(() => ({
  fullFlow: vi.fn(),
  findOpen: vi.fn(),
  status: vi.fn(),
  rpc: vi.fn(),
  invoice: {} as Record<string, unknown>,
  /** Zapytania do bazy w kolejności (atrapa klienta serwisowego). */
  queries: [] as Query[],
  /** Bieżący i wszystkie wykonane kroki runnera. */
  step: null as string | null,
  steps: [] as string[],
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
  createAdminClient: async () => ({
    from: (table: string) => {
      const query: Query = { table, op: 'select', filters: {}, step: m.step };
      m.queries.push(query);
      // Warunkowy UPDATE jak w Postgresie: zmienia fakturę tylko, gdy pasują wszystkie filtry `eq`.
      const matches = () => Object.entries(query.filters).every(([key, value]) => m.invoice[key] === value);
      const q = {
        select: () => q,
        eq: (key: string, value: unknown) => { query.filters[key] = value; return q; },
        in: () => q,
        or: () => q,
        update: (payload: Record<string, unknown>) => { query.op = 'update'; query.payload = payload; return q; },
        maybeSingle: async () => {
          if (query.op !== 'update') return { data: { ...m.invoice }, error: null };
          if (!matches()) return { data: null, error: null };
          Object.assign(m.invoice, query.payload);
          return { data: { id: m.invoice.id }, error: null };
        },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
      };
      return q;
    },
    rpc: m.rpc,
  }),
}));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: vi.fn() }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@/lib/analytics/funnel', () => ({ recordFirstInvoiceAccepted: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));

import * as Sentry from '@sentry/nextjs';

import { decideRetry, MAX_WAIT_RETRIES } from '@/lib/jobs/retry';
import { KSEF_MAX_RETRIES, KSEF_TENANT_CONCURRENCY_LIMIT, getKsefRetryDelay } from '@/lib/jobs/retry-schedule';
import { parseDurationMs } from '@/lib/jobs/duration';
import { runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import { KsefApiError, ksefFetch } from '@/lib/ksef/client';
import { queryReceivedInvoices } from '@/lib/ksef/inbox';
import { KSEF_SEND_BRAKE_MIN_FIRMS, KSEF_SEND_BRAKE_RETRY_MS } from '@/lib/ksef/rate-limit-pause';
import { ksefRateLimiter } from '@/lib/ksef/rate-limiter';
import { describeSendAttemptFailure } from '@/lib/ksef/send-attempt-ledger';
import { submitInvoice } from '@/lib/ksef/submit';
import { findKsefSessionRow } from '@/lib/ksef/submission-log';
import { downloadUpoFromKsef } from '@/lib/ksef/upo-client';
import { updateInvoiceStatus } from '@/lib/supabase/admin-queries';

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
  step: {
    run: async (name, fn) => {
      m.step = name;
      m.steps.push(name);
      try {
        return await fn();
      } finally {
        m.step = null;
      }
    },
    sleep: vi.fn(),
    sendEvent: vi.fn(),
    scheduleAfter: vi.fn(),
  },
});
const event = (tenantId: string, invoiceId: string) => ({
  invoiceId, tenantId, nip: tenantId === TENANT_B ? NIP_B : NIP_A, environment: 'test' as const, sendAttemptId: ATTEMPT,
  invoice: { type: 'VAT', internalNumber: 'FV/1', issueDate: '2026-11-09' } as Invoice,
});
const ACCEPTED = { ksefNumber: 'K-1', xmlStoragePath: 'x.xml', xmlSha256Hash: 'h', xmlSizeBytes: 1, sessionReferenceNumber: 'S-2', invoiceReferenceNumber: 'R-2' };
const claimCalls = () => m.rpc.mock.calls.filter(([fn]) => fn === 'claim_ksef_send');
const uuid = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const invoiceUpdates = () => m.queries.filter((q) => q.table === 'invoices' && q.op === 'update');
type PauseError = Error & { retryAfterMs: number; pause: boolean; cause?: unknown };

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
  // Przejęcie jak `claim_ksef_send` (00124): faktura z tego wiersza przechodzi w `sending` tej próby.
  m.rpc.mockImplementation(async (fn: string, args: Record<string, unknown> = {}) => {
    if (fn !== 'claim_ksef_send') return { data: false, error: null };
    const claimedAt = new Date().toISOString();
    if (args.p_invoice_id === m.invoice.id && args.p_tenant_id === m.invoice.tenant_id) {
      Object.assign(m.invoice, { ksef_status: 'sending', ksef_send_owner: args.p_owner ?? null, submitted_to_ksef_at: claimedAt });
    }
    return { data: claimedAt, error: null };
  });
  m.invoice = { id: uuid(1), tenant_id: TENANT_A, direction: 'outgoing', ksef_status: 'queued', ksef_number: null, ksef_environment: 'test', invoice_type: 'VAT', invoice_kind: 'regular', fa3_data: {} };
  m.queries = [];
  m.step = null;
  m.steps = [];
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

  // Karta L1a: „czekanie wypada przed przejęciem wysyłki albo po jego zwolnieniu,
  // nigdy z fakturą w `sending`” — pauza trwa tyle, ile podał MF (tu godzinę),
  // a `sending` alarmuje po 15 min (`stale_ksef_sending_invoices`) i po 30 min (I2).
  it('pauza zastaje fakturę w `sending` tej próby (po wcześniejszym wykonaniu): przejęcie zwolnione do `queued`, bez nowego przejęcia i bez wysyłki', async () => {
    m.fullFlow.mockRejectedValueOnce(new KsefApiError(429, '{}', 'KSeF 429', 3_600_000));
    await settle(runSubmitInvoice(event(TENANT_A, uuid(20)), ctx()));
    m.rpc.mockClear();
    m.fullFlow.mockClear();
    m.queries = [];
    // Stan po wcześniejszym wykonaniu tej próby (np. 503 po przejęciu albo padnięty worker).
    const claimedAt = '2026-11-09T08:59:00.000Z';
    m.invoice = { ...m.invoice, id: uuid(20), ksef_status: 'sending', ksef_send_owner: ATTEMPT, submitted_to_ksef_at: claimedAt };

    at(60);
    const error = await settle(runSubmitInvoice(event(TENANT_A, uuid(20)), ctx())) as PauseError;
    expect(error.name).toBe('RetryAfterError');
    expect(error.pause).toBe(true);
    // Czeka do końca pauzy (3600 s − 60 s), z rozrzutem w górę — bez obcięcia.
    expect(error.retryAfterMs).toBeGreaterThanOrEqual(3_540_000);
    // Zwolnienie: świeży odczyt i warunkowy UPDATE własnego przejęcia, w kroku pauzy.
    expect(m.queries.filter((q) => q.step === 'ksef-rate-limit-pause' && q.op === 'select')).toHaveLength(1);
    expect(invoiceUpdates()).toEqual([expect.objectContaining({
      step: 'ksef-rate-limit-pause',
      payload: { ksef_status: 'queued' },
      filters: { id: uuid(20), tenant_id: TENANT_A, ksef_status: 'sending', ksef_send_owner: ATTEMPT },
    })]);
    // Właściciel i znacznik przejęcia zostają: po pauzie ta sama próba przejmie od razu (00124).
    expect(m.invoice).toMatchObject({ ksef_status: 'queued', ksef_send_owner: ATTEMPT, submitted_to_ksef_at: claimedAt });
    expect(claimCalls()).toHaveLength(0);
    expect(m.fullFlow).not.toHaveBeenCalled();
  });

  it('pauza: faktury w `sending` innej próby nie zwalnia (cudza dzierżawa wygrywa)', async () => {
    m.fullFlow.mockRejectedValueOnce(new KsefApiError(429, '{}', 'KSeF 429', 600_000));
    await settle(runSubmitInvoice(event(TENANT_A, uuid(21)), ctx()));
    m.queries = [];
    m.invoice = { ...m.invoice, id: uuid(21), ksef_status: 'sending', ksef_send_owner: '99999999-9999-4999-8999-999999999999' };

    at(10);
    const error = await settle(runSubmitInvoice(event(TENANT_A, uuid(21)), ctx())) as PauseError;
    expect(error).toMatchObject({ name: 'RetryAfterError', pause: true });
    expect(invoiceUpdates()).toEqual([]);
    expect(m.invoice.ksef_status).toBe('sending');
  });

  it('429 po przejęciu (krok wysyłki): przejęcie zwolnione do `queued`, firma w pauzie, próba niezużyta', async () => {
    m.invoice = { ...m.invoice, id: uuid(50) };
    m.fullFlow.mockRejectedValueOnce(new KsefApiError(429, '{}', 'KSeF API POST /sessions/online failed: 429', 120_000));

    const error = await settle(runSubmitInvoice(event(TENANT_A, uuid(50)), ctx(3))) as PauseError;
    expect(claimCalls()).toHaveLength(1);
    expect(error).toMatchObject({ name: 'RetryAfterError', pause: true });
    expect(error.retryAfterMs).toBeGreaterThanOrEqual(120_000);
    expect(error.cause).toBeInstanceOf(KsefApiError);
    expect(invoiceUpdates()).toEqual([expect.objectContaining({
      step: 'submit-to-ksef',
      payload: { ksef_status: 'queued' },
      filters: { id: uuid(50), tenant_id: TENANT_A, ksef_status: 'sending', ksef_send_owner: ATTEMPT },
    })]);
    expect(m.invoice).toMatchObject({ ksef_status: 'queued', ksef_send_owner: ATTEMPT });
    expect(decideRetry(error, 3, policy, 0)).toMatchObject({ action: 'retry', nextAttempt: 3, nextWaits: 0 });

    // Następne wykonanie tej faktury (przed końcem pauzy): czeka przed przejęciem.
    m.rpc.mockClear();
    at(30);
    const next = await settle(runSubmitInvoice(event(TENANT_A, uuid(50)), ctx(3))) as PauseError;
    expect(next).toMatchObject({ name: 'RetryAfterError', pause: true });
    expect(next.retryAfterMs).toBeGreaterThanOrEqual(90_000);
    expect(claimCalls()).toHaveLength(0);
  });

  it('firma bez pauzy i bez hamulca: krok pauzy nie czyta bazy', async () => {
    m.invoice = { ...m.invoice, id: uuid(70) };
    await expect(runSubmitInvoice(event(TENANT_A, uuid(70)), ctx())).resolves.toMatchObject({ success: true });
    // Warunek dodatni: krok się wykonał (inaczej brak zapytań nic nie dowodzi).
    expect(m.steps).toContain('ksef-rate-limit-pause');
    expect(m.steps.indexOf('ksef-rate-limit-pause')).toBeLessThan(m.steps.indexOf('mark-as-sending'));
    expect(m.queries.filter((q) => q.step === 'ksef-rate-limit-pause')).toEqual([]);
  });

  it('hamulec 429: 5 firm z 429 w oknie — część faktur kolejnej firmy czeka (bez przejęcia), część wychodzi; alarm raz', async () => {
    const limitedFirm = async (nip: string) => {
      atrapa.limited = true;
      const r = await settle(ksefRateLimiter.enqueue(nip, () => ksefFetch('/sessions/online', { method: 'POST', env: 'test' })));
      expect((r as KsefApiError).status).toBe(429);
    };
    const runMany = async (from: number, count: number) => {
      const out: unknown[] = [];
      for (let i = 0; i < count; i += 1) {
        m.invoice = { ...m.invoice, id: uuid(from + i), tenant_id: TENANT_B, ksef_status: 'queued', ksef_send_owner: null };
        out.push(await settle(runSubmitInvoice(event(TENANT_B, uuid(from + i)), ctx())));
      }
      return out;
    };

    // Firmy inne niż A i B (fikcyjne NIP-y 1234567892…); próg z modułu pauzy (dziś 5, jak skrzynka).
    const nips = Array.from({ length: KSEF_SEND_BRAKE_MIN_FIRMS }, (_, i) => String(1_234_567_892 + i));
    // Warunek dodatni: o jedną firmę mniej niż próg — hamulec jeszcze nie działa, wszystko wychodzi.
    for (const nip of nips.slice(0, -1)) await limitedFirm(nip);
    expect((await runMany(100, 8)).every((r) => r === 'ok')).toBe(true);

    // Kolejna firma z 429 w 10 minut (próg osiągnięty): hamulec.
    await limitedFirm(nips.at(-1)!);
    m.rpc.mockClear();
    m.fullFlow.mockClear();
    const results = await runMany(200, 20);
    const waiting = results.filter((r): r is PauseError => r instanceof Error && r.name === 'RetryAfterError');
    const passed = results.filter((r) => r === 'ok');
    expect(waiting.length + passed.length).toBe(20);
    expect(waiting.length).toBeGreaterThan(0);
    expect(passed.length).toBeGreaterThan(0);
    for (const w of waiting) {
      expect(w.pause).toBe(true);
      expect(w.retryAfterMs).toBeGreaterThanOrEqual(KSEF_SEND_BRAKE_RETRY_MS);
    }
    // Zatrzymane przez hamulec nie przejmują wysyłki i nie idą do KSeF.
    expect(claimCalls()).toHaveLength(passed.length);
    expect(m.fullFlow).toHaveBeenCalledTimes(passed.length);
    const brakeAlerts = vi.mocked(Sentry.captureMessage).mock.calls.filter(([msg]) => String(msg).includes('hamulec 429'));
    expect(brakeAlerts).toHaveLength(1);
  });

  it('data nadania oryginału przy własnym duplikacie: 429 to pauza, nie przyjęcie numeru bez daty', async () => {
    const K = '1234567890-20261109-0123456789AB-01';
    const HASH = 'ab'.repeat(32);
    m.invoice = { ...m.invoice, id: uuid(60) };
    m.findOpen.mockResolvedValue({
      sessionReferenceNumber: 'SES-1', invoiceReferenceNumber: 'REF-1', attemptedAt: T0.toISOString(),
      originalKsefNumber: K, originalSessionReferenceNumber: 'SES-0', payloadHash: HASH,
    });
    // Sesja oryginału jest w historii tej faktury z tym samym plikiem — własny duplikat.
    vi.mocked(findKsefSessionRow).mockResolvedValueOnce({ requestPayloadHash: HASH, xmlStoragePath: 'x.xml', invoiceReferenceNumber: 'REF-0' } as never);
    // Data nadania po referencji własnej sesji: KSeF odpowiada 429.
    m.status.mockRejectedValueOnce(new KsefApiError(429, '{}', 'KSeF 429', 120_000));

    const error = await settle(runSubmitInvoice(event(TENANT_A, uuid(60)), ctx())) as PauseError;
    expect(m.status).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ name: 'RetryAfterError', pause: true });
    expect(error.retryAfterMs).toBeGreaterThanOrEqual(120_000);
    expect(error.cause).toBeInstanceOf(KsefApiError);
    // Bez przyjęcia numeru bez daty nadania (art. 106na) i bez alarmu „brak daty”.
    expect(updateInvoiceStatus).not.toHaveBeenCalled();
    expect(vi.mocked(Sentry.captureMessage).mock.calls.map(([msg]) => String(msg)))
      .not.toContain('KSeF: brak daty przyjęcia oryginału przy przyjęciu numeru z duplikatu');
    expect(m.invoice).toMatchObject({ ksef_status: 'queued', ksef_send_owner: ATTEMPT });
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
