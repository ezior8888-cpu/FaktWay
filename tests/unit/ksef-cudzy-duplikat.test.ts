import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { Invoice } from '@/types/invoice';
import type { FakeKsef, MemoryDb, Row } from './helpers/ksef-pelna-sciezka';

/**
 * D-A4-1 (decyzja Bartosza 04.10.2026, plan „zero zgubionych faktur”): KSeF
 * odpowiada 440 „duplikat”, a sesji oryginału nie ma w naszej historii.
 * Dotąd: `failed KSEF_DUPLICATE_RECONCILE` — ślepa uliczka dla klienta
 * i operatora. Teraz runner pobiera oryginał (`GET /invoices/ksef/{numer}`)
 * i rozstrzyga:
 *   - plik identyczny z naszym → nasza faktura, `accepted` z numerem oryginału;
 *   - oryginał z innego programu (SystemInfo) → `KSEF_NUMBER_TAKEN`: klient
 *     wraca do szkicu i wystawia z nowym numerem (wpisy duplikatu przestają
 *     być dowodem kontaktu);
 *   - oryginał z FaktWay o innej treści, numer KSeF znany w innej fakturze,
 *     brak uprawnienia do pobrania → operator (`KSEF_DUPLICATE_RECONCILE`);
 *   - chwilowa awaria pobrania → ponowienie samej weryfikacji, bez drugiej wysyłki.
 * Ta sama weryfikacja przy 440 w ścieżce uzgadniania po referencji.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const NUMBER = 'FV 2026/10/001';
const GENERATED_AT = new Date('2026-10-01T10:00:00.000Z');

const m = vi.hoisted(() => ({
  ksef: null as unknown as FakeKsef,
  mem: { db: {}, failWrite: null } as MemoryDb,
  storage: new Map<string, string>(),
  updateStatus: vi.fn(),
  invalidate: vi.fn(),
  captureMessage: vi.fn(),
  storageReadFails: false,
  archiveFails: false,
}));

vi.mock('@/lib/ksef/client', async (orig) =>
  (await import('./helpers/ksef-pelna-sciezka')).ksefClientModule(await orig(), () => m.ksef));
vi.mock('@/lib/ksef/encryption', async () => (await import('./helpers/ksef-pelna-sciezka')).encryptionModule());
vi.mock('@/lib/supabase/admin', async () => (await import('./helpers/ksef-pelna-sciezka')).adminClientModule(() => m.mem));
vi.mock('@/lib/ksef/session-cache', () => ({
  ksefSessionCache: { getSession: async () => ({ accessToken: 'token' }), invalidate: m.invalidate },
}));
vi.mock('@/lib/ksef/rate-limiter', () => ({
  ksefRateLimiter: { enqueue: (_nip: string, fn: () => unknown) => fn() },
}));
vi.mock('@/lib/storage/r2-client', () => ({ getR2Config: () => ({ bucketName: 'b' }), getR2Client: () => ({ send: vi.fn() }) }));
vi.mock('@/lib/storage/r2', async (orig) => {
  const real = await orig<typeof import('@/lib/storage/r2')>();
  return {
    ...real,
    uploadInvoiceXml: async (tenantId: string, invoiceId: string, issueDate: string, xml: string, o?: { attemptId?: string | null }) => {
      const storagePath = real.invoiceXmlKeyFor({ tenantId, invoiceId, issueDate, attemptId: o?.attemptId });
      m.storage.set(storagePath, xml);
      const { sha256Hex } = await import('./helpers/ksef-pelna-sciezka');
      return { storagePath, sha256Hash: sha256Hex(xml), sizeBytes: xml.length, etag: '"e"' };
    },
    invoiceXmlExistsForId: async () => false,
    // Archiwum bajtów oryginału (`archiveImportedKsefXml`, D-A4-1b-3 PR A).
    uploadToR2IfAbsent: async (key: string, body: Buffer) => {
      if (m.archiveFails) throw new Error('R2 niedostępne (zapis)');
      if (m.storage.has(key)) return false;
      m.storage.set(key, body.toString('utf8'));
      return true;
    },
    downloadFromR2: async (key: string) => {
      const xml = m.storage.get(key);
      if (xml === undefined) throw new Error(`brak pliku ${key}`);
      return Buffer.from(xml, 'utf8');
    },
    downloadInvoiceXml: async (path: string) => {
      if (m.storageReadFails) throw new Error('R2 niedostępne');
      const xml = m.storage.get(path);
      if (xml === undefined) throw new Error(`brak pliku ${path}`);
      return xml;
    },
  };
});
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(async () => undefined),
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/ksef/xml-generated-at', () => ({ claimXmlGeneratedAt: async () => new Date('2026-10-01T10:00:00.000Z') }));
vi.mock('@/lib/xml/validator', () => ({ validateInvoiceXml: async () => ({ valid: true, errors: [] }), InvoiceXmlSchemaError: class extends Error {} }));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: async () => false }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: async () => ({ offline: false }) }));
vi.mock('@/lib/ksef/health-status', () => ({ isKsefHealthy: async () => true }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@/lib/ksef/submit-reference-boundary', () => ({ assertSubmitReferences: async () => 'regular' }));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn(), assertJobIdentity: vi.fn() }));
vi.mock('@/lib/supabase/admin-queries', async (orig) => ({
  ...await orig<typeof import('@/lib/supabase/admin-queries')>(),
  getTenantKsefCredentials: async () => ({ type: 'token', nip: '1234567890', token: 't' }),
  updateInvoiceStatus: m.updateStatus,
}));
// Wiersz faktury, przejęcie wysyłki (00124) i dowód kontaktu — klient z `@/lib/supabase/server`.
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: async () => {
    const q = {
      select: () => q, eq: () => q, in: () => q, or: () => q, update: () => q,
      maybeSingle: async () => ({
        data: { id: ID, direction: 'outgoing', ksef_status: 'sending', ksef_number: null, ksef_environment: 'test',
          invoice_type: 'VAT', invoice_kind: 'regular', internal_number: NUMBER, fa3_data: {} },
        error: null,
      }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return {
      from: () => q,
      rpc: async (fn: string) => fn === 'ksef_has_contact_evidence'
        ? { data: (m.mem.db.ksef_submissions ?? []).some((r) => ['intent', 'sent', 'accepted', 'duplicate'].includes(String(r.status))), error: null }
        : { data: '2026-10-03T12:00:00.000000+00:00', error: null },
    };
  },
}));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: vi.fn() }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: m.captureMessage, addBreadcrumb: vi.fn() }));

import { NonRetriableError, RetryAfterError } from '@/lib/jobs/errors';
import { runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import { classifySendError } from '@/lib/ksef/send-error-codes';
import { invoiceXmlKeyFor } from '@/lib/storage/r2';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';
import { freshKsef, SEEDED_ACQUISITION, seedKsefInvoice, sha256Hex } from './helpers/ksef-pelna-sciezka';
import {
  KSEF_ORIGINAL_ALARM_KINDS,
  ORIGINAL_GATE_RULES,
  mergeDuplicateCheck,
  parseDuplicateCheck,
  type KsefDuplicateCheck,
  type KsefOriginalRelease,
} from '@/lib/ksef/duplicate-check';
import { DUPLICATE_DECISION_TEXTS, duplicateOriginalOffer } from '@/lib/ksef/duplicate-decision';

const faktura = (unitPriceNet = 100) => finalizeInvoice({
  internalNumber: NUMBER,
  type: 'VAT',
  issueDate: '2026-10-01',
  saleDate: '2026-10-01',
  seller: { nip: '5260001246', name: 'ACME', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
  buyer: { nip: '5252241585', name: 'Klient', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '02-001 Warszawa' } },
  lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet, vatRate: '23' }],
  payment: { currency: 'PLN', dueDate: '2026-10-15', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
});

/** Dokładnie ten plik, który runner wygeneruje dla faktury (ta sama data wytworzenia). */
const ourXml = (unitPriceNet = 100) => generateFA3Xml(faktura(unitPriceNet) as Invoice, { generatedAt: GENERATED_AT });
const fromOtherProgram = (xml: string) => xml
  .replace(/<SystemInfo>[^<]*<\/SystemInfo>/, '<SystemInfo>Inny Program 2.0</SystemInfo>')
  .replace(/<P_15>[^<]*<\/P_15>/, '<P_15>999.99</P_15>');
const withOtherHeaderDate = (xml: string) => xml
  .replace(/<DataWytworzeniaFa>[^<]*<\/DataWytworzeniaFa>/, '<DataWytworzeniaFa>2026-09-01T08:00:00Z</DataWytworzeniaFa>');

const event = () => ({
  invoiceId: ID, tenantId: T, nip: '1234567890', environment: 'test' as const,
  invoice: faktura() as Invoice, sendAttemptId: ATTEMPT,
});
const ctx = (attempt: number): JobContext => ({
  attempt,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
});
const failing = (run: Promise<unknown>) => run.then(() => { throw new Error('oczekiwano błędu'); }, (e: unknown) => e as Error);

const submissions = () => (m.mem.db.ksef_submissions ?? []) as Row[];
const accepted = () => m.updateStatus.mock.calls.find(([, p]) => (p as Row).ksef_status === 'accepted')?.[1] as Row | undefined;
const evidence = () => submissions().some((r) => ['intent', 'sent', 'accepted', 'duplicate'].includes(String(r.status)));
const ATTEMPT_KEY = () => invoiceXmlKeyFor({ tenantId: T, invoiceId: ID, issueDate: '2026-10-01', attemptId: ATTEMPT });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  m.ksef = freshKsef();
  m.mem = { db: { ksef_submissions: [], invoices: [] }, failWrite: null };
  m.storage = new Map();
  m.storageReadFails = false;
  m.archiveFails = false;
});
afterEach(() => vi.unstubAllEnvs());

