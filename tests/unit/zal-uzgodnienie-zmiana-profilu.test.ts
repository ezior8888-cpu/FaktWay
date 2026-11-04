import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { Invoice } from '@/types/invoice';
import type { AdvanceInvoiceData } from '@/types/invoice-types';
import { sellerPartyFromSellerData } from '@/lib/invoices/map-buyer-party';

import { jsonb, memoryDb, type MemoryDb, type Row } from './helpers/ponowienie-specjalne-baza';

/**
 * A4b PR2a (§2.5): granica wysyłki sprawdza sprzedawcę zaliczki (ZAL) także
 * z ŻYWEGO profilu firmy. Do tej zmiany robiła to przed każdym krokiem joba,
 * również przed uzgodnieniem wcześniejszej wysyłki: firma, która po wysłaniu
 * zaliczki zmieniła nazwę w ustawieniach, nie mogła jej już uzgodnić —
 * „Tylko uzgodnij” i cron I5 kończyły jako INVALID_DOCUMENT, choć KSeF mógł
 * mieć plik. Uzgodnienie nie wysyła nowego pliku, więc profil firmy nie ma
 * tam znaczenia; przed każdym POST (także po zamknięciu STALE) sprawdzenie
 * zostaje.
 *
 * Prawdziwy runner i PRAWDZIWA granica (`assertSubmitReferences`); atrapy:
 * baza (projekcja kolumn jak PostgREST), HTTP KSeF (status po referencji),
 * pełny przepływ wysyłki i dziennik wysyłek.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const NIP = '1234567890';

const m = vi.hoisted(() => ({
  fullFlow: vi.fn(),
  findOpen: vi.fn(),
  status: vi.fn(),
  markSubmission: vi.fn(),
  updateStatus: vi.fn(),
  captureMessage: vi.fn(),
  intents: vi.fn(),
  promote: vi.fn(),
  sessionInvoices: vi.fn(),
  rpcCalls: [] as string[],
  db: null as unknown as MemoryDb,
}));

vi.mock('@/lib/xml/invoice-calculator', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/xml/invoice-calculator')>(),
  // Fikcyjny NIP 1234567890 nie ma poprawnej sumy kontrolnej — jak w innych testach granicy.
  validateNipChecksum: () => true,
}));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: async () => false }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));
vi.mock('@/lib/auth/ksef-verification-guard', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/auth/ksef-verification-guard')>(),
  requireKsefVerificationForBackgroundJob: async () => undefined,
}));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: async () => ({ offline: false }) }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@/lib/ksef/submit-invoice-full', () => ({ submitInvoiceFullFlow: m.fullFlow }));
// Bez atrapy `@/lib/ksef/submit-reference-boundary` — granica jest prawdziwa.
vi.mock('@/lib/ksef/submit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ksef/submit')>(),
  checkInvoiceStatusByReference: m.status,
  listSessionInvoicesAfterClose: m.sessionInvoices,
}));
vi.mock('@/lib/ksef/submission-log', () => ({
  // A2: domyślnie bez zamiarów wysyłki do rozstrzygnięcia (przypadki niżej je ustawiają).
  findOpenKsefSubmissionIntents: m.intents,
  promoteKsefSubmissionIntent: m.promote,
  abandonKsefSubmissionIntent: vi.fn(),
  recordKsefSubmissionIntent: vi.fn(),
  // D-A4-1: weryfikacja cudzego 440 — domyślnie bez sesji w historii i bez znanego numeru.
  findKsefSessionRow: vi.fn(async () => null),
  findSubmissionPayloads: vi.fn(async () => []),
  findTenantInvoiceByKsefNumber: vi.fn(async () => null),
  closeKsefAttempt: vi.fn(),
  markKsefSubmissionsNumberTaken: vi.fn(),
  recordKsefDuplicateCheck: vi.fn(),
  recordKsefAcceptedSession: vi.fn(),
  markKsefAttemptDuplicatePending: vi.fn(),
  recordKsefSubmissionSent: vi.fn(),
  markKsefSubmission: m.markSubmission,
  findOpenKsefSubmission: m.findOpen,
  findOwnKsefSessionXmlPath: vi.fn(async () => null),
  isOwnKsefSession: vi.fn(async () => false),
  findSessionReferenceForKsefNumber: vi.fn(async () => null),
}));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn(), assertJobIdentity: vi.fn() }));
vi.mock('@/lib/supabase/admin-queries', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/supabase/admin-queries')>(),
  getTenantKsefCredentials: async () => ({ type: 'token', nip: NIP, token: 't' }),
  updateInvoiceStatus: m.updateStatus,
}));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => m.db }));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: vi.fn() }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: m.captureMessage, addBreadcrumb: vi.fn() }));

import { KSEF_SUBMISSION_STALE_CODE, runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import { classifySendError } from '@/lib/ksef/send-error-codes';
import { KsefApiError } from '@/lib/ksef/client';

// Zaliczka jak w `ksef-submit-reference-boundary.test.ts` (koperta i zamrożony sprzedawca).
const address = { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' };
const seller = { nip: NIP, name: 'Fixture seller', address };
const sellerParty = sellerPartyFromSellerData(seller);
const advance = {
  invoiceType: 'advance', internalNumber: 'ZAL/1', seller,
  issueDate: '2026-09-28', advanceAmount: 123, totalContractAmount: 1000,
  vatRate: '23', description: 'Zaliczka na usługę',
  buyer: {
    type: 'b2b', idType: 'nip', nip: '9876543210', name: 'Fixture buyer',
    address: { countryCode: 'PL', addressLine1: 'ul. Odbiorcy 2', addressLine2: '00-002 Warszawa' },
  },
  paymentMethod: 'transfer', paymentDueDate: '2026-09-28', bankAccount: '11111111111111111111111111',
  taxAnnotations: { cashMethod: 2, splitPayment: 2 },
} as AdvanceInvoiceData;
const eventInvoice = {
  internalNumber: 'ZAL/1', type: 'ZAL', issueDate: '2026-09-28', seller: sellerParty,
  advanceEnvelope: advance,
  annotations: advance.taxAnnotations,
  payment: { method: 'transfer', dueDate: advance.paymentDueDate, bankAccount: advance.bankAccount },
} as Invoice;

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};
/** Zdarzenie po przejściu przez jsonb zlecenia pg-boss. */
const event = (extra: Record<string, unknown> = {}) => jsonb({
  invoiceId: ID, tenantId: TENANT, nip: NIP, environment: 'test' as const, sendAttemptId: ATTEMPT,
  invoice: eventInvoice, advanceData: advance,
  ...extra,
});
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const sentRow = (attemptedAt: string) => ({ sessionReferenceNumber: 'SES-1', invoiceReferenceNumber: 'REF-1', attemptedAt });
const ACCEPTED = { ksefNumber: 'K-1', xmlStoragePath: 'x.xml', xmlSha256Hash: 'h', xmlSizeBytes: 1, sessionReferenceNumber: 'S-2', invoiceReferenceNumber: 'R-2' };

