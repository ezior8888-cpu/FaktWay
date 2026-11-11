import { inspect } from 'node:util';

import { NonRetriableError, RetryAfterError } from '@/lib/jobs/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import { KsefApiError } from '@/lib/ksef/client';
import type { Invoice } from '@/types/invoice';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  fullFlow: vi.fn(),
  offline: vi.fn(),
}));

// ── Część 1: submitInvoice na atrapie API KSeF ──
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
  recordKsefSubmissionSent: vi.fn(),
  markKsefSubmission: vi.fn(),
  findOpenKsefSubmission: vi.fn(async () => null),
  isOwnKsefSession: vi.fn(async () => false),
  findSessionReferenceForKsefNumber: vi.fn(async () => 'SESJA-TEST'),
}));
vi.mock('@/lib/ksef/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksef/client')>()),
  ksefFetch: mocks.fetch,
}));
vi.mock('@/lib/ksef/session-cache', () => ({
  ksefSessionCache: { getSession: async () => ({ accessToken: 'token' }) },
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

// ── Część 2: job wysyłki — wszystko poza klasyfikacją błędu wyciszone ──
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn() }));
// Krok 5: job czyta wyłącznik wysyłek autorytatywnie — tu zdjęty.
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: async () => false }));
vi.mock('@/lib/ksef/submit-invoice-full', () => ({ submitInvoiceFullFlow: mocks.fullFlow }));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: async () => ({ offline: false }) }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: mocks.offline }));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(),
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/supabase/admin-queries', () => ({
  getTenantKsefCredentials: vi.fn(async () => ({ type: 'token' })),
  updateInvoiceStatus: vi.fn(),
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
          : {
              id: '11111111-1111-4111-8111-111111111111',
              ksef_status: 'queued', ksef_number: null, ksef_environment: 'test',
              invoice_kind: 'regular', invoice_type: 'VAT', internal_number: 'FV 1/2026',
              fa3_data: { internalNumber: 'FV 1/2026', type: 'VAT' },
            },
        error: null,
      }),
    };
    // Przejęcie wysyłki (AUD-10, 00124) — w tych testach zawsze wolne.
    return { from: () => q, rpc: async (fn: string) => ({ data: fn === 'claim_ksef_send' ? '2026-10-02T12:00:00.000000+00:00' : null, error: null }), };
  },
}));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));

import { KsefInvoiceRejectedError, submitInvoice } from '@/lib/ksef/submit';
import { runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import type { KsefAuth } from '@/lib/ksef/auth';

/**
 * Odrzucenie w STATUSIE faktury (kod ≥ 400 z pollingu) to decyzja KSeF
 * o treści. Wcześniej leciało jako zwykły Error: 5 ponownych wysyłek tej
 * samej faktury, a po wyczerpaniu prób — Offline24 jak przy awarii.
 *
 * 440 „Duplikat faktury” (CIRFMF/ksef-docs, API 2.0.0 RC6.0) znaczy, że
 * faktura o tym numerze JUŻ jest w KSeF — `extensions` podają jej numer.
 */

const ORYGINAL = '5265877635-20250626-010080DD2B5E-26';
const SESJA = '20250626-SO-2F14610000-242991F8C9-B4';

function ksefZwraca(status: Record<string, unknown>) {
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url === '/sessions/online') return { referenceNumber: 'S1' };
    if (url.endsWith('/invoices') && url.startsWith('/sessions/online/')) return { referenceNumber: 'I1' };
    if (url === '/sessions/S1/invoices/I1') return { referenceNumber: 'I1', invoiceHash: 'h', status };
    return {};
  });
}

const DUPLIKAT = {
  code: 440,
  description: 'Duplikat faktury',
  details: [`Duplikat faktury. Faktura o numerze KSeF: ${ORYGINAL} została już prawidłowo przesłana do systemu w sesji: ${SESJA}`],
  extensions: { originalSessionReferenceNumber: SESJA, originalKsefNumber: ORYGINAL },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
});
afterEach(() => vi.unstubAllEnvs());

