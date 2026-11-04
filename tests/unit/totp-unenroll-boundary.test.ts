import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  client: vi.fn(), state: vi.fn(), limit: vi.fn(), sendLimit: vi.fn(), reauth: vi.fn(),
  factors: vi.fn(), unenroll: vi.fn(), cleanup: vi.fn(), audit: vi.fn(), revalidate: vi.fn(),
  validate: vi.fn(), update: vi.fn(), nonce: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.client }));
vi.mock('@/lib/auth/verified-mfa', () => ({ getVerifiedMfaState: mocks.state }));
vi.mock('@/lib/rate-limit/password', () => ({
  checkPasswordOperationRateLimit: mocks.limit, checkPasswordNonceSendRateLimit: mocks.sendLimit,
}));
vi.mock('@/lib/auth/reauth', () => ({ reauthenticateWithPassword: mocks.reauth }));
vi.mock('@/lib/auth/mfa-recovery', () => ({ deleteAllRecoveryCodes: mocks.cleanup }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/auth/password', () => ({ validatePassword: mocks.validate }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));

import {
  unenrollTotpAction,
} from '@/app/(dashboard)/settings/security/actions';

const user = { id: 'fixture-user', email: 'member@example.test' };
const totp = { id: 'fixture-totp', factor_type: 'totp', status: 'verified' };
const allowed = { allowed: true, unavailable: false, retryAfter: 0 };
const client = { auth: {
  mfa: { listFactors: mocks.factors, unenroll: mocks.unenroll },
  updateUser: mocks.update, reauthenticate: mocks.nonce,
} };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network call'); }));
  mocks.client.mockResolvedValue(client);
  mocks.state.mockResolvedValue({ status: 'verified', user });
  mocks.limit.mockResolvedValue(allowed);
  mocks.sendLimit.mockResolvedValue(allowed);
  mocks.reauth.mockResolvedValue({ ok: true });
  mocks.factors.mockResolvedValue({ data: { all: [totp] }, error: null });
  mocks.cleanup.mockResolvedValue(undefined);
  mocks.unenroll.mockResolvedValue({ data: { id: totp.id }, error: null });
});
afterEach(() => vi.unstubAllGlobals());

function noMutation() {
  expect(mocks.cleanup).not.toHaveBeenCalled();
  expect(mocks.unenroll).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(mocks.revalidate).not.toHaveBeenCalled();
}
function noPasswordWork() {
  expect(mocks.limit).not.toHaveBeenCalled();
  expect(mocks.reauth).not.toHaveBeenCalled();
  expect(mocks.factors).not.toHaveBeenCalled();
  noMutation();
}

