import { NonRetriableError } from '@/lib/jobs/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { EnqueueKsefSubmitParams } from '@/lib/invoices/ksef-submit-enqueue';
import type { KsefSendMode } from '@/lib/invoices/ksef-send-step';
import type { JobContext } from '@/lib/jobs/registry';
import type { Invoice } from '@/types/invoice';

/**
 * Krok 5 planu automatyzacji — hamulce i konfiguracja fail-closed.
 *
 * - AUD-63: wyłącznik `killAllKsefSubmissions` istniał, ale nikt go nie czytał.
 * - AUD-03/04: korekty liczone błędnie — na KSeF produkcyjnym zostają szkicem.
 * - AUD-09: brak `JOBS_BACKEND` po cichu wybierał Inngest.
 * - AUD-20: mocki KSeF/GUS/Anthropic/Resend włączała sama zmienna.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const mocks = vi.hoisted(() => ({
  flag: vi.fn(),
  send: vi.fn(),
  offline: vi.fn(),
  health: vi.fn(),
  audit: vi.fn(),
  verification: vi.fn(),
  fullFlow: vi.fn(),
  credentials: vi.fn(),
  findOpen: vi.fn(),
  sendEvent: vi.fn(),
  invoice: {} as Record<string, unknown>,
  updates: [] as Array<Record<string, unknown>>,
  /** Blob certyfikatu firmy (`tenants.ksef_credentials_encrypted`); null = brak certyfikatu. */
  blob: null as unknown,
}));

vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: mocks.flag }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: mocks.send }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: mocks.audit }));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerification: mocks.verification,
  requireKsefVerificationForBackgroundJob: mocks.verification,
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: mocks.health }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: mocks.offline }));
vi.mock('@/lib/ksef/submit-invoice-full', () => ({ submitInvoiceFullFlow: mocks.fullFlow }));
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
  findOpenKsefSubmission: mocks.findOpen,
  isOwnKsefSession: vi.fn(async () => false),
  findSessionReferenceForKsefNumber: vi.fn(async () => null),
}));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn() }));
vi.mock('@/lib/supabase/admin-queries', () => ({
  getTenantKsefCredentials: mocks.credentials,
  updateInvoiceStatus: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({
  // Prawdziwy `createAdminClient` jest synchroniczny (`lib/supabase/server.ts`):
  // runner woła go z `await`, enqueue bez — mock musi obsłużyć obie drogi.
  createAdminClient: () => {
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
        if (patch) mocks.updates.push(patch);
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    // Blob certyfikatu czyta enqueue kluczem serwisowym (00112, AUD-103).
    const tenants = {
      select: () => tenants,
      eq: () => tenants,
      single: async () => ({ data: { ksef_credentials_encrypted: mocks.blob }, error: null }),
    };
    // Przejęcie wysyłki (AUD-10, 00124) — w tych testach zawsze wolne.
    return {
      from: (table: string) => (table === 'tenants' ? tenants : q),
      rpc: async (fn: string) => ({ data: fn === 'claim_ksef_send' ? '2026-10-02T12:00:00.000000+00:00' : null, error: null }),
    };
  },
}));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));

