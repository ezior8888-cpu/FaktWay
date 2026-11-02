import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({
  create: vi.fn(), getSession: vi.fn(), getUser: vi.fn(), getClaims: vi.fn(),
  localAal: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(), order: vi.fn(), limit: vi.fn(),
}));
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.create }));
import { updateSession } from '@/lib/supabase/middleware';
import { ACTIVE_ORG_COOKIE } from '@/lib/supabase/active-org';
const userId = 'fixture-user';
const factor = { id: 'fixture-factor', factor_type: 'totp', status: 'verified' };
const org = '11111111-1111-4111-8111-111111111111';
let aal: string;
let factors: typeof factor[];
let refresh: boolean;
beforeEach(() => {
  vi.resetAllMocks(); aal = 'aal1'; factors = [factor]; refresh = false;
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_MOBILE_PANEL', 'off');
  vi.stubEnv('NEXT_PUBLIC_MOBILE_PANEL_ALLOWLIST', '');
  mocks.create.mockImplementation((_url: string, _key: string, options: {
    cookies: { setAll: (values: { name: string; value: string; options: { path: string; httpOnly: boolean } }[], headers: Record<string, string>) => void };
  }) => {
    mocks.getClaims.mockImplementation(async (token?: string) => {
      // Drugi argument jak w prawdziwym `@supabase/ssr` (applyServerStorage).
      if (!token && refresh) options.cookies.setAll([{ name: 'fixture-session', value: 'refreshed', options: { path: '/', httpOnly: true } }], { 'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0', Expires: '0', Pragma: 'no-cache' });
      return { data: { claims: { sub: userId, aal } }, error: null };
    });
    return { auth: {
      getSession: mocks.getSession, getUser: mocks.getUser, getClaims: mocks.getClaims,
      mfa: { getAuthenticatorAssuranceLevel: mocks.localAal },
    }, from: mocks.from };
  });
  mocks.getSession.mockResolvedValue({ data: { session: {
    access_token: 'signed-fixture', user: { id: userId, factors: [], aal: 'aal2' },
  } }, error: null });
  mocks.getUser.mockImplementation(async () => ({ data: { user: { id: userId, factors } }, error: null }));
  // Old middleware would trust this cookie-derived answer.
  mocks.localAal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal1' } });
  const query = { select: mocks.select, eq: mocks.eq, order: mocks.order, limit: mocks.limit };
  mocks.from.mockReturnValue(query); mocks.select.mockReturnValue(query);
  mocks.eq.mockReturnValue(query); mocks.order.mockReturnValue(query);
  mocks.limit.mockResolvedValue({ data: [], error: null });
});
afterEach(() => vi.unstubAllEnvs());
function request(path: string, withOrg = true, method = 'GET') {
  return new NextRequest('https://app.example.test' + path, {
    method, headers: withOrg ? { cookie: ACTIVE_ORG_COOKIE + '=' + org } : undefined,
  });
}
it.each(['/api/invoices/fixture/pdf', '/api/gdpr/export', '/api/support/chat'])('denies AAL1 at private API %s despite forged local factors', async (path) => {
  const response = await updateSession(request(path));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'mfa_required' });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.localAal).not.toHaveBeenCalled();
});
it.each(['GET', 'POST'])('challenges private HTML/RSC/actions before org data (%s)', async (method) => {
  const response = await updateSession(request('/invoices', false, method));
  expect(response.status).toBe(307);
  expect(response.headers.get('location')).toBe('https://app.example.test/login/two-factor?redirect=%2Finvoices');
  expect(mocks.from).not.toHaveBeenCalled();
});
it.each(['aal2', 'no-factor'])('preserves optional MFA policy for %s', async (state) => {
  if (state === 'no-factor') factors = []; else aal = 'aal2';
  const response = await updateSession(request('/api/invoices/fixture/pdf'));
  expect(response.status).toBe(200);
  expect(response.headers.get('x-middleware-next')).toBe('1');
  expect(mocks.getUser).toHaveBeenCalledWith('signed-fixture');
});
it('fails closed if current factors cannot be retrieved', async () => {
  mocks.getUser.mockRejectedValue(new Error('fixture offline'));
  const response = await updateSession(request('/api/gdpr/export'));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'session_verification_failed' });
  expect(mocks.from).not.toHaveBeenCalled();
});
it('rejects mismatched verified identity before bootstrap', async () => {
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'other', factors } }, error: null });
  const response = await updateSession(request('/invoices', false));
  expect(response.status).toBe(503);
  expect(mocks.from).not.toHaveBeenCalled();
});
it('returns API 401 when the previously claimed session no longer authenticates', async () => {
  mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
  const response = await updateSession(request('/api/gdpr/export'));
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'not_authenticated' });
});
it.each(['/api/health', '/auth/callback', '/reset-password', '/login/two-factor', '/login/two-factor/setup'])('preserves public/auth route %s for the route’s own guard', async (path) => {
  const response = await updateSession(request(path, false));
  expect(response.status).toBe(200);
  expect(mocks.getUser).not.toHaveBeenCalled();
  expect(mocks.from).not.toHaveBeenCalled();
});
it.each(['aal1', 'aal2'])('does not require an org to reach the admin guard (%s)', async (state) => {
  aal = state; if (state === 'aal1') factors = [];
  const response = await updateSession(request('/admin/users', false));
  expect(response.status).toBe(200);
  expect(mocks.from).not.toHaveBeenCalled();
});
it('keeps normal organization onboarding when no membership exists', async () => {
  factors = [];
  const response = await updateSession(request('/dashboard', false));
  expect(response.headers.get('location')).toBe('https://app.example.test/onboarding');
  expect(mocks.from).toHaveBeenCalledWith('memberships');
});
it('preserves refreshed session cookies on the challenge redirect', async () => {
  refresh = true;
  const response = await updateSession(request('/invoices'));
  expect(response.cookies.get('fixture-session')?.value).toBe('refreshed');
});
it('preserves refreshed session cookies on an API MFA refusal', async () => {
  refresh = true;
  const response = await updateSession(request('/api/gdpr/export'));
  expect(response.status).toBe(403);
  expect(response.cookies.get('fixture-session')?.value).toBe('refreshed');
});

