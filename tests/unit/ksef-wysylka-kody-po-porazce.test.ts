import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { Invoice } from '@/types/invoice';
import { KsefApiError } from '@/lib/ksef/client';

/**
 * Cykl życia faktury, PR 2 — runner wysyłki po porażce (rewizja 03.10.2026):
 *
 *   W1  błąd odczytu poświadczeń (PostgREST/sieć) kończył fakturę jako
 *       `rejected` („KSeF odrzucił”), choć KSeF nic nie dostał;
 *   S1  odrzucenie w statusie (450) i cudzy duplikat (440) zostawiały wpis
 *       `ksef_submissions` otwarty, więc każda kolejna próba „uzgadniała”
 *       nieistniejącą sesję;
 *   W3  `onExhausted` z `handled:false` (zły payload, inne środowisko)
 *       zostawiał fakturę w `queued` na zawsze, bez alarmu;
 *   I4  po `failed`/`rejected` wiersz ma kod z katalogu i zwolnione przejęcie.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  flag: vi.fn(),
  health: vi.fn(),
  audit: vi.fn(),
  verification: vi.fn(),
  fullFlow: vi.fn(),
  credentials: vi.fn(),
  findOpen: vi.fn(),
  markSubmission: vi.fn(),
  sendEvent: vi.fn(),
  captureMessage: vi.fn(),
  download: vi.fn(),
  sessionRow: vi.fn(),
  readOurXml: vi.fn(),
  numberTaken: vi.fn(),
  closeAttempt: vi.fn(),
  /** Wynik `ksef_has_contact_evidence` (00131/00136). */
  evidence: false as boolean | null,
  /** Wynik `claim_ksef_send`: znacznik czasu = przejęte, `null` = trzyma inna próba (S22). */
  claim: '2026-10-03T12:00:00.000000+00:00' as string | null,
  invoice: {} as Record<string, unknown>,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: mocks.flag }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: mocks.audit }));
vi.mock('@/lib/auth/ksef-verification-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/ksef-verification-guard')>();
  return {
    ...actual,
    requireKsefVerification: mocks.verification,
    requireKsefVerificationForBackgroundJob: mocks.verification,
  };
});
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: mocks.health }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@/lib/ksef/submit-invoice-full', () => ({ submitInvoiceFullFlow: mocks.fullFlow }));
vi.mock('@/lib/ksef/submit-reference-boundary', () => ({ assertSubmitReferences: async () => 'regular' }));
// D-A4-1: pobranie oryginału przy cudzym 440 i odczyt naszego pliku (reszta modułów prawdziwa).
vi.mock('@/lib/ksef/submit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ksef/submit')>(),
  downloadKsefInvoice: mocks.download,
}));
vi.mock('@/lib/storage/r2', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/storage/r2')>(),
  downloadInvoiceXml: mocks.readOurXml,
}));
vi.mock('@/lib/ksef/submission-log', () => ({
  // A2: bez zamiarów wysyłki do rozstrzygnięcia — runner idzie jak dotąd.
  findOpenKsefSubmissionIntents: vi.fn(async () => []),
  promoteKsefSubmissionIntent: vi.fn(async () => false),
  abandonKsefSubmissionIntent: vi.fn(),
  recordKsefSubmissionIntent: vi.fn(),
  // D-A4-1: weryfikacja cudzego 440 — domyślnie bez sesji w historii i bez znanego numeru.
  findKsefSessionRow: mocks.sessionRow,
  findSubmissionPayloads: vi.fn(async () => []),
  findTenantInvoiceByKsefNumber: vi.fn(async () => null),
  closeKsefAttempt: mocks.closeAttempt,
  markKsefSubmissionsNumberTaken: mocks.numberTaken,
  recordKsefDuplicateCheck: vi.fn(),
  recordKsefAcceptedSession: vi.fn(),
  markKsefAttemptDuplicatePending: vi.fn(),
  recordKsefSubmissionSent: vi.fn(),
  markKsefSubmission: mocks.markSubmission,
  findOpenKsefSubmission: mocks.findOpen,
  isOwnKsefSession: vi.fn(async () => false),
  findSessionReferenceForKsefNumber: vi.fn(async () => null),
}));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn(), assertJobIdentity: vi.fn() }));
vi.mock('@/lib/supabase/admin-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/admin-queries')>();
  return { ...actual, getTenantKsefCredentials: mocks.credentials, updateInvoiceStatus: vi.fn() };
});
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: async () => {
    let patch: Record<string, unknown> | null = null;
    const q = {
      select: () => q,
      eq: () => q,
      in: () => q,
      or: () => q,
      update: (p: Record<string, unknown>) => { patch = p; return q; },
      maybeSingle: async () => {
        if (patch) {
          mocks.updates.push(patch);
          Object.assign(mocks.invoice, patch);
          return { data: { id: ID }, error: null };
        }
        return { data: { ...mocks.invoice }, error: null };
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (patch) { mocks.updates.push(patch); Object.assign(mocks.invoice, patch); }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return {
      from: () => q,
      rpc: async (fn: string) => ({
        data: fn === 'claim_ksef_send' ? mocks.claim : fn === 'ksef_has_contact_evidence' ? mocks.evidence : null,
        error: null,
      }),
    };
  },
}));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: mocks.captureMessage, addBreadcrumb: vi.fn() }));

