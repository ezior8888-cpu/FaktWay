import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { KsefAuth } from '@/lib/ksef/auth';
import type { Invoice } from '@/types/invoice';

/**
 * Decyzja D5 cyklu życia faktury (00134): plik XML kluczowany per PRÓBA
 * wysyłki (`tenant/yyyy/mm/invoiceId/sendAttemptId.xml`). Do tej zmiany każda
 * próba pisała w ten sam klucz per faktura: ponowna wysyłka po powrocie do
 * szkicu i poprawie nadpisywała plik, który już poszedł do KSeF, a uzgodnienie
 * po referencji wyliczało klucz od nowa zamiast wskazać plik tej próby.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const LEGACY_KEY = `${T}/2026/10/${ID}.xml`;
const ATTEMPT_KEY = `${T}/2026/10/${ID}/${ATTEMPT}.xml`;

const m = vi.hoisted(() => ({
  upload: vi.fn(),
  submit: vi.fn(),
  recordSent: vi.fn(),
  findOpen: vi.fn(),
  ownPath: vi.fn(),
  sessionRow: vi.fn(),
  status: vi.fn(),
  updateStatus: vi.fn(),
  listAttempts: vi.fn(),
  invoice: {} as Record<string, unknown>,
}));

vi.mock('@/lib/storage/r2-client', () => ({ getR2Config: () => ({ bucketName: 'b' }), getR2Client: () => ({ send: vi.fn() }) }));
vi.mock('@/lib/storage/r2', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/storage/r2')>(),
  uploadInvoiceXml: m.upload,
  listInvoiceAttemptXmls: m.listAttempts,
}));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(async () => undefined),
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/ksef/submit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ksef/submit')>(),
  submitInvoice: m.submit,
  checkInvoiceStatusByReference: m.status,
}));
vi.mock('@/lib/ksef/submission-log', () => ({
  // A2: bez zamiarów wysyłki do rozstrzygnięcia — runner idzie jak dotąd.
  findOpenKsefSubmissionIntents: vi.fn(async () => []),
  promoteKsefSubmissionIntent: vi.fn(async () => false),
  abandonKsefSubmissionIntent: vi.fn(),
  recordKsefSubmissionIntent: vi.fn(),
  // D-A4-1: weryfikacja cudzego 440 — domyślnie bez sesji w historii i bez znanego numeru.
  findKsefSessionRow: m.sessionRow,
  findSubmissionPayloads: vi.fn(async () => []),
  findTenantInvoiceByKsefNumber: vi.fn(async () => null),
  closeKsefAttempt: vi.fn(),
  markKsefSubmissionsNumberTaken: vi.fn(),
  recordKsefDuplicateCheck: vi.fn(),
  recordKsefAcceptedSession: vi.fn(),
  markKsefAttemptDuplicatePending: vi.fn(),
  recordKsefSubmissionSent: m.recordSent,
  markKsefSubmission: vi.fn(),
  findOpenKsefSubmission: m.findOpen,
  findOwnKsefSessionXmlPath: m.ownPath,
  isOwnKsefSession: vi.fn(async () => true),
  findSessionReferenceForKsefNumber: vi.fn(async () => null),
}));
vi.mock('@/lib/ksef/xml-generated-at', () => ({ claimXmlGeneratedAt: async () => new Date('2026-10-01T10:00:00.000Z') }));
vi.mock('@/lib/xml/validator', () => ({ validateInvoiceXml: async () => ({ valid: true, errors: [] }), InvoiceXmlSchemaError: class extends Error {} }));
// Runner
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
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: vi.fn() }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));

import { invoiceXmlAttemptKey, invoiceXmlAttemptPrefix, invoiceXmlKey, invoiceXmlKeyFor } from '@/lib/storage/r2';
import { submitInvoiceFullFlow } from '@/lib/ksef/submit-invoice-full';
import { runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import { collectInvoiceStorageKeys } from '@/lib/retention/invoice-files';
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
// Pełna faktura: runner przechodzi PRAWDZIWY przepływ (generator FA(3), PUT),
// zamockowane są tylko granice — magazyn, walidator XSD, KSeF, baza.
const event = (sendAttemptId?: string) => ({
  invoiceId: ID, tenantId: T, nip: '1234567890', environment: 'test' as const,
  invoice: faktura() as Invoice,
  ...(sendAttemptId ? { sendAttemptId } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  m.upload.mockImplementation(async (_t: string, _i: string, _d: string, _xml: string, o?: { attemptId?: string | null }) => ({
    storagePath: invoiceXmlKeyFor({ tenantId: T, invoiceId: ID, issueDate: '2026-10-01', attemptId: o?.attemptId }),
    sha256Hash: 'h'.repeat(64), sizeBytes: 10, etag: '"e"',
  }));
  m.submit.mockImplementation(async (_x: string, _a: unknown, _e: unknown, _c: unknown, hooks?: { onInvoiceSent?: (r: unknown) => Promise<void> }) => {
    await hooks?.onInvoiceSent?.({ sessionReferenceNumber: 'S-1', invoiceReferenceNumber: 'R-1' });
    return { ksefNumber: 'K-1', acquisitionTimestamp: '2026-10-01T10:00:00Z', sessionReferenceNumber: 'S-1', invoiceReferenceNumber: 'R-1' };
  });
  m.findOpen.mockResolvedValue(null);
  m.invoice = { id: ID, direction: 'outgoing', ksef_status: 'queued', ksef_number: null, ksef_environment: 'test', invoice_type: 'VAT', invoice_kind: 'regular', fa3_data: {} };
});
afterEach(() => vi.unstubAllEnvs());

describe('klucze XML', () => {
  it('per próba: tenant/yyyy/mm/invoiceId/sendAttemptId.xml; bez próby — klucz historyczny', () => {
    expect(invoiceXmlAttemptKey(T, ID, '2026-10-01', ATTEMPT)).toBe(ATTEMPT_KEY);
    expect(invoiceXmlAttemptPrefix(T, ID, '2026-10-01')).toBe(`${T}/2026/10/${ID}/`);
    expect(invoiceXmlKeyFor({ tenantId: T, invoiceId: ID, issueDate: '2026-10-01', attemptId: ATTEMPT })).toBe(ATTEMPT_KEY);
    expect(invoiceXmlKeyFor({ tenantId: T, invoiceId: ID, issueDate: '2026-10-01', attemptId: null })).toBe(LEGACY_KEY);
    expect(invoiceXmlKey(T, ID, '2026-10-01')).toBe(LEGACY_KEY);
  });

  it('identyfikator próby spoza alfabetu klucza jest odrzucany', () => {
    expect(() => invoiceXmlAttemptKey(T, ID, '2026-10-01', '../x')).toThrow('Invalid sendAttemptId');
  });
});

describe('submitInvoiceFullFlow (D5)', () => {
  it('z sendAttemptId: zapis pod kluczem próby, wpis sent zna ten plik', async () => {
    const result = await submitInvoiceFullFlow(T, ID, faktura(), {} as KsefAuth, 'test', null, null, null, ATTEMPT);

    expect(m.upload.mock.calls[0]![4]).toEqual({ attemptId: ATTEMPT });
    expect(result.xmlStoragePath).toBe(ATTEMPT_KEY);
    expect(m.recordSent).toHaveBeenCalledWith(expect.objectContaining({ xmlStoragePath: ATTEMPT_KEY }));
  });

  it('bez sendAttemptId (stare zdarzenie): klucz historyczny per faktura', async () => {
    const result = await submitInvoiceFullFlow(T, ID, faktura(), {} as KsefAuth, 'test');
    expect(m.upload.mock.calls[0]![4]).toEqual({ attemptId: null });
    expect(result.xmlStoragePath).toBe(LEGACY_KEY);
    expect(m.recordSent).toHaveBeenCalledWith(expect.objectContaining({ xmlStoragePath: LEGACY_KEY }));
  });

  // C-12: dawniej HEAD wyłączał ochronę i ponowienie nadpisywało plik. Bajty po
  // 412 porównuje `r2.ts` (`xml-storage-immutability`, `xml-submit-archive-integrity`).
  it('ponowienie tej samej próby: ten sam klucz i ten sam zapis, bez wyłączania ochrony', async () => {
    await submitInvoiceFullFlow(T, ID, faktura(), {} as KsefAuth, 'test', null, null, null, ATTEMPT);
    await submitInvoiceFullFlow(T, ID, faktura(), {} as KsefAuth, 'test', null, null, null, ATTEMPT);

    expect(m.upload.mock.calls.map((c) => c[4])).toEqual([{ attemptId: ATTEMPT }, { attemptId: ATTEMPT }]);
  });
});

describe('runner: uzgodnienie wskazuje plik próby (D5)', () => {
  it('reference-reconcile: ścieżka z wpisu sent, nie klucz wyliczony od nowa', async () => {
    m.findOpen.mockResolvedValue({ sessionReferenceNumber: 'S-9', invoiceReferenceNumber: 'R-9', xmlStoragePath: `${T}/2026/10/${ID}/stara-proba.xml` });
    m.status.mockResolvedValue({ state: 'accepted', ksefNumber: 'K-9', acquisitionTimestamp: '2026-10-01T10:00:00Z' });

    await runSubmitInvoice(event(ATTEMPT), ctx);

    expect(m.updateStatus).toHaveBeenCalledWith(ID, expect.objectContaining({
      ksef_status: 'accepted', ksef_number: 'K-9', xml_storage_path: `${T}/2026/10/${ID}/stara-proba.xml`,
    }), T);
    expect(m.submit).not.toHaveBeenCalled();
  });

  it('wpis sent sprzed 00134 (bez ścieżki): klucz historyczny', async () => {
    m.findOpen.mockResolvedValue({ sessionReferenceNumber: 'S-9', invoiceReferenceNumber: 'R-9' });
    m.status.mockResolvedValue({ state: 'accepted', ksefNumber: 'K-9' });
    await runSubmitInvoice(event(ATTEMPT), ctx);
    expect(m.updateStatus).toHaveBeenCalledWith(ID, expect.objectContaining({ xml_storage_path: LEGACY_KEY }), T);
  });

  it('własny duplikat 440 (ten sam plik — D-A4-1): plik próby z tej sesji; wpis bez ścieżki → klucz historyczny', async () => {
    const HASH_HEX = 'cd'.repeat(32);
    const dup = () => new KsefInvoiceRejectedError(440, {
      code: 440, description: 'Duplikat', details: [],
      extensions: { originalKsefNumber: 'K-ORIG', originalSessionReferenceNumber: 'S-ORIG' },
    } as never, { invoiceHash: Buffer.from(HASH_HEX, 'hex').toString('base64') });
    m.submit.mockRejectedValue(dup());
    m.sessionRow.mockResolvedValue({ status: 'sent', requestPayloadHash: HASH_HEX, xmlStoragePath: `${T}/2026/10/${ID}/proba-oryginalna.xml` });
    await runSubmitInvoice(event(ATTEMPT), ctx);
    expect(m.updateStatus).toHaveBeenCalledWith(ID, expect.objectContaining({
      ksef_number: 'K-ORIG', xml_storage_path: `${T}/2026/10/${ID}/proba-oryginalna.xml`,
    }), T);

    vi.clearAllMocks();
    m.findOpen.mockResolvedValue(null);
    m.submit.mockRejectedValue(dup());
    m.sessionRow.mockResolvedValue({ status: 'sent', requestPayloadHash: HASH_HEX, xmlStoragePath: null });
    await runSubmitInvoice(event(ATTEMPT), ctx);
    expect(m.updateStatus).toHaveBeenCalledWith(ID, expect.objectContaining({ ksef_number: 'K-ORIG', xml_storage_path: LEGACY_KEY }), T);
  });

  it('nowa wysyłka przekazuje sendAttemptId do pełnego przepływu', async () => {
    await runSubmitInvoice(event(ATTEMPT), ctx);
    expect(m.upload.mock.calls[0]![4]).toMatchObject({ attemptId: ATTEMPT });
    expect(m.updateStatus).toHaveBeenCalledWith(ID, expect.objectContaining({ xml_storage_path: ATTEMPT_KEY }), T);
  });
});

describe('retencja: pliki wszystkich prób (D5)', () => {
  const client = {
    from: () => {
      const q = { select: () => q, eq: () => q, then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok) };
      return q;
    },
  } as never;

  it('z datą wystawienia listuje folder prób i dodaje pliki do usunięcia', async () => {
    m.listAttempts.mockResolvedValue([ATTEMPT_KEY, `${T}/2026/10/${ID}/inna.xml`]);
    const keys = await collectInvoiceStorageKeys(client, { id: ID, tenant_id: T, issue_date: '2026-10-01', xml_storage_path: ATTEMPT_KEY });
    expect(m.listAttempts).toHaveBeenCalledWith(T, ID, '2026-10-01');
    expect(keys.r2.sort()).toEqual([ATTEMPT_KEY, `${T}/2026/10/${ID}/inna.xml`].sort());
  });

  it('bez daty wystawienia nie listuje; błąd listowania przerywa (nie wiem ≠ nie ma)', async () => {
    await collectInvoiceStorageKeys(client, { id: ID, tenant_id: T, xml_storage_path: LEGACY_KEY });
    expect(m.listAttempts).not.toHaveBeenCalled();
    m.listAttempts.mockRejectedValue(new Error('R2 503'));
    await expect(collectInvoiceStorageKeys(client, { id: ID, tenant_id: T, issue_date: '2026-10-01' })).rejects.toThrow('R2 503');
  });
});
