import { NonRetriableError } from '@/lib/jobs/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { Invoice } from '@/types/invoice';

/**
 * AUD-12: `xml_documents` nigdy nie było zapisywane — PDF bez kodu QR KOD I,
 * „Pobierz XML” i portal księgowej zwracały błąd. Job zapisuje teraz wiersz
 * (ścieżka, SHA-256, rozmiar) przy akceptacji.
 * AUD-13: błąd zgodności z XSD FA(3) był zwykłym błędem — 5 ponowień, potem
 * Offline24 do terminu. KSeF takiej faktury nigdy nie przyjmie.
 * AUD-14 (decyzja B3): na KSeF produkcyjnym automatyczne przejście w Offline24
 * jest wyłączone, dopóki kody QR nie są zgodne ze specyfikacją MF (#122).
 */

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  fullFlow: vi.fn(),
  findOpen: vi.fn(),
  isOwn: vi.fn(),
  mark: vi.fn(),
  record: vi.fn(),
  status: vi.fn(),
  invalidate: vi.fn(),
  sendEvent: vi.fn(),
  credentials: vi.fn(),
  health: vi.fn(),
  addOffline: vi.fn(),
  recordXml: vi.fn(),
}));

vi.mock('@/lib/ksef/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksef/client')>()),
  ksefFetch: mocks.fetch,
}));
vi.mock('@/lib/ksef/session-cache', () => ({
  ksefSessionCache: { getSession: async () => ({ accessToken: 'token' }), invalidate: mocks.invalidate },
}));
vi.mock('@/lib/ksef/rate-limiter', () => ({
  ksefRateLimiter: { enqueue: (_nip: string, fn: () => unknown) => fn() },
}));
vi.mock('@/lib/ksef/encryption', () => ({
  generateSessionEncryption: async () => ({ encryptedSymmetricKey: 'k', initializationVector: 'iv' }),
  encryptInvoiceXml: () => ({
    invoiceHash: 'h',
    invoiceSize: 1,
    encryptedInvoiceHash: 'eh',
    encryptedInvoiceSize: 1,
    encryptedInvoiceContent: 'c',
  }),
}));
vi.mock('@/lib/ksef/submission-log', () => ({
  // A2: bez zamiarów wysyłki do rozstrzygnięcia — runner idzie jak dotąd.
  findOpenKsefSubmissionIntents: vi.fn(async () => []),
  promoteKsefSubmissionIntent: vi.fn(async () => false),
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
  recordKsefSubmissionSent: mocks.record,
  markKsefSubmission: mocks.mark,
  findOpenKsefSubmission: mocks.findOpen,
  isOwnKsefSession: mocks.isOwn,
  findSessionReferenceForKsefNumber: vi.fn(async () => null),
}));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn() }));
// Krok 5: job czyta wyłącznik wysyłek autorytatywnie — tu zdjęty.
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: async () => false }));
vi.mock('@/lib/ksef/submit-invoice-full', () => ({ submitInvoiceFullFlow: mocks.fullFlow }));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: mocks.health, isKsefHealthy: async () => true }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: mocks.addOffline }));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: mocks.recordXml }));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(),
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/supabase/admin-queries', () => ({
  getTenantKsefCredentials: mocks.credentials,
  updateInvoiceStatus: mocks.status,
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: async () => {
    let isUpdate = false;
    const q = {
      select: () => q,
      eq: () => q,
      or: () => q,
      update: () => { isUpdate = true; return q; },
      maybeSingle: async () => ({
        data: isUpdate
          ? { id: '11111111-1111-4111-8111-111111111111' }
          // Faktura w bazie = treść zdarzenia (kontrola z #63), środowisko „test”.
          : {
              id: '11111111-1111-4111-8111-111111111111', ksef_status: 'sending', ksef_number: null,
              ksef_environment: 'test', invoice_kind: 'regular', invoice_type: 'VAT', internal_number: 'FV/1/2026',
              fa3_data: { internalNumber: 'FV/1/2026', type: 'VAT', issueDate: '2026-10-01' },
            },
        error: null,
      }),
    };
    // Przejęcie wysyłki (AUD-10, 00124) — w tych testach zawsze wolne.
    return { from: () => q, rpc: async (fn: string) => ({ data: fn === 'claim_ksef_send' ? '2026-10-02T12:00:00.000000+00:00' : null, error: null }), };
  },
}));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));

