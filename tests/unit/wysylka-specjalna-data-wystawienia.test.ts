import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { Invoice } from '@/types/invoice';
import type { AdvanceInvoiceData, CorrectionInvoiceData } from '@/types/invoice-types';

/**
 * Decyzja Bartosza 06.10.2026 (A4b PR2, krytyka projektu B1): dokument
 * specjalny (KOR, ZAL, ROZ) nie wychodzi do KSeF z datą wystawienia inną niż
 * dziś. Sprawdzenie przy zleceniu nie wystarcza — ponowienia pg-boss (do ok.
 * 1 h 20 min) i oczekiwanie na przejęcie potrafią przenieść POST za północ,
 * a w KSeF dokument wystawia się w dniu wysyłki (art. 106na ust. 1; F-092):
 * z wcześniejszą datą byłby fakturą offline bez oznaczeń. Worker przed
 * wysyłką (i drugi raz w haku sesji, `wysylka-specjalna-data-przed-plikiem`) odmawia z kodem ISSUE_DATE_PASSED (terminal, 00147) — dotyczy też
 * pierwszej wysyłki po północy. Zwykła faktura bez zmian (B1/B2).
 *
 * Prawdziwy runner (`runSubmitInvoice`, `onSubmitInvoiceExhausted`); atrapy:
 * baza, HTTP KSeF (`submitInvoiceFullFlow`), granica dokumentu (rodzaj).
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
  /** Rodzaj dokumentu z granicy wysyłki (`assertSubmitReferences`). */
  kind: 'regular' as 'regular' | 'correction' | 'advance' | 'final',
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
vi.mock('@/lib/ksef/submit-reference-boundary', () => ({ assertSubmitReferences: async () => mocks.kind }));
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
import { classifySendError, SEND_ERROR_CODES } from '@/lib/ksef/send-error-codes';
import { NonRetriableError } from '@/lib/jobs/errors';
import { decideResend } from '@/lib/invoices/ksef-send-policy';
import { operatorRequeueButton } from '@/lib/admin/ksef-operator-policy';

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: mocks.sendEvent, scheduleAfter: vi.fn() },
};

function event(kind: 'regular' | 'advance' | 'correction', issueDate: string) {
  const type = kind === 'advance' ? 'ZAL' : kind === 'correction' ? 'KOR' : 'VAT';
  return {
    invoiceId: ID,
    tenantId: TENANT,
    nip: '1234567890',
    environment: 'test' as const,
    sendAttemptId: ATTEMPT,
    invoice: { type, internalNumber: `${type}/1`, issueDate } as Invoice,
    // Koperty skrócone — granica dokumentu jest tu atrapą (rodzaj z `mocks.kind`).
    ...(kind === 'advance' ? { advanceData: { invoiceType: 'advance', internalNumber: 'ZAL/1', issueDate } as unknown as AdvanceInvoiceData } : {}),
    ...(kind === 'correction' ? { correctionData: { invoiceType: 'correction', internalNumber: 'KOR/1', issueDate } as unknown as CorrectionInvoiceData } : {}),
  };
}