describe('D-A4-1: cudzy 440 — weryfikacja treści oryginału z KSeF', () => {
  it('oryginał z innego programu → KSEF_NUMBER_TAKEN z danymi oryginału; wpisy duplikatu nie są już dowodem kontaktu', async () => {
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: 'K-OBCA', xml: fromOtherProgram(ourXml()) });

    const error = await failing(runSubmitInvoice(event(), ctx(0)));

    expect(error).toBeInstanceOf(NonRetriableError);
    expect(classifySendError(error).code).toBe('KSEF_NUMBER_TAKEN');
    expect(error.message).toContain('K-OBCA');
    expect(error.message).toContain('999.99');
    expect(m.ksef.invoicePosts).toBe(1);
    expect(submissions().map((r) => r.status)).toEqual(['number_taken']);
    expect(evidence()).toBe(false);
  });

  it('ten sam plik w sesji spoza historii (np. sprzed 00099) → nasza faktura: accepted z numerem oryginału, wpis z sesją dla UPO', async () => {
    seedKsefInvoice(m.ksef, { session: 'S-STARA', ksefNumber: 'K-STARA', xml: ourXml() });

    await runSubmitInvoice(event(), ctx(0));

    expect(accepted()).toMatchObject({ ksef_status: 'accepted', ksef_number: 'K-STARA', xml_storage_path: ATTEMPT_KEY() });
    expect(submissions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ session_reference_number: 'S-STARA', status: 'accepted', response_ksef_number: 'K-STARA' }),
      expect.objectContaining({ session_reference_number: 'S-1', status: 'duplicate' }),
    ]));
  });

  it('440 przy uzgadnianiu otwartego wpisu sent (np. po timeoucie pollingu) → ta sama weryfikacja, bez wysyłki', async () => {
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: 'K-OBCA', xml: fromOtherProgram(ourXml()) });
    // Nasza wcześniejsza wysyłka: KSeF rozstrzygnął ją jako 440 po tym, jak polling się skończył.
    const our = ourXml();
    m.ksef.sessions.set('S-9', { open: false, invoices: [{
      referenceNumber: 'I-9', invoiceNumber: NUMBER, invoiceHash: Buffer.from(sha256Hex(our), 'hex').toString('base64'),
      code: 440, ksefNumber: null, xml: our, originalSession: 'S-OBCA', originalKsef: 'K-OBCA',
    }] });
    const ourPath = `${T}/2026/10/${ID}/wczesniejsza-proba.xml`;
    m.storage.set(ourPath, our);
    m.mem.db.ksef_submissions = [{
      id: 'row-9', tenant_id: T, invoice_id: ID, submission_type: 'online', status: 'sent',
      session_reference_number: 'S-9', invoice_reference_number: 'I-9', request_payload_hash: sha256Hex(our),
      xml_storage_path: ourPath, attempted_at: new Date().toISOString(),
    }];

    const error = await failing(runSubmitInvoice(event(), ctx(1)));

    expect(classifySendError(error).code).toBe('KSEF_NUMBER_TAKEN');
    expect(m.ksef.invoicePosts).toBe(0);
    expect(submissions().map((r) => r.status)).toEqual(['number_taken']);
  });

  it('chwilowa awaria pobrania → ponowienie samej weryfikacji: wpis zostaje otwarty, druga próba nie wysyła pliku', async () => {
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: 'K-OBCA', xml: fromOtherProgram(ourXml()) });
    m.ksef.downloadFailure = { status: 503 };

    const first = await failing(runSubmitInvoice(event(), ctx(0)));
    expect(first).toBeInstanceOf(RetryAfterError);
    // Po wyczerpaniu ponowień: do uzgodnienia przez operatora, nie „KSeF niedostępny” z automatem.
    expect(classifySendError(first).code).toBe('KSEF_DUPLICATE_RECONCILE');
    expect(submissions().map((r) => r.status)).toEqual(['sent']);

    m.ksef.downloadFailure = null;
    const second = await failing(runSubmitInvoice(event(), ctx(1)));
    expect(classifySendError(second).code).toBe('KSEF_NUMBER_TAKEN');
    expect(m.ksef.invoicePosts).toBe(1);
  });

  it('brak uprawnienia do pobrania (403) → operator; wpis zostaje otwarty, więc „Tylko uzgodnij” powtórzy weryfikację', async () => {
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: 'K-OBCA', xml: fromOtherProgram(ourXml()) });
    m.ksef.downloadFailure = { status: 403 };

    const error = await failing(runSubmitInvoice(event(), ctx(0)));

    expect(error).toBeInstanceOf(NonRetriableError);
    expect(classifySendError(error).code).toBe('KSEF_DUPLICATE_RECONCILE');
    expect(submissions().map((r) => r.status)).toEqual(['sent']);
  });

  // D-A4-1b-3 PR B (decyzja Bartosza 07.10.2026 (1)): przy znanym numerze runner
  // też pobiera oryginał — klient decyduje, widząc dane K i odnośnik do dokumentu Y.
  // Dlatego `downloads` 0 → 1; kod i numer dokumentu Y w komunikacie zostają.
  it('numer KSeF oryginału należy do innej faktury tej firmy w FaktWay → do decyzji klienta, oryginał pobrany', async () => {
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: 'K-OBCA', xml: fromOtherProgram(ourXml()) });
    m.mem.db.invoices = [{ id: 'inna', tenant_id: T, direction: 'outgoing', ksef_status: 'accepted', ksef_number: 'K-OBCA', internal_number: 'FV/INNA/1' }];

    const error = await failing(runSubmitInvoice(event(), ctx(0)));

    expect(classifySendError(error).code).toBe('KSEF_DUPLICATE_RECONCILE');
    expect(error.message).toContain('FV/INNA/1');
    expect(m.ksef.downloads).toBe(1);
  });

  it('D-A4-1b-3 (A0): numer KSeF oryginału ma tylko faktura PRZYCHODZĄCA firmy → to nie jest „znany numer”; weryfikacja treści jak zwykle', async () => {
    // Faktura zakupowa z tym numerem KSeF (np. sprzedaż firmy samej sobie
    // odebrana skrzynką) nie jest zapisem naszej sprzedaży — nie może
    // zatrzymać porównania treści oryginału.
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: 'K-OBCA', xml: fromOtherProgram(ourXml()) });
    m.mem.db.invoices = [{ id: 'zakup', tenant_id: T, direction: 'incoming', ksef_number: 'K-OBCA', internal_number: 'FZ/1' }];

    const error = await failing(runSubmitInvoice(event(), ctx(0)));

    expect(m.ksef.downloads).toBe(1);
    expect(classifySendError(error).code).toBe('KSEF_NUMBER_TAKEN');
    expect(error.message).not.toContain('FZ/1');
  });

  it('nasza sesja w historii, ale treść faktury się zmieniła (np. po powrocie do szkicu) → nie przyjmujemy numeru starej treści', async () => {
    const old = ourXml(150);
    seedKsefInvoice(m.ksef, { session: 'S-STARA', ksefNumber: 'K-STARA', xml: old });
    m.mem.db.ksef_submissions = [{
      id: 'row-old', tenant_id: T, invoice_id: ID, submission_type: 'online', status: 'abandoned',
      session_reference_number: 'S-STARA', invoice_reference_number: null, request_payload_hash: sha256Hex(old),
      attempted_at: new Date(Date.now() - 86_400_000).toISOString(),
    }];

    const error = await failing(runSubmitInvoice(event(), ctx(0)));

    expect(accepted()).toBeUndefined();
    expect(classifySendError(error).code).toBe('KSEF_DUPLICATE_RECONCILE');
  });

  it('oryginał z FaktWay z inną datą wytworzenia (ta sama treść) → operator, nigdy „numer zajęty”', async () => {
    seedKsefInvoice(m.ksef, { session: 'S-STARA', ksefNumber: 'K-STARA', xml: withOtherHeaderDate(ourXml()) });

    const error = await failing(runSubmitInvoice(event(), ctx(0)));

    expect(accepted()).toBeUndefined();
    expect(classifySendError(error).code).toBe('KSEF_DUPLICATE_RECONCILE');
    expect(error.message).toContain('K-STARA');
  });
});

