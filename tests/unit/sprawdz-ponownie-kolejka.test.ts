import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D-A4-1b-3 PR D (stos na #248): kolejka wysyłki w trybie „tylko uzgodnij”
 * dla klienta. Operator i cron budują zdarzenie `invoice/submit.requested`
 * przez `buildKsefRequeueEvent` (z `reconcileOnly: true`); klient szedł
 * dotąd przez `enqueueKsefSubmitAfterDraft`, który przekazywał tryb tylko do
 * RPC (`requeue_ksef_send(p_reconcile_only)`), ale NIE do danych zdarzenia.
 * Runner czyta `reconcileOnly` ze zdarzenia — bez niego „Sprawdź ponownie”
 * WYSŁAŁOBY fakturę od nowa. Tu pilnujemy trzech rzeczy:
 *   1. zdarzenie niesie `reconcileOnly: true` (i tylko wtedy),
 *   2. tryb uzgodnienia nigdy nie idzie ścieżką Offline24 (ta wysyła),
 *   3. odmowy hamulców w tym trybie mówią o sprawdzaniu, nie o wysyłce,
 *      i nazywają dokument.
 *
 * Prawdziwe: `enqueueKsefSubmitAfterDraft`, krok transakcji kolejki.
 * Zastąpione: zapis zlecenia pg-boss (atrapa transakcji), flagi, MFA,
 * weryfikacja, zdrowie KSeF, deszyfrowanie certyfikatu, dziennik prób.
 */

const st = vi.hoisted(() => ({
  events: [] as Array<{ name: string; groupId?: string; singletonKey?: string; data: Record<string, unknown> }>,
  sql: [] as Array<{ sql: string; values: unknown[] }>,
  /** Globalny wyłącznik operatora: `true` = wstrzymane, `'throw'` = nie da się odczytać. */
  paused: false as boolean | 'throw',
  blob: '\\x00' as string | null,
  offline: false,
  addToOfflineQueue: vi.fn(),
  shouldUseOfflineMode: vi.fn(),
  refusals: [] as Array<Record<string, unknown>>,
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/feature-flags/global-flags', () => ({
  getGlobalFlagForExecution: vi.fn(async (flag: string) => {
    if (flag !== 'killAllKsefSubmissions') return false;
    if (st.paused === 'throw') throw new Error('flagi niedostępne');
    return st.paused;
  }),
}));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerification: async () => undefined,
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/auth/sensitive-mfa', () => ({
  assertSensitiveMfa: async () => undefined,
  SensitiveMfaRequiredError: class SensitiveMfaRequiredError extends Error {},
}));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: st.shouldUseOfflineMode }));
vi.mock('@/lib/ksef/offline24-policy', () => ({ isOffline24Enabled: () => true }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: st.addToOfflineQueue }));
vi.mock('@/lib/ksef/credentials-crypto', () => ({
  decryptCredentials: () => ({ type: 'xades', nip: '1234567890' }),
}));
vi.mock('@/lib/ksef/send-attempt-ledger', () => ({
  recordSendRefusal: async (entry: Record<string, unknown>) => {
    st.refusals.push(entry);
  },
}));
vi.mock('@/lib/jobs/enqueue', () => ({
  sendJobEvent: async (
    event: unknown,
    options?: { inTransaction?: (tx: { executeSql: (sql: string, values?: unknown[]) => Promise<unknown> }) => Promise<void> },
  ) => {
    await options?.inTransaction?.({
      executeSql: async (sql: string, values?: unknown[]) => {
        st.sql.push({ sql, values: values ?? [] });
        return { rows: [{ id: 'x' }], rowCount: 1 };
      },
    });
    st.events.push(JSON.parse(JSON.stringify(event)) as (typeof st.events)[number]);
    return { ids: ['job-1'] };
  },
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    const q = {
      select: () => q,
      eq: () => q,
      single: async () => ({ data: { ksef_credentials_encrypted: st.blob }, error: null }),
    };
    return { from: () => q };
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => {
    const q = {
      select: () => q,
      eq: () => q,
      single: async () => ({ data: { ksef_credentials_encrypted: st.blob }, error: null }),
    };
    return { from: () => q };
  },
}));

import { enqueueKsefSubmitAfterDraft, type EnqueueKsefSubmitParams } from '@/lib/invoices/ksef-submit-enqueue';
import { DUPLICATE_DECISION_TEXTS } from '@/lib/ksef/duplicate-decision';
import type { Invoice } from '@/types/invoice';

const TENANT = '11111111-1111-4111-8111-111111111111';
const INVOICE_ID = '33333333-3333-4333-8333-333333333333';
const USER = '55555555-5555-4555-8555-555555555555';
const NR = 'FV/12/10/2026';

const TEXTS = () => DUPLICATE_DECISION_TEXTS.RECHECK;

function params(mode: EnqueueKsefSubmitParams['mode']): EnqueueKsefSubmitParams {
  return {
    supabase: {} as EnqueueKsefSubmitParams['supabase'],
    tenantId: TENANT,
    userId: USER,
    invoiceId: INVOICE_ID,
    nip: '1234567890',
    invoice: { internalNumber: NR, type: 'VAT', lines: [], seller: { nip: '1234567890' } } as unknown as Invoice,
    auditKind: 'regular',
    internalNumberForAudit: NR,
    mode,
  };
}

