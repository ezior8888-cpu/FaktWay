import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Invoice } from '@/types/invoice';
import { KsefApiError } from '@/lib/ksef/client';

/**
 * A5 (plan „zero zgubionych faktur”, brief centrum dowodzenia §5): każde
 * wykonanie joba wysyłki zostawia jeden wiersz w dzienniku prób
 * `ksef_send_attempts` — także porażka PRZED wysłaniem pliku do KSeF
 * (poświadczenia, XML, przejęcie), której dziś nie ma w `ksef_submissions`,
 * a na fakturze zostaje tylko ostatni błąd (`last_error*`).
 *
 * Ścieżka prawdziwa: job zarejestrowany w `handlers/package-d.ts` →
 * `wrapHandler` (pg-boss) → runner. Atrapy tylko dla bazy, KSeF i kolejki.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const JOB_1 = '33333333-3333-4333-8333-333333333331';
const JOB_2 = '33333333-3333-4333-8333-333333333332';

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  verification: vi.fn(),
  health: vi.fn(),
  fullFlow: vi.fn(),
  credentials: vi.fn(),
  findOpen: vi.fn(),
  bossSend: vi.fn(),
  /** Wynik `claim_ksef_send`: znacznik czasu = przejęte, `null` = trzyma inna próba. */
  claim: '2026-10-13T12:00:00.000000+00:00' as string | null,
  invoice: {} as Record<string, unknown>,
  /** Stan tabeli `ksef_send_attempts` po zapisach (id → wiersz). */
  ledger: new Map<string, Row>(),
  /** Awaria zapisu dziennika (sprawdzenie, że nie blokuje wysyłki). */
  ledgerDown: false,
  /** Zapis dziennika wisi (blokada tabeli) — kończy go tylko przerwanie (abortSignal). */
  ledgerHangs: false,
  nextId: 0,
}));

vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: vi.fn(async () => false) }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));
vi.mock('@/lib/auth/ksef-verification-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/ksef-verification-guard')>();
  return {
    ...actual,
    requireKsefVerification: mocks.verification,
    requireKsefVerificationForBackgroundJob: mocks.verification,
  };
});
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: mocks.health }));
vi.mock('@/lib/ksef/health-status', () => ({ isKsefHealthy: vi.fn(async () => true) }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@/lib/ksef/submit-invoice-full', () => ({ submitInvoiceFullFlow: mocks.fullFlow }));
vi.mock('@/lib/ksef/submit-reference-boundary', () => ({ assertSubmitReferences: async () => 'regular' }));
vi.mock('@/lib/ksef/submission-log', () => ({
  findOpenKsefSubmissionIntents: vi.fn(async () => []),
  promoteKsefSubmissionIntent: vi.fn(async () => false),
  abandonKsefSubmissionIntent: vi.fn(),
  recordKsefSubmissionIntent: vi.fn(),
  findKsefSessionRow: vi.fn(async () => null),
  findSubmissionPayloads: vi.fn(async () => []),
  findTenantInvoiceByKsefNumber: vi.fn(async () => null),
  closeKsefAttempt: vi.fn(),
  markKsefSubmissionsNumberTaken: vi.fn(),
  recordKsefDuplicateCheck: vi.fn(),
  recordKsefAcceptedSession: vi.fn(),
  markKsefAttemptDuplicatePending: vi.fn(),
  recordKsefSubmissionSent: vi.fn(),
  markKsefSubmission: vi.fn(),
  findOpenKsefSubmission: mocks.findOpen,
  findKsefNumberTaken: vi.fn(async () => null),
  isOwnKsefSession: vi.fn(async () => false),
  findSessionReferenceForKsefNumber: vi.fn(async () => null),
}));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: vi.fn() }));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn(), assertJobIdentity: vi.fn() }));
vi.mock('@/lib/supabase/admin-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/admin-queries')>();
  return { ...actual, getTenantKsefCredentials: mocks.credentials, updateInvoiceStatus: vi.fn() };
});