import { onSubmitInvoiceExhausted, runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import { KsefCredentialsError } from '@/lib/supabase/admin-queries';
import { KsefInvoiceRejectedError } from '@/lib/ksef/submit';
import { InvoiceXmlSchemaError } from '@/lib/xml/validator';

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: mocks.sendEvent, scheduleAfter: vi.fn() },
};

function event(environment: 'test' | 'production' = 'test') {
  return {
    invoiceId: ID,
    tenantId: TENANT,
    nip: '1234567890',
    environment,
    sendAttemptId: ATTEMPT,
    invoice: { type: 'VAT', internalNumber: 'FV/1', issueDate: '2026-10-01' } as Invoice,
  };
}

type ThrownError = Error & { countsAsAttempt?: boolean };

/** Runner MA rzucić — wynik bez błędu to porażka testu. */
async function failing(run: Promise<unknown>): Promise<ThrownError> {
  return run.then(
    () => { throw new Error('oczekiwano błędu, runner zakończył się sukcesem'); },
    (e: unknown) => e as ThrownError,
  );
}

function lastInvoiceUpdate() {
  return mocks.updates.filter((u) => 'ksef_status' in u).at(-1);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flag.mockResolvedValue(false);
  mocks.verification.mockResolvedValue(undefined);
  mocks.health.mockResolvedValue({ offline: false });
  mocks.findOpen.mockResolvedValue(null);
  mocks.evidence = false;
  mocks.credentials.mockResolvedValue({ type: 'token', nip: '1234567890', token: 't' });
  mocks.invoice = {
    id: ID, direction: 'outgoing', ksef_status: 'queued', ksef_number: null, ksef_environment: 'test',
    invoice_type: 'VAT', invoice_kind: 'regular', internal_number: 'FV/1',
    fa3_data: { type: 'VAT', internalNumber: 'FV/1', issueDate: '2026-10-01' },
  };
  mocks.updates = [];
  mocks.claim = '2026-10-03T12:00:00.000000+00:00';
  vi.stubEnv('KSEF_ENV', 'test');
});
afterEach(() => vi.unstubAllEnvs());

describe('W1: błąd infrastruktury przy odczycie poświadczeń', () => {
  it('jest ponawiany (zwykły błąd), a po wyczerpaniu kończy jako failed INFRA, nie rejected', async () => {
    mocks.credentials.mockRejectedValue(new KsefCredentialsError('tenant-read', 'Tenant x not found: TypeError: fetch failed'));

    const error = await failing(runSubmitInvoice(event(), ctx));
    expect(error).toBeInstanceOf(Error);
    expect(error.name).not.toBe('NonRetriableError');

    await onSubmitInvoiceExhausted(error, event(), { ...ctx, attempt: 5 });
    expect(lastInvoiceUpdate()).toMatchObject({ ksef_status: 'failed', last_error_code: 'INFRA', ksef_send_owner: null });
  });

  it('brak certyfikatu kończy jako failed NO_CERTIFICATE (klient uzupełnia ustawienia), nie rejected', async () => {
    mocks.credentials.mockRejectedValue(new KsefCredentialsError('missing', 'Tenant x nie ma skonfigurowanych credentials KSeF'));

    const error = await failing(runSubmitInvoice(event(), ctx));
    expect(error.name).toBe('NonRetriableError');

    await onSubmitInvoiceExhausted(error, event(), ctx);
    expect(lastInvoiceUpdate()).toMatchObject({ ksef_status: 'failed', last_error_code: 'NO_CERTIFICATE', ksef_send_owner: null });
  });

  it('brak klucza po rotacji: ponowienie z alarmem dla operatora, po wyczerpaniu failed CREDENTIALS_UNAVAILABLE', async () => {
    mocks.credentials.mockRejectedValue(new KsefCredentialsError('decrypt', 'decryptCredentials: brak klucza, którym zaszyfrowano dane (rotacja?)'));

    const error = await failing(runSubmitInvoice(event(), ctx));
    expect(error.name).not.toBe('NonRetriableError');
    expect(mocks.captureMessage).toHaveBeenCalled();

    await onSubmitInvoiceExhausted(error, event(), { ...ctx, attempt: 5 });
    expect(lastInvoiceUpdate()).toMatchObject({ ksef_status: 'failed', last_error_code: 'CREDENTIALS_UNAVAILABLE' });
  });
});

