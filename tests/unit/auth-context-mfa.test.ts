import { createHmac, hkdfSync } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(), createAdminClient: vi.fn(), cookies: vi.fn(),
  getSession: vi.fn(), getUser: vi.fn(), getClaims: vi.fn(),
  from: vi.fn(), select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient, createAdminClient: mocks.createAdminClient,
}));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));

import {
  ActionAuthError, requireOwner, requireUserAndActiveOrg,
  requireUserAndTenant, requireVerifiedUser, resolveApiUserAndActiveOrg,
} from '@/lib/supabase/auth-context';
import { ACTIVE_ORG_COOKIE } from '@/lib/supabase/active-org';

const token = 'synthetic-original-access-token';
const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '22222222-2222-4222-8222-222222222222';
const user = {
  id: 'session-user', email: 'user@example.test',
  factors: [{ id: 'totp-fixture', factor_type: 'totp', status: 'verified' }],
};
const client = { auth: {
  getSession: mocks.getSession, getUser: mocks.getUser, getClaims: mocks.getClaims,
} };
const query = { select: mocks.select, eq: mocks.eq, maybeSingle: mocks.maybeSingle };
type Membership = { user_id: string; organization_id: string; status: string; role: string };
let memberships: Membership[];
let filters: Record<string, string>;

beforeEach(() => {
  vi.resetAllMocks();
  memberships = [{ user_id: user.id, organization_id: tenantId, status: 'active', role: 'owner' }];
  filters = {};
  mocks.createClient.mockResolvedValue(client);
  mocks.getSession.mockResolvedValue({ data: { session: {
    access_token: token, user: { id: 'forged-cookie-user', factors: [] },
  } }, error: null });
  mocks.getUser.mockResolvedValue({ data: { user: structuredClone(user) }, error: null });
  mocks.getClaims.mockResolvedValue({ data: { claims: { sub: user.id, aal: 'aal2' } }, error: null });
  mocks.cookies.mockResolvedValue({ get: (key: string) => key === ACTIVE_ORG_COOKIE ? { value: tenantId } : undefined });
  mocks.createAdminClient.mockReturnValue({ from: mocks.from });
  mocks.from.mockReturnValue(query);
  mocks.select.mockReturnValue(query);
  mocks.eq.mockImplementation((key: string, value: string) => {
    filters[key] = value;
    return query;
  });
  mocks.maybeSingle.mockImplementation(async () => ({
    data: memberships.find((membership) => Object.entries(filters)
      .every(([key, value]) => membership[key as keyof Membership] === value)) ?? null,
    error: null,
  }));
});

const verificationFailure = {
  error: 'session_verification_failed', status: 401,
  message: 'Nie udało się zweryfikować sesji. Zaloguj się ponownie.',
};
const unauthenticated = { error: 'not_authenticated', status: 401, message: 'Niezalogowany' };
const challengeRequired = { error: 'mfa_required', status: 403, message: 'Wymagana weryfikacja dwuetapowa' };