import {
  enqueueKsefSubmitAfterDraft,
  type KsefSubmitEnqueueResult,
} from '@/lib/invoices/ksef-submit-enqueue';
import {
  resendMissingCredentialsMessage,
  resendPausedMessage,
  resendPauseUnknownMessage,
} from '@/lib/invoices/ksef-send-policy';
import { onSubmitInvoiceExhausted, runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import { classifySendError } from '@/lib/ksef/send-error-codes';
import {
  heldErrorMessage,
  KOR_HOLD,
  KOR_HOLD_JOB_MESSAGE,
  KOR_HOLD_MESSAGE,
  KSEF_PAUSED,
  KSEF_PAUSED_JOB_MESSAGE,
  KSEF_PAUSED_MESSAGE,
  KSEF_PAUSED_SPECIAL_JOB_MESSAGE,
} from '@/lib/ksef/submission-holds';
import {
  assertPgBossWorkerBackend,
  getJobsBackend,
  resolveJobsBackend,
} from '@/lib/jobs/config';
import { isAnthropicMocked, isGusMocked, isKsefMocked, isResendMocked } from '@/lib/test-mode';

const noDatabaseAccess = { from: vi.fn() } as unknown as SupabaseClient;

function enqueueParams(
  type: Invoice['type'],
  auditKind: EnqueueKsefSubmitParams['auditKind'],
  mode?: KsefSendMode,
) {
  return {
    supabase: noDatabaseAccess,
    tenantId: TENANT,
    userId: USER,
    invoiceId: ID,
    nip: '1234567890',
    environment: 'test' as const,
    invoice: { type, internalNumber: 'FK/1' } as Invoice,
    auditKind,
    ...(mode ? { mode } : {}),
  };
}

/** „Wyślij ponownie” klienta przy fakturze `failed` (K3): ten sam enqueue w trybie ponowienia. */
function resendParams(type: Invoice['type'], auditKind: EnqueueKsefSubmitParams['auditKind']) {
  return enqueueParams(type, auditKind, { kind: 'requeue', actorUserId: USER });
}

/** Treść odmowy enqueue; sukces tam, gdzie test oczekuje odmowy, to błąd testu. */
function refusal(result: KsefSubmitEnqueueResult): string {
  if (result.ok) throw new Error(`oczekiwano odmowy, jest ${result.mode}`);
  return result.error;
}

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: {
    run: async (_name, fn) => fn(),
    sleep: vi.fn(),
    sendEvent: mocks.sendEvent,
    scheduleAfter: vi.fn(),
  },
};