describe('S1: odrzucenie przez KSeF zamyka wpis historii', () => {
  it('450 w statusie: wpis sent → rejected, faktura rejected KSEF_REJECTED bez przejęcia', async () => {
    mocks.fullFlow.mockRejectedValue(new KsefInvoiceRejectedError(450, { code: 450, description: 'Błąd semantyczny', details: ['P_15'] } as never));
    // Pierwszy odczyt (uzgodnienie przed POST): brak wcześniejszej próby;
    // drugi (po odrzuceniu): wpis `sent` zapisany przez hook wysyłki.
    mocks.findOpen
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ sessionReferenceNumber: 'SES-1', invoiceReferenceNumber: 'REF-1' });

    const error = await failing(runSubmitInvoice(event(), ctx));
    expect(error.name).toBe('NonRetriableError');
    expect(mocks.markSubmission).toHaveBeenCalledWith(expect.objectContaining({
      invoiceReferenceNumber: 'REF-1', status: 'rejected', errorCode: '450',
    }));

    await onSubmitInvoiceExhausted(error, event(), ctx);
    expect(lastInvoiceUpdate()).toMatchObject({ ksef_status: 'rejected', last_error_code: 'KSEF_REJECTED', ksef_send_owner: null });
  });

  // D-A4-1: cudzy 440 rozstrzyga treść oryginału pobranego z KSeF; tu cała
  // ścieżka do `onExhausted` z prawdziwym klasyfikatorem (werdykt wygrywa
  // z KsefInvoiceRejectedError i błędem HTTP pobrania w łańcuchu przyczyn).
  const foreign440 = () => new KsefInvoiceRejectedError(440, {
    code: 440, description: 'Duplikat', details: [],
    extensions: { originalKsefNumber: '9999999999-20261001-000000000001-00', originalSessionReferenceNumber: 'CUDZA' },
  } as never, { invoiceHash: 'nasz', sessionReferenceNumber: 'SES-2', invoiceReferenceNumber: 'REF-2' });

  it('cudzy duplikat 440, oryginał z innego programu o innej treści: wpisy → number_taken, faktura failed KSEF_NUMBER_TAKEN', async () => {
    mocks.fullFlow.mockRejectedValue(foreign440());
    mocks.download.mockResolvedValue(Buffer.from('<Faktura><Naglowek><SystemInfo>Inny</SystemInfo></Naglowek><Fa><P_2>FV/1</P_2><P_15>9.99</P_15></Fa></Faktura>'));
    // Nasz plik tej próby (inna treść) — porównanie poza nagłówkiem.
    mocks.sessionRow.mockResolvedValue({ status: 'sent', requestPayloadHash: 'ab'.repeat(32), xmlStoragePath: 'nasz.xml' });
    mocks.readOurXml.mockResolvedValue('<Faktura><Naglowek><SystemInfo>KSeF SaaS v1.0</SystemInfo></Naglowek><Fa><P_2>FV/1</P_2><P_15>123.00</P_15></Fa></Faktura>');

    const error = await failing(runSubmitInvoice(event(), ctx));
    expect(mocks.numberTaken).toHaveBeenCalledWith(expect.objectContaining({ originalKsefNumber: '9999999999-20261001-000000000001-00' }));

    await onSubmitInvoiceExhausted(error, event(), ctx);
    expect(lastInvoiceUpdate()).toMatchObject({ ksef_status: 'failed', last_error_code: 'KSEF_NUMBER_TAKEN', ksef_send_owner: null });
    expect(String(lastInvoiceUpdate()?.last_error)).toContain('9999999999-20261001-000000000001-00');
  });

  it('cudzy duplikat 440, oryginału nie da się pobrać (403): faktura failed KSEF_DUPLICATE_RECONCILE, wpis zostaje otwarty', async () => {
    mocks.fullFlow.mockRejectedValue(foreign440());
    mocks.download.mockRejectedValue(new KsefApiError(403, 'Forbidden', 'Forbidden'));

    const error = await failing(runSubmitInvoice(event(), ctx));
    expect(mocks.closeAttempt).not.toHaveBeenCalled();
    expect(mocks.markSubmission).not.toHaveBeenCalled();

    await onSubmitInvoiceExhausted(error, event(), ctx);
    expect(lastInvoiceUpdate()).toMatchObject({ ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE', ksef_send_owner: null });
  });
});

