import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Telefon wchodzi do panelu jak każdy inny klient (FaktWay 1.0, pkt 2).
 * Dawna bramka BUG-008 odsyłała telefony na `/mobile`, dopóki ktoś nie włączył
 * przełącznika w środowisku. Teraz żadnego przełącznika nie ma: produkcja ma
 * wpuszczać telefon zawsze, a nie go odbijać.
 */
const mocks = vi.hoisted(() => ({
  create: vi.fn(), getSession: vi.fn(), getUser: vi.fn(), getClaims: vi.fn(),
  from: vi.fn(), select: vi.fn(), eq: vi.fn(), order: vi.fn(), limit: vi.fn(),
}));
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.create }));
import { updateSession } from '@/lib/supabase/middleware';
import { ACTIVE_ORG_COOKIE } from '@/lib/supabase/active-org';

const userId = 'fixture-user';
const org = '11111111-1111-4111-8111-111111111111';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const PIXEL = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36';
let signedIn: boolean;

beforeEach(() => {
  vi.resetAllMocks();
  signedIn = true;
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
  mocks.create.mockImplementation(() => ({
    auth: { getSession: mocks.getSession, getUser: mocks.getUser, getClaims: mocks.getClaims },
    from: mocks.from,
  }));
  mocks.getClaims.mockImplementation(async () => ({
    data: signedIn ? { claims: { sub: userId, aal: 'aal1' } } : null, error: null,
  }));
  mocks.getSession.mockResolvedValue({ data: { session: {
    access_token: 'signed-fixture', user: { id: userId, factors: [], aal: 'aal1' },
  } }, error: null });
  mocks.getUser.mockResolvedValue({ data: { user: { id: userId, factors: [] } }, error: null });
  const query = { select: mocks.select, eq: mocks.eq, order: mocks.order, limit: mocks.limit };
  mocks.from.mockReturnValue(query); mocks.select.mockReturnValue(query);
  mocks.eq.mockReturnValue(query); mocks.order.mockReturnValue(query);
  mocks.limit.mockResolvedValue({ data: [], error: null });
});
afterEach(() => vi.unstubAllEnvs());

function phone(path: string, userAgent = IPHONE) {
  return new NextRequest('https://app.example.test' + path, {
    headers: { 'user-agent': userAgent, accept: 'text/html', cookie: ACTIVE_ORG_COOKIE + '=' + org },
  });
}

it.each([
  ['iPhone', IPHONE],
  ['Android', PIXEL],
])('%s niezalogowany wchodzi na /login bez przekierowania na /mobile', async (_name, ua) => {
  signedIn = false;
  const response = await updateSession(phone('/login', ua));
  expect(response.headers.get('location')).toBeNull();
  expect(response.headers.get('x-middleware-next')).toBe('1');
});

it.each(['/dashboard', '/invoices', '/invoices/new', '/settings'])(
  'iPhone zalogowany wchodzi na %s bez przekierowania na /mobile',
  async (path) => {
    const response = await updateSession(phone(path));
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
  },
);

it('zalogowany telefon z landingu jedzie na pulpit, jak każdy klient', async () => {
  const response = await updateSession(phone('/'));
  expect(response.headers.get('location')).toBe('https://app.example.test/dashboard');
});

it('/mobile zostaje osiągalne bez logowania (krótka instrukcja instalacji)', async () => {
  signedIn = false;
  const response = await updateSession(phone('/mobile'));
  expect(response.headers.get('location')).toBeNull();
  expect(response.headers.get('x-middleware-next')).toBe('1');
});
