import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';
import { fakePosthog, lejekClient } from '../helpers/lejek-atrapy';
import { makeSelfSignedCertificate } from '../helpers/self-signed-cert';

/**
 * ksef_configured: pierwsze skuteczne podłączenie, czyli wynik `claimed` z RPC.
 * Prawdziwa akcja `uploadCertificateAction`, mocki jak w
 * ksef-certificate-claim-action.test.ts: KSeF, szyfrowanie, limit, MFA i baza.
 */

const h = vi.hoisted(() => ({
  db: null as unknown,
  posthog: null as unknown,
  claim: 'claimed' as string,
  mfa: vi.fn(),
  ksefAuth: vi.fn(),
  encrypt: vi.fn(),
  rateLimit: vi.fn(),
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: '11111111-1111-4111-8111-111111111111' }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        single: async () => ({ data: { nip: '1234567890' }, error: null }),
      };
      return q;
    },
  }),
  createAdminClient: () => {
    const client = lejekClient(h.db as MemoryDb, { finalize_ksef_certificate_claim: h.claim });
    return {
      ...client,
      from: (table: string) => {
        if (table === 'memberships') {
          const q = {
            select: () => q,
            eq: () => q,
            maybeSingle: async () => ({ data: { role: 'owner', status: 'active' }, error: null }),
          };
          return q;
        }
        return client.from(table);
      },
    };
  },
}));
vi.mock('@/lib/analytics/posthog-node-client', () => ({ getPostHogNodeClient: () => h.posthog }));
vi.mock('@/lib/auth/verified-mfa', () => ({ getVerifiedMfaState: h.mfa }));
vi.mock('@/lib/ksef/auth', () => ({ authenticateWithXades: h.ksefAuth }));
vi.mock('@/lib/ksef/credentials-crypto', () => ({ encryptCredentials: h.encrypt }));
vi.mock('@/lib/ksef/history-sync/client-pause', () => ({
  clearKsefHistoryCertificateErrors: async () => ({ ok: true }),
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: h.rateLimit }));

import { uploadCertificateAction } from '@/components/settings/actions';

// Akcja czyta pliki naprawdę (kreator KSeF), więc fixture to prawdziwy certyfikat samopodpisany.
const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64');
const material = makeSelfSignedCertificate({ kind: 'ec', nip: '1234567890' });
const pem = { certificate: b64(material.certPem), privateKey: b64(material.keyPem) };
let posthog: ReturnType<typeof fakePosthog>;

function seed(owner: Row = {}) {
  h.db = memoryDb({
    users: [{ id: OWNER, analytics_consent: 'granted', signup_source: { channel: 'youtube', at: '2026-10-30' }, ...owner }],
    memberships: [{ organization_id: TENANT, user_id: OWNER, role: 'owner', status: 'active', joined_at: '2026-10-30T00:00:00Z' }],
  });
}

function session() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return {
    accessToken: 'header.' + Buffer.from(JSON.stringify({ per: 'Owner', exp })).toString('base64url') + '.signature',
    accessTokenExpiresAt: (exp - 60) * 1000,
    refreshToken: 'fixture-refresh',
    refreshTokenExpiresAt: (exp + 3600) * 1000,
    nip: '1234567890',
  };
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  posthog = fakePosthog();
  h.posthog = posthog;
  h.claim = 'claimed';
  seed();
  h.mfa.mockResolvedValue({ status: 'verified', user: { id: OWNER, email: 'owner@example.test' } });
  h.rateLimit.mockResolvedValue({ allowed: true, fallback: false, retryAfter: 0 });
  h.ksefAuth.mockImplementation(async () => session());
  h.encrypt.mockReturnValue(Buffer.alloc(64, 1));
});
afterEach(() => vi.unstubAllEnvs());

describe('ksef_configured', () => {
  it('wynik claimed: jedno zdarzenie z kanałem, a podwójne wykonanie sklei się po uuid', async () => {
    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: true, wasFirstClaim: true });
    await uploadCertificateAction(pem);

    expect(posthog.sklejone('ksef_configured')).toHaveLength(1);
    expect(posthog.messages[0]).toMatchObject({
      distinctId: OWNER,
      event: 'ksef_configured',
      groups: { tenant: TENANT },
      properties: { env: 'test', source: 'youtube', tenant_id: TENANT },
    });
    expect(posthog.messages[1]!.uuid).toBe(posthog.messages[0]!.uuid);
  });

  it('wymiana certyfikatu (already_claimed_by_self): bez zdarzenia', async () => {
    h.claim = 'already_claimed_by_self';
    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: true, wasFirstClaim: false });
    expect(posthog.messages).toEqual([]);
  });

  it('NIP zajęty przez inną firmę: bez zdarzenia', async () => {
    h.claim = 'already_claimed_by_other';
    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false, code: 'NIP_ALREADY_CLAIMED' });
    expect(posthog.messages).toEqual([]);
  });

  it('właściciel bez zgody: certyfikat zapisany, bez zdarzenia', async () => {
    seed({ analytics_consent: 'denied' });
    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: true, wasFirstClaim: true });
    expect(posthog.messages).toEqual([]);
  });

  it('awaria analityki nie cofa podłączenia', async () => {
    h.db = memoryDb({ users: [] });
    (h.db as MemoryDb).failures['users:select'] = { code: '08006', message: 'zerwane' };
    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: true, wasFirstClaim: true });
  });
});