describe('D-A4-1a — ustalenia recenzji przed wypchnięciem', () => {
  it('niezweryfikowany 440 (403): znacznik na otwartym wpisie; po 48 h, gdy KSeF nie zna już sesji, „tylko uzgodnij” weryfikuje treść — nigdy NOT_IN_KSEF', async () => {
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: 'K-OBCA', xml: fromOtherProgram(ourXml()) });
    m.ksef.downloadFailure = { status: 403 };
    await failing(runSubmitInvoice(event(), ctx(0)));
    expect(submissions()).toEqual([expect.objectContaining({
      status: 'sent', error_code: '440', original_ksef_number: 'K-OBCA', original_session_reference_number: 'S-OBCA',
    })]);
    expect(m.captureMessage).toHaveBeenCalledWith('KSeF: duplikat 440 do uzgodnienia przez operatora', expect.anything());

    // Dwie doby później: KSeF zapomniał naszą sesję (pytanie o status dałoby 21173 → STALE).
    m.ksef.sessions.delete('S-1');
    submissions()[0]!.attempted_at = new Date(Date.now() - 72 * 3_600_000).toISOString();
    const stillLocked = await failing(runSubmitInvoice({ ...event(), reconcileOnly: true }, ctx(0)));
    expect(classifySendError(stillLocked).code).toBe('KSEF_DUPLICATE_RECONCILE');
    expect(submissions()[0]).toMatchObject({ status: 'sent' });

    m.ksef.downloadFailure = null;
    const decided = await failing(runSubmitInvoice({ ...event(), reconcileOnly: true }, ctx(0)));
    expect(classifySendError(decided).code).toBe('KSEF_NUMBER_TAKEN');
    expect(m.ksef.invoicePosts).toBe(1);
  });

  it('chwilowy błąd odczytu naszego pliku z magazynu → ponowienie weryfikacji, nie werdykt dla operatora', async () => {
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: 'K-OBCA', xml: fromOtherProgram(ourXml()) });
    m.storageReadFails = true;

    const error = await failing(runSubmitInvoice(event(), ctx(0)));

    expect(error).toBeInstanceOf(RetryAfterError);
    expect(submissions().map((r) => r.status)).toEqual(['sent']);
  });

  it('inny program, ta sama treść co nasza (tylko nagłówek) → operator, nie „numer zajęty” (ta sama sprzedaż)', async () => {
    const sameContent = withOtherHeaderDate(ourXml()).replace(/<SystemInfo>[^<]*<\/SystemInfo>/, '<SystemInfo>Inny Program 2.0</SystemInfo>');
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: 'K-OBCA', xml: sameContent });

    const error = await failing(runSubmitInvoice(event(), ctx(0)));

    expect(classifySendError(error).code).toBe('KSEF_DUPLICATE_RECONCILE');
    expect(error.message).toContain('ta sama sprzedaż');
    expect(evidence()).toBe(true);
  });

  it('akceptacja duplikatu, a zapis faktury pada → wpis próby zostaje otwarty; ponowienie przyjmuje numer bez drugiej wysyłki', async () => {
    seedKsefInvoice(m.ksef, { session: 'S-STARA', ksefNumber: 'K-STARA', xml: ourXml() });
    m.updateStatus.mockRejectedValueOnce(new Error('PostgREST 503'));

    await failing(runSubmitInvoice(event(), ctx(0)));
    expect(submissions().find((r) => r.session_reference_number === 'S-1')).toMatchObject({ status: 'sent', original_ksef_number: 'K-STARA' });

    await runSubmitInvoice(event(), ctx(1));
    expect(accepted()).toMatchObject({ ksef_number: 'K-STARA' });
    expect(m.ksef.invoicePosts).toBe(1);
    expect(submissions().find((r) => r.session_reference_number === 'S-1')).toMatchObject({ status: 'duplicate' });
  });

  it('oryginał = wcześniejsza próba tej samej treści, której wpis nie zna pliku (sprzed 00134) → archiwum pobranego oryginału', async () => {
    const earlier = withOtherHeaderDate(ourXml());
    seedKsefInvoice(m.ksef, { session: 'S-OLD', ksefNumber: 'K-OLD', xml: earlier });
    m.mem.db.ksef_submissions = [{
      id: 'row-old', tenant_id: T, invoice_id: ID, submission_type: 'online', status: 'abandoned',
      session_reference_number: 'S-INNA', invoice_reference_number: null, request_payload_hash: sha256Hex(earlier),
      xml_storage_path: null, attempted_at: new Date(Date.now() - 86_400_000).toISOString(),
    }];

    await runSubmitInvoice(event(), ctx(0));

    const saved = accepted();
    expect(saved).toMatchObject({ ksef_status: 'accepted', ksef_number: 'K-OLD' });
    expect(String(saved?.xml_storage_path)).toMatch(/\/ksef-[0-9a-f]{40}\.xml$/);
    expect(m.storage.get(String(saved?.xml_storage_path))).toBe(earlier);
  });
});

describe('D-A4-1: data przyjęcia oryginału przy przyjęciu numeru z duplikatu (art. 106na)', () => {
  it('zweryfikowany duplikat spoza historii → ksef_accepted_at = data nadania numeru oryginałowi (metadane KSeF)', async () => {
    // Prawdziwy kształt numeru KSeF: zakres dat zapytania bierze się z jego daty.
    const KSEF = '5260001246-20260928-0100A0B0C0D0-1A';
    seedKsefInvoice(m.ksef, { session: 'S-STARA', ksefNumber: KSEF, xml: ourXml(), acquisitionDate: '2026-09-28T07:15:00.000Z' });

    await runSubmitInvoice(event(), ctx(0));

    expect(accepted()).toMatchObject({ ksef_number: KSEF, ksef_accepted_at: '2026-09-28T07:15:00.000Z' });
  });

  it('własny duplikat z sesji w historii → data ze statusu po referencji tamtej wysyłki (bez zapytania o metadane)', async () => {
    const own = ourXml();
    seedKsefInvoice(m.ksef, { session: 'S-WLASNA', ksefNumber: 'K-WLASNA', xml: own, acquisitionDate: '2026-09-29T12:00:00.000Z' });
    m.ksef.metadataFails = true;
    m.mem.db.ksef_submissions = [{
      id: 'row-own', tenant_id: T, invoice_id: ID, submission_type: 'online', status: 'abandoned',
      session_reference_number: 'S-WLASNA', invoice_reference_number: 'I-S-WLASNA', request_payload_hash: sha256Hex(own),
      attempted_at: new Date(Date.now() - 86_400_000).toISOString(),
    }];

    await runSubmitInvoice(event(), ctx(0));

    expect(accepted()).toMatchObject({ ksef_number: 'K-WLASNA', ksef_accepted_at: '2026-09-29T12:00:00.000Z' });
  });

  it('daty nie da się ustalić (metadane 503) → numer przyjęty mimo to, alarm dla operatora', async () => {
    const KSEF = '5260001246-20260928-0100A0B0C0D0-1A';
    seedKsefInvoice(m.ksef, { session: 'S-STARA', ksefNumber: KSEF, xml: ourXml(), acquisitionDate: SEEDED_ACQUISITION });
    m.ksef.metadataFails = true;

    await runSubmitInvoice(event(), ctx(0));

    expect(accepted()).toMatchObject({ ksef_number: KSEF });
    expect(accepted()?.ksef_accepted_at).toBeUndefined();
    expect(m.captureMessage).toHaveBeenCalledWith(expect.stringContaining('daty przyjęcia oryginału'), expect.anything());
  });
});