function useDocument(kind: 'regular' | 'advance' | 'correction', issueDate: string) {
  const type = kind === 'advance' ? 'ZAL' : kind === 'correction' ? 'KOR' : 'VAT';
  mocks.kind = kind;
  Object.assign(mocks.invoice, {
    invoice_type: type, invoice_kind: kind, internal_number: `${type}/1`, issue_date: issueDate,
    fa3_data: { type, internalNumber: `${type}/1`, issueDate },
  });
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
  mocks.kind = 'regular';
  mocks.fullFlow.mockResolvedValue({ ksefNumber: '1234567890-20261002-0100A0B0C0D1-AF', status: 'accepted' });
  vi.stubEnv('KSEF_ENV', 'test');
  // „Dziś” w Polsce: 02.10.2026 (dzień po dacie wystawienia z testu).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-02T09:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});


describe('ISSUE_DATE_PASSED: dokument specjalny tylko w dniu wystawienia (decyzja 06.10.2026)', () => {
  it.each(['advance', 'correction'] as const)('%s z datą wczorajszą → bez POST, failed ISSUE_DATE_PASSED z komunikatem', async (kind) => {
    useDocument(kind, '2026-10-01');
    const error = await failing(runSubmitInvoice(event(kind, '2026-10-01'), ctx));
    expect(error.name).toBe('NonRetriableError');
    expect(mocks.fullFlow).not.toHaveBeenCalled();

    await onSubmitInvoiceExhausted(error, event(kind, '2026-10-01'), ctx);
    expect(lastInvoiceUpdate()).toMatchObject({ ksef_status: 'failed', last_error_code: 'ISSUE_DATE_PASSED' });
    const message = String(lastInvoiceUpdate()?.last_error ?? '');
    expect(message).toContain('2026-10-01');
    expect(message).toContain('2026-10-02');
    expect(message).not.toMatch(/^NonRetriableError/);
  });

  it('północ między bezpiecznikiem a plikiem (odmowa z haka sesji) → bez ponowienia, failed ISSUE_DATE_PASSED', async () => {
    useDocument('advance', '2026-10-02');
    const { IssueDatePassedError } = await import('@/lib/ksef/special-issue-date');
    mocks.fullFlow.mockRejectedValueOnce(new IssueDatePassedError('2026-10-02', '2026-10-03'));
    const error = await failing(runSubmitInvoice(event('advance', '2026-10-02'), ctx));
    // Nie RetryAfterError: ponowienie po 30 s tylko odłożyłoby tę samą odmowę.
    expect(error.name).toBe('NonRetriableError');

    await onSubmitInvoiceExhausted(error, event('advance', '2026-10-02'), ctx);
    expect(lastInvoiceUpdate()).toMatchObject({ ksef_status: 'failed', last_error_code: 'ISSUE_DATE_PASSED' });
    expect(String(lastInvoiceUpdate()?.last_error ?? '')).toContain('2026-10-03');
  });

  it('zaliczka z dzisiejszą datą → wysyłka jak dotąd', async () => {
    useDocument('advance', '2026-10-02');
    await runSubmitInvoice(event('advance', '2026-10-02'), ctx);
    expect(mocks.fullFlow).toHaveBeenCalledTimes(1);
  });

  it('zwykła faktura z wczorajszą datą → wysyłka jak dotąd (B1/B2 bez zmian)', async () => {
    useDocument('regular', '2026-10-01');
    await runSubmitInvoice(event('regular', '2026-10-01'), ctx);
    expect(mocks.fullFlow).toHaveBeenCalledTimes(1);
  });

  it('klasyfikacja: znacznik [ISSUE_DATE_PASSED] → kod z katalogu, klasa terminal (szkic, bez automatu)', () => {
    expect(classifySendError(new NonRetriableError('[ISSUE_DATE_PASSED] x'))).toEqual({ code: 'ISSUE_DATE_PASSED', class: 'terminal' });
  });

  it('klient: „Wróć do szkicu” z powodem daty; operator: odmowa ponowienia z powodem', () => {
    const decision = decideResend({
      direction: 'outgoing', status: 'failed', errorCode: SEND_ERROR_CODES.ISSUE_DATE_PASSED, invoiceKind: 'advance',
      facts: { sendData: 'stored', kindHeld: false, issueDatePassed: true }, environmentKnown: true,
    });
    expect(decision).toMatchObject({ allowed: false, reason: 'terminal' });
    expect((decision as { message: string }).message).toMatch(/datę wystawienia sprzed dzisiaj/);
    // A4b PR2b (decyzja 07.10.2026): zablokowany szkic → pomoc FaktWay; „uzgodni operator” nie ma ścieżki w panelu.
    expect((decision as { message: string }).message).not.toMatch(/uzgodni/);
    const button = operatorRequeueButton({
      direction: 'outgoing', status: 'failed', errorCode: SEND_ERROR_CODES.ISSUE_DATE_PASSED, invoiceKind: 'advance',
      facts: { sendData: 'stored', kindHeld: false, issueDatePassed: true }, environmentKnown: true,
    });
    expect(button.enabled).toBe(false);
    expect(button.reason).toMatch(/datą wystawienia sprzed dzisiaj/);
    // Kod powstaje bez otwartego wpisu — „Tylko uzgodnij” nie ma tu czego uzgadniać.
    expect(button.reason).not.toMatch(/Tylko uzgodnij/);
  });
});