async function failing(run: Promise<unknown>): Promise<Error> {
  return run.then(() => { throw new Error('oczekiwano błędu'); }, (e: unknown) => e as Error);
}

const tenantReads = () => m.db.reads.filter((r) => r.table === 'tenants');

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  m.fullFlow.mockResolvedValue(ACCEPTED);
  // Tylko mockResolvedValue: po naprawie runner pyta o otwarty wpis także przed granicą.
  m.findOpen.mockResolvedValue(null);
  m.intents.mockResolvedValue([]);
  m.promote.mockResolvedValue(false);
  m.sessionInvoices.mockResolvedValue([]);
  m.rpcCalls = [];
  const invoice: Row = jsonb({
    id: ID, tenant_id: TENANT, direction: 'outgoing',
    // Ponowiona przez `requeue_ksef_send` (była failed po wysyłce, która mogła dojść do KSeF).
    ksef_status: 'queued', ksef_number: null, ksef_environment: null,
    invoice_kind: 'advance', invoice_type: 'ZAL', internal_number: 'ZAL/1', issue_date: '2026-09-28',
    parent_invoice_id: null, advance_invoice_ids: [],
    // Zamrożone przy wystawieniu (00132): treść równa zdarzeniu, sprzedawca jak w kopercie.
    fa3_data: eventInvoice, seller_nip: NIP, seller_data: sellerParty, special_data: null,
  });
  m.db = memoryDb(
    {
      invoices: [invoice],
      // Profil firmy zmieniony PO wysłaniu zaliczki — reszta danych bez zmian.
      tenants: [{ id: TENANT, nip: NIP, name: 'Nowa nazwa', address_json: address }],
    },
    (fn) => {
      m.rpcCalls.push(fn);
      return {
        data: fn === 'ksef_has_contact_evidence' ? true : '2026-10-03T12:00:00.000000+00:00',
        error: null,
      };
    },
  );
});
afterEach(() => vi.unstubAllEnvs());