/** Atrapa klienta serwisowego: `ksef_send_attempts` jak tabela, reszta jak faktura. */
function ledgerQuery() {
  let pending: { op: 'insert'; row: Row } | { op: 'update'; patch: Row } | null = null;
  const filters: Row = {};
  let signal: AbortSignal | null = null;
  const fail = () => ({ data: null, error: { message: 'fixture: dziennik niedostępny' } });
  const settle = () => {
    if (!mocks.ledgerHangs) return Promise.resolve(apply());
    return new Promise((resolve) => {
      signal?.addEventListener('abort', () => resolve({ data: null, error: { message: 'AbortError: fixture' } }));
    });
  };
  const apply = () => {
    if (mocks.ledgerDown) return fail();
    if (pending?.op === 'insert') {
      const id = `row-${++mocks.nextId}`;
      mocks.ledger.set(id, { ...pending.row, id });
      return { data: { id }, error: null };
    }
    if (pending?.op === 'update') {
      const target = mocks.ledger.get(String(filters.id));
      if (target) Object.assign(target, pending.patch);
      return { data: target ? { id: filters.id } : null, error: null };
    }
    return { data: null, error: null };
  };
  const q = {
    insert: (row: Row) => { pending = { op: 'insert', row }; return q; },
    update: (patch: Row) => { pending = { op: 'update', patch }; return q; },
    select: () => q,
    eq: (column: string, value: unknown) => { filters[column] = value; return q; },
    abortSignal: (s: AbortSignal) => { signal = s; return q; },
    single: () => settle(),
    maybeSingle: () => settle(),
    then: (resolve: (v: unknown) => unknown) => settle().then(resolve),
  };
  return q;
}

function invoiceQuery() {
  let patch: Row | null = null;
  const q = {
    select: () => q,
    eq: () => q,
    in: () => q,
    or: () => q,
    update: (p: Row) => { patch = p; return q; },
    maybeSingle: async () => {
      if (patch) { Object.assign(mocks.invoice, patch); return { data: { id: ID }, error: null }; }
      return { data: { ...mocks.invoice }, error: null };
    },
    then: (resolve: (v: unknown) => unknown) => {
      if (patch) Object.assign(mocks.invoice, patch);
      return Promise.resolve({ data: null, error: null }).then(resolve);
    },
  };
  return q;
}

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: async () => ({
    from: (table: string) => (table === 'ksef_send_attempts' ? ledgerQuery() : invoiceQuery()),
    rpc: async (fn: string) => ({
      data: fn === 'claim_ksef_send' ? mocks.claim : null,
      error: null,
    }),
  }),
}));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));
vi.mock('@/lib/jobs/boss', () => ({ startBoss: async () => ({ send: mocks.bossSend }) }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvents: vi.fn(), sendJobEvent: vi.fn() }));
vi.mock('@/lib/jobs/run-log', () => ({ recordJobRun: vi.fn(async () => undefined) }));
vi.mock('@/lib/jobs/sentry', () => ({ reportExhaustedJob: vi.fn() }));

