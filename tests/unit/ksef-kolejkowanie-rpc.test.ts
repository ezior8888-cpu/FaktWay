import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Invoice } from '@/types/invoice';

/**
 * Cykl życia faktury, PR 3 (W16/W2): `enqueueKsefSubmitAfterDraft` zmienia
 * stan faktury WYŁĄCZNIE przez RPC `enqueue_ksef_send` / `requeue_ksef_send`
 * (00131), wykonywane w tej samej transakcji co zapis zlecenia pg-boss.
 * Sesja klienta nie pisze `ksef_status`. Odmowa RPC (podwójne kliknięcie,
 * błąd treści) wraca do klienta zrozumiałym komunikatem, bez zlecenia.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const m = vi.hoisted(() => ({
  send: vi.fn(),
  audit: vi.fn(),
  clientUpdates: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: async () => false }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: m.send }));
vi.mock('@/lib/audit/log', () => ({ logAudit: m.audit }));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerification: async () => undefined,
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/auth/sensitive-mfa', () => ({
  assertSensitiveMfa: async () => undefined,
  SensitiveMfaRequiredError: class SensitiveMfaRequiredError extends Error {},
}));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: async () => ({ offline: false, isMfOutage: false }) }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@/lib/ksef/credentials-crypto', () => ({
  decryptCredentials: () => ({ type: 'token', nip: '1234567890', token: 't' }),
}));
vi.mock('@/lib/ksef/claim-environment', () => ({ requireConfiguredKsefEnvironment: () => 'test' }));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => {
    const q = {
      select: () => q,
      eq: () => q,
      single: async () => ({ data: { ksef_credentials_encrypted: '\\x00' }, error: null }),
    };
    return { from: () => q };
  },
}));

import { enqueueKsefSubmitAfterDraft } from '@/lib/invoices/ksef-submit-enqueue';
import { KSEF_ALREADY_QUEUED_MESSAGE } from '@/lib/invoices/ksef-send-step';

/** Klient sesji: rejestruje każdą próbę zapisu — po PR 3 nie może być żadnej. */
const clientSession = {
  from: () => ({
    update: (patch: Record<string, unknown>) => {
      m.clientUpdates.push(patch);
      return { eq: () => ({ eq: async () => ({ error: null }), then: (ok: (v: unknown) => unknown) => ok({ error: null }) }) };
    },
  }),
} as unknown as SupabaseClient;

type Tx = { executeSql: ReturnType<typeof vi.fn> };

/** `sendJobEvent` z pg-boss zastąpione: wykonuje krok transakcji na podanym `tx`. */
function sendRunningStep(tx: Tx, outcome: 'ok' | Error = 'ok') {
  m.send.mockImplementation(async (_event: unknown, options?: { inTransaction?: (tx: Tx) => Promise<void> }) => {
    await options?.inTransaction?.(tx);
    if (outcome !== 'ok') throw outcome;
    return { ids: ['job-1'] };
  });
}

function params(extra: Partial<Parameters<typeof enqueueKsefSubmitAfterDraft>[0]> = {}) {
  return {
    supabase: clientSession,
    tenantId: TENANT,
    userId: USER,
    invoiceId: ID,
    nip: '1234567890',
    invoice: { type: 'VAT', internalNumber: 'FV/1', issueDate: '2026-10-03' } as Invoice,
    auditKind: 'regular' as const,
    ...extra,
  };
}

function sentEvent() {
  return m.send.mock.calls[0]?.[0] as { data: { sendAttemptId?: string }; singletonKey?: string; groupId?: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.clientUpdates = [];
  vi.stubEnv('KSEF_ENV', 'test');
});
afterEach(() => vi.unstubAllEnvs());

describe('kolejkowanie wysyłki: RPC w transakcji ze zleceniem', () => {
  it('draft → queued robi enqueue_ksef_send w kroku transakcji; klient nie pisze statusu', async () => {
    const tx: Tx = { executeSql: vi.fn(async () => ({ rows: [{ id: ID }], rowCount: 1 })) };
    sendRunningStep(tx);

    const result = await enqueueKsefSubmitAfterDraft(params());

    // PR D: wynik niesie `sendAttemptId` (audyt „Sprawdź ponownie”); tu liczy się tryb i brak odmowy.
    expect(result).toEqual({ ok: true, mode: 'online_queued', sendAttemptId: expect.any(String) });
    const event = sentEvent();
    expect(event.singletonKey).toBe(ID);
    expect(event.groupId).toBe(TENANT);
    expect(event.data.sendAttemptId).toMatch(UUID);
    expect(tx.executeSql).toHaveBeenCalledTimes(1);
    const [sql, values] = tx.executeSql.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/public\.enqueue_ksef_send\(/);
    expect(values).toEqual([ID, TENANT, event.data.sendAttemptId]);
    expect(m.clientUpdates.filter((u) => 'ksef_status' in u)).toEqual([]);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.submit_requested', entityId: ID }));
  });

  it('ponowna wysyłka (failed → queued) idzie przez requeue_ksef_send z aktorem i trybem uzgodnienia', async () => {
    const tx: Tx = { executeSql: vi.fn(async () => ({ rows: [{ id: ID }], rowCount: 1 })) };
    sendRunningStep(tx);

    const result = await enqueueKsefSubmitAfterDraft(params({ mode: { kind: 'requeue', actorUserId: USER, reconcileOnly: true } }));

    // PR D: wynik niesie `sendAttemptId` (audyt „Sprawdź ponownie”); tu liczy się tryb i brak odmowy.
    expect(result).toEqual({ ok: true, mode: 'online_queued', sendAttemptId: expect.any(String) });
    const [sql, values] = tx.executeSql.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/public\.requeue_ksef_send\(/);
    expect(values).toEqual([ID, TENANT, sentEvent().data.sendAttemptId, USER, true]);
  });

  it('drugie kliknięcie: RPC odmawia (P0002) → „już wysyłana”, bez zlecenia i bez zapisu statusu', async () => {
    const tx: Tx = {
      executeSql: vi.fn(async () => {
        throw Object.assign(new Error('Faktura nie jest szkicem albo nie należy do tej firmy'), { code: 'P0002' });
      }),
    };
    sendRunningStep(tx);

    const result = await enqueueKsefSubmitAfterDraft(params());

    expect(result).toEqual({ ok: false, error: KSEF_ALREADY_QUEUED_MESSAGE });
    expect(m.clientUpdates).toEqual([]);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('odmowa merytoryczna RPC (P0001) wraca do klienta własnym komunikatem', async () => {
    const message = 'Błąd treści dokumentu (XSD_INVALID) — wróć do szkicu i popraw';
    const tx: Tx = { executeSql: vi.fn(async () => { throw Object.assign(new Error(message), { code: 'P0001' }); }) };
    sendRunningStep(tx);

    const result = await enqueueKsefSubmitAfterDraft(params({ mode: { kind: 'requeue', actorUserId: USER } }));

    expect(result).toEqual({ ok: false, error: message });
  });

  it('awaria kolejki po kroku: błąd do klienta, nic nie pisze statusu (transakcję wycofał pg-boss)', async () => {
    const tx: Tx = { executeSql: vi.fn(async () => ({ rows: [{ id: ID }], rowCount: 1 })) };
    sendRunningStep(tx, new Error('connection terminated unexpectedly'));

    const result = await enqueueKsefSubmitAfterDraft(params());

    expect(result.ok).toBe(false);
    expect(m.clientUpdates).toEqual([]);
    expect(m.audit).not.toHaveBeenCalled();
  });
});