// The verified-MFA helper is real: only the Auth SDK and database boundaries are mocked.
describe.each(['action', 'api'] as const)('%s tenant boundary', (boundary) => {
  const invoke = () => boundary === 'action' ? requireUserAndActiveOrg() : resolveApiUserAndActiveOrg();
  const expectDenied = async (expected: { error: string; status: number; message: string }) => {
    if (boundary === 'action') {
      await expect(invoke()).rejects.toMatchObject({ name: 'ActionAuthError', message: expected.message });
    } else {
      await expect(invoke()).resolves.toEqual({ ok: false, status: expected.status, error: expected.error });
    }
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  };
  const expectAllowed = async () => {
    if (boundary === 'action') {
      await expect(invoke()).resolves.toEqual({ supabase: client, user: { id: user.id, email: user.email }, tenantId, role: 'owner' });
    } else {
      await expect(invoke()).resolves.toEqual({ ok: true, userId: user.id, tenantId, role: 'owner' });
    }
  };

  it('allows AAL2 and binds authoritative identity and claims to the same token before service-role access', async () => {
    await expectAllowed();
    expect(mocks.getUser).toHaveBeenCalledExactlyOnceWith(token);
    expect(mocks.getClaims).toHaveBeenCalledExactlyOnceWith(token);
    expect(mocks.getClaims.mock.invocationCallOrder[0]).toBeLessThan(mocks.cookies.mock.invocationCallOrder[0]!);
    expect(mocks.cookies.mock.invocationCallOrder[0]).toBeLessThan(mocks.createAdminClient.mock.invocationCallOrder[0]!);
    expect(filters).toEqual({ user_id: user.id, organization_id: tenantId, status: 'active' });
  });

  it('rejects AAL1 with enrolled TOTP even when the unsigned cookie user hides all factors', async () => {
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: user.id, aal: 'aal1' } }, error: null });
    mocks.getSession.mockResolvedValue({ data: { session: {
      access_token: token,
      user: { ...user, factors: [], aal: 'aal2', user_metadata: { mfa_verified: true, recovery_verified: true } },
    } }, error: null });
    await expectDenied(challengeRequired);
  });

  it.each(['phone', 'webauthn'])('rejects AAL1 with a verified %s factor even when the UI does not support it', async (factor_type) => {
    mocks.getUser.mockResolvedValue({ data: { user: {
      ...user, factors: [{ id: 'unsupported-factor', factor_type, status: 'verified' }],
    } }, error: null });
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: user.id, aal: 'aal1' } }, error: null });
    await expectDenied(challengeRequired);
  });

  it.each([undefined, [], [{ id: 'pending', factor_type: 'totp', status: 'unverified' }]])(
    'preserves optional MFA for AAL1 without verified TOTP: %j', async (factors) => {
      mocks.getUser.mockResolvedValue({ data: { user: { ...user, factors } }, error: null });
      mocks.getClaims.mockResolvedValue({ data: { claims: { sub: user.id, aal: 'aal1' } }, error: null });
      await expectAllowed();
    },
  );

  it('rejects a missing token without trusting cookie identity', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: { user } }, error: null });
    await expectDenied(unauthenticated);
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.getClaims).not.toHaveBeenCalled();
  });

  it.each([
    { data: { user: null }, error: null },
    { data: { user }, error: { message: 'revoked-session-sensitive-detail' } },
  ])('rejects failed authoritative identity: %j', async (response) => {
    mocks.getUser.mockResolvedValue(response);
    await expectDenied(unauthenticated);
    expect(mocks.getClaims).not.toHaveBeenCalled();
  });

  it.each([
    { sub: 'other-user', aal: 'aal2' },
    { sub: user.id },
    { sub: user.id, aal: 'aal3' },
  ])('rejects inconsistent or unsupported signed claims: %j', async (claims) => {
    mocks.getClaims.mockResolvedValue({ data: { claims }, error: null });
    await expectDenied(verificationFailure);
  });

  it.each([
    { data: null, error: { message: 'signature-sensitive-detail' } },
    { data: null, error: null },
    { data: { claims: { sub: user.id, aal: 'aal2' } }, error: { message: 'expired' } },
  ])('does not grant access on failed claim verification: %j', async (response) => {
    mocks.getClaims.mockResolvedValue(response);
    await expectDenied(verificationFailure);
  });

  it('rejects a session read error', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: { message: 'storage-sensitive-detail' } });
    await expectDenied(verificationFailure);
  });

  it.each(['getSession', 'getUser', 'getClaims'] as const)('hides %s outages and denies before database access', async (method) => {
    mocks[method].mockRejectedValue(new Error('sensitive-internal-auth-detail'));
    await expectDenied(verificationFailure);
  });

  it('waits for verified claims before reading the organization or constructing service-role', async () => {
    let resolveClaims!: (value: { data: { claims: { sub: string; aal: string } }; error: null }) => void;
    let started!: () => void;
    const claimsStarted = new Promise<void>((resolve) => { started = resolve; });
    mocks.getClaims.mockImplementation(() => {
      started();
      return new Promise((resolve) => { resolveClaims = resolve; });
    });
    const pending = invoke();
    await claimsStarted;
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    resolveClaims({ data: { claims: { sub: user.id, aal: 'aal2' } }, error: null });
    await pending;
    expect(mocks.createAdminClient).toHaveBeenCalledOnce();
  });

  it.each(['foreign_org', 'foreign_user', 'revoked'] as const)('still rejects %s membership after MFA succeeds', async (scenario) => {
    memberships = [{
      user_id: scenario === 'foreign_user' ? 'another-user' : user.id,
      organization_id: scenario === 'foreign_org' ? otherTenantId : tenantId,
      status: scenario === 'revoked' ? 'revoked' : 'active', role: 'owner',
    }];
    if (boundary === 'action') {
      await expect(invoke()).rejects.toThrow('Brak dostępu do aktywnej organizacji');
    } else {
      await expect(invoke()).resolves.toEqual({ ok: false, status: 403, error: 'no_active_org' });
    }
    expect(filters).toEqual({ user_id: user.id, organization_id: tenantId, status: 'active' });
  });

  it('still rejects missing organization selection without creating service-role', async () => {
    mocks.cookies.mockResolvedValue({ get: () => undefined });
    if (boundary === 'action') {
      await expect(invoke()).rejects.toThrow('Brak aktywnej organizacji');
    } else {
      await expect(invoke()).resolves.toEqual({ ok: false, status: 403, error: 'no_active_org' });
    }
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });
});

