import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  client: vi.fn(), getSession: vi.fn(), getUser: vi.fn(), getClaims: vi.fn(),
  update: vi.fn(), send: vi.fn(), reauth: vi.fn(), password: vi.fn(),
  attempt: vi.fn(), sendLimit: vi.fn(), audit: vi.fn(), revalidate: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.client }));
vi.mock('@/lib/auth/reauth', () => ({ reauthenticateWithPassword: mocks.reauth }));
vi.mock('@/lib/auth/password', () => ({ validatePassword: mocks.password }));
vi.mock('@/lib/rate-limit/password', () => ({
  checkPasswordOperationRateLimit: mocks.attempt, checkPasswordNonceSendRateLimit: mocks.sendLimit,
}));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));

import { changePasswordAction, requestPasswordChangeNonceAction } from '@/app/(dashboard)/settings/security/actions';

const id = '11111111-1111-4111-8111-111111111111';
const user = {
  id, aud: 'authenticated', email: 'fixture@example.test', email_confirmed_at: '2026-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z', app_metadata: {}, user_metadata: {},
  factors: [{ id: 'totp-fixture', factor_type: 'totp', status: 'verified' }],
};
const current = 'Synthetic-current!123';
const nextPassword = 'Synthetic-next!456';
// Token widżetu Turnstile idzie do GoTrue razem z hasłem (captcha-w-gotrue).
const captchaToken = 'synthetic-turnstile-token';
function form(nonce?: string) {
  const data = new FormData();
  data.set('current_password', current);
  data.set('new_password', nextPassword);
  data.set('cf-turnstile-response', captchaToken);
  if (nonce !== undefined) data.set('nonce', nonce);
  return data;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request'); }));
  mocks.client.mockResolvedValue({ auth: {
    getSession: mocks.getSession, getUser: mocks.getUser, getClaims: mocks.getClaims,
    updateUser: mocks.update, reauthenticate: mocks.send,
  } });
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'original-aal2', user: { id: 'forged', factors: [] } } }, error: null });
  mocks.getUser.mockResolvedValue({ data: { user }, error: null });
  mocks.getClaims.mockResolvedValue({ data: { claims: { sub: id, aal: 'aal2' } }, error: null });
  mocks.attempt.mockResolvedValue({ allowed: true, retryAfter: 0, unavailable: false });
  mocks.sendLimit.mockResolvedValue({ allowed: true, retryAfter: 0, unavailable: false });
  mocks.reauth.mockResolvedValue({ ok: true });
  mocks.password.mockResolvedValue({ valid: true });
  mocks.update.mockResolvedValue({ data: { user }, error: null });
  mocks.send.mockResolvedValue({ data: { user: null, session: null }, error: null });
});
afterEach(() => vi.unstubAllGlobals());