describe('submitInvoice: odrzucenie w statusie faktury', () => {
  it('440: typowany błąd z numerem KSeF faktury, która już jest w systemie', async () => {
    ksefZwraca(DUPLIKAT);
    const blad = await submitInvoice('<xml/>', {} as KsefAuth, 'test').catch((e: unknown) => e);

    expect(blad).toBeInstanceOf(KsefInvoiceRejectedError);
    const b = blad as KsefInvoiceRejectedError;
    expect(b.isDuplicate).toBe(true);
    expect(b.originalKsefNumber).toBe(ORYGINAL);
    expect(b.originalSessionReferenceNumber).toBe(SESJA);
    expect(b.message).toContain(`numer KSeF ${ORYGINAL}`);
    expect(b.message).toMatch(/sprawdź ją w KSeF/);
  });

  it('440 bez extensions (starsze API): nadal duplikat, komunikat bez numeru', async () => {
    ksefZwraca({ code: 440, description: 'Duplikat faktury' });
    const b = (await submitInvoice('<xml/>', {} as KsefAuth, 'test').catch((e: unknown) => e)) as KsefInvoiceRejectedError;
    expect(b.isDuplicate).toBe(true);
    expect(b.originalKsefNumber).toBeNull();
    expect(b.message).toMatch(/^KSeF ma już fakturę o tym numerze\./);
  });

  it('450 (semantyka): typowany błąd, nie duplikat', async () => {
    ksefZwraca({ code: 450, description: 'Błąd weryfikacji semantyki dokumentu faktury', details: ['P_2'] });
    const b = (await submitInvoice('<xml/>', {} as KsefAuth, 'test').catch((e: unknown) => e)) as KsefInvoiceRejectedError;
    expect(b).toBeInstanceOf(KsefInvoiceRejectedError);
    expect(b.isDuplicate).toBe(false);
    // F-093-STATUS: komunikat (logi, telemetria) to sam status; opis i szczegóły tylko dla klienta.
    expect(b.message).toBe('KSeF odrzucił fakturę (status 450)');
    expect(b.customerMessage).toBe('KSeF odrzucił fakturę: Błąd weryfikacji semantyki dokumentu faktury. Szczegóły: P_2');
    expect(b.ksefDescription).toBe('Błąd weryfikacji semantyki dokumentu faktury');
    expect(b.ksefDetails).toEqual(['P_2']);
  });
});

describe('F-093-STATUS: treść odpowiedzi KSeF poza komunikatem błędu', () => {
  const NABYWCA = 'Nabywca Wartownik Testowy, NIP 9876543210';

  it('serializacja błędu (JSON, inspect, rozpakowanie) nie pokazuje opisu ani szczegółów', () => {
    const b = new KsefInvoiceRejectedError(450, { code: 450, description: 'Opis Wartownika', details: [NABYWCA] });
    const widoczne = [
      b.message,
      String(b.stack),
      JSON.stringify(b),
      JSON.stringify({ ...b }),
      inspect(b, { depth: 8 }),
      inspect(new Error('opakowanie', { cause: b }), { depth: 8 }),
    ].join('\n');

    expect(widoczne).not.toContain('Wartownik');
    expect(widoczne).not.toContain('9876543210');
    expect(b.customerMessage).toBe(`KSeF odrzucił fakturę: Opis Wartownika. Szczegóły: ${NABYWCA}`);
  });

  it('440: komunikat bez szczegółów z KSeF, numer oryginału zostaje', async () => {
    ksefZwraca(DUPLIKAT);
    const b = (await submitInvoice('<xml/>', {} as KsefAuth, 'test').catch((e: unknown) => e)) as KsefInvoiceRejectedError;

    expect(b.message).toContain(`numer KSeF ${ORYGINAL}`);
    expect(b.message).not.toContain('Szczegóły');
    expect(b.message).not.toContain('została już prawidłowo przesłana');
    expect(b.ksefDetails).toEqual(DUPLIKAT.details);
    expect(b.customerMessage).toBe(b.message);
  });

  it.each([
    ['tekst', 'jeden szczegół', ['jeden szczegół']],
    ['obiekt', { pole: 'P_2' }, []],
    ['null', null, []],
    ['lista z nie-tekstem', ['P_2', 7, null], ['P_2']],
  ])('details jako %s: konstruktor nie rzuca (odrzucenie zostaje odrzuceniem)', (_opis, details, oczekiwane) => {
    const b = new KsefInvoiceRejectedError(450, { code: 450, description: 'Opis', details } as never);

    expect(b.message).toBe('KSeF odrzucił fakturę (status 450)');
    expect(b.ksefDetails).toEqual(oczekiwane);
  });

  it('opis nie-tekstem: pusty opis, bez wyjątku', () => {
    const b = new KsefInvoiceRejectedError(450, { code: 450, description: { x: 1 }, details: ['P_2'] } as never);

    expect(b.ksefDescription).toBe('');
    expect(b.customerMessage).toBe('KSeF odrzucił fakturę: . Szczegóły: P_2');
  });

  it('F-093-OPIS: 5xx w statusie bez opisu z KSeF w komunikacie', async () => {
    ksefZwraca({ code: 550, description: 'Opis Wartownika 550' });
    const blad = (await submitInvoice('<xml/>', {} as KsefAuth, 'test').catch((e: unknown) => e)) as Error;

    expect(blad.message).toBe('KSeF przerwał przetwarzanie faktury (status 550)');
  });

  it('F-093-OPIS: faktura przyjęta bez numeru KSeF, komunikat bez opisu z KSeF', async () => {
    ksefZwraca({ code: 200, description: 'Opis Wartownika 200' });
    const blad = (await submitInvoice('<xml/>', {} as KsefAuth, 'test').catch((e: unknown) => e)) as Error;

    expect(blad.message).toBe('KSeF: faktura przetworzona bez numeru KSeF (status 200)');
  });
});