function phoneRequest(path: string) {
  return new NextRequest('https://app.example.test' + path, {
    headers: {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      accept: 'text/html',
      cookie: ACTIVE_ORG_COOKIE + '=' + org,
    },
  });
}

it.each(['on', 'allowlist'])('mobile rollout %s still challenges enrolled AAL1 before company data', async (mode) => {
  vi.stubEnv('NEXT_PUBLIC_MOBILE_PANEL', mode);
  vi.stubEnv('NEXT_PUBLIC_MOBILE_PANEL_ALLOWLIST', userId);
  refresh = true;
  const response = await updateSession(phoneRequest('/invoices'));
  expect(response.headers.get('location')).toBe('https://app.example.test/login/two-factor?redirect=%2Finvoices');
  expect(response.cookies.get('fixture-session')?.value).toBe('refreshed');
  expect(mocks.from).not.toHaveBeenCalled();
  expect(mocks.localAal).not.toHaveBeenCalled();
});

it.each(['off', 'on', 'allowlist'])('mobile mode %s cannot exempt a private API from MFA', async (mode) => {
  vi.stubEnv('NEXT_PUBLIC_MOBILE_PANEL', mode);
  vi.stubEnv('NEXT_PUBLIC_MOBILE_PANEL_ALLOWLIST', userId);
  const response = await updateSession(phoneRequest('/api/gdpr/export'));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'mfa_required' });
  expect(mocks.from).not.toHaveBeenCalled();
});

it('lets an allowed phone with verified MFA continue to its protected page', async () => {
  vi.stubEnv('NEXT_PUBLIC_MOBILE_PANEL', 'allowlist');
  vi.stubEnv('NEXT_PUBLIC_MOBILE_PANEL_ALLOWLIST', userId);
  aal = 'aal2';
  const response = await updateSession(phoneRequest('/invoices'));
  expect(response.headers.get('x-middleware-next')).toBe('1');
  expect(mocks.getUser).toHaveBeenCalledWith('signed-fixture');
});