it('the compatibility alias and owner guard inherit MFA enforcement', async () => {
  mocks.getClaims.mockResolvedValue({ data: { claims: { sub: user.id, aal: 'aal1' } }, error: null });
  await expect(requireUserAndTenant()).rejects.toBeInstanceOf(ActionAuthError);
  await expect(requireOwner()).rejects.toThrow(challengeRequired.message);
  expect(mocks.createAdminClient).not.toHaveBeenCalled();
});

// Logowanie biometrią (FW1): asercja z weryfikacją użytkownika wystarcza do
// panelu, więc sesja AAL1 ze znacznikiem przechodzi te same granice co AAL2.
// Znacznik liczony niezależnie od kodu aplikacji.
describe('passkey session marker at the panel boundaries', () => {
  const SERVICE_ROLE = 'fixture-service-role-key-do-testow';
  const SESSION = 'fixture-session-id';
  function marker(sub = user.id, sessionId = SESSION): string {
    const expiry = String(Math.floor(Date.now() / 1000) + 3600);
    const key = Buffer.from(hkdfSync('sha256', SERVICE_ROLE, Buffer.alloc(0), 'faktway/passkey-session-marker/v1', 32));
    const mac = createHmac('sha256', key).update(['v1', sub, sessionId, expiry].join('\n')).digest('base64url');
    return ['v1', expiry, mac].join('.');
  }
  function cookiesWith(value: string | undefined) {
    mocks.cookies.mockResolvedValue({
      get: (key: string) => key === ACTIVE_ORG_COOKIE ? { value: tenantId }
        : key === 'ksef.passkey_session' && value ? { value } : undefined,
    });
  }
  beforeEach(() => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE);
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: user.id, aal: 'aal1', session_id: SESSION } }, error: null });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('allows actions, API routes and the user-only boundary with a valid marker of this session', async () => {
    cookiesWith(marker());
    await expect(requireUserAndActiveOrg()).resolves.toMatchObject({ tenantId, role: 'owner', user: { id: user.id } });
    await expect(resolveApiUserAndActiveOrg()).resolves.toEqual({ ok: true, userId: user.id, tenantId, role: 'owner' });
    await expect(requireVerifiedUser()).resolves.toMatchObject({ user: { id: user.id } });
    await expect(requireOwner()).resolves.toMatchObject({ role: 'owner' });
  });

  it.each([
    ['another session', () => marker(user.id, 'other-session')],
    ['another account', () => marker('other-user', SESSION)],
    ['no marker', () => undefined],
  ])('denies the challenge state with %s before any tenant lookup', async (_name, value) => {
    cookiesWith(value());
    await expect(requireUserAndActiveOrg()).rejects.toThrow(challengeRequired.message);
    await expect(resolveApiUserAndActiveOrg()).resolves.toEqual({ ok: false, status: 403, error: 'mfa_required' });
    await expect(requireVerifiedUser()).rejects.toThrow(challengeRequired.message);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });
});