describe('submitInvoice: błąd systemu KSeF (5xx w statusie) to nie odrzucenie', () => {
  // 550: „Przetwarzanie zostało przerwane z przyczyn wewnętrznych systemu.
  // Spróbuj ponownie.” (CIRFMF/ksef-docs, RC5.7). Uwaga recenzji nr 4.
  it.each([
    [550, 'Operacja została anulowana przez system'],
    [500, 'Nieznany błąd'],
  ])('%i → zwykły Error (ponowienie), nie KsefInvoiceRejectedError', async (code, description) => {
    ksefZwraca({ code, description });
    const blad = await submitInvoice('<xml/>', {} as KsefAuth, 'test').catch((e: unknown) => e);

    expect(blad).toBeInstanceOf(Error);
    expect(blad).not.toBeInstanceOf(KsefInvoiceRejectedError);
    expect((blad as Error).message).toContain(`status ${code}`);
  });
});

describe('job wysyłki: odrzucenie w statusie kończy się bez ponowień', () => {
  const ctx: JobContext = {
    attempt: 0,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
  };
  const zdarzenie = {
    invoiceId: '11111111-1111-4111-8111-111111111111',
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    nip: '1234567890',
    environment: 'test' as const,
    invoice: { internalNumber: 'FV 1/2026', type: 'VAT' } as Invoice,
  };

  it.each([
    ['440 duplikat', DUPLIKAT],
    ['450 semantyka', { code: 450, description: 'Błąd semantyki' }],
  ])('%s → NonRetriableError (nie RetryAfterError, więc bez Offline24)', async (_opis, status) => {
    // D-A4-1: przy 440 runner pobiera oryginał z KSeF; tu KSeF odmawia (403) → werdykt dla operatora.
    mocks.fetch.mockRejectedValue(new KsefApiError(403, 'Forbidden', 'Forbidden'));
    mocks.fullFlow.mockRejectedValue(new KsefInvoiceRejectedError(status.code, status));
    const blad = await runSubmitInvoice(zdarzenie, ctx).catch((e: unknown) => e);

    expect(blad).toBeInstanceOf(NonRetriableError);
    expect(blad).not.toBeInstanceOf(RetryAfterError);
    expect(mocks.offline).not.toHaveBeenCalled();
  });

  it('komunikat duplikatu z numerem KSeF trafia do błędu joba (a stamtąd na fakturę)', async () => {
    mocks.fetch.mockRejectedValue(new KsefApiError(403, 'Forbidden', 'Forbidden'));
    mocks.fullFlow.mockRejectedValue(new KsefInvoiceRejectedError(440, DUPLIKAT));
    const blad = (await runSubmitInvoice(zdarzenie, ctx).catch((e: unknown) => e)) as Error;
    expect(blad.message).toContain(ORYGINAL);
  });

  it('awaria sieci nadal jest ponawiana', async () => {
    mocks.fullFlow.mockRejectedValue(new Error('ECONNRESET'));
    await expect(runSubmitInvoice(zdarzenie, ctx)).rejects.toBeInstanceOf(RetryAfterError);
  });
});