import '@/lib/jobs/handlers/package-d';
import { getRegisteredJobs } from '@/lib/jobs/registry';
import { MAX_WAIT_RETRIES } from '@/lib/jobs/retry';
import { wrapHandler } from '@/lib/jobs/run-job';
import { runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import { sendAttemptMessage, withSendAttemptLedger } from '@/lib/ksef/send-attempt-ledger';
import { KsefCredentialsError } from '@/lib/supabase/admin-queries';
import { InvoiceXmlSchemaError } from '@/lib/xml/validator';

const submitJob = getRegisteredJobs().find((j) => j.queue === 'invoice.submit.requested');
if (!submitJob) throw new Error('fixture: brak joba invoice.submit.requested w rejestrze');
const run = wrapHandler(submitJob);

function event(attempt = 0) {
  return {
    invoiceId: ID,
    tenantId: TENANT,
    nip: '1234567890',
    environment: 'test' as const,
    sendAttemptId: ATTEMPT,
    invoice: { type: 'VAT', internalNumber: 'FV/1', issueDate: '2026-10-13' } as Invoice,
    ...(attempt > 0 ? { __attempt: attempt } : {}),
  };
}

function job(id: string, attempt = 0, extra: Record<string, unknown> = {}) {
  return { id, name: 'invoice.submit.requested', data: { ...event(attempt), ...extra }, groupId: TENANT, expireInSeconds: 900, heartbeatSeconds: null, signal: new AbortController().signal };
}

const rows = () => [...mocks.ledger.values()];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verification.mockResolvedValue(undefined);
  mocks.health.mockResolvedValue({ offline: false });
  mocks.findOpen.mockResolvedValue(null);
  mocks.credentials.mockResolvedValue({ type: 'token', nip: '1234567890', token: 't' });
  mocks.bossSend.mockResolvedValue('retry-job');
  mocks.invoice = {
    id: ID, direction: 'outgoing', ksef_status: 'queued', ksef_number: null, ksef_environment: 'test',
    invoice_type: 'VAT', invoice_kind: 'regular', internal_number: 'FV/1',
  };
  mocks.claim = '2026-10-13T12:00:00.000000+00:00';
  mocks.ledger = new Map();
  mocks.ledgerDown = false;
  mocks.ledgerHangs = false;
  mocks.nextId = 0;
  vi.stubEnv('KSEF_ENV', 'test');
  vi.stubEnv('SOURCE_COMMIT', 'abc1234');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

describe('A5: wiersz dziennika dla porażki przed wysłaniem pliku', () => {
  it('brak certyfikatu (poświadczenia): jeden wiersz failed / credentials z kodem i klasą z katalogu', async () => {
    mocks.credentials.mockRejectedValue(new KsefCredentialsError('missing', 'Tenant x nie ma skonfigurowanych credentials KSeF'));

    await run([job(JOB_1)] as never);

    expect(mocks.fullFlow).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      tenant_id: TENANT,
      invoice_id: ID,
      send_attempt_id: ATTEMPT,
      job_id: JOB_1,
      execution: 0,
      ksef_environment: 'test',
      worker_sha: 'abc1234',
      status: 'failed',
      stage: 'credentials',
      error_code: 'NO_CERTIFICATE',
      error_class: 'setup',
      retryable: false,
    });
    expect(rows()[0]!.finished_at).toEqual(expect.any(String));
    // Jeden zegar (worker) dla startu i końca — porażka zapisu wyniku nie udaje padniętego workera.
    expect(rows()[0]!.started_at).toEqual(expect.any(String));
    expect(String(rows()[0]!.started_at) <= String(rows()[0]!.finished_at)).toBe(true);
  });

  it('XML niezgodny ze schematem: etap xml, kod XSD_INVALID, bez ponowień', async () => {
    mocks.fullFlow.mockRejectedValue(new InvoiceXmlSchemaError(['P_7: maxLength']));

    await run([job(JOB_1)] as never);

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ status: 'failed', stage: 'xml', error_code: 'XSD_INVALID', error_class: 'terminal', retryable: false });
  });
});

describe('A5: treść klienta poza dziennikiem (brief §5, reguła 4)', () => {
  it('kwoty, numer rachunku, NIP, VAT-UE i wartości w cudzysłowach są maskowane; sens komunikatu zostaje', () => {
    const message = sendAttemptMessage(
      'InvoiceValidationError: Suma pozycji 1 234,56 PLN różni się od P_15 1234.57; rachunek PL61 1090 1014 0000 0712 1981 2874; ' +
        'nabywca 1234567890, VAT-UE PL5260250995; pole P_7 = "Usługa księgowa dla Jan Kowalski" i „Pracownia Testowa”',
    );
    expect(message).not.toMatch(/1 ?234|0712|1981|2874|1234567890|5260250995|Kowalski|Pracownia/);
    expect(message).toContain('InvoiceValidationError');
    expect(message).toContain('P_15');
    expect(message).toContain('P_7');
  });
});

