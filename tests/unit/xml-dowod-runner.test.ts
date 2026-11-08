import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { Invoice } from '@/types/invoice';

/**
 * C-12 na prawdziwym runnerze: wiersz `xml_documents` dostaje skrót pliku,
 * który poszedł do KSeF w TEJ próbie. Do tej naprawy uzgodnienie po referencji
 * liczyło skrót z tego, co akurat leży w magazynie — po nadpisaniu pliku KOD I
 * na PDF wskazywałby inny dokument, niż ma KSeF. Mocki tylko na granicach:
 * magazyn, KSeF, baza; zapis wiersza sprawdza `xml-document-evidence.test.ts`.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_KEY = `${T}/2026/10/${ID}/${ATTEMPT}.xml`;
const OLD_ATTEMPT_KEY = `${T}/2026/10/${ID}/stara-proba.xml`;
const HASH = 'ab'.repeat(32);

const m = vi.hoisted(() => ({
  upload: vi.fn(),
  submit: vi.fn(),
  findOpen: vi.fn(),
  sessionRow: vi.fn(),
  status: vi.fn(),
  downloadKsef: vi.fn(),
  updateStatus: vi.fn(),
  record: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  invoice: {} as Record<string, unknown>,
}));

vi.mock('@/lib/storage/r2-client', () => ({ getR2Config: () => ({ bucketName: 'b' }), getR2Client: () => ({ send: vi.fn() }) }));
vi.mock('@/lib/storage/r2', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/storage/r2')>(),
  uploadInvoiceXml: m.upload,
  invoiceXmlExistsForId: vi.fn(async () => false),
}));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: m.record }));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(async () => undefined),
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/ksef/submit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ksef/submit')>(),
  submitInvoice: m.submit,
  checkInvoiceStatusByReference: m.status,
  downloadKsefInvoice: m.downloadKsef,
}));
vi.mock('@/lib/ksef/submission-log', () => ({
  findOpenKsefSubmissionIntents: vi.fn(async () => []),
  promoteKsefSubmissionIntent: vi.fn(async () => false),
  abandonKsefSubmissionIntent: vi.fn(),
  recordKsefSubmissionIntent: vi.fn(),
  findKsefSessionRow: m.sessionRow,
  findSubmissionPayloads: vi.fn(async () => []),
  findTenantInvoiceByKsefNumber: vi.fn(async () => null),
  closeKsefAttempt: vi.fn(),
  markKsefSubmissionsNumberTaken: vi.fn(),
  recordKsefDuplicateCheck: vi.fn(),
  recordKsefAcceptedSession: vi.fn(),
  markKsefAttemptDuplicatePending: vi.fn(),
  recordKsefSubmissionSent: vi.fn(),
  markKsefSubmission: vi.fn(),
  findOpenKsefSubmission: m.findOpen,
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
      select: () => q, eq: () => q, in: () => q, or: () => q, update: () => q,
      maybeSingle: async () => ({ data: { ...m.invoice }, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return { from: () => q, rpc: async () => ({ data: '2026-10-03T12:00:00.000000+00:00', error: null }) };
  },
}));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: m.captureException, captureMessage: m.captureMessage, addBreadcrumb: vi.fn() }));

import { runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import { KsefInvoiceRejectedError } from '@/lib/ksef/submit';
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
const event = () => ({
  invoiceId: ID,
  tenantId: T,
  nip: '1234567890',
  environment: 'test' as const,
  invoice: faktura() as Invoice,
  sendAttemptId: ATTEMPT,
});

const recorded = () => m.record.mock.calls[0]![0] as Record<string, unknown>;
const expectAccepted = (number: string) =>
  expect(m.updateStatus).toHaveBeenCalledWith(ID, expect.objectContaining({ ksef_status: 'accepted', ksef_number: number }), T);

beforeEach(() => {
  vi.clearAllMocks();
  m.record.mockReset();
  vi.stubEnv('KSEF_ENV', 'test');
  m.upload.mockResolvedValue({ storagePath: ATTEMPT_KEY, sha256Hash: HASH, sizeBytes: 321, etag: '"e"' });
  m.submit.mockResolvedValue({ ksefNumber: 'K-1', acquisitionTimestamp: '2026-10-01T10:00:00Z', sessionReferenceNumber: 'S-1', invoiceReferenceNumber: 'R-1' });
  m.findOpen.mockResolvedValue(null);
  m.invoice = { id: ID, direction: 'outgoing', ksef_status: 'queued', ksef_number: null, ksef_environment: 'test', invoice_type: 'VAT', invoice_kind: 'regular', fa3_data: {} };
});
afterEach(() => vi.unstubAllEnvs());

describe('uzgodnienie po referencji (ponowienie po przyjęciu pliku przez KSeF)', () => {
  const openSubmission = {
    sessionReferenceNumber: 'S-9',
    invoiceReferenceNumber: 'R-9',
    xmlStoragePath: OLD_ATTEMPT_KEY,
    payloadHash: HASH,
  };

  beforeEach(() => {
    m.status.mockResolvedValue({ state: 'accepted', ksefNumber: 'K-9', acquisitionTimestamp: '2026-10-01T10:00:00Z' });
  });

  it('wiersz dostaje skrót z wpisu `sent` tej próby, a plik w magazynie ma się z nim zgadzać', async () => {
    m.findOpen.mockResolvedValue(openSubmission);

    await runSubmitInvoice(event(), ctx);

    expect(m.record).toHaveBeenCalledOnce();
    expect(recorded()).toMatchObject({
      tenantId: T,
      invoiceId: ID,
      storagePath: OLD_ATTEMPT_KEY,
      sha256Hash: HASH,
      verifyStoredBytes: true,
    });
    expectAccepted('K-9');
  });

  it('wpis `sent` bez skrótu (historia sprzed 01.10.2026): bez wiersza z przypadkowego pliku, alarm dla operatora, akceptacja zostaje', async () => {
    m.findOpen.mockResolvedValue({ ...openSubmission, payloadHash: null });

    await runSubmitInvoice(event(), ctx);

    expect(m.record).not.toHaveBeenCalled();
    expect(m.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('bez skrótu'),
      expect.objectContaining({
        tags: expect.objectContaining({ area: 'ksef.xml-documents', kind: 'no-payload-hash' }),
        extra: expect.objectContaining({ invoiceId: ID }),
      }),
    );
    expectAccepted('K-9');
  });
});

describe('świeża wysyłka', () => {
  it('skrót i rozmiar z zapisu w tej próbie: bez dodatkowego GET (plan skalowania)', async () => {
    await runSubmitInvoice(event(), ctx);

    expect(recorded()).toMatchObject({ storagePath: ATTEMPT_KEY, sha256Hash: HASH, sizeBytes: 321 });
    expect(recorded().verifyStoredBytes).toBeFalsy();
    expectAccepted('K-1');
  });

  it('konflikt dowodu po akceptacji nie cofa akceptacji; Sentry widzi błąd', async () => {
    const conflict = new Error('inny plik');
    m.record.mockRejectedValue(conflict);

    await runSubmitInvoice(event(), ctx);

    expectAccepted('K-1');
    expect(m.captureException).toHaveBeenCalledWith(conflict, expect.objectContaining({
      tags: expect.objectContaining({ area: 'ksef.xml-documents' }),
    }));
  });
});

describe('duplikat 440 rozstrzygnięty jako nasza faktura', () => {
  const duplicate = (invoiceHash: string, extensions: Record<string, string>) => new KsefInvoiceRejectedError(440, {
    code: 440,
    description: 'Duplikat',
    details: [],
    extensions,
  } as never, { invoiceHash });
  const asBase64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

  it('własna sesja: skrót i plik z wpisu tej sesji, zgodność bajtów sprawdzana przy zapisie wiersza', async () => {
    m.submit.mockRejectedValue(duplicate(asBase64(HASH), { originalKsefNumber: 'K-ORIG', originalSessionReferenceNumber: 'S-ORIG' }));
    m.sessionRow.mockResolvedValue({ status: 'sent', requestPayloadHash: HASH, xmlStoragePath: OLD_ATTEMPT_KEY });

    await runSubmitInvoice(event(), ctx);

    expect(recorded()).toMatchObject({ storagePath: OLD_ATTEMPT_KEY, sha256Hash: HASH, verifyStoredBytes: true });
    expectAccepted('K-ORIG');
  });

  it('treść zgodna z pobranym oryginałem: skrót oryginału, zgodność bajtów sprawdzana przy zapisie wiersza', async () => {
    const original = Buffer.from('<Faktura>oryginał</Faktura>');
    const originalHash = createHash('sha256').update(original).digest('hex');
    m.submit.mockRejectedValue(duplicate(asBase64(originalHash), { originalKsefNumber: 'K-ORIG' }));
    m.sessionRow.mockResolvedValue(null);
    m.downloadKsef.mockResolvedValue(original);

    await runSubmitInvoice(event(), ctx);

    expect(recorded()).toMatchObject({ sha256Hash: originalHash, verifyStoredBytes: true });
    expectAccepted('K-ORIG');
  });
});