it.each([undefined, null, 42, {}, new File(['fixture'], 'fixture.txt'), '', 'x'.repeat(1025)])(
  'rejects invalid or oversized password %s before authentication', async (password) => {
    expect(await unenrollTotpAction(password as string)).toEqual({ ok: false, error: 'invalid_password' });
    expect(mocks.client).not.toHaveBeenCalled();
    noPasswordWork();
  },
);
it.each([
  ['unauthenticated', 'not_authenticated'],
  ['challenge_required', 'mfa_required'],
  ['enrollment_required', 'mfa_required'],
])('denies %s before password verification', async (status, error) => {
  mocks.state.mockResolvedValue({ status, user });
  expect(await unenrollTotpAction('fixture')).toEqual({ ok: false, error });
  noPasswordWork();
});
it.each(['client', 'state'] as const)('fails closed on a thrown %s error without exposing it', async (name) => {
  mocks[name].mockRejectedValue(new Error('synthetic-private-detail'));
  expect(await unenrollTotpAction('fixture')).toEqual({ ok: false, error: 'verification_unavailable' });
  noPasswordWork();
});
it('waits for MFA before touching the password budget', async () => {
  let complete!: (value: object) => void;
  mocks.state.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
  const pending = unenrollTotpAction('fixture');
  await vi.waitFor(() => expect(mocks.state).toHaveBeenCalledWith(client));
  noPasswordWork();
  complete({ status: 'challenge_required', user });
  await expect(pending).resolves.toEqual({ ok: false, error: 'mfa_required' });
});
it.each([
  { error: 'rate_limited', retryAfter: 42 },
  { error: 'verification_unavailable' },
])('propagates a refusal from the authoritative reauth budget: $error', async ({ error, retryAfter }) => {
  const result = { ok: false, error, ...(retryAfter ? { retryAfter } : {}) };
  mocks.reauth.mockResolvedValue(result);
  expect(await unenrollTotpAction('fixture', 'synthetic-turnstile-token')).toEqual(result);
  expect(mocks.limit).not.toHaveBeenCalled();
  expect(mocks.reauth).toHaveBeenCalledExactlyOnceWith('fixture', 'synthetic-turnstile-token');
  expect(mocks.factors).not.toHaveBeenCalled();
  noMutation();
});
it.each([
  ['invalid_password', 'invalid_password'], ['not_authenticated', 'not_authenticated'],
  ['unknown', 'verification_unavailable'],
])('denies isolated reauth %s without removing anything', async (reason, error) => {
  mocks.reauth.mockResolvedValue({ ok: false, error: reason });
  expect(await unenrollTotpAction('fixture')).toEqual({ ok: false, error });
  expect(mocks.factors).not.toHaveBeenCalled();
  noMutation();
});
it('handles a thrown isolated reauth failure without leaking it', async () => {
  mocks.reauth.mockRejectedValue(new Error('synthetic-private-detail'));
  expect(await unenrollTotpAction('fixture')).toEqual({ ok: false, error: 'verification_unavailable' });
  noMutation();
});
// The mixed-action budget regression uses real reauth + limiter in password-shared-budget.test.ts.
it.each([
  { data: null, error: { message: 'synthetic-private-detail' } },
  { data: null, error: null }, { data: {}, error: null },
  { data: { all: [] }, error: null },
  { data: { all: [{ ...totp, status: 'unverified' }] }, error: null },
])('refuses missing or stale factor data before cleanup', async (result) => {
  mocks.factors.mockResolvedValue(result);
  expect(await unenrollTotpAction('fixture')).toEqual({ ok: false, error: 'unenroll_failed' });
  noMutation();
});
it('handles factor listing transport failure', async () => {
  mocks.factors.mockRejectedValue(new Error('synthetic-private-detail'));
  expect(await unenrollTotpAction('fixture')).toEqual({ ok: false, error: 'unenroll_failed' });
  noMutation();
});
it('retains every factor when legacy-code cleanup fails', async () => {
  mocks.cleanup.mockRejectedValue(new Error('synthetic-private-detail'));
  expect(await unenrollTotpAction('fixture')).toEqual({ ok: false, error: 'unenroll_failed' });
  expect(mocks.cleanup).toHaveBeenCalledExactlyOnceWith(user.id);
  expect(mocks.unenroll).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(mocks.revalidate).not.toHaveBeenCalled();
});
it('cleans codes before touching TOTP and leaves phone and WebAuthn factors alone', async () => {
  const pending = { ...totp, id: 'fixture-pending', status: 'unverified' };
  mocks.factors.mockResolvedValue({ data: { all: [
    { ...totp, id: 'fixture-phone', factor_type: 'phone' }, totp,
    { ...totp, id: 'fixture-webauthn', factor_type: 'webauthn' }, pending,
  ] }, error: null });
  expect(await unenrollTotpAction('x'.repeat(1024))).toEqual({ ok: true });
  expect(mocks.reauth).toHaveBeenCalledExactlyOnceWith('x'.repeat(1024), undefined);
  expect(mocks.unenroll.mock.calls).toEqual([[{ factorId: totp.id }], [{ factorId: pending.id }]]);
  expect(mocks.limit).not.toHaveBeenCalled();
  expect(mocks.reauth.mock.invocationCallOrder[0]).toBeLessThan(mocks.factors.mock.invocationCallOrder[0]);
  expect(mocks.cleanup.mock.invocationCallOrder[0]).toBeLessThan(mocks.unenroll.mock.invocationCallOrder[0]);
  expect(mocks.audit).toHaveBeenCalledExactlyOnceWith({
    action: 'auth.mfa_unenrolled', tenantId: null, userId: user.id,
    metadata: { factor_type: 'totp', removed_count: 2 },
  });
  expect(mocks.revalidate).toHaveBeenCalledExactlyOnceWith('/settings/security');
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.nonce).not.toHaveBeenCalled();
});
describe.each(['error', 'throw'])('Auth deletion %s', (mode) => {
  function fail() {
    if (mode === 'error') mocks.unenroll.mockResolvedValue({ error: { message: 'synthetic-private-detail' } });
    else mocks.unenroll.mockRejectedValue(new Error('synthetic-private-detail'));
  }
  it('does not claim success for a failed first operation', async () => {
    fail();
    expect(await unenrollTotpAction('fixture')).toEqual({ ok: false, error: 'unenroll_failed' });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('reports partial removal explicitly and stops before further factors', async () => {
    mocks.factors.mockResolvedValue({ data: { all: [totp, { ...totp, id: 'second' }, { ...totp, id: 'third' }] }, error: null });
    fail();
    mocks.unenroll.mockResolvedValueOnce({ error: null, data: { id: totp.id } });
    expect(await unenrollTotpAction('fixture')).toEqual({ ok: false, error: 'unenroll_incomplete' });
    expect(mocks.unenroll.mock.calls).toEqual([[{ factorId: totp.id }], [{ factorId: 'second' }]]);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.revalidate).toHaveBeenCalledExactlyOnceWith('/settings/security');
  });
});
