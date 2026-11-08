import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NonRetriableError, RetryAfterError } from '@/lib/jobs/errors';
import type { JobContext } from '@/lib/jobs/registry';
import type { Invoice } from '@/types/invoice';

/**
 * C-12 na prawdziwym runnerze: inny plik pod kluczem próby nie może wpaść
 * w ogólne ponawianie (pięć razy ten sam błąd, potem `failed` bez wyjaśnienia)
 * ani zablokować faktury bez wyjścia. Fail-closed z wyjściem (protokół, pkt 4):
 * kod z automatycznym ponowieniem, a każde nowe kolejkowanie ma nowy klucz.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const NEXT_ATTEMPT = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_KEY = `${T}/2026/10/${ID}/${ATTEMPT}.xml`;
const NEXT_KEY = `${T}/2026/10/${ID}/${NEXT_ATTEMPT}.xml`;
const HASH = 'ab'.repeat(32);

const m = vi.hoisted(() => ({
  upload: vi.fn(),
  submit: vi.fn(),
  downloadKsef: vi.fn(),
  downloadStored: vi.fn(),
  sessionRow: vi.fn(),
  payloads: vi.fn(),
  updateStatus: vi.fn(),
  invoiceUpdate: vi.fn(),
  captureMessage: vi.fn(),
  invoice: {} as Record<string, unknown>,
}));

vi.mock('@/lib/storage/r2-client', () => ({ getR2Config: () => ({ bucketName: 'b' }), getR2Client: () => ({ send: vi.fn() }) }));
vi.mock('@/lib/storage/r2', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/storage/r2')>(),
  uploadInvoiceXml: m.upload,
  downloadInvoiceXml: m.downloadStored,
}));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: vi.fn() }));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(async () => undefined),
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/ksef/submit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ksef/submit')>(),
  submitInvoice: m.submit,
  downloadKsefInvoice: m.downloadKsef,
}));
vi.mock('@/lib/ksef/submission-log', () => ({
  findOpenKsefSubmissionIntents: vi.fn(async () => []),
  promoteKsefSubmissionIntent: vi.fn(async () => false),
  abandonKsefSubmissionIntent: vi.fn(),
  recordKsefSubmissionIntent: vi.fn(),
  findKsefSessionRow: m.sessionRow,
  findSubmissionPayloads: m.payloads,
  findTenantInvoiceByKsefNumber: vi.fn(async () => null),
  closeKsefAttempt: vi.fn(),
  markKsefSubmissionsNumberTaken: vi.fn(),
  recordKsefDuplicateCheck: vi.fn(),
  recordKsefAcceptedSession: vi.fn(),
  markKsefAttemptDuplicatePending: vi.fn(),
  recordKsefSubmissionSent: vi.fn(),
  markKsefSubmission: vi.fn(),
  findOpenKsefSubmission: vi.fn(async () => null),
  findOwnKsefSessionXmlPath: vi.fn(async () => null),
  isOwnKsefSession: vi.fn(async () => true),
  findSessionReferenceForKsefNumber: vi.fn(async () => null),
}));
vi.mock('@/lib/ksef/xml-generated-at', () => ({ claimXmlGeneratedAt: async () => new Date('2026-10-01T10:00:00.000Z') }));
vi.mock('@/lib/xml/validator', () => ({ validateInvoiceXml: async () => ({ valid: true, errors: [] }), InvoiceXmlSchemaError: class extends Error {} }));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: async () => false }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: async () => ({ offline: false }) }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@/lib/ksef/submit-reference-boundary', () => ({ assertSubmitReferences: async () => 'regular' }));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn(), assertJobIdentity: vi.fn() }));
vi.mock('@/lib/supabase/admin-queries', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/supabase/admin-queries')>(),
  getTenantKsefCredentials: async () => ({ type: 'token', nip: '1234567890', token: 't' }),
  updateInvoiceStatus: m.updateStatus,
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: async () => {
    const q = {
      select: () => q,
      eq: () => q,
      in: () => q,
      or: () => q,
      update: (patch: Record<string, unknown>) => {
        m.invoiceUpdate(patch);
        return q;
      },
      maybeSingle: async () => ({ data: { ...m.invoice }, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return { from: () => q, rpc: async () => ({ data: '2026-10-03T12:00:00.000000+00:00', error: null }) };
  },
}));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: m.captureMessage, addBreadcrumb: vi.fn() }));

import { onSubmitInvoiceExhausted, runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import { classifySendError, isAutoRequeueable } from '@/lib/ksef/send-error-codes';
import { KsefInvoiceRejectedError } from '@/lib/ksef/submit';
import { XmlArchiveConflictError } from '@/lib/storage/xml-archive-conflict';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';

const faktura = () => finalizeInvoice({
  internalNumber: 'FV 2026/10/001',
  type: 'VAT',
  issueDate: '2026-10-01',
  saleDate: '2026-10-01',
  seller: { nip: '5260001246', name: 'ACME', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
  buyer: { nip: '5252241585', name: 'Klient', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '02-001 Warszawa' } },
  lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
  payment: { currency: 'PLN', dueDate: '2026-10-15', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
});

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};
const event = (sendAttemptId: string = ATTEMPT) => ({
  invoiceId: ID,
  tenantId: T,
  nip: '1234567890',
  environment: 'test' as const,
  invoice: faktura() as Invoice,
  sendAttemptId,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.upload.mockReset();
  m.submit.mockReset();
  vi.stubEnv('KSEF_ENV', 'test');
  m.payloads.mockResolvedValue([]);
  m.submit.mockResolvedValue({ ksefNumber: 'K-1', acquisitionTimestamp: '2026-10-01T10:00:00Z', sessionReferenceNumber: 'S-1', invoiceReferenceNumber: 'R-1' });
  m.invoice = { id: ID, direction: 'outgoing', ksef_status: 'queued', ksef_number: null, ksef_environment: 'test', invoice_type: 'VAT', invoice_kind: 'regular', fa3_data: {} };
});
afterEach(() => vi.unstubAllEnvs());

describe('inny plik pod kluczem próby', () => {
  const conflicted = async (): Promise<unknown> => {
    m.upload.mockRejectedValueOnce(new XmlArchiveConflictError(ATTEMPT_KEY));
    return runSubmitInvoice(event(), ctx).catch((e: unknown) => e);
  };

  it('bez ponawiania tej samej próby i bez kontaktu z KSeF', async () => {
    const error = await conflicted();

    expect(error).toBeInstanceOf(NonRetriableError);
    expect(m.upload).toHaveBeenCalledOnce();
    expect(m.submit).not.toHaveBeenCalled();
  });

  it('kod z automatycznym ponowieniem i wyjściem dla klienta: INFRA, transient', async () => {
    const error = await conflicted();

    expect(classifySendError(error)).toEqual({ code: 'INFRA', class: 'transient' });
    expect(isAutoRequeueable('INFRA')).toBe(true);
  });

  it('alarm dla operatora z kluczem pliku', async () => {
    await conflicted();

    expect(m.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('inny plik'),
      expect.objectContaining({
        tags: expect.objectContaining({ job: 'submit-invoice', kind: 'xml-archive-conflict' }),
        extra: expect.objectContaining({ tenantId: T, invoiceId: ID, storagePath: ATTEMPT_KEY }),
      }),
    );
  });

  it('faktura: `failed` z kodem i polskim komunikatem bez znacznika i bez ścieżki', async () => {
    const error = await conflicted();

    await onSubmitInvoiceExhausted(error as Error, event(), ctx);

    const patch = m.invoiceUpdate.mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((p) => p.last_error_code === 'INFRA');
    expect(patch).toMatchObject({ ksef_status: 'failed', last_error_code: 'INFRA' });
    expect(String(patch?.last_error)).toContain('Tej wysyłki nie wykonaliśmy');
    expect(String(patch?.last_error)).not.toContain('[INFRA]');
    expect(String(patch?.last_error)).not.toContain(T);
  });

  it('wyjście działa: nowe kolejkowanie ma nowy klucz i faktura idzie do KSeF', async () => {
    await conflicted();
    m.upload.mockResolvedValueOnce({ storagePath: NEXT_KEY, sha256Hash: HASH, sizeBytes: 10, etag: '"e"' });

    await runSubmitInvoice(event(NEXT_ATTEMPT), ctx);

    expect(m.upload.mock.calls[1]![4]).toMatchObject({ attemptId: NEXT_ATTEMPT });
    expect(m.submit).toHaveBeenCalledOnce();
    expect(m.updateStatus).toHaveBeenCalledWith(ID, expect.objectContaining({ ksef_status: 'accepted', xml_storage_path: NEXT_KEY }), T);
  });
});

describe('chwilowy błąd odczytu po 412', () => {
  it('zostaje ponawialny: ponowienie tej samej próby, bez kontaktu z KSeF', async () => {
    m.upload.mockRejectedValueOnce(new Error('storage unavailable'));

    const error = await runSubmitInvoice(event(), ctx).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RetryAfterError);
    expect(m.submit).not.toHaveBeenCalled();
  });
});

describe('duplikat 440: archiwum pobranego oryginału, gdy wpis próby nie zna pliku', () => {
  it('zapis bez wyłączania ochrony przed nadpisaniem', async () => {
    const original = Buffer.from('<Faktura>oryginał</Faktura>');
    const originalHash = createHash('sha256').update(original).digest('hex');
    m.submit.mockRejectedValue(new KsefInvoiceRejectedError(440, {
      code: 440,
      description: 'Duplikat',
      details: [],
      extensions: { originalKsefNumber: 'K-ORIG' },
    } as never, {
      invoiceHash: Buffer.from('ef'.repeat(32), 'hex').toString('base64'),
      sessionReferenceNumber: 'S-1',
      invoiceReferenceNumber: 'R-1',
    }));
    m.sessionRow.mockResolvedValue({ status: 'sent', requestPayloadHash: 'ef'.repeat(32), xmlStoragePath: ATTEMPT_KEY });
    m.downloadStored.mockResolvedValue(original.toString('utf8'));
    m.downloadKsef.mockResolvedValue(original);
    m.payloads.mockResolvedValue([{ hash: originalHash, xmlStoragePath: null }]);
    m.upload
      .mockResolvedValueOnce({ storagePath: ATTEMPT_KEY, sha256Hash: HASH, sizeBytes: 10, etag: '"e"' })
      .mockResolvedValueOnce({ storagePath: `${T}/2026/10/${ID}/ksef-x.xml`, sha256Hash: originalHash, sizeBytes: original.length, etag: '"e"' });

    await runSubmitInvoice(event(), ctx);

    const archive = m.upload.mock.calls[1]!;
    expect(archive[4]).toEqual({ attemptId: `ksef-${originalHash.slice(0, 40)}` });
  });
});