describe('D-A4-1b-3 (A): dane oryginału przy nierozstrzygniętym 440 — zapisane na wpisie próby', () => {
  // Realny kształt numeru KSeF — z niego zakres dat zapytania o metadane (data nadania).
  const K = '5260001246-20260928-0100A0B0C0D0-1A';
  const marker = () => submissions().find((r) => r.original_ksef_number === K);
  const archiveKey = `${T}/ksef-import/${K}.xml`;

  it('oryginał z FaktWay o innej treści → original_check z danymi oryginału, skrótem, archiwum i datą nadania', async () => {
    const original = ourXml(150);
    seedKsefInvoice(m.ksef, { session: 'S-STARA', ksefNumber: K, xml: original, acquisitionDate: '2026-09-28T07:15:00.000Z' });

    const error = await failing(runSubmitInvoice(event(), ctx(0)));

    expect(classifySendError(error).code).toBe('KSEF_DUPLICATE_RECONCILE');
    expect(marker()).toMatchObject({ status: 'sent' });
    expect(marker()!.original_check).toMatchObject({
      v: 1, env: 'test', reason: 'faktflow-original', sha256: sha256Hex(original), archivePath: archiveKey,
      sameContentExceptHeader: false, ownHistory: false, acquiredAt: '2026-09-28T07:15:00.000Z', httpStatus: null,
      knownInvoice: null,
      summary: expect.objectContaining({ number: NUMBER, issueDate: '2026-10-01', buyerNip: '5252241585', systemInfo: 'KSeF SaaS v1.0' }),
    });
    // Dokładne bajty z KSeF pod kluczem importu historii (ten sam obiekt zobaczy Magiczny import).
    expect(m.storage.get(archiveKey)).toBe(original);
  });

  it('oryginał to plik z historii tej faktury → ownHistory: true', async () => {
    const old = ourXml(150);
    seedKsefInvoice(m.ksef, { session: 'S-STARA', ksefNumber: K, xml: old });
    m.mem.db.ksef_submissions = [{
      id: 'row-old', tenant_id: T, invoice_id: ID, submission_type: 'online', status: 'abandoned',
      session_reference_number: 'S-STARA', invoice_reference_number: null, request_payload_hash: sha256Hex(old),
      attempted_at: new Date(Date.now() - 86_400_000).toISOString(),
    }];

    await failing(runSubmitInvoice(event(), ctx(0)));

    expect(marker()!.original_check).toMatchObject({ reason: 'faktflow-original', ownHistory: true });
  });

  it('inny program, ta sama treść → reason same-content-other-program', async () => {
    const sameContent = withOtherHeaderDate(ourXml()).replace(/<SystemInfo>[^<]*<\/SystemInfo>/, '<SystemInfo>Inny Program 2.0</SystemInfo>');
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: K, xml: sameContent });

    await failing(runSubmitInvoice(event(), ctx(0)));

    expect(marker()!.original_check).toMatchObject({
      reason: 'same-content-other-program', sameContentExceptHeader: true,
      summary: expect.objectContaining({ systemInfo: 'Inny Program 2.0' }),
    });
  });

  // D-A4-1b-3 PR B (07.10 (1)): known-number niesie dane oryginału jak no-own-file —
  // pobranie, skrót, podsumowanie, archiwum i `ownHistory` (wcześniej sha256/summary null, bez pobierania).
  it('numer KSeF ma inna faktura sprzedaży w FaktWay → reason known-number z odnośnikiem i danymi pobranego oryginału', async () => {
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: K, xml: fromOtherProgram(ourXml()) });
    m.mem.db.invoices = [{ id: 'inna', tenant_id: T, direction: 'outgoing', ksef_status: 'accepted', ksef_number: K, internal_number: 'FV/INNA/1' }];

    await failing(runSubmitInvoice(event(), ctx(0)));

    expect(m.ksef.downloads).toBe(1);
    expect(marker()!.original_check).toMatchObject({
      reason: 'known-number', knownInvoice: { id: 'inna', internalNumber: 'FV/INNA/1' },
      sha256: sha256Hex(fromOtherProgram(ourXml())), summary: expect.objectContaining({ number: NUMBER, systemInfo: 'Inny Program 2.0' }),
      archivePath: archiveKey, ownHistory: false,
    });
  });

  it('403 przy pobraniu → reason download-refused z kodem HTTP; 503 → download-pending', async () => {
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: K, xml: fromOtherProgram(ourXml()) });
    m.ksef.downloadFailure = { status: 503 };
    await failing(runSubmitInvoice(event(), ctx(0)));
    expect(marker()!.original_check).toMatchObject({ reason: 'download-pending', httpStatus: 503, sha256: null });

    m.ksef.downloadFailure = { status: 403 };
    await failing(runSubmitInvoice(event(), ctx(1)));
    expect(marker()!.original_check).toMatchObject({ reason: 'download-refused', httpStatus: 403, sha256: null });
  });

  it('błąd odczytu naszego pliku → reason storage-pending (dane oryginału już są)', async () => {
    const other = fromOtherProgram(ourXml());
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: K, xml: other });
    m.storageReadFails = true;

    await failing(runSubmitInvoice(event(), ctx(0)));

    expect(marker()!.original_check).toMatchObject({ reason: 'storage-pending', sha256: sha256Hex(other) });
  });

  it('w archiwum inny plik pod tym numerem KSeF → reason archive-conflict, werdykt dla operatora (nie pętla ponowień)', async () => {
    seedKsefInvoice(m.ksef, { session: 'S-STARA', ksefNumber: K, xml: ourXml(150) });
    m.storage.set(archiveKey, '<Faktura>coś innego</Faktura>');

    const error = await failing(runSubmitInvoice(event(), ctx(0)));

    expect(error).toBeInstanceOf(NonRetriableError);
    expect(classifySendError(error).code).toBe('KSEF_DUPLICATE_RECONCILE');
    expect(marker()!.original_check).toMatchObject({ reason: 'archive-conflict' });
    expect(m.storage.get(archiveKey)).toBe('<Faktura>coś innego</Faktura>');
  });

  it('ponowienie tej samej weryfikacji → ten sam zapis, archiwum bez konfliktu, bez drugiej wysyłki', async () => {
    const original = ourXml(150);
    seedKsefInvoice(m.ksef, { session: 'S-STARA', ksefNumber: K, xml: original });

    await failing(runSubmitInvoice(event(), ctx(0)));
    const first = { ...(marker()!.original_check as Row) };
    const again = await failing(runSubmitInvoice({ ...event(), reconcileOnly: true }, ctx(0)));

    expect(classifySendError(again).code).toBe('KSEF_DUPLICATE_RECONCILE');
    expect(m.ksef.invoicePosts).toBe(1);
    expect(marker()!.original_check).toMatchObject({ ...first, checkedAt: expect.any(String) });
  });

  // Ustalenia recenzji PR A.
  it('ponowne sprawdzenie, które nie pobrało oryginału (503, 403), NIE kasuje zapisanych danych — dopisuje wynik próby', async () => {
    const original = ourXml(150);
    seedKsefInvoice(m.ksef, { session: 'S-STARA', ksefNumber: K, xml: original });
    await failing(runSubmitInvoice(event(), ctx(0)));
    const full = { ...(marker()!.original_check as Row) };
    expect(full).toMatchObject({ reason: 'faktflow-original', sha256: sha256Hex(original) });

    // Cron I5 dwie doby później: KSeF chwilowo nie oddaje pliku.
    m.ksef.downloadFailure = { status: 503 };
    await failing(runSubmitInvoice({ ...event(), reconcileOnly: true }, ctx(0)));
    expect(marker()!.original_check).toMatchObject({
      reason: 'faktflow-original', sha256: sha256Hex(original), archivePath: archiveKey, summary: full.summary,
      recheck: { reason: 'download-pending', httpStatus: 503, checkedAt: expect.any(String) },
    });

    // Token wymieniony na taki bez InvoiceRead — dane dalej są, próba zapisana.
    m.ksef.downloadFailure = { status: 403 };
    await failing(runSubmitInvoice({ ...event(), reconcileOnly: true }, ctx(0)));
    expect(marker()!.original_check).toMatchObject({
      reason: 'faktflow-original', sha256: sha256Hex(original), recheck: { reason: 'download-refused', httpStatus: 403 },
    });

    // Udane sprawdzenie zastępuje zapis w całości (bez starego wyniku próby).
    m.ksef.downloadFailure = null;
    await failing(runSubmitInvoice({ ...event(), reconcileOnly: true }, ctx(0)));
    expect(marker()!.original_check).toMatchObject({ reason: 'faktflow-original', recheck: null });
  });

  it('błąd zapisu archiwum (nie konflikt) → osobny powód archive-pending, dane oryginału zapisane, ponowienie', async () => {
    const original = ourXml(150);
    seedKsefInvoice(m.ksef, { session: 'S-STARA', ksefNumber: K, xml: original });
    m.archiveFails = true;

    const error = await failing(runSubmitInvoice(event(), ctx(0)));

    expect(error).toBeInstanceOf(RetryAfterError);
    expect(marker()!.original_check).toMatchObject({ reason: 'archive-pending', sha256: sha256Hex(original), archivePath: null });
  });
});

/**
 * D-A4-1b-3 PR B, U18a–U18f (decyzja Bartosza 07.10.2026 (1); spec v3 §2.7.1):
 * numer KSeF oryginału ma już inna, przyjęta faktura sprzedaży firmy (Y).
 * Runner nie kończy już werdyktu przed pobraniem: pobiera, archiwizuje
 * i podsumowuje K z tą samą obsługą błędów co pozostałe powody — klient
 * zdecyduje, widząc dane K i odnośnik do Y. Pomijane jest tylko „accept”
 * (Y ma już K; druga faktura z tym samym numerem KSeF byłaby podwójną sprzedażą w JPK).
 */