describe('XSD i kody terminalne', () => {
  it('XSD: rejected XSD_INVALID (klient wraca do szkicu)', async () => {
    mocks.fullFlow.mockRejectedValue(new InvoiceXmlSchemaError(['P_7: maxLength']));
    const error = await failing(runSubmitInvoice(event(), ctx));
    expect(error.name).toBe('NonRetriableError');
    await onSubmitInvoiceExhausted(error, event(), ctx);
    expect(lastInvoiceUpdate()).toMatchObject({ ksef_status: 'rejected', last_error_code: 'XSD_INVALID', ksef_send_owner: null });
  });
});

describe('W3: onExhausted zawsze zostawia ślad', () => {
  it('zdarzenie z innego środowiska: failed ENV_MISMATCH + Sentry.captureMessage, nie cicho queued', async () => {
    const result = await onSubmitInvoiceExhausted(new Error('cokolwiek'), event('production'), ctx);
    expect(result).toMatchObject({ handled: true, finalStatus: 'failed' });
    expect(lastInvoiceUpdate()).toMatchObject({ ksef_status: 'failed', last_error_code: 'ENV_MISMATCH' });
    expect(mocks.captureMessage).toHaveBeenCalled();
    // D-A4-2: komunikat dla klienta — które środowiska i co zrobić (szkic, nie ponowienie).
    const message = String(lastInvoiceUpdate()?.last_error ?? '');
    expect(message).toContain('production');
    expect(message).toContain('Wróć do szkicu');
  });

  it('D-A4-2: ENV_MISMATCH przy dowodzie kontaktu (wcześniejsza próba mogła dotrzeć do KSeF) — bez „nie została wysłana” i bez „wróć do szkicu”', async () => {
    mocks.evidence = true;
    await onSubmitInvoiceExhausted(new Error('cokolwiek'), event('production'), ctx);
    expect(lastInvoiceUpdate()).toMatchObject({ ksef_status: 'failed', last_error_code: 'ENV_MISMATCH' });
    const message = String(lastInvoiceUpdate()?.last_error ?? '');
    expect(message).toContain('nie wystawiaj');
    expect(message).not.toContain('nie została wysłana');
    expect(message).not.toContain('Wróć do szkicu');
    // Decyzja Bartosza 07.10.2026 (A4b PR2b): panel operatora nie ma tu ścieżki — pomoc FaktWay sprawdzi fakturę w KSeF.
    expect(message).not.toMatch(/uzgodni (ją|go) operator/);
    expect(message).toContain('pomoc@faktway.pl');
  });

  it('zły payload (bez nip): failed INVALID_EVENT, gdy da się ustalić fakturę i firmę', async () => {
    const broken = { ...event(), nip: undefined } as unknown as Parameters<typeof onSubmitInvoiceExhausted>[1];
    const result = await onSubmitInvoiceExhausted(new Error('Niepoprawny payload'), broken, ctx);
    expect(result).toMatchObject({ handled: true, finalStatus: 'failed' });
    expect(lastInvoiceUpdate()).toMatchObject({ ksef_status: 'failed', last_error_code: 'INVALID_EVENT' });
    expect(mocks.captureMessage).toHaveBeenCalled();
  });

  it('faktura przychodząca: żadnej zmiany stanu, ale alarm', async () => {
    mocks.invoice.direction = 'incoming';
    const result = await onSubmitInvoiceExhausted(new Error('x'), event(), ctx);
    expect(result).toMatchObject({ handled: false, reason: 'invoice-direction-mismatch' });
    expect(lastInvoiceUpdate()).toBeUndefined();
    expect(mocks.captureMessage).toHaveBeenCalled();
  });
});

describe('S22: oczekiwanie nie zużywa próby', () => {
  it('„wysyłkę trzyma inna próba” to RetryAfterError bez zużycia próby', async () => {
    // Bez vi.resetModules/doMock: pod pełnym biegiem Vitest podmiana modułu
    // w locie była niestabilna (runner trafiał na inną instancję atrapy).
    mocks.claim = null;
    const error = await failing(runSubmitInvoice(event(), ctx));
    expect(error.name).toBe('RetryAfterError');
    expect(error.countsAsAttempt).toBe(false);
    expect(mocks.fullFlow).not.toHaveBeenCalled();
  });
});