function submitEvent(type: Invoice['type'] = 'VAT') {
  return {
    invoiceId: ID,
    tenantId: TENANT,
    nip: '1234567890',
    environment: 'test' as const,
    invoice: { type, internalNumber: 'FV/1', issueDate: '2026-10-01' } as Invoice,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flag.mockResolvedValue(false);
  mocks.verification.mockResolvedValue(undefined);
  mocks.health.mockResolvedValue({ offline: false });
  mocks.findOpen.mockResolvedValue(null);
  mocks.credentials.mockResolvedValue({ type: 'token', nip: '1234567890' });
  // Faktura w bazie = treść zdarzenia `submitEvent()` (kontrola z #63).
  mocks.invoice = {
    id: ID,
    ksef_status: 'queued',
    ksef_number: null,
    ksef_environment: 'test',
    invoice_type: 'VAT',
    invoice_kind: 'regular',
    internal_number: 'FV/1',
    fa3_data: { type: 'VAT', internalNumber: 'FV/1', issueDate: '2026-10-01' },
  };
  mocks.updates = [];
  mocks.blob = null;
  vi.stubEnv('KSEF_ENV', 'test');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('wyłącznik wysyłek przy kolejkowaniu', () => {
  it('włączony wyłącznik zatrzymuje fakturę przed kolejką i Offline24', async () => {
    mocks.flag.mockResolvedValue(true);
    const result = await enqueueKsefSubmitAfterDraft(enqueueParams('VAT', 'regular'));
    expect(result).toEqual({ ok: false, error: KSEF_PAUSED_MESSAGE });
    expect(mocks.flag).toHaveBeenCalledWith('killAllKsefSubmissions');
    expect(mocks.verification).not.toHaveBeenCalled();
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.offline).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('awaria odczytu wyłącznika = brak wysyłki (fail-closed)', async () => {
    mocks.flag.mockRejectedValue(new Error('baza niedostępna'));
    const result = await enqueueKsefSubmitAfterDraft(enqueueParams('VAT', 'regular'));
    expect(result.ok).toBe(false);
    expect(mocks.verification).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

/**
 * A4b PR2b (spec §2.3): „Wyślij ponownie” przy fakturze `failed` idzie przez
 * ten sam enqueue w trybie `requeue`. Odmowa nie zmienia stanu — faktura
 * zostaje z błędem wysyłki, nie wraca do szkicu — więc tekst nie może mówić
 * „zapisana jako szkic” (do PR2b mówiły tak: `KSEF_PAUSED_MESSAGE`, tekst
 * awarii odczytu wyłącznika i `missingCredentialsMessage` w enqueue). Teksty
 * pierwszej wysyłki szkicu (test wyłącznika wyżej, wyczerpanie prób niżej)
 * zostają celowo bez zmian — pilnują ich strażniki.
 */
describe('ponowienie z failed — prawdziwe teksty odmowy enqueue (A4b PR2b)', () => {
  it('włączony wyłącznik przy ponowieniu zwykłej faktury: bez „szkicu”, faktura zostaje z błędem wysyłki', async () => {
    mocks.flag.mockResolvedValue(true);
    const error = refusal(await enqueueKsefSubmitAfterDraft(resendParams('VAT', 'regular')));
    expect(error).not.toMatch(/szkic/);
    expect(error).toMatch(/nie wykonaliśmy/);
    expect(error).toMatch(/zostaje z błędem wysyłki/);
    expect(error).toBe(resendPausedMessage('regular'));
    expect(mocks.flag).toHaveBeenCalledWith('killAllKsefSubmissions');
    expect(mocks.verification).not.toHaveBeenCalled();
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.offline).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([
    ['ZAL', 'advance'],
    ['KOR', 'correction'],
  ] as const)('włączony wyłącznik przy ponowieniu dokumentu specjalnego (%s, KSeF TEST): z kopii tylko dziś, w dniu wystawienia', async (type, kind) => {
    mocks.flag.mockResolvedValue(true);
    const error = refusal(await enqueueKsefSubmitAfterDraft(resendParams(type, kind)));
    // Tekst specjalny może kazać „wrócić do szkicu” po dacie — ale nie twierdzi, że dokument nim jest.
    expect(error).not.toMatch(/jako szkic|została zapisana/);
    expect(error).toMatch(/nie wykonaliśmy/);
    expect(error).toMatch(/zostaje z błędem wysyłki/);
    expect(error).toMatch(/tylko dziś, w dniu wystawienia/);
    expect(error).toBe(resendPausedMessage(kind));
    expect(error).not.toBe(resendPausedMessage('regular'));
    expect(mocks.verification).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([
    ['VAT', 'regular'],
    ['ZAL', 'advance'],
  ] as const)('awaria odczytu wyłącznika przy ponowieniu (%s): „nie wykonaliśmy”, nie „zapisana” (fail-closed)', async (type, kind) => {
    mocks.flag.mockRejectedValue(new Error('baza niedostępna'));
    const error = refusal(await enqueueKsefSubmitAfterDraft(resendParams(type, kind)));
    expect(error).not.toMatch(/zapisana/);
    expect(error).toMatch(/nie wykonaliśmy/);
    expect(error).toBe(resendPauseUnknownMessage(kind));
    expect(mocks.verification).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([
    ['VAT', 'regular'],
    ['ZAL', 'advance'],
  ] as const)('brak certyfikatu przy ponowieniu (%s): faktura zostaje z błędem wysyłki, nie „zapisana jako szkic”', async (type, kind) => {
    mocks.blob = null;
    const error = refusal(await enqueueKsefSubmitAfterDraft(resendParams(type, kind)));
    expect(error).not.toMatch(/jako szkic|została zapisana/);
    expect(error).toMatch(/nie wykonaliśmy/);
    expect(error).toMatch(/zostaje z błędem wysyłki/);
    expect(error).toBe(resendMissingCredentialsMessage(kind));
    expect(mocks.verification).toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('strażnik: pierwsza wysyłka szkicu (jawny tryb enqueue, także faktura zaliczkowa) zostaje przy KSEF_PAUSED_MESSAGE', async () => {
    mocks.flag.mockResolvedValue(true);
    expect(await enqueueKsefSubmitAfterDraft(enqueueParams('VAT', 'regular', { kind: 'enqueue' })))
      .toEqual({ ok: false, error: KSEF_PAUSED_MESSAGE });
    expect(await enqueueKsefSubmitAfterDraft(enqueueParams('ZAL', 'advance')))
      .toEqual({ ok: false, error: KSEF_PAUSED_MESSAGE });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('strażnik: pierwsza wysyłka szkicu — awaria odczytu wyłącznika nadal mówi o zapisanej fakturze', async () => {
    mocks.flag.mockRejectedValue(new Error('baza niedostępna'));
    const error = refusal(await enqueueKsefSubmitAfterDraft(enqueueParams('VAT', 'regular')));
    expect(error).toMatch(/Faktura została zapisana/);
  });

  it.each([
    ['VAT', 'regular'],
    ['ZAL', 'advance'],
  ] as const)('strażnik: pierwsza wysyłka szkicu bez certyfikatu (%s) — nadal „zapisana jako szkic”', async (type, kind) => {
    mocks.blob = null;
    const error = refusal(await enqueueKsefSubmitAfterDraft(enqueueParams(type, kind)));
    expect(error).toMatch(/zapisan[ya] jako szkic/);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe('blokada korekt przy kolejkowaniu', () => {
  it('korekta na KSeF produkcyjnym zostaje szkicem', async () => {
    vi.stubEnv('KSEF_ENV', 'production');
    const result = await enqueueKsefSubmitAfterDraft(enqueueParams('KOR', 'correction'));
    expect(result).toEqual({ ok: false, error: KOR_HOLD_MESSAGE });
    expect(mocks.verification).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('korekta oznaczona tylko rodzajem akcji też jest zatrzymana', async () => {
    vi.stubEnv('KSEF_ENV', 'production');
    const result = await enqueueKsefSubmitAfterDraft(enqueueParams('VAT', 'correction'));
    expect(result).toEqual({ ok: false, error: KOR_HOLD_MESSAGE });
  });

  it('na KSeF TEST korekta przechodzi dalej (sprawdzenie poprawki)', async () => {
    mocks.verification.mockRejectedValue(new Error('stop po bramkach'));
    await expect(
      enqueueKsefSubmitAfterDraft(enqueueParams('KOR', 'correction')),
    ).rejects.toThrow('stop po bramkach');
    expect(mocks.verification).toHaveBeenCalled();
  });
});

describe('hamulce w jobie wysyłki', () => {
  it('włączony wyłącznik: neutralny błąd ze znacznikiem, bez sondy zdrowia i wysyłki', async () => {
    mocks.flag.mockResolvedValue(true);
    const error = await runSubmitInvoice(submitEvent(), ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetriableError);
    expect((error as Error).message).toMatch(/^\[KSEF_PAUSED\] /);
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.offline).not.toHaveBeenCalled();
    expect(mocks.fullFlow).not.toHaveBeenCalled();
  });

  it('wyłącznik włączony w trakcie joba zatrzymuje wysyłkę tuż przed KSeF', async () => {
    mocks.flag.mockResolvedValueOnce(false).mockResolvedValue(true);
    const error = await runSubmitInvoice(submitEvent(), ctx).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/^\[KSEF_PAUSED\] /);
    expect(mocks.findOpen).toHaveBeenCalled();
    expect(mocks.fullFlow).not.toHaveBeenCalled();
  });

  it('awaria odczytu wyłącznika: ponowienie (zwykły błąd), nigdy wysyłka', async () => {
    mocks.flag.mockRejectedValue(new Error('Nie udało się sprawdzić wyłącznika funkcji'));
    const error = await runSubmitInvoice(submitEvent(), ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetriableError);
    expect(mocks.fullFlow).not.toHaveBeenCalled();
  });

  it('korekta na produkcji zatrzymana po typie zapisanym w bazie, nawet gdy zdarzenie mówi VAT', async () => {
    vi.stubEnv('KSEF_ENV', 'production');
    mocks.invoice.invoice_type = 'KOR';
    mocks.invoice.invoice_kind = 'correction';
    const error = await runSubmitInvoice({ ...submitEvent('VAT'), environment: 'production' }, ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetriableError);
    expect((error as Error).message).toMatch(/^\[KOR_HOLD\] /);
    // A4b PR2b: KOR_HOLD nie ma przycisków klienta (decyzja a), a I7 wznawia
    // tylko KSEF_PAUSED — tekst nad przyciskami nie obiecuje automatu.
    expect((error as Error).message).not.toMatch(/automatycznie/);
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.fullFlow).not.toHaveBeenCalled();
  });

  it.each([
    ['ZAL', 'advance'],
    ['KOR', 'correction'],
  ] as const)('włączony wyłącznik przy dokumencie specjalnym (%s, KSeF TEST): automat tylko w dniu wystawienia — także w last_error', async (type, kind) => {
    mocks.flag.mockResolvedValue(true);
    mocks.invoice.invoice_type = type;
    mocks.invoice.invoice_kind = kind;
    const error = await runSubmitInvoice(submitEvent(type), ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetriableError);
    const message = (error as Error).message;
    expect(message).toMatch(/^\[KSEF_PAUSED\] /);
    expect(message).not.toMatch(/wyjdzie automatycznie po przywróceniu/);
    expect(message).toMatch(/w dniu ich wystawienia/);
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.fullFlow).not.toHaveBeenCalled();

    // Wyczerpanie prób: ten tekst trafia do `last_error` nad przyciskami; kod bez zmian.
    mocks.invoice.ksef_status = 'queued';
    await onSubmitInvoiceExhausted(error as Error, submitEvent(type), ctx);
    const failure = mocks.updates.find((u) => 'last_error' in u);
    expect(failure).toMatchObject({ ksef_status: 'failed', last_error_code: 'KSEF_PAUSED' });
    expect(failure?.last_error).toMatch(/w dniu ich wystawienia/);
  });

  it('strażnik: zwykła faktura przy włączonym wyłączniku zostaje przy dotychczasowym tekście joba', async () => {
    mocks.flag.mockResolvedValue(true);
    const error = await runSubmitInvoice(submitEvent(), ctx).catch((e: unknown) => e);
    expect((error as Error).message).toBe(`[KSEF_PAUSED] ${KSEF_PAUSED_JOB_MESSAGE}`);
  });
});

/**
 * A4b PR2b (spec §2.5): `last_error` hamulca stoi nad przyciskami
 * (`invoice-detail-view.tsx`). KOR_HOLD nie ma automatu ani przycisków
 * klienta (decyzja a; I7 wznawia tylko KSEF_PAUSED), a KSEF_PAUSED przy
 * KOR/ZAL wznawia się tylko w dniu wystawienia (decyzja b). Znaczniki `[KOD]`
 * zostają — klasyfikator (`send-error-codes.ts`) ich nie zmienia.
 */
describe('teksty hamulców joba nie obiecują automatu, którego nie ma (A4b PR2b)', () => {
  it('KOR_HOLD: „tej próby nie wykonaliśmy” i „sami nie wyślemy”, bez „automatycznie”', () => {
    expect(KOR_HOLD_JOB_MESSAGE).not.toMatch(/automatycznie/);
    expect(KOR_HOLD_JOB_MESSAGE).toMatch(/nie wykonaliśmy/);
    expect(KOR_HOLD_JOB_MESSAGE).toMatch(/sami nie wyślemy/);
    expect(heldErrorMessage(KOR_HOLD, 'correction')).toBe(`[KOR_HOLD] ${KOR_HOLD_JOB_MESSAGE}`);
    expect(classifySendError(new NonRetriableError(heldErrorMessage(KOR_HOLD, 'correction'))).code).toBe('KOR_HOLD');
  });

  it.each(['advance', 'correction'])('KSEF_PAUSED przy dokumencie specjalnym (%s): automat tylko w dniu wystawienia, znacznik bez zmian', (kind) => {
    const message = heldErrorMessage(KSEF_PAUSED, kind);
    expect(message).toMatch(/^\[KSEF_PAUSED\] /);
    expect(message).not.toMatch(/wyjdzie automatycznie po przywróceniu/);
    expect(message).toMatch(/w dniu ich wystawienia/);
    expect(message).toBe(`[KSEF_PAUSED] ${KSEF_PAUSED_SPECIAL_JOB_MESSAGE}`);
    expect(classifySendError(new NonRetriableError(message)).code).toBe('KSEF_PAUSED');
  });

  it('strażnik: KSEF_PAUSED zwykłej faktury — tekst i znacznik bez zmian', () => {
    expect(heldErrorMessage(KSEF_PAUSED)).toBe(`[KSEF_PAUSED] ${KSEF_PAUSED_JOB_MESSAGE}`);
    expect(heldErrorMessage(KSEF_PAUSED, 'regular')).toBe(`[KSEF_PAUSED] ${KSEF_PAUSED_JOB_MESSAGE}`);
    expect(classifySendError(new NonRetriableError(heldErrorMessage(KSEF_PAUSED))).code).toBe('KSEF_PAUSED');
  });
});

describe('wyczerpanie prób po hamulcu = stan „do uzgodnienia”, nie „odrzucona”', () => {
  it.each(['KSEF_PAUSED', 'KOR_HOLD'] as const)('%s', async (code) => {
    mocks.invoice.ksef_status = 'queued';
    const message = code === 'KSEF_PAUSED' ? KSEF_PAUSED_MESSAGE : KOR_HOLD_MESSAGE;
    const result = await onSubmitInvoiceExhausted(
      new NonRetriableError(`[${code}] ${message}`),
      submitEvent(),
      ctx,
    );
    expect(result).toMatchObject({ handled: true, finalStatus: 'failed' });
    expect(mocks.updates[0]).toMatchObject({
      ksef_status: 'failed',
      last_error: message,
      last_error_code: code,
    });
    expect(mocks.offline).not.toHaveBeenCalled();
    expect(mocks.sendEvent).toHaveBeenCalledWith('emit-failure', expect.objectContaining({
      name: 'invoice/submit.failed',
      data: expect.objectContaining({ terminal: true, manualReconciliationRequired: true }),
    }));
  });
});

describe('JOBS_BACKEND — jedyny backend to pg-boss (etap 10)', () => {
  it('brak zmiennej albo pgboss = pg-boss, także na produkcji', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
    for (const value of ['', 'pgboss', ' pgboss ']) {
      vi.stubEnv('JOBS_BACKEND', value);
      expect(getJobsBackend()).toBe('pgboss');
      expect(resolveJobsBackend()).toBe('pgboss');
    }
  });

  it.each(['inngest', 'pg-boss', 'PGBOSS'])('nieobsługiwana wartość (%s) = błąd, zlecenie nie wychodzi', (value) => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
    vi.stubEnv('JOBS_BACKEND', value);
    expect(resolveJobsBackend()).toBeNull();
    expect(() => getJobsBackend()).toThrow(/JOBS_BACKEND/);
  });

  it('worker startuje przy braku zmiennej albo pgboss, nie przy innej wartości', () => {
    vi.stubEnv('JOBS_BACKEND', 'pgboss');
    expect(() => assertPgBossWorkerBackend()).not.toThrow();
    vi.stubEnv('JOBS_BACKEND', '');
    expect(() => assertPgBossWorkerBackend()).not.toThrow();
    vi.stubEnv('JOBS_BACKEND', 'inngest');
    expect(() => assertPgBossWorkerBackend()).toThrow(/JOBS_BACKEND/);
  });
});

describe('mocki integracji nie działają na produkcji', () => {
  const ALL = ['E2E_MOCK_KSEF', 'E2E_MOCK_GUS', 'E2E_MOCK_ANTHROPIC', 'E2E_MOCK_RESEND'];
  const checks = () => [isKsefMocked(), isGusMocked(), isAnthropicMocked(), isResendMocked()];

  it('lokalnie zmienna włącza mock (Playwright)', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'development');
    for (const name of ALL) vi.stubEnv(name, '1');
    expect(checks()).toEqual([true, true, true, true]);
  });

  it('na produkcji ta sama zmienna jest ignorowana', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
    for (const name of ALL) vi.stubEnv(name, '1');
    expect(checks()).toEqual([false, false, false, false]);
  });

  it('build bez markera środowiska też ignoruje mocki', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', '');
    vi.stubEnv('APP_ENV', '');
    vi.stubEnv('NODE_ENV', 'production');
    for (const name of ALL) vi.stubEnv(name, '1');
    expect(checks()).toEqual([false, false, false, false]);
  });
});