describe('D-A4-1b-3 PR B: znany numer KSeF — oryginał pobrany i opisany (U18)', () => {
  const K = '5260001246-20260928-0100A0B0C0D0-1A';
  const Y_ID = '33333333-3333-4333-8333-333333333333';
  const Y = { id: Y_ID, tenant_id: T, direction: 'outgoing', ksef_status: 'accepted', ksef_number: K, internal_number: 'FV/INNA/1' };
  const KNOWN = { id: Y_ID, internalNumber: 'FV/INNA/1' };
  const marker = () => submissions().find((r) => r.original_ksef_number === K);
  const archiveKey = `${T}/ksef-import/${K}.xml`;
  /** 2.11.B KNOWN_NUMBER_LAST_ERROR (C16): `ownHistory` false — klient rozstrzyga na karcie faktury. */
  const KNOWN_NUMBER_LAST_ERROR = `KSeF ma już fakturę o tym numerze (numer KSeF ${K}), a w FaktWay ten numer KSeF ma dokument FV/INNA/1 — ` +
    'do rozstrzygnięcia na karcie faktury (ta sama czy inna sprzedaż); nie wystawiaj jej ponownie.';
  /** 2.11.B KNOWN_NUMBER_LAST_ERROR_OWN (C16): `ownHistory` true — klient nie decyduje, więc tekst nie mówi, że sprawa czeka na niego. */
  const KNOWN_NUMBER_LAST_ERROR_OWN = `KSeF ma już fakturę o tym numerze (numer KSeF ${K}), a w FaktWay ten numer KSeF ma dokument FV/INNA/1; ` +
    'faktura w KSeF może być wcześniejszą wysyłką tego dokumentu z FaktWay — wyjaśnia to pomoc FaktWay; nie wystawiaj jej ponownie.';

  beforeEach(() => {
    m.mem.db.invoices = [{ ...Y }];
  });

  it('U18a: pobranie K, bajty w archiwum importu, pełny original_check i tekst „do rozstrzygnięcia na karcie faktury”', async () => {
    const original = fromOtherProgram(ourXml());
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: K, xml: original, acquisitionDate: '2026-09-28T07:15:00.000Z' });

    const error = await failing(runSubmitInvoice(event(), ctx(0)));

    expect(error).toBeInstanceOf(NonRetriableError);
    expect(classifySendError(error).code).toBe('KSEF_DUPLICATE_RECONCILE');
    expect(error.message).toBe(`[KSEF_DUPLICATE_RECONCILE] ${KNOWN_NUMBER_LAST_ERROR}`);
    expect(m.ksef.downloads).toBe(1);
    expect(m.storage.get(archiveKey)).toBe(original);
    expect(marker()).toMatchObject({ status: 'sent' });
    expect(marker()!.original_check).toMatchObject({
      v: 1, env: 'test', reason: 'known-number', knownInvoice: KNOWN,
      sha256: sha256Hex(original), sizeBytes: Buffer.byteLength(original, 'utf8'), archivePath: archiveKey,
      summary: expect.objectContaining({ number: NUMBER, systemInfo: 'Inny Program 2.0', gross: '999.99', buyerNip: '5252241585' }),
      sameContentExceptHeader: false, ownHistory: false, acquiredAt: '2026-09-28T07:15:00.000Z', httpStatus: null, recheck: null,
    });
    expect(accepted()).toBeUndefined();
    // Alarm `ksef-duplicate-known-number` zostaje — operator sprawdza Y w każdym przypadku.
    expect(m.captureMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      tags: expect.objectContaining({ kind: 'ksef-duplicate-known-number' }),
      extra: expect.objectContaining({ otherInvoice: 'FV/INNA/1', ownHistory: false }),
    }));
  });

  it('U18b: 503 przy pobraniu → download-pending (ponowienie) z knownInvoice; 403 → download-refused (werdykt) z knownInvoice', async () => {
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: K, xml: fromOtherProgram(ourXml()) });
    m.ksef.downloadFailure = { status: 503 };

    const pending = await failing(runSubmitInvoice(event(), ctx(0)));
    expect(pending).toBeInstanceOf(RetryAfterError);
    expect(classifySendError(pending).code).toBe('KSEF_DUPLICATE_RECONCILE');
    expect(marker()!.original_check).toMatchObject({ reason: 'download-pending', httpStatus: 503, sha256: null, knownInvoice: KNOWN });

    m.ksef.downloadFailure = { status: 403 };
    const refused = await failing(runSubmitInvoice(event(), ctx(1)));
    expect(refused).toBeInstanceOf(NonRetriableError);
    expect(classifySendError(refused).code).toBe('KSEF_DUPLICATE_RECONCILE');
    expect(marker()!.original_check).toMatchObject({ reason: 'download-refused', httpStatus: 403, sha256: null, knownInvoice: KNOWN });
    expect(m.ksef.downloads).toBe(2);
    expect(m.ksef.invoicePosts).toBe(1);
  });

  it('U18c: błąd odczytu naszego pliku → storage-pending z danymi K (sha256) i knownInvoice', async () => {
    const original = fromOtherProgram(ourXml());
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: K, xml: original });
    m.storageReadFails = true;

    const error = await failing(runSubmitInvoice(event(), ctx(0)));

    expect(error).toBeInstanceOf(RetryAfterError);
    expect(marker()!.original_check).toMatchObject({ reason: 'storage-pending', sha256: sha256Hex(original), knownInvoice: KNOWN });
  });

  it('U18d: błąd zapisu archiwum → archive-pending (ponowienie); inny plik w archiwum → archive-conflict (werdykt); oba z knownInvoice', async () => {
    const original = fromOtherProgram(ourXml());
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: K, xml: original });
    m.archiveFails = true;

    const pending = await failing(runSubmitInvoice(event(), ctx(0)));
    expect(pending).toBeInstanceOf(RetryAfterError);
    expect(marker()!.original_check).toMatchObject({
      reason: 'archive-pending', sha256: sha256Hex(original), archivePath: null, knownInvoice: KNOWN,
    });

    m.archiveFails = false;
    m.storage.set(archiveKey, '<Faktura>coś innego</Faktura>');
    const conflict = await failing(runSubmitInvoice(event(), ctx(1)));
    expect(conflict).toBeInstanceOf(NonRetriableError);
    expect(classifySendError(conflict).code).toBe('KSEF_DUPLICATE_RECONCILE');
    expect(marker()!.original_check).toMatchObject({ reason: 'archive-conflict', sha256: sha256Hex(original), knownInvoice: KNOWN });
    expect(m.storage.get(archiveKey)).toBe('<Faktura>coś innego</Faktura>');
  });

  it('U18e: K = nasz bieżący plik → ownHistory: true, bez przyjęcia numeru (Y ma już K) i tekst KNOWN_NUMBER_LAST_ERROR_OWN', async () => {
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: K, xml: ourXml() });

    const error = await failing(runSubmitInvoice(event(), ctx(0)));

    expect(classifySendError(error).code).toBe('KSEF_DUPLICATE_RECONCILE');
    expect(error.message).toBe(`[KSEF_DUPLICATE_RECONCILE] ${KNOWN_NUMBER_LAST_ERROR_OWN}`);
    expect(accepted()).toBeUndefined();
    expect(submissions().some((r) => r.status === 'accepted')).toBe(false);
    expect(marker()!.original_check).toMatchObject({
      reason: 'known-number', ownHistory: true, sha256: sha256Hex(ourXml()), knownInvoice: KNOWN,
    });
  });

  it('U18f: znacznik z PR A (known-number bez danych) + „Tylko uzgodnij” → pełny zapis, bez drugiej wysyłki', async () => {
    const original = fromOtherProgram(ourXml());
    seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: K, xml: original });
    await failing(runSubmitInvoice(event(), ctx(0)));
    // Kształt zapisu sprzed PR B: werdykt bez pobrania (sha256 i summary null).
    marker()!.original_check = {
      v: 1, env: 'test', checkedAt: '2026-10-05T08:00:00.000Z', reason: 'known-number', sha256: null, archivePath: null,
      sizeBytes: null, summary: null, sameContentExceptHeader: null, ownHistory: null, acquiredAt: null, httpStatus: null,
      knownInvoice: KNOWN, recheck: null,
    };

    const again = await failing(runSubmitInvoice({ ...event(), reconcileOnly: true }, ctx(0)));

    expect(classifySendError(again).code).toBe('KSEF_DUPLICATE_RECONCILE');
    expect(m.ksef.invoicePosts).toBe(1);
    expect(marker()!.original_check).toMatchObject({
      reason: 'known-number', knownInvoice: KNOWN, sha256: sha256Hex(original), archivePath: archiveKey, ownHistory: false,
      summary: expect.objectContaining({ number: NUMBER }), recheck: null,
    });
  });
});

/**
 * D-A4-1b-3 PR C (spec v3, 5.1 i 7.2): przy werdykcie `faktflow-original` runner
 * ocenia plik oryginału (brama pochodzenia, `evaluateOriginalGate`) i zapisuje
 * wynik na znaczniku jako `original_check.importGate`. Na tej ocenie SQL z 00149
 * buduje ofertę (`pair`/`record`/`released`/`review-*`) i blokadę
 * `provenance-review` (I5R): plik z generatora FaktFlow zapisuje klient,
 * plik, który na taki nie wygląda (EUR, ceny brutto…), trafia do operatora.
 *
 * Zmiany runnera (5.1): `importGate` w `recordCheck` tylko dla `faktflow-original`;
 * `importGate: { kind, problems }` w `extra` alarmu `alertOperator`; przy
 * `review` dodatkowy alarm Sentry z odciskiem `[kind, invoiceId]`; `last_error`
 * z `FAKTFLOW.LAST_ERROR` / `LAST_ERROR_REVIEW` (bez „operatora” — reguła
 * 07.10.2026); `parseDuplicateCheck` czyta `importGate` i `recheckNeeded`,
 * a `mergeDuplicateCheck` zachowuje `release` (INV-26) i nie przenosi
 * `recheckNeeded` do nowego zapisu (INV-25).
 */