const RECONCILE = { kind: 'requeue', actorUserId: USER, reconcileOnly: true } as const;

beforeEach(() => {
  vi.clearAllMocks();
  st.events.length = 0;
  st.sql.length = 0;
  st.refusals.length = 0;
  st.paused = false;
  st.blob = '\\x00';
  st.shouldUseOfflineMode.mockResolvedValue({ offline: false, isMfOutage: false });
  vi.stubEnv('KSEF_ENV', 'test');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PR D: zdarzenie wysyłki w trybie „tylko uzgodnij” (klient)', () => {
  it('reconcileOnly: zdarzenie niesie `reconcileOnly: true`, RPC dostaje p_reconcile_only = true, wynik niesie sendAttemptId', async () => {
    const result = await enqueueKsefSubmitAfterDraft(params(RECONCILE));
    expect(result).toMatchObject({ ok: true, mode: 'online_queued' });
    expect(st.events).toHaveLength(1);
    const data = st.events[0]!.data;
    expect(data.reconcileOnly).toBe(true);
    expect(st.events[0]!.singletonKey).toBe(INVOICE_ID);
    expect(st.sql).toHaveLength(1);
    expect(st.sql[0]!.sql).toContain('requeue_ksef_send');
    expect(st.sql[0]!.values).toEqual([INVOICE_ID, TENANT, data.sendAttemptId, USER, true]);
    expect((result as { sendAttemptId?: string }).sendAttemptId).toBe(data.sendAttemptId);
  });

  it('zwykłe ponowienie („Wyślij ponownie”): zdarzenie BEZ `reconcileOnly`, RPC dostaje false', async () => {
    const result = await enqueueKsefSubmitAfterDraft(params({ kind: 'requeue', actorUserId: USER }));
    expect(result).toMatchObject({ ok: true, mode: 'online_queued' });
    expect('reconcileOnly' in st.events[0]!.data).toBe(false);
    expect(st.sql[0]!.values[4]).toBe(false);
  });

  it('pierwsza wysyłka szkicu: zdarzenie BEZ `reconcileOnly`', async () => {
    await enqueueKsefSubmitAfterDraft(params(undefined));
    expect('reconcileOnly' in st.events[0]!.data).toBe(false);
    expect(st.sql[0]!.sql).toContain('enqueue_ksef_send');
  });
});

describe('PR D: tryb uzgodnienia nie idzie ścieżką Offline24', () => {
  beforeEach(() => {
    st.shouldUseOfflineMode.mockResolvedValue({ offline: true, isMfOutage: true });
  });

  it('KSeF niedostępny + certyfikat XAdES: uzgodnienie trafia do kolejki online (Offline24 wysyłałby fakturę)', async () => {
    const result = await enqueueKsefSubmitAfterDraft(params(RECONCILE));
    expect(result).toMatchObject({ ok: true, mode: 'online_queued' });
    expect(st.addToOfflineQueue).not.toHaveBeenCalled();
    expect(st.events[0]!.data.reconcileOnly).toBe(true);
  });

  it('kontrola: zwykłe ponowienie przy awarii KSeF nadal idzie do kolejki offline (zachowanie sprzed PR D)', async () => {
    const result = await enqueueKsefSubmitAfterDraft(params({ kind: 'requeue', actorUserId: USER }));
    expect(result).toMatchObject({ ok: true, mode: 'offline_queued' });
    expect(st.addToOfflineQueue).toHaveBeenCalledTimes(1);
  });
});

describe('PR D: odmowy hamulców w trybie uzgodnienia mówią o sprawdzaniu i nazywają dokument', () => {
  it('pauza operatora', async () => {
    st.paused = true;
    const result = await enqueueKsefSubmitAfterDraft(params(RECONCILE));
    expect(result).toEqual({ ok: false, error: TEXTS().PAUSED(NR) });
    expect(TEXTS().PAUSED(NR)).toContain(NR);
    expect(st.events).toHaveLength(0);
    expect(st.sql).toHaveLength(0);
  });

  it('nie da się odczytać wyłącznika', async () => {
    st.paused = 'throw';
    const result = await enqueueKsefSubmitAfterDraft(params(RECONCILE));
    expect(result).toEqual({ ok: false, error: TEXTS().PAUSE_UNKNOWN(NR) });
    expect(TEXTS().PAUSE_UNKNOWN(NR)).toContain(NR);
    expect(st.events).toHaveLength(0);
  });

  it('brak certyfikatu KSeF', async () => {
    st.blob = null;
    const result = await enqueueKsefSubmitAfterDraft(params(RECONCILE));
    expect(result).toEqual({ ok: false, error: TEXTS().NO_CERTIFICATE(NR) });
    expect(TEXTS().NO_CERTIFICATE(NR)).toContain(NR);
    expect(st.events).toHaveLength(0);
  });

  it('odmowy zostają w dzienniku prób (jak dotąd), zwykłe ponowienie zachowuje swoje teksty', async () => {
    st.paused = true;
    await enqueueKsefSubmitAfterDraft(params(RECONCILE));
    expect(st.refusals).toHaveLength(1);
    const regular = await enqueueKsefSubmitAfterDraft(params({ kind: 'requeue', actorUserId: USER }));
    expect((regular as { error: string }).error).toContain('faktura zostaje z błędem wysyłki');
  });
});