import { InvoiceXmlSchemaError } from '@/lib/xml/validator';
import { onSubmitInvoiceExhausted, runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import type { KsefAuth } from '@/lib/ksef/auth';

const XADES = { type: 'xades', nip: '1234567890', certificatePem: 'fixture-pem' } as unknown as KsefAuth;
const ctx: JobContext = {
  attempt: 1,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: mocks.sendEvent, scheduleAfter: vi.fn() },
};
const zdarzenie = {
  invoiceId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  nip: '1234567890',
  environment: 'test' as const,
  invoice: { internalNumber: 'FV/1/2026', type: 'VAT', issueDate: '2026-10-01' } as Invoice,
};
const ACCEPTED = {
  ksefNumber: '1234567890-20261001-0100A0B0C0D0-1A',
  xmlStoragePath: 'tenants/aaaa/2026/10/inv.xml',
  xmlSha256Hash: 'a'.repeat(64),
  xmlSizeBytes: 2048,
  acquisitionTimestamp: '2026-10-01T10:00:00Z',
  sessionReferenceNumber: 'S-1',
  invoiceReferenceNumber: 'I-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.credentials.mockResolvedValue(XADES);
  mocks.findOpen.mockResolvedValue(null);
  mocks.health.mockResolvedValue({ offline: false });
  mocks.fullFlow.mockResolvedValue(ACCEPTED);
  vi.stubEnv('KSEF_ENV', 'test');
});
afterEach(() => vi.unstubAllEnvs());

describe('xml_documents przy akceptacji (AUD-12)', () => {
  it('zapisuje ścieżkę, SHA-256 i rozmiar XML przyjętego przez KSeF', async () => {
    await runSubmitInvoice(zdarzenie, ctx);
    expect(mocks.recordXml).toHaveBeenCalledWith({
      tenantId: zdarzenie.tenantId,
      invoiceId: zdarzenie.invoiceId,
      storagePath: ACCEPTED.xmlStoragePath,
      sha256Hash: ACCEPTED.xmlSha256Hash,
      sizeBytes: ACCEPTED.xmlSizeBytes,
      // C-12: świeża wysyłka zapisała te bajty w tym przebiegu — bez dodatkowego GET.
      verifyStoredBytes: false,
    });
  });

  it('błąd zapisu nie cofa akceptacji', async () => {
    mocks.recordXml.mockRejectedValue(new Error('fixture db'));
    await expect(runSubmitInvoice(zdarzenie, ctx)).resolves.toMatchObject({ success: true });
  });
});

describe('błąd XSD bez ponowień (AUD-13)', () => {
  it('niezgodność ze schematem FA(3) kończy się od razu, bez retry i bez Offline24', async () => {
    mocks.fullFlow.mockRejectedValue(new InvoiceXmlSchemaError(['Linia 12: element P_15 niepoprawny']));
    await expect(runSubmitInvoice(zdarzenie, ctx)).rejects.toBeInstanceOf(NonRetriableError);
  });
});

describe('Offline24 na KSeF produkcyjnym (AUD-14)', () => {
  it('PROD: zła sonda zdrowia NIE parkuje faktury w Offline24 — idzie zwykła wysyłka', async () => {
    vi.stubEnv('KSEF_ENV', 'production');
    mocks.health.mockResolvedValue({ offline: true, isMfOutage: false, reason: 'ping' });
    // Zdarzenie z tego samego środowiska co konfiguracja (#63).
    await runSubmitInvoice({ ...zdarzenie, environment: 'production' }, ctx);
    expect(mocks.addOffline).not.toHaveBeenCalled();
    expect(mocks.fullFlow).toHaveBeenCalled();
  });

  // Decyzja 02.10.2026 (#71): Offline24 wstrzymany także na TEST.
  it('TEST: bez sondy zdrowia i bez Offline24 — zwykła wysyłka', async () => {
    mocks.health.mockResolvedValue({ offline: true, isMfOutage: false, reason: 'ping' });
    await runSubmitInvoice(zdarzenie, ctx);
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.addOffline).not.toHaveBeenCalled();
    expect(mocks.fullFlow).toHaveBeenCalled();
  });

  it('PROD: po wyczerpaniu prób nie parkuje w Offline24', async () => {
    vi.stubEnv('KSEF_ENV', 'production');
    await onSubmitInvoiceExhausted(new Error('ECONNRESET'), zdarzenie, ctx);
    expect(mocks.addOffline).not.toHaveBeenCalled();
  });
});