describe('D-A4-1b-3 PR C: runner zapisuje bramę pochodzenia na znaczniku faktflow-original (5.1)', () => {
  // Realny kształt numeru KSeF — z niego zakres dat zapytania o metadane (data nadania).
  const K = '5260001246-20260928-0100A0B0C0D0-1A';
  /** NIP sprzedawcy w pliku z `faktura()` — brama porównuje go z NIP firmy ZE ZDARZENIA (F3). */
  const SELLER_NIP = '5260001246';
  // PR C: brzmienie po zmianie marki (merge 3451a72e); spec 5.1 ma nazwę sprzed zmiany, a nazwa-produktu.test.ts zabrania „FaktFlow” w lib/.
  const PROVENANCE_MESSAGE = 'KSeF: plik z oznaczeniem FaktWay do przeglądu operatora';
  const OPERATOR_MESSAGE = 'KSeF: duplikat 440 do uzgodnienia przez operatora';
  const ARCHIVE_KEY = `${T}/ksef-import/${K}.xml`;
  const RELEASE = {
    at: '2026-10-05T12:00:00.000Z',
    via: 'operator',
    actorUserId: '99999999-9999-4999-8999-999999999999',
    note: 'Plik sprawdzony z klientem, zgodny z jego fakturą.',
  } as const;
  const RECHECK_NEEDED = { kind: 'gate-drift', at: '2026-10-06T08:00:00.000Z' } as const;
  /** Podgląd zapisany na znaczniku przy oddaniu — z kluczem, którego kod nie zna: `preview` ma zostać BEZ przebudowy. */
  const STORED_PREVIEW = {
    issueDate: '2026-10-01',
    saleDate: '2026-10-01',
    period: '10.2026',
    buyerIdKind: 'nip',
    annotations: [],
    exemptionBasis: null,
    lineCount: 1,
    lines: [{ ordinal: 1, name: 'Usługa', quantity: '1.0000', unit: 'usł.', unitPriceNet: '150.0000', vatRate: '23', gross: '184.50' }],
    totals: { net: '150.00', vat: '34.50', gross: '184.50' },
    zapisaneBezPrzebudowy: 'tak',
  };

  /** Zdarzenie z NIP firmy równym NIP sprzedawcy w pliku (`event()` ma `1234567890`). */
  const gateEvent = () => ({ ...event(), nip: SELLER_NIP });
  const seedOriginal = (xml: string) =>
    seedKsefInvoice(m.ksef, { session: 'S-STARA', ksefNumber: K, xml, acquisitionDate: '2026-09-28T07:15:00.000Z' });
  const marker = () => submissions().find((r) => r.original_ksef_number === K);
  const checkOfMarker = () => (marker()?.original_check ?? {}) as Row;
  const importGateOf = () => checkOfMarker().importGate as Row | undefined;
  const provenanceAlarms = () => m.captureMessage.mock.calls.filter(([text]) => text === PROVENANCE_MESSAGE);
  const asEur = (xml: string) => xml.replace('<KodWaluty>PLN</KodWaluty>', '<KodWaluty>EUR</KodWaluty>');
  const withGrossPrice = (xml: string) => xml.replace('<P_9A>', '<P_9B>184.5</P_9B><P_9A>');
  /** Jak `beforeEach` — dla testów, które uruchamiają kilka niezależnych werdyktów. */
  const resetWorld = () => {
    vi.clearAllMocks();
    m.ksef = freshKsef();
    m.mem = { db: { ksef_submissions: [], invoices: [] }, failWrite: null };
    m.storage = new Map();
    m.storageReadFails = false;
    m.archiveFails = false;
  };
  /** Znacznik po werdykcie `review`, na którym SQL `release_ksef_original_review` zapisał oddanie decyzji i `recheckNeeded`. */
  const releasedMarker = async () => {
    seedOriginal(asEur(ourXml(150)));
    await failing(runSubmitInvoice(gateEvent(), ctx(0)));
    const check = checkOfMarker();
    check.importGate = { v: 1, rules: ORIGINAL_GATE_RULES, kind: 'review', problems: ['currency'], preview: STORED_PREVIEW, release: RELEASE };
    check.recheckNeeded = RECHECK_NEEDED;
    return structuredClone(check);
  };

  describe('plik z generatora FaktFlow — brama importable', () => {
    it('importGate {v, rules, kind: importable, problems: [], preview} na znaczniku; last_error z FAKTFLOW.LAST_ERROR; bez alarmu przeglądu', async () => {
      seedOriginal(ourXml(150));

      const error = await failing(runSubmitInvoice(gateEvent(), ctx(0)));

      expect(classifySendError(error).code).toBe('KSEF_DUPLICATE_RECONCILE');
      expect(error.message).toBe(`[KSEF_DUPLICATE_RECONCILE] ${DUPLICATE_DECISION_TEXTS.FAKTFLOW.LAST_ERROR(K)}`);
      // Reguła 07.10.2026: ani „operator”, ani „uzgodnienia” — klient zdecyduje sam na karcie.
      expect(error.message).not.toMatch(/operator/i);
      expect(importGateOf()).toEqual({
        v: 1,
        rules: ORIGINAL_GATE_RULES,
        kind: 'importable',
        problems: [],
        preview: expect.objectContaining({
          issueDate: '2026-10-01',
          saleDate: '2026-10-01',
          period: '10.2026',
          buyerIdKind: 'nip',
          annotations: [],
          exemptionBasis: null,
          lineCount: 1,
        }),
      });
      const preview = importGateOf()!.preview as { totals: Record<string, string>; lines: Array<Record<string, string>> };
      expect({ net: Number(preview.totals.net), vat: Number(preview.totals.vat), gross: Number(preview.totals.gross) })
        .toEqual({ net: 150, vat: 34.5, gross: 184.5 });
      expect(preview.lines).toHaveLength(1);
      expect(provenanceAlarms()).toEqual([]);
      // Dotychczasowy alarm operatora dostaje ocenę bramy w `extra`.
      expect(m.captureMessage).toHaveBeenCalledWith(OPERATOR_MESSAGE, expect.objectContaining({
        tags: expect.objectContaining({ kind: 'ksef-duplicate-faktflow-original' }),
        extra: expect.objectContaining({ importGate: { kind: 'importable', problems: [] } }),
      }));
      expect(m.ksef.invoicePosts).toBe(1);
    });

    it('NIP firmy do reguły „seller” bierze ze zdarzenia (F3): inny NIP w zdarzeniu niż sprzedawca w pliku → review', async () => {
      seedOriginal(ourXml(150));

      const error = await failing(runSubmitInvoice(event(), ctx(0)));

      expect(importGateOf()).toMatchObject({ v: 1, kind: 'review' });
      expect(importGateOf()!.problems).toEqual(['seller']);
      expect(error.message).toBe(`[KSEF_DUPLICATE_RECONCILE] ${DUPLICATE_DECISION_TEXTS.FAKTFLOW.LAST_ERROR_REVIEW(K)}`);
      expect(provenanceAlarms()).toHaveLength(1);
    });
  });

  describe('plik, który nie wygląda na plik z generatora — brama review + alarm przeglądu', () => {
    it.each([
      ['plik w EUR', asEur, 'currency'],
      ['plik z ceną brutto (P_9B)', withGrossPrice, 'gross-prices'],
    ] as const)('%s → kind: review, jeden alarm Sentry z odciskiem [kind, invoiceId], last_error z LAST_ERROR_REVIEW', async (_name, mutate, problem) => {
      seedOriginal(mutate(ourXml(150)));

      const error = await failing(runSubmitInvoice(gateEvent(), ctx(0)));

      expect(classifySendError(error).code).toBe('KSEF_DUPLICATE_RECONCILE');
      expect(error.message).toBe(`[KSEF_DUPLICATE_RECONCILE] ${DUPLICATE_DECISION_TEXTS.FAKTFLOW.LAST_ERROR_REVIEW(K)}`);
      expect(error.message).not.toMatch(/operator/i);
      const gate = importGateOf()!;
      expect(gate).toMatchObject({ v: 1, rules: ORIGINAL_GATE_RULES, kind: 'review' });
      expect(gate.problems).toContain(problem);
      // EUR: plik się nie odczytał — brak podglądu; cena brutto: podgląd jest (rodzaj nabywcy dla CORRECTION_PERSON).
      if (problem === 'currency') expect(gate.preview).toBeNull();
      else expect(gate.preview).toMatchObject({ buyerIdKind: 'nip', lineCount: 1 });
      expect(provenanceAlarms()).toEqual([[PROVENANCE_MESSAGE, {
        level: 'warning',
        tags: expect.objectContaining({ kind: KSEF_ORIGINAL_ALARM_KINDS.provenanceReview }),
        fingerprint: [KSEF_ORIGINAL_ALARM_KINDS.provenanceReview, ID],
        extra: expect.objectContaining({ tenantId: T, invoiceId: ID, originalKsefNumber: K, problems: gate.problems }),
      }]]);
      // Alarm operatora też niesie ocenę: ten sam kind i problemy.
      expect(m.captureMessage).toHaveBeenCalledWith(OPERATOR_MESSAGE, expect.objectContaining({
        extra: expect.objectContaining({ importGate: { kind: 'review', problems: gate.problems } }),
      }));
      expect(m.ksef.invoicePosts).toBe(1);
    });
  });

  describe('importGate tylko przy faktflow-original', () => {
    it('znany numer (też gdy plik jest z FaktFlow), ta sama treść z innego programu i brak własnego pliku zostają bez importGate', async () => {
      // Kontrast: faktflow-original ma bramę.
      seedOriginal(ourXml(150));
      await failing(runSubmitInvoice(gateEvent(), ctx(0)));
      expect(checkOfMarker()).toMatchObject({ reason: 'faktflow-original' });
      expect(importGateOf()).toMatchObject({ v: 1, kind: 'importable' });

      // Znany numer wygrywa z faktflow-original: powód known-number, bez bramy.
      resetWorld();
      seedOriginal(ourXml(150));
      m.mem.db.invoices = [{ id: 'inna', tenant_id: T, direction: 'outgoing', ksef_status: 'accepted', ksef_number: K, internal_number: 'FV/INNA/1' }];
      await failing(runSubmitInvoice(gateEvent(), ctx(0)));
      expect(checkOfMarker()).toMatchObject({ reason: 'known-number' });
      expect(checkOfMarker()).not.toHaveProperty('importGate');

      // Ta sama treść z innego programu: same-content-other-program, bez bramy.
      resetWorld();
      seedOriginal(withOtherHeaderDate(ourXml()).replace(/<SystemInfo>[^<]*<\/SystemInfo>/, '<SystemInfo>Inny Program 2.0</SystemInfo>'));
      await failing(runSubmitInvoice(gateEvent(), ctx(0)));
      expect(checkOfMarker()).toMatchObject({ reason: 'same-content-other-program' });
      expect(checkOfMarker()).not.toHaveProperty('importGate');

      // Historia wysyłki bez naszego pliku (wpis sprzed 00134) i oryginał z innego programu: no-own-file, bez bramy.
      resetWorld();
      seedOriginal(fromOtherProgram(ourXml()));
      const ours = ourXml();
      m.ksef.sessions.set('S-9', { open: false, invoices: [{
        referenceNumber: 'I-9', invoiceNumber: NUMBER, invoiceHash: Buffer.from(sha256Hex(ours), 'hex').toString('base64'),
        code: 440, ksefNumber: null, xml: ours, originalSession: 'S-STARA', originalKsef: K,
      }] });
      m.mem.db.ksef_submissions = [{
        id: 'row-9', tenant_id: T, invoice_id: ID, submission_type: 'online', status: 'sent',
        session_reference_number: 'S-9', invoice_reference_number: 'I-9', request_payload_hash: null,
        xml_storage_path: null, attempted_at: new Date().toISOString(),
      }];
      await failing(runSubmitInvoice(gateEvent(), ctx(1)));
      expect(checkOfMarker()).toMatchObject({ reason: 'no-own-file' });
      expect(checkOfMarker()).not.toHaveProperty('importGate');
      expect(provenanceAlarms()).toEqual([]);
    });

    it('odmowa pobrania (403), chwilowa awaria (503) i niezapisany plik w archiwum nie mają oryginału do oceny — bez importGate', async () => {
      seedOriginal(ourXml(150));
      m.ksef.downloadFailure = { status: 403 };
      await failing(runSubmitInvoice(gateEvent(), ctx(0)));
      expect(checkOfMarker()).toMatchObject({ reason: 'download-refused' });
      expect(checkOfMarker()).not.toHaveProperty('importGate');

      m.ksef.downloadFailure = { status: 503 };
      await failing(runSubmitInvoice(gateEvent(), ctx(1)));
      expect(checkOfMarker()).not.toHaveProperty('importGate');

      // Błąd zapisu archiwum (archive-pending) i inny plik pod tym numerem (archive-conflict): ocena pliku nie powstaje.
      m.ksef.downloadFailure = null;
      m.archiveFails = true;
      await failing(runSubmitInvoice({ ...gateEvent(), reconcileOnly: true }, ctx(0)));
      expect(checkOfMarker()).toMatchObject({ reason: 'archive-pending' });
      expect(checkOfMarker()).not.toHaveProperty('importGate');
      m.archiveFails = false;
      m.storage.set(ARCHIVE_KEY, '<Faktura>coś innego</Faktura>');
      await failing(runSubmitInvoice({ ...gateEvent(), reconcileOnly: true }, ctx(0)));
      expect(checkOfMarker()).toMatchObject({ reason: 'archive-conflict' });
      expect(checkOfMarker()).not.toHaveProperty('importGate');
      expect(provenanceAlarms()).toEqual([]);

      // Kontrast: po usunięciu konfliktu ten sam plik dostaje bramę.
      m.storage.delete(ARCHIVE_KEY);
      await failing(runSubmitInvoice({ ...gateEvent(), reconcileOnly: true }, ctx(0)));
      expect(importGateOf()).toMatchObject({ kind: 'importable' });
    });
  });

  describe('ponowienie od zera', () => {
    it('brama jest deterministyczna: ten sam plik → ten sam importGate, jeden znacznik, alarm przeglądu z tym samym odciskiem', async () => {
      seedOriginal(asEur(ourXml(150)));

      await failing(runSubmitInvoice(gateEvent(), ctx(0)));
      const first = structuredClone(importGateOf());
      expect(first).toMatchObject({ kind: 'review', problems: ['currency'] });
      await failing(runSubmitInvoice({ ...gateEvent(), reconcileOnly: true }, ctx(0)));

      expect(importGateOf()).toEqual(first);
      expect(submissions().filter((r) => r.original_ksef_number === K)).toHaveLength(1);
      const alarms = provenanceAlarms();
      expect(alarms).toHaveLength(2);
      expect(alarms[1]![1]).toEqual(alarms[0]![1]);
    });
  });

  describe('INV-26: ponowne sprawdzenie nie gubi oddania decyzji (release)', () => {
    it.each([[503], [403]])('nieudane pobranie (%i) po oddaniu zostawia importGate co do bajtu (release.actorUserId, release.note, preview) i recheckNeeded', async (status) => {
      const before = await releasedMarker();
      m.ksef.downloadFailure = { status };

      await failing(runSubmitInvoice({ ...gateEvent(), reconcileOnly: true }, ctx(0)));

      const after = checkOfMarker();
      expect(after.importGate).toEqual(before.importGate);
      expect((after.importGate as Row).release).toEqual(RELEASE);
      expect((after.importGate as Row).preview).toEqual(STORED_PREVIEW);
      expect(after.recheckNeeded).toEqual(RECHECK_NEEDED);
      expect(after.recheck).toMatchObject({ httpStatus: status });
      // Dane oryginału z udanego sprawdzenia zostają — na nich klient podejmie decyzję.
      expect(after).toMatchObject({ reason: 'faktflow-original', sha256: before.sha256, archivePath: before.archivePath });
    });

    it('po nieudanym pobraniu oferta nadal „released” (decyzja wraca do klienta jak w PR B)', async () => {
      await releasedMarker();
      m.ksef.downloadFailure = { status: 503 };

      await failing(runSubmitInvoice({ ...gateEvent(), reconcileOnly: true }, ctx(0)));

      // `recheckNeeded` blokuje decyzję klienta (blokada recheck-needed), ale ocena oferty z samego znacznika to `released`.
      expect(duplicateOriginalOffer(checkOfMarker(), false)).toBe('released');
    });

    it('udane pobranie tego samego pliku z tą samą oceną review zachowuje release; recheckNeeded znika (nowy werdykt = nowa ocena)', async () => {
      seedOriginal(asEur(ourXml(150)));
      await failing(runSubmitInvoice(gateEvent(), ctx(0)));
      const assessed = structuredClone(importGateOf());
      expect(assessed).toMatchObject({ kind: 'review', problems: ['currency'] });
      const check = checkOfMarker();
      check.importGate = { ...(check.importGate as Row), release: RELEASE };
      check.recheckNeeded = RECHECK_NEEDED;

      await failing(runSubmitInvoice({ ...gateEvent(), reconcileOnly: true }, ctx(0)));

      const after = checkOfMarker();
      expect(after.importGate).toEqual({ ...assessed, release: RELEASE });
      expect(after).not.toHaveProperty('recheckNeeded');
      expect(after.recheck).toBeNull();
    });

    it.each([
      ['inny plik w EUR (inny SHA, te same problemy)', (xml: string) => asEur(xml.replace('<P_9A>150.0000</P_9A>', '<P_9A>175.0000</P_9A>').replace('150.00', '175.00')), 'currency'],
      ['plik z ceną brutto (inny SHA i inne problemy)', withGrossPrice, 'gross-prices'],
    ] as const)('%s → nowa ocena bez release', async (_name, mutate, problem) => {
      seedOriginal(asEur(ourXml(150)));
      await failing(runSubmitInvoice(gateEvent(), ctx(0)));
      const check = checkOfMarker();
      expect(check.importGate).toMatchObject({ kind: 'review' });
      check.importGate = { ...(check.importGate as Row), release: RELEASE };
      // Inne bajty pod tym samym numerem KSeF (w KSeF to się nie zdarza; test sprawdza regułę SHA) — archiwum bez starego pliku.
      m.ksef.sessions.get('S-STARA')!.invoices[0]!.xml = mutate(ourXml(150));
      m.storage.delete(ARCHIVE_KEY);

      await failing(runSubmitInvoice({ ...gateEvent(), reconcileOnly: true }, ctx(0)));

      const gate = importGateOf()!;
      expect(gate).toMatchObject({ v: 1, kind: 'review' });
      expect(gate.problems).toContain(problem);
      expect(gate).not.toHaveProperty('release');
      expect(checkOfMarker().sha256).not.toBe(check.sha256);
    });
  });
});

