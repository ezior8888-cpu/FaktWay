import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  membershipResult: vi.fn(),
  tenantResult: vi.fn(),
  rpc: vi.fn(),
  mfa: vi.fn(),
  ksefAuth: vi.fn(),
  encrypt: vi.fn(),
  rateLimit: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: '11111111-1111-4111-8111-111111111111' }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient,
  createAdminClient: mocks.createAdminClient,
}));
vi.mock('@/lib/auth/verified-mfa', () => ({ getVerifiedMfaState: mocks.mfa }));
vi.mock('@/lib/ksef/auth', () => ({ authenticateWithXades: mocks.ksefAuth }));
vi.mock('@/lib/ksef/credentials-crypto', () => ({ encryptCredentials: mocks.encrypt }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: mocks.rateLimit }));

import { uploadCertificateAction } from '@/components/settings/actions';

const tenantId = '11111111-1111-4111-8111-111111111111';
const user = { id: '22222222-2222-4222-8222-222222222222', email: 'owner@example.test' };
const pem = { certPem: 'CERTIFICATE_FIXTURE', keyPem: 'PRIVATE_KEY_FIXTURE' };

function ksefSession(permissions: unknown = 'Owner') {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return {
    accessToken: 'header.' + Buffer.from(JSON.stringify({ per: permissions, exp })).toString('base64url') + '.signature',
    accessTokenExpiresAt: (exp - 60) * 1000,
    refreshToken: 'fixture-refresh',
    refreshTokenExpiresAt: (exp + 3600) * 1000,
    nip: '1234567890',
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  const membershipQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: mocks.membershipResult,
  };
  const tenantQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: mocks.tenantResult,
  };
  mocks.createClient.mockResolvedValue({
    from: vi.fn((table: string) => {
      if (table !== 'tenants') throw new Error(`Unexpected client table ${table}`);
      return tenantQuery;
    }),
  });
  mocks.createAdminClient.mockReturnValue({
    from: vi.fn((table: string) => {
      if (table !== 'memberships') throw new Error(`Unexpected admin table ${table}`);
      return membershipQuery;
    }),
    rpc: mocks.rpc,
  });
  mocks.membershipResult.mockResolvedValue({ data: { role: 'owner', status: 'active' }, error: null });
  mocks.tenantResult.mockResolvedValue({ data: { nip: '1234567890' }, error: null });
  mocks.mfa.mockResolvedValue({ status: 'verified', user });
  mocks.rateLimit.mockResolvedValue({ allowed: true, fallback: false, retryAfter: 0 });
  mocks.ksefAuth.mockImplementation(async () => ksefSession());
  mocks.encrypt.mockReturnValue(Buffer.alloc(64, 1));
  mocks.rpc.mockResolvedValue({ data: 'claimed', error: null });
});

afterEach(() => vi.unstubAllEnvs());

function expectNoKsefEffects() {
  expect(mocks.ksefAuth).not.toHaveBeenCalled();
  expect(mocks.encrypt).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.revalidate).not.toHaveBeenCalled();
}

describe('KSeF certificate claim action', () => {
  it.each(['admin', 'member', 'accountant'])('rejects %s before external I/O or privileged RPC', async (role) => {
    mocks.membershipResult.mockResolvedValue({ data: { role, status: 'active' }, error: null });

    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false });
    expectNoKsefEffects();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it.each(['enrollment_required', 'challenge_required'])('requires completed MFA when status is %s', async (status) => {
    mocks.mfa.mockResolvedValue({ status, user });

    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false });
    expectNoKsefEffects();
  });

  // Logowanie biometrią (FW1): panel przepuścił sesję ze znacznikiem, a tu dalej
  // trzeba prawdziwego kodu. Klient dostaje przejście na ekran kodu, nie „włącz 2FA”.
  it('a passkey session past the panel gate gets the code-screen path, without KSeF effects', async () => {
    mocks.mfa.mockResolvedValueOnce({ status: 'verified', user })
      .mockResolvedValueOnce({ status: 'challenge_required', user });

    await expect(uploadCertificateAction(pem)).resolves.toEqual({
      success: false,
      mfaStepUp: true,
      error: 'Zmiana certyfikatu KSeF wymaga potwierdzenia kodem z aplikacji.',
    });
    expectNoKsefEffects();
  });

  it('an owner without 2FA still gets the enable-2FA message and no code-screen path', async () => {
    mocks.mfa.mockResolvedValueOnce({ status: 'verified', user })
      .mockResolvedValueOnce({ status: 'enrollment_required', user });

    const result = await uploadCertificateAction(pem);
    expect(result).toMatchObject({ success: false, error: 'Przed zmianą certyfikatu KSeF włącz i potwierdź logowanie dwuetapowe.' });
    expect(result).not.toHaveProperty('mfaStepUp');
    expectNoKsefEffects();
  });

  it('refuses an MFA identity mismatch before authentication with KSeF', async () => {
    mocks.mfa.mockResolvedValueOnce({ status: 'verified', user })
      .mockResolvedValueOnce({ status: 'verified', user: { ...user, id: 'other-user' } });

    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false });
    expectNoKsefEffects();
  });

  it('does not authenticate against an implicit or invalid KSeF environment', async () => {
    vi.stubEnv('KSEF_ENV', 'unknown');

    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false });
    expectNoKsefEffects();
  });
  it('rejects a production endpoint override before the XAdES exchange', async () => {
    vi.stubEnv('KSEF_ENV', 'production');
    vi.stubEnv('KSEF_PROD_URL', 'https://api-test.ksef.mf.gov.pl/v2');
    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false });
    expectNoKsefEffects();
  });

  it('rejects delegated permissions after XAdES without persisting credentials', async () => {
    mocks.ksefAuth.mockResolvedValue(ksefSession(['InvoiceRead', 'CredentialsManage']));
    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false });
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('denies a missing limiter instead of sending unbounded attempts to KSeF', async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: true, fallback: true, retryAfter: 0 });

    await expect(uploadCertificateAction(pem)).resolves.toMatchObject({ success: false });
    expectNoKsefEffects();
  });

  it('does not claim ownership if KSeF rejects the certificate or leaks its exception', async () => {
    mocks.ksefAuth.mockRejectedValue(new Error('private_schema.cert_detail'));

    const result = await uploadCertificateAction(pem);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).not.toContain('private_schema');
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('sends one atomic service-role RPC only after owner, MFA and KSeF succeed', async () => {
    const result = await uploadCertificateAction(pem);

    expect(result).toMatchObject({ success: true, wasFirstClaim: true });
    expect(mocks.ksefAuth).toHaveBeenCalledExactlyOnceWith({
      type: 'xades', nip: '1234567890', certificatePem: pem.certPem,
      privateKeyPem: pem.keyPem,
    }, 'test');
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('finalize_ksef_certificate_claim', {
      p_tenant_id: tenantId,
      p_actor_user_id: user.id,
      p_expected_nip: '1234567890',
      p_encrypted_credentials: `\\x${Buffer.alloc(64, 1).toString('hex')}`,
      p_certificate_expiry: null,
      p_environment: 'test',
    });
    expect(mocks.revalidate).toHaveBeenCalledWith('/settings/ksef');
  });

  it('does not leak a database error or report an unrecognized RPC result as success', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'private_schema.secret_detail' } })
      .mockResolvedValueOnce({ data: 'unknown', error: null });

    const first = await uploadCertificateAction(pem);
    const second = await uploadCertificateAction(pem);
    expect(first.success).toBe(false);
    if (!first.success) expect(first.error).not.toContain('private_schema');
    expect(second).toMatchObject({ success: false });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});