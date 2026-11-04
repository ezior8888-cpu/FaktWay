import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Invoice } from '@/types/invoice';

/**
 * Odmowa wysyłki PRZED kolejką (`ksef-submit-enqueue.ts`: hamulce, MFA,
 * certyfikat, wyłącznik) zostawiała fakturę jako szkic bez żadnego śladu —
 * klient widział komunikat, operator nic. Decyzja 13.10.2026: odmowy są na
 * liście błędów wysyłki jako osobny licznik (`status = 'refused'`), poza
 * skutecznością wysyłki.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  flag: vi.fn(),
  send: vi.fn(),
  mfa: vi.fn(),
  verification: vi.fn(),
  decrypt: vi.fn(),
  health: vi.fn(),
  /** Blob certyfikatu firmy; null = brak certyfikatu. */
  blob: null as unknown,
  ledger: [] as Row[],
  ledgerDown: false,
}));

vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: mocks.flag }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: mocks.send }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/auth/sensitive-mfa', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/auth/sensitive-mfa')>(),
  assertSensitiveMfa: mocks.mfa,
}));
vi.mock('@/lib/auth/ksef-verification-guard', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/auth/ksef-verification-guard')>(),
  requireKsefVerification: mocks.verification,
}));
vi.mock('@/lib/ksef/credentials-crypto', () => ({ decryptCredentials: mocks.decrypt }));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: mocks.health }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === 'ksef_send_attempts') {
        return {
          insert: (row: Row) => {
            const result = async () => {
              if (mocks.ledgerDown) return { data: null, error: { message: 'fixture: dziennik niedostępny' } };
              mocks.ledger.push(row);
              return { data: null, error: null };
            };
            return { abortSignal: () => result() };
          },
        };
      }
      const tenants = {
        select: () => tenants,
        eq: () => tenants,
        single: async () => ({ data: { ksef_credentials_encrypted: mocks.blob }, error: null }),
      };
      return tenants;
    },
  }),
}));

import { enqueueKsefSubmitAfterDraft } from '@/lib/invoices/ksef-submit-enqueue';
import { KSEF_PAUSED_MESSAGE } from '@/lib/ksef/submission-holds';
import { SensitiveMfaRequiredError } from '@/lib/auth/sensitive-mfa';

function params() {
  return {
    supabase: {} as SupabaseClient,
    tenantId: TENANT,
    userId: USER,
    invoiceId: ID,
    nip: '1234567890',
    invoice: { type: 'VAT', internalNumber: 'FV/1', issueDate: '2026-10-13' } as Invoice,
    auditKind: 'regular' as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flag.mockResolvedValue(false);
  mocks.send.mockResolvedValue(undefined);
  mocks.mfa.mockResolvedValue(undefined);
  mocks.verification.mockResolvedValue(undefined);
  mocks.decrypt.mockReturnValue({ type: 'token', nip: '1234567890', token: 't' });
  mocks.health.mockResolvedValue({ offline: false, isMfOutage: false });
  mocks.blob = Buffer.from('zaszyfrowane').toString('base64');
  mocks.ledger = [];
  mocks.ledgerDown = false;
  vi.stubEnv('KSEF_ENV', 'test');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('odmowa przed kolejką zostawia wiersz refused w dzienniku prób', () => {
  it('wyłącznik wysyłki: kod KSEF_PAUSED, klasa hold, kto kliknął; wynik dla klienta bez zmian', async () => {
    mocks.flag.mockResolvedValue(true);

    const result = await enqueueKsefSubmitAfterDraft(params());

    expect(result).toEqual({ ok: false, error: KSEF_PAUSED_MESSAGE });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.ledger).toHaveLength(1);
    expect(mocks.ledger[0]).toMatchObject({
      tenant_id: TENANT,
      invoice_id: ID,
      user_id: USER,
      status: 'refused',
      stage: 'enqueue',
      error_code: 'KSEF_PAUSED',
      error_class: 'hold',
      retryable: false,
    });
    expect(mocks.ledger[0]!.finished_at).toEqual(expect.any(String));
  });

  it('brak certyfikatu: kod NO_CERTIFICATE, klasa setup', async () => {
    mocks.blob = null;

    const result = await enqueueKsefSubmitAfterDraft(params());

    expect(result.ok).toBe(false);
    expect(mocks.ledger).toHaveLength(1);
    expect(mocks.ledger[0]).toMatchObject({ status: 'refused', error_code: 'NO_CERTIFICATE', error_class: 'setup' });
  });

  it('wymagane MFA: kod MFA_REQUIRED (poza katalogiem KSeF — bez klasy)', async () => {
    mocks.mfa.mockRejectedValue(new SensitiveMfaRequiredError('ksef_submit'));

    const result = await enqueueKsefSubmitAfterDraft(params());

    expect(result).toMatchObject({ ok: false, code: 'MFA_REQUIRED' });
    expect(mocks.ledger[0]).toMatchObject({ status: 'refused', error_code: 'MFA_REQUIRED' });
    expect(mocks.ledger[0]!.error_class ?? null).toBeNull();
  });

  it('wysyłka zakolejkowana: bez wiersza odmowy', async () => {
    const result = await enqueueKsefSubmitAfterDraft(params());

    expect(result).toEqual({ ok: true, mode: 'online_queued' });
    expect(mocks.ledger).toHaveLength(0);
  });

  it('awaria dziennika nie zmienia odpowiedzi dla klienta', async () => {
    mocks.flag.mockResolvedValue(true);
    mocks.ledgerDown = true;

    const result = await enqueueKsefSubmitAfterDraft(params());

    expect(result).toEqual({ ok: false, error: KSEF_PAUSED_MESSAGE });
  });
});