describe('ZAL po zmianie profilu firmy: uzgodnienie bez żywego profilu, POST z nim (A4b PR2a)', () => {
  it('„tylko uzgodnij” z otwartym wpisem sent → status po referencji, faktura przyjęta, profil firmy nieczytany', async () => {
    m.findOpen.mockResolvedValue(sentRow(hoursAgo(5)));
    m.status.mockResolvedValue({ state: 'accepted', ksefNumber: 'K-UZG', acquisitionTimestamp: '2026-10-01T10:00:00Z' });

    await expect(runSubmitInvoice(event({ reconcileOnly: true }), ctx)).resolves.toMatchObject({ success: true, ksefNumber: 'K-UZG' });

    expect(m.status).toHaveBeenCalledTimes(1);
    expect(m.updateStatus).toHaveBeenCalledWith(ID, expect.objectContaining({ ksef_status: 'accepted', ksef_number: 'K-UZG' }), TENANT);
    expect(m.fullFlow).not.toHaveBeenCalled();
    expect(tenantReads()).toHaveLength(0);
  });

  it('pełne zdarzenie ze świeżym wpisem sent → uzgodnione po referencji, bez nowej wysyłki', async () => {
    m.findOpen.mockResolvedValue(sentRow(hoursAgo(1)));
    m.status.mockResolvedValue({ state: 'accepted', ksefNumber: 'K-UZG', acquisitionTimestamp: '2026-10-01T10:00:00Z' });

    await expect(runSubmitInvoice(event(), ctx)).resolves.toMatchObject({ success: true, ksefNumber: 'K-UZG' });

    expect(m.status).toHaveBeenCalledTimes(1);
    expect(m.updateStatus).toHaveBeenCalledWith(ID, expect.objectContaining({ ksef_status: 'accepted', ksef_number: 'K-UZG' }), TENANT);
    expect(m.fullFlow).not.toHaveBeenCalled();
    expect(tenantReads()).toHaveLength(0);
  });

  it('strażnik: bez otwartego wpisu, pełna wysyłka → INVALID_DOCUMENT przed KSeF (profil firmy sprawdzony)', async () => {
    const error = await failing(runSubmitInvoice(event(), ctx));
    expect(error.name).toBe('NonRetriableError');
    expect(error.message).toContain('manual reconciliation');
    expect(classifySendError(error).code).toBe('INVALID_DOCUMENT');
    expect(m.status).not.toHaveBeenCalled();
    expect(m.fullFlow).not.toHaveBeenCalled();
    expect(tenantReads().length).toBeGreaterThan(0);
    // Odmowa jeszcze przed przejęciem wysyłki — pominięcie profilu jest warunkowe, nie bezwarunkowe.
    expect(m.rpcCalls).not.toContain('claim_ksef_send');
  });

  it('„tylko uzgodnij” bez otwartego wpisu (wpis zamknięty wcześniej) → RESULT_UNCERTAIN bez czytania profilu firmy', async () => {
    // Np. ponowienie pg-boss po próbie, która zamknęła wpis jako STALE — dowód kontaktu zostaje.
    const error = await failing(runSubmitInvoice(event({ reconcileOnly: true }), ctx));
    expect(classifySendError(error).code).toBe('RESULT_UNCERTAIN');
    expect(m.fullFlow).not.toHaveBeenCalled();
    expect(tenantReads()).toHaveLength(0);
  });

  it('pełne zdarzenie z otwartym zamiarem intent → zamiar rozstrzygnięty, uzgodnienie po referencji, bez czytania profilu', async () => {
    m.intents.mockResolvedValue([{ sessionReferenceNumber: 'SES-I', payloadHash: null, attemptedAt: hoursAgo(1) }]);
    m.sessionInvoices.mockResolvedValue([{ referenceNumber: 'REF-I', invoiceNumber: 'ZAL/1', invoiceHash: 'x', statusCode: 200 }]);
    m.promote.mockImplementation(async () => {
      // Zamiar awansowany do wpisu sent — od tej chwili jest otwarta wysyłka.
      m.findOpen.mockResolvedValue({ sessionReferenceNumber: 'SES-I', invoiceReferenceNumber: 'REF-I', attemptedAt: hoursAgo(1) });
      return true;
    });
    m.status.mockResolvedValue({ state: 'accepted', ksefNumber: 'K-INT', acquisitionTimestamp: '2026-10-01T10:00:00Z' });

    await expect(runSubmitInvoice(event(), ctx)).resolves.toMatchObject({ success: true, ksefNumber: 'K-INT' });

    expect(m.promote).toHaveBeenCalledWith(expect.objectContaining({ invoiceReferenceNumber: 'REF-I' }));
    expect(m.fullFlow).not.toHaveBeenCalled();
    expect(tenantReads()).toHaveLength(0);
  });

  it('wpis sent sprzed 3 dni + 404: zamknięty jako STALE, potem granica przed POST odmawia (INVALID_DOCUMENT), bez wysyłki', async () => {
    m.findOpen.mockResolvedValue(sentRow(hoursAgo(72)));
    m.status.mockRejectedValue(new KsefApiError(404, 'x', 'Not found'));

    const error = await failing(runSubmitInvoice(event(), ctx));

    expect(m.status).toHaveBeenCalledTimes(1);
    expect(m.markSubmission).toHaveBeenCalledWith(expect.objectContaining({
      invoiceReferenceNumber: 'REF-1', status: 'rejected', errorCode: KSEF_SUBMISSION_STALE_CODE,
    }));
    expect(error.name).toBe('NonRetriableError');
    expect(classifySendError(error).code).toBe('INVALID_DOCUMENT');
    expect(m.fullFlow).not.toHaveBeenCalled();
    // Żywy profil czytany raz — dopiero przed POST, po zamknięciu wpisu STALE.
    expect(tenantReads()).toHaveLength(1);
  });
});