describe('password operations', () => {
  it.each([changePasswordAction, requestPasswordChangeNonceAction])('checks verified MFA before any password attempt', async (action) => {
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: id, aal: 'aal1' } }, error: null });
    expect(await action(form())).toEqual({ ok: false, error: 'mfa_required' });
    expect(mocks.attempt).not.toHaveBeenCalled();
    expect(mocks.reauth).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each([changePasswordAction, requestPasswordChangeNonceAction])('denies unauthenticated and unverifiable identities', async (action) => {
    mocks.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    expect(await action(form())).toEqual({ ok: false, error: 'not_authenticated' });
    mocks.getClaims.mockRejectedValue(new Error('private transport error'));
    expect(await action(form())).toEqual({ ok: false, error: 'verification_unavailable' });
    expect(mocks.reauth).not.toHaveBeenCalled();
    expect(mocks.attempt).not.toHaveBeenCalled();
  });
  it.each([changePasswordAction, requestPasswordChangeNonceAction])('does not require MFA enrollment for an ordinary account', async (action) => {
    mocks.getUser.mockResolvedValue({ data: { user: { ...user, factors: [] } }, error: null });
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: id, aal: 'aal1' } }, error: null });
    expect(await action(form())).toEqual({ ok: true });
  });
  it.each([changePasswordAction, requestPasswordChangeNonceAction])('propagates the shared reauth limit without charging a second attempt', async (action) => {
    mocks.reauth.mockResolvedValue({ ok: false, error: 'rate_limited', retryAfter: 117 });
    expect(await action(form())).toEqual({ ok: false, error: 'rate_limited', retryAfter: 117 });
    expect(mocks.attempt).not.toHaveBeenCalled();
    expect(mocks.reauth).toHaveBeenCalledExactlyOnceWith(current, captchaToken);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each([changePasswordAction, requestPasswordChangeNonceAction])('fails closed if the account limiter is unavailable', async (action) => {
    mocks.reauth.mockResolvedValue({ ok: false, error: 'verification_unavailable' });
    expect(await action(form())).toEqual({ ok: false, error: 'verification_unavailable' });
    expect(mocks.reauth).toHaveBeenCalledExactlyOnceWith(current, captchaToken);
    expect(mocks.attempt).not.toHaveBeenCalled();
  });
  it.each([changePasswordAction, requestPasswordChangeNonceAction])('keeps wrong passwords and verification outages distinct', async (action) => {
    mocks.reauth.mockResolvedValueOnce({ ok: false, error: 'invalid_password' });
    expect(await action(form())).toEqual({ ok: false, error: 'invalid_current' });
    mocks.reauth.mockResolvedValueOnce({ ok: false, error: 'unknown' });
    expect(await action(form())).toEqual({ ok: false, error: 'verification_unavailable' });
    mocks.reauth.mockRejectedValueOnce(new Error('synthetic private detail'));
    expect(await action(form())).toEqual({ ok: false, error: 'verification_unavailable' });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each(['', 'x'.repeat(1025), new File(['secret'], 'fixture')])('rejects invalid current-password inputs before creating a client', async (value) => {
    const data = form(); data.set('current_password', value);
    expect(await changePasswordAction(data)).toEqual({ ok: false, error: 'invalid_current' });
    expect(await requestPasswordChangeNonceAction(data)).toEqual({ ok: false, error: 'invalid_current' });
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it.each(['', 'x'.repeat(129), new File(['secret'], 'fixture')])('rejects malformed new passwords before reauth', async (value) => {
    const data = form(); data.set('new_password', value);
    expect(await changePasswordAction(data)).toEqual({ ok: false, error: 'weak_password' });
    expect(mocks.reauth).not.toHaveBeenCalled();
  });
  it.each(['12345', '12345678901', '123 456', '１２３４５６', new File(['123456'], 'fixture')])('rejects malformed nonce without Auth or password operations', async (value) => {
    const data = form(); data.set('nonce', value);
    expect(await changePasswordAction(data)).toEqual({ ok: false, error: 'invalid_nonce' });
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it.each(['123456', '1234567890'])('passes a bounded nonce and current password on the original client', async (nonce) => {
    expect(await changePasswordAction(form(nonce))).toEqual({ ok: true });
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ password: nextPassword, current_password: current, nonce });
    expect(mocks.reauth).toHaveBeenCalledExactlyOnceWith(current, captchaToken);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledExactlyOnceWith({ action: 'auth.password_changed', tenantId: null, userId: id });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(current);
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(nonce);
  });
  it('preserves the old-session flow without sending mail implicitly', async () => {
    mocks.update.mockResolvedValue({ data: { user: null }, error: { code: 'reauthentication_needed', message: 'private' } });
    expect(await changePasswordAction(form())).toEqual({ ok: false, error: 'reauthentication_needed' });
    expect(mocks.update).toHaveBeenCalledWith({ password: nextPassword, current_password: current });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it.each([
    ['reauthentication_not_valid', 'invalid_nonce'], ['otp_expired', 'invalid_nonce'],
    ['current_password_required', 'invalid_current'], ['current_password_mismatch', 'invalid_current'],
    ['same_password', 'same_password'], ['weak_password', 'weak_password'],
    ['insufficient_aal', 'mfa_required'], ['session_expired', 'not_authenticated'],
    ['over_request_rate_limit', 'rate_limited'], ['unexpected_failure', 'update_failed'],
  ])('normalizes Auth error %s without reflecting its message', async (code, error) => {
    mocks.update.mockResolvedValue({ data: { user: null }, error: { code, message: 'secret transport details' } });
    expect(await changePasswordAction(form('123456'))).toEqual({ ok: false, error });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it.each([null, { id: 'another-user' }])('requires the updated identity before a success audit', async (updated) => {
    mocks.update.mockResolvedValue({ data: { user: updated }, error: null });
    expect(await changePasswordAction(form())).toEqual({ ok: false, error: 'verification_unavailable' });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('handles thrown updates without success or exposing error details', async () => {
    mocks.update.mockRejectedValue(new Error('sensitive HTTP body'));
    expect(await changePasswordAction(form())).toEqual({ ok: false, error: 'verification_unavailable' });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe('explicit password nonce request', () => {
  it('sends only after the cooldown and password verification, without updating the password', async () => {
    expect(await requestPasswordChangeNonceAction(form())).toEqual({ ok: true });
    expect(mocks.sendLimit).toHaveBeenCalledExactlyOnceWith(id);
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.send.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.reauth.mock.invocationCallOrder[0]);
    expect(mocks.send.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.sendLimit.mock.invocationCallOrder[0]);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it.each([false, true])('denies sends during cooldown or outage (%s)', async (unavailable) => {
    mocks.sendLimit.mockResolvedValue({ allowed: false, retryAfter: 40, unavailable });
    expect(await requestPasswordChangeNonceAction(form())).toEqual(unavailable
      ? { ok: false, error: 'verification_unavailable' }
      : { ok: false, error: 'rate_limited', retryAfter: 40 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.reauth).not.toHaveBeenCalled();
  });
  it('does not report a sent code when delivery fails', async () => {
    mocks.send.mockResolvedValue({ error: { code: 'email_not_confirmed', message: 'private user details' } });
    expect(await requestPasswordChangeNonceAction(form())).toEqual({ ok: false, error: 'nonce_send_failed' });
    mocks.send.mockRejectedValueOnce(new Error('private SMTP error'));
    expect(await requestPasswordChangeNonceAction(form())).toEqual({ ok: false, error: 'verification_unavailable' });
  });
  it('treats provider rate limits as retryable, without exposing provider data', async () => {
    mocks.send.mockResolvedValue({ error: { code: 'over_email_send_rate_limit', message: 'private user details' } });
    expect(await requestPasswordChangeNonceAction(form())).toEqual({ ok: false, error: 'rate_limited' });
  });
});

it('uses the real SDK with the original AAL2 JWT for nonce and password update', async () => {
  const { createClient } = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const token = [encode({ alg: 'HS256', typ: 'JWT' }), encode({ sub: id, aal: 'aal2', exp: now + 3600, iat: now }), 'synthetic-signature'].join('.');
  const session = { access_token: token, refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_at: now + 3600, expires_in: 3600, user };
  const writes: string[] = [];
  const requests: Array<{ method: string; path: string; authorization: string | null; body: unknown }> = [];
  const sdk = createClient('https://auth.example.test', 'synthetic-anon', {
    auth: {
      autoRefreshToken: false, detectSessionInUrl: false, persistSession: true, storageKey: 'fixture-session',
      storage: { getItem: () => JSON.stringify(session), setItem: (_key, value) => { writes.push(value); }, removeItem: () => {} },
    },
    global: { fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      const method = init?.method ?? 'GET';
      requests.push({ method, path: url.pathname, authorization: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === 'GET' && url.pathname === '/auth/v1/reauthenticate') {
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname === '/auth/v1/user' && (method === 'GET' || method === 'PUT')) {
        return new Response(JSON.stringify(user), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error('Unexpected SDK HTTP request');
    } },
  });
  mocks.client.mockResolvedValue(sdk);
  expect(await requestPasswordChangeNonceAction(form())).toEqual({ ok: true });
  expect(await changePasswordAction(form('12345678'))).toEqual({ ok: true });
  expect(requests.every((request) => request.authorization === 'Bearer ' + token)).toBe(true);
  expect(requests.filter((request) => request.path.endsWith('/reauthenticate'))).toEqual([
    { method: 'GET', path: '/auth/v1/reauthenticate', authorization: 'Bearer ' + token, body: null },
  ]);
  expect(requests.filter((request) => request.method === 'PUT')).toEqual([
    { method: 'PUT', path: '/auth/v1/user', authorization: 'Bearer ' + token,
      body: { password: nextPassword, current_password: current, nonce: '12345678', code_challenge: null, code_challenge_method: null } },
  ]);
  expect(requests.some((request) => request.path.endsWith('/token'))).toBe(false);
  expect(writes.length).toBeGreaterThan(0);
  for (const write of writes) expect(JSON.parse(write).access_token).toBe(token);
});