describe('A5: ponowienia nie nadpisują wcześniejszych porażek', () => {
  it('503 z KSeF, potem sukces: dwa wiersze — porażka zostaje w historii obok sukcesu', async () => {
    mocks.fullFlow
      .mockRejectedValueOnce(new KsefApiError(503, 'Service Unavailable', 'Service Unavailable'))
      .mockResolvedValueOnce({
        ksefNumber: '1234567890-20261013-ABCDEF123456-01',
        xmlStoragePath: 'x.xml',
        xmlSha256Hash: 'ab'.repeat(32),
        xmlSizeBytes: 10,
        acquisitionTimestamp: '2026-10-13T12:00:01Z',
        sessionReferenceNumber: 'SES-1',
        invoiceReferenceNumber: 'REF-1',
        via: 'submit',
      });

    await run([job(JOB_1)] as never);
    expect(mocks.bossSend).toHaveBeenCalledOnce();
    await run([job(JOB_2, 1)] as never);

    const [first, second] = rows();
    expect(first).toMatchObject({
      job_id: JOB_1, execution: 0, status: 'failed', stage: 'ksef',
      error_code: 'KSEF_UNAVAILABLE', error_class: 'transient', ksef_http_status: 503, retryable: true,
    });
    expect(second).toMatchObject({
      job_id: JOB_2, execution: 1, send_attempt_id: ATTEMPT, status: 'succeeded', result: 'accepted',
    });
    expect(second?.error_code ?? null).toBeNull();
  });
});

describe('A5: oczekiwanie i odporność', () => {
  it('wysyłkę trzyma inna próba: status waiting, nie porażka', async () => {
    mocks.claim = null;

    await run([job(JOB_1)] as never);

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ status: 'waiting', stage: 'claim', retryable: true });
  });

  it('oczekiwanie po wyczerpaniu limitu odczekań to błąd z kodem (pg-boss liczy je wtedy jako próbę)', async () => {
    mocks.claim = null;

    await run([job(JOB_1, 0, { __waits: MAX_WAIT_RETRIES })] as never);

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ status: 'failed', stage: 'claim', retryable: true });
    expect(rows()[0]!.error_code).toEqual(expect.any(String));
  });

  it('zawieszony zapis dziennika (blokada tabeli) nie zatrzymuje wysyłki — przerwanie po limicie czasu', async () => {
    mocks.ledgerHangs = true;
    mocks.fullFlow.mockResolvedValue({
      ksefNumber: '1234567890-20261013-ABCDEF123456-01',
      xmlStoragePath: 'x.xml',
      sessionReferenceNumber: 'SES-1',
      invoiceReferenceNumber: 'REF-1',
      via: 'submit',
    });
    const fast = wrapHandler({
      ...submitJob,
      handler: withSendAttemptLedger((data, ctx) => runSubmitInvoice(data as never, ctx), { timeoutMs: 20 }),
    } as never);

    const results = await fast([job(JOB_1)] as never);

    expect(results).toEqual([{ id: JOB_1, status: 'completed' }]);
    expect(mocks.fullFlow).toHaveBeenCalledOnce();
    expect(mocks.invoice.ksef_status).not.toBe('failed');
  });

  it('awaria zapisu dziennika nie zatrzymuje wysyłki', async () => {
    mocks.ledgerDown = true;
    mocks.fullFlow.mockResolvedValue({
      ksefNumber: '1234567890-20261013-ABCDEF123456-01',
      xmlStoragePath: 'x.xml',
      sessionReferenceNumber: 'SES-1',
      invoiceReferenceNumber: 'REF-1',
      via: 'submit',
    });

    const results = await run([job(JOB_1)] as never);

    expect(mocks.fullFlow).toHaveBeenCalledOnce();
    expect(results).toEqual([{ id: JOB_1, status: 'completed' }]);
    expect(mocks.bossSend).not.toHaveBeenCalled();
  });
});
