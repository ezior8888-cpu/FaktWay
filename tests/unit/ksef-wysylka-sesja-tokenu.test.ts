import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Invoice } from '@/types/invoice';

/**
 * Plan aplikacji mobilnej, M8: wysyłka do KSeF z telefonu (`/api/mobile/v1`).
 *
 * Kolejka (`enqueueKsefSubmitAfterDraft`) sprawdza dwie rzeczy o sesji: 2FA
 * właściciela przy włączonej fladze `requireMfaForSensitive` (AUD-65) i znacznik
 * weryfikacji KSeF firmy. Obie czytały sesję z ciasteczek strony. Trasa API
 * telefonu ciasteczek nie ma: bez `tokenSession` właściciel po kodzie 2FA
 * dostawałby „wymaga weryfikacji dwuetapowej”, a każda firma „musi najpierw
 * zweryfikować certyfikat”. Z `tokenSession` ta sama reguła działa na stanie
 * 2FA tokenu (sprawdzonym w `authenticateMobileRequest`) i na kliencie z tokenem.
 *
 * Prawdziwe: `lib/auth/sensitive-mfa.ts`, `lib/auth/ksef-verification-guard.ts`,
 * `lib/invoices/ksef-submit-enqueue.ts`. Atrapy: baza (klienci Supabase),
 * kolejka pg-boss, flagi, audyt.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const m = vi.hoisted(() => ({
  send: vi.fn(),
  audit: vi.fn(),
  flag: true,
  role: 'owner',
  /** Sesja z ciasteczek strony: w trasie API telefonu jej nie ma. */
  cookieSession: false,
  cookieTenantReads: 0,
}));

vi.mock('@/lib/feature-flags/global-flags', () => ({
  getGlobalFlagForExecution: async (name: string) => (name === 'requireMfaForSensitive' ? m.flag : false),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: m.send }));
vi.mock('@/lib/audit/log', () => ({ logAudit: m.audit }));
vi.mock('@/lib/ksef/send-attempt-ledger', () => ({ recordSendRefusal: vi.fn() }));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: async () => ({ offline: false, isMfOutage: false }) }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@/lib/ksef/submission-holds', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ksef/submission-holds')>()),
  isKsefSubmissionPaused: async () => false,
}));
vi.mock('@/lib/ksef/credentials-crypto', () => ({
  decryptCredentials: () => ({ type: 'token', nip: '1234567890', token: 't' }),
}));
vi.mock('@/lib/supabase/server', () => {
  const chain = (result: () => unknown) => {
    const q: Record<string, unknown> = {};
    Object.assign(q, { select: () => q, eq: () => q, maybeSingle: async () => result(), single: async () => result() });
    return q;
  };
  return {
    // Klient z ciasteczek: w trasie API telefonu bez sesji, więc RLS nie pokaże firmy.
    createClient: async () => ({
      auth: {
        getSession: async () => ({ data: { session: m.cookieSession ? { access_token: 'cookie' } : null }, error: null }),
      },
      from: () => {
        m.cookieTenantReads += 1;
        return chain(() => ({ data: null, error: null }));
      },
    }),
    createAdminClient: () => ({
      from: (table: string) =>
        chain(() =>
          table === 'memberships'
            ? { data: { role: m.role }, error: null }
            : { data: { ksef_credentials_encrypted: '\\x00' }, error: null },
        ),
    }),
  };
});

import { enqueueKsefSubmitAfterDraft } from '@/lib/invoices/ksef-submit-enqueue';

/** Klient z tokenem telefonu: RLS pokazuje firmę z weryfikacją KSeF na TEST. */
function tokenClient(verified = true): SupabaseClient {
  const q: Record<string, unknown> = {};
  Object.assign(q, {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({
      data: verified ? { ksef_verified_at: '2026-11-01T10:00:00Z', ksef_verified_environment: 'test', vat_exemption_basis: null } : null,
      error: null,
    }),
  });
  return { from: () => q } as unknown as SupabaseClient;
}

function params(extra: Partial<Parameters<typeof enqueueKsefSubmitAfterDraft>[0]> = {}) {
  return {
    supabase: tokenClient(),
    tenantId: TENANT,
    userId: USER,
    invoiceId: ID,
    nip: '1234567890',
    invoice: { type: 'VAT', internalNumber: 'FV/1/11/2026', issueDate: '2026-11-13', lines: [] } as unknown as Invoice,
    auditKind: 'regular' as const,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.flag = true;
  m.role = 'owner';
  m.cookieSession = false;
  m.cookieTenantReads = 0;
  vi.stubEnv('KSEF_ENV', 'test');
  m.send.mockImplementation(async (_event: unknown, options?: { inTransaction?: (tx: unknown) => Promise<void> }) => {
    await options?.inTransaction?.({ executeSql: async () => ({ rows: [{ id: ID }], rowCount: 1 }) });
    return { ids: ['job-1'] };
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('wysyłka do KSeF z sesji tokenu (telefon)', () => {
  it('właściciel po kodzie 2FA (token AAL2) przy włączonej fladze: faktura w kolejce', async () => {
    const result = await enqueueKsefSubmitAfterDraft(params({ tokenSession: { mfa: 'verified' } }));

    expect(result).toMatchObject({ ok: true, mode: 'online_queued' });
    expect(m.send).toHaveBeenCalledTimes(1);
    // Znacznik KSeF czyta klient z tokenem, nie sesja z ciasteczek.
    expect(m.cookieTenantReads).toBe(0);
  });

  it('właściciel bez 2FA przy włączonej fladze: ta sama odmowa co na stronie, bez kolejki', async () => {
    const result = await enqueueKsefSubmitAfterDraft(params({ tokenSession: { mfa: 'enrollment_required' } }));

    expect(result).toEqual({
      ok: false,
      code: 'MFA_REQUIRED',
      error: 'Ta operacja wymaga weryfikacji dwuetapowej. Włącz ją w Ustawieniach → Bezpieczeństwo i zaloguj się ponownie.',
    });
    expect(m.send).not.toHaveBeenCalled();
  });

  it('flaga wyłączona: konto bez 2FA wysyła jak na stronie', async () => {
    m.flag = false;
    const result = await enqueueKsefSubmitAfterDraft(params({ tokenSession: { mfa: 'enrollment_required' } }));
    expect(result).toMatchObject({ ok: true });
  });

  it('firma bez weryfikacji KSeF (odczyt tokenem): odmowa z komunikatem strony', async () => {
    m.flag = false;
    const result = await enqueueKsefSubmitAfterDraft(params({ supabase: tokenClient(false), tokenSession: { mfa: 'verified' } }));
    expect(result).toEqual({
      ok: false,
      code: 'KSEF_NOT_VERIFIED',
      error: 'Twoja organizacja musi najpierw zweryfikować certyfikat KSeF w Ustawieniach → KSeF.',
    });
    expect(m.send).not.toHaveBeenCalled();
  });

  it('bez tokenSession (strona) zostaje sesja z ciasteczek: bez sesji odmowa jak dotąd', async () => {
    const result = await enqueueKsefSubmitAfterDraft(params());
    expect(result).toMatchObject({ ok: false, code: 'MFA_REQUIRED' });
  });
});
