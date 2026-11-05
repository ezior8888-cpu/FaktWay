import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Invoice } from '@/types/invoice';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(), decrypt: vi.fn(), health: vi.fn(), offlineAdd: vi.fn(),
  send: vi.fn(), audit: vi.fn(), environment: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerification: mocks.verify,
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/ksef/credentials-crypto', () => ({ decryptCredentials: mocks.decrypt }));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: mocks.health }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: mocks.offlineAdd }));
vi.mock('@/lib/ksef/claim-environment', () => ({ requireConfiguredKsefEnvironment: mocks.environment }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: mocks.send }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
// Blob poświadczeń main czyta kluczem serwisowym (AUD-103) — ta sama atrapa.
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => supabase }));
// Globalny wyłącznik wysyłek (main) — w tym teście wyłączony.
vi.mock('@/lib/ksef/submission-holds', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksef/submission-holds')>()),
  isKsefSubmissionPaused: async () => false,
}));

import { enqueueKsefSubmitAfterDraft } from '@/lib/invoices/ksef-submit-enqueue';

const invoiceId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const supabase = {
  from(table: string) {
    if (table !== 'tenants') throw new Error(`Unexpected table: ${table}`);
    const query = {
      select: () => query,
      eq: () => query,
      single: async () => ({ data: { ksef_credentials_encrypted: 'ZmFrZQ==' }, error: null }),
      update: () => query,
    };
    return query;
  },
} as unknown as SupabaseClient;

const base = {
  supabase, tenantId, userId: '33333333-3333-4333-8333-333333333333',
  invoiceId, nip: '1234567890', invoice: { internalNumber: 'TEST-1' } as Invoice,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.decrypt.mockReturnValue({ type: 'xades', certificatePem: 'fixture-pem' });
  mocks.health.mockResolvedValue({ offline: true, isMfOutage: true, reason: 'KSeF down' });
  mocks.environment.mockReturnValue('test');
});

describe('special invoice enqueue under KSeF outage', () => {
  // Offline24 wstrzymany wszędzie (decyzja 02.10.2026, #71): bez sondy
  // zdrowia i bez kolejki offline — dokument idzie zwykłą wysyłką, job ponawia.
  it.each(['correction', 'advance', 'regular'] as const)(
    'TEST outage: %s goes to the ordinary submit queue without Offline24', async (auditKind) => {
      await enqueueKsefSubmitAfterDraft({ ...base, auditKind }).catch(() => undefined);
      expect(mocks.health).not.toHaveBeenCalled();
      expect(mocks.offlineAdd).not.toHaveBeenCalled();
    },
  );

  it('each enqueue carries a fresh send attempt id for the send claim (AUD-10)', async () => {
    mocks.environment.mockReturnValue('test');
    await enqueueKsefSubmitAfterDraft({ ...base, auditKind: 'regular' }).catch(() => undefined);
    await enqueueKsefSubmitAfterDraft({ ...base, auditKind: 'regular' }).catch(() => undefined);
    const ids = mocks.send.mock.calls.map((c) => (c[0] as { data: { sendAttemptId?: string } }).data.sendAttemptId);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  // Polityka main (AUD-14, decyzja B3): na PROD bez sondy zdrowia i bez
  // Offline24 — zwykła wysyłka, którą job ponawia. Szkic Codexa z #63 zastąpiony.
  it('PROD: no health probe and no Offline24 QR for an ordinary VAT (AUD-14)', async () => {
    mocks.environment.mockReturnValue('production');
    await enqueueKsefSubmitAfterDraft({ ...base, auditKind: 'regular' }).catch(() => undefined);
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.offlineAdd).not.toHaveBeenCalled();
  });

  it('blocks PROD final settlement before checking health or sending an event', async () => {
    mocks.environment.mockReturnValue('production');
    const result = await enqueueKsefSubmitAfterDraft({ ...base, auditKind: 'final' });
    expect(result).toMatchObject({ ok: false });
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('blocks PROD correction before checking health or sending an event', async () => {
    mocks.environment.mockReturnValue('production');
    const result = await enqueueKsefSubmitAfterDraft({ ...base, auditKind: 'correction' });
    expect(result).toMatchObject({ ok: false });
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