/**
 * Odczyt i scalanie `original_check` (5.1 punkt 4) bez runnera: to, co
 * `recordKsefDuplicateCheck` robi na każdym zapisie — `parseDuplicateCheck`
 * poprzedniego jsonb z bazy + `mergeDuplicateCheck(previous, next)`.
 * Czerwone na commicie kontraktu: `parseDuplicateCheck` nie czyta jeszcze
 * `importGate` ani `recheckNeeded` (obiekt budowany od nowa gubi nieznane
 * klucze), a `mergeDuplicateCheck` nie przenosi `release`.
 */
describe('D-A4-1b-3 PR C (5.1 pkt 4): parseDuplicateCheck i mergeDuplicateCheck dla importGate, release i recheckNeeded', () => {
  const K = '5260001246-20260928-0100A0B0C0D0-1A';
  const SHA = 'ab'.repeat(32);
  const PREVIEW = {
    issueDate: '2026-10-01', saleDate: null, period: '10.2026', buyerIdKind: 'nip', annotations: [], exemptionBasis: null,
    lineCount: 1,
    lines: [{ ordinal: 1, name: 'Usługa', quantity: '1', unit: 'usł.', unitPriceNet: '150.00', vatRate: '23', gross: '184.50' }],
    totals: { net: '150.00', vat: '34.50', gross: '184.50' },
    pozostawione: { bez: 'przebudowy' },
  };
  const NEW_PREVIEW = { ...PREVIEW, lineCount: 2, pozostawione: undefined };
  const RELEASE: KsefOriginalRelease = {
    at: '2026-10-05T12:00:00.000Z', via: 'operator', actorUserId: '99999999-9999-4999-8999-999999999999', note: 'Plik sprawdzony z klientem.',
  };
  const RECHECK_NEEDED = { kind: 'gate-drift', at: '2026-10-06T08:00:00.000Z' } as const;
  const SUMMARY = { systemInfo: 'KSeF SaaS v1.0', number: NUMBER, issueDate: '2026-10-01', buyerNip: '5252241585', buyerName: 'Klient', gross: '184.50', currency: 'PLN' };

  const reviewGate = (problems: string[], extra: Row = {}): Row => ({
    v: 1, rules: ORIGINAL_GATE_RULES, kind: 'review', problems, preview: PREVIEW, ...extra,
  });
  /** `original_check` jak w bazie (jsonb) — po udanym sprawdzeniu `faktflow-original`. */
  const stored = (over: Row = {}): Row => ({
    v: 1, env: 'test', checkedAt: '2026-10-05T08:00:00.000Z', reason: 'faktflow-original', sha256: SHA,
    archivePath: `${T}/ksef-import/${K}.xml`, sizeBytes: 2048, summary: SUMMARY, sameContentExceptHeader: false,
    ownHistory: false, acquiredAt: '2026-09-28T07:15:00.000Z', httpStatus: null, knownInvoice: null, recheck: null,
    importGate: reviewGate(['gross-prices', 'markers'], { release: RELEASE }), recheckNeeded: RECHECK_NEEDED, ...over,
  });
  const previousOf = (over: Row = {}): KsefDuplicateCheck => {
    const parsed = parseDuplicateCheck(stored(over));
    if (!parsed) throw new Error('parseDuplicateCheck odrzuciło poprawny zapis');
    return parsed;
  };
  /** Nowy zapis runnera po udanym pobraniu (to, co `recordCheck` buduje; bez `recheckNeeded`). */
  const nextOf = (over: Partial<KsefDuplicateCheck> = {}): KsefDuplicateCheck => ({
    v: 1, env: 'test', checkedAt: '2026-10-07T08:00:00.000Z', reason: 'faktflow-original', sha256: SHA,
    archivePath: `${T}/ksef-import/${K}.xml`, sizeBytes: 2048, summary: SUMMARY, sameContentExceptHeader: false,
    ownHistory: false, acquiredAt: '2026-09-28T07:15:00.000Z', httpStatus: null, knownInvoice: null, recheck: null,
    importGate: reviewGate(['markers', 'gross-prices'], { preview: NEW_PREVIEW }) as unknown as KsefDuplicateCheck['importGate'],
    ...over,
  });
  /** Nieudane pobranie (503) — dane puste, tylko powód i status (jak `recordCheck('download-pending', …)`). */
  const failedFetch = (status = 503): KsefDuplicateCheck => ({
    v: 1, env: 'test', checkedAt: '2026-10-07T08:00:00.000Z', reason: status === 403 ? 'download-refused' : 'download-pending',
    sha256: null, archivePath: null, sizeBytes: null, summary: null, sameContentExceptHeader: null, ownHistory: null,
    acquiredAt: null, httpStatus: status, knownInvoice: null, recheck: null,
  });

  describe('parseDuplicateCheck', () => {
    it('importGate z release (w całości), preview (bez przebudowy) i recheckNeeded przechodzą przez odczyt z bazy', () => {
      const parsed = previousOf();

      expect(parsed.importGate).toEqual(reviewGate(['gross-prices', 'markers'], { release: RELEASE }));
      expect(parsed.importGate?.preview).toEqual(PREVIEW);
      expect(parsed.importGate?.release).toEqual(RELEASE);
      expect(parsed.recheckNeeded).toEqual(RECHECK_NEEDED);
      expect(parsed.reason).toBe('faktflow-original');
    });

    it('brama bez release i z preview null — poprawna', () => {
      const parsed = previousOf({ importGate: { v: 1, rules: 7, kind: 'importable', problems: [], preview: null }, recheckNeeded: undefined });

      expect(parsed.importGate).toEqual({ v: 1, rules: 7, kind: 'importable', problems: [], preview: null });
      expect(parsed).not.toHaveProperty('recheckNeeded');
    });

    it.each([
      ['v ≠ 1', { v: 2, rules: 1, kind: 'review', problems: ['rates'], preview: null }],
      ['rules nie jest liczbą', { v: 1, rules: '1', kind: 'review', problems: ['rates'], preview: null }],
      ['kind spoza importable/review', { v: 1, rules: 1, kind: 'ok', problems: [], preview: null }],
      ['problems nie jest tablicą', { v: 1, rules: 1, kind: 'review', problems: 'rates', preview: null }],
      ['problems z elementem, który nie jest napisem', { v: 1, rules: 1, kind: 'review', problems: [7], preview: null }],
      ['review bez problemów', { v: 1, rules: 1, kind: 'review', problems: [], preview: null }],
      ['importable z problemami', { v: 1, rules: 1, kind: 'importable', problems: ['rates'], preview: null }],
      ['brama napisem', 'importable'],
      ['brama tablicą', [{ v: 1 }]],
    ])('zły kształt bramy (%s) → klucz pominięty (blokada recheck-needed), reszta znacznika nietknięta', (_name, gate) => {
      const parsed = previousOf({ importGate: gate });

      // Kontrola dodatnia w tym samym teście: poprawna brama NIE jest pomijana.
      expect(previousOf().importGate).toBeDefined();
      expect(parsed).not.toHaveProperty('importGate');
      expect(parsed).toMatchObject({ reason: 'faktflow-original', sha256: SHA, archivePath: `${T}/ksef-import/${K}.xml` });
    });

    it.each([
      ['bez via', { at: RELEASE.at, actorUserId: RELEASE.actorUserId, note: RELEASE.note }],
      ['via „client”', { ...RELEASE, via: 'client' }],
      ['at pustym napisem', { ...RELEASE, at: '' }],
      ['actorUserId liczbą', { ...RELEASE, actorUserId: 7 }],
      ['note liczbą', { ...RELEASE, note: 7 }],
      ['release napisem', 'oddane'],
    ])('zły kształt release (%s) → klucz release pominięty, brama zostaje', (_name, release) => {
      const parsed = previousOf({ importGate: reviewGate(['rates'], { release }) });

      expect(previousOf().importGate?.release).toEqual(RELEASE);
      expect(parsed.importGate).toEqual(reviewGate(['rates']));
      expect(parsed.importGate?.release).toBeUndefined();
    });

    it('release.at niebędące datą, ale niepustym napisem — release zostaje (M5: SQL sprawdza tylko typ), także po scaleniu z nieudanym pobraniem', () => {
      const release = { ...RELEASE, at: 'wczoraj' };
      const previous = previousOf({ importGate: reviewGate(['rates'], { release }) });

      expect(previous.importGate?.release).toEqual(release);
      expect(mergeDuplicateCheck(previous, failedFetch()).importGate?.release).toEqual(release);
    });

    it('release z actorUserId i note równymi null — poprawny (operator bez konta/notatki w starym wpisie)', () => {
      const release = { at: RELEASE.at, via: 'operator', actorUserId: null, note: null };

      expect(previousOf({ importGate: reviewGate(['rates'], { release }) }).importGate?.release).toEqual(release);
    });

    it.each([
      ['kind spoza listy', { kind: 'kiedyś', at: RECHECK_NEEDED.at }],
      ['at nie jest napisem', { kind: 'gate-drift', at: 1 }],
      ['napisem', 'gate-drift'],
    ])('zły kształt recheckNeeded (%s) → klucz pominięty', (_name, bad) => {
      expect(previousOf().recheckNeeded).toEqual(RECHECK_NEEDED);
      expect(previousOf({ recheckNeeded: bad })).not.toHaveProperty('recheckNeeded');
    });
  });

  describe('mergeDuplicateCheck: nieudane pobranie (zachowaj poprzedni)', () => {
    it.each([[503], [403]])('%i po oddaniu → importGate co do bajtu (release.actorUserId, release.note, preview) i recheckNeeded, wynik próby w recheck', (status) => {
      const previous = previousOf();

      const merged = mergeDuplicateCheck(previous, failedFetch(status));

      expect(merged.importGate).toEqual(reviewGate(['gross-prices', 'markers'], { release: RELEASE }));
      expect(merged.importGate?.release?.actorUserId).toBe(RELEASE.actorUserId);
      expect(merged.importGate?.release?.note).toBe(RELEASE.note);
      expect(merged.importGate?.preview).toEqual(PREVIEW);
      expect(merged.recheckNeeded).toEqual(RECHECK_NEEDED);
      expect(merged.recheck).toEqual({ reason: status === 403 ? 'download-refused' : 'download-pending', httpStatus: status, checkedAt: '2026-10-07T08:00:00.000Z' });
      expect(merged.sha256).toBe(SHA);
    });
  });

  describe('mergeDuplicateCheck: nowy zapis (INV-26 release, INV-25 recheckNeeded)', () => {
    it('ten sam plik (SHA, środowisko), ta sama ocena review (problemy jako zbiór, kolejność bez znaczenia) → release przechodzi, preview i reszta z nowej oceny; recheckNeeded nie', () => {
      const merged = mergeDuplicateCheck(previousOf(), nextOf());

      expect(merged.importGate?.release).toEqual(RELEASE);
      expect(merged.importGate).toEqual({ ...reviewGate(['markers', 'gross-prices'], { preview: NEW_PREVIEW }), release: RELEASE });
      expect(merged.importGate?.preview).toEqual(NEW_PREVIEW);
      expect(merged).not.toHaveProperty('recheckNeeded');
      expect(merged.recheck).toBeNull();
      expect(merged.checkedAt).toBe('2026-10-07T08:00:00.000Z');
    });

    it.each([
      ['inny SHA-256 pliku', () => nextOf({ sha256: 'cd'.repeat(32) })],
      ['inne środowisko', () => nextOf({ env: 'production' })],
      ['inne problemy (zbiór różny)', () => nextOf({ importGate: reviewGate(['gross-prices'], { preview: NEW_PREVIEW }) as unknown as KsefDuplicateCheck['importGate'] })],
      ['dodatkowy problem', () => nextOf({ importGate: reviewGate(['gross-prices', 'markers', 'rates']) as unknown as KsefDuplicateCheck['importGate'] })],
      ['nowa ocena importable (plik zgodny z generatorem)', () => nextOf({ importGate: { v: 1, rules: ORIGINAL_GATE_RULES, kind: 'importable', problems: [], preview: null } })],
      ['nowy zapis bez bramy', () => nextOf({ importGate: undefined })],
      ['powód inny niż faktflow-original', () => nextOf({ reason: 'known-number', knownInvoice: { id: 'inna', internalNumber: 'FV/INNA/1' }, importGate: undefined })],
    ])('%s → nowa ocena bez release (przegląd zaczyna się od nowa)', (_name, make) => {
      // Kontrola dodatnia: ten sam poprzedni znacznik z pasującym nowym zapisem release zachowuje.
      expect(mergeDuplicateCheck(previousOf(), nextOf()).importGate?.release).toEqual(RELEASE);

      const merged = mergeDuplicateCheck(previousOf(), make());

      expect(merged.importGate?.release).toBeUndefined();
      expect(merged).not.toHaveProperty('recheckNeeded');
    });

    it('poprzedni znacznik bez release (przegląd bez oddania) → nowy zapis bez release', () => {
      const previous = previousOf({ importGate: reviewGate(['gross-prices', 'markers']) });

      expect(mergeDuplicateCheck(previousOf(), nextOf()).importGate?.release).toEqual(RELEASE);
      const merged = mergeDuplicateCheck(previous, nextOf());

      expect(merged.importGate).toEqual(reviewGate(['markers', 'gross-prices'], { preview: NEW_PREVIEW }));
      expect(merged.importGate?.release).toBeUndefined();
    });

    it('poprzedni znacznik z nieczytelną bramą (pominiętą przy odczycie) → nic do przeniesienia', () => {
      const previous = previousOf({ importGate: { v: 1, rules: 1, kind: 'review', problems: [], preview: null, release: RELEASE } });

      expect(mergeDuplicateCheck(previousOf(), nextOf()).importGate?.release).toEqual(RELEASE);
      expect(mergeDuplicateCheck(previous, nextOf()).importGate?.release).toBeUndefined();
    });

    it('recheckNeeded z poprzedniego znacznika nie przechodzi do nowego zapisu, nawet bez release', () => {
      const previous = previousOf({ importGate: reviewGate(['markers', 'gross-prices']), recheckNeeded: RECHECK_NEEDED });

      expect(previous.recheckNeeded).toEqual(RECHECK_NEEDED);
      expect(mergeDuplicateCheck(previous, nextOf())).not.toHaveProperty('recheckNeeded');
    });
  });
});
