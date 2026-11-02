import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ACTIVE_ORG_COOKIE } from '@/lib/supabase/active-org';

// AUD-63: `maintenanceMode` („Przerwa techniczna — blokuje panel”, 00060)
// istniał tylko w bazie — nikt go nie czytał. Bramka siedzi w proxy:
// panel zalogowanego dostaje stronę przerwy, prywatne API 503.
// Błąd odczytu flagi: ostatnia znana wartość, a bez niej panel działa.

const mocks = vi.hoisted(() => ({
  create: vi.fn(), getClaims: vi.fn(), mfa: vi.fn(), flag: vi.fn(),
  from: vi.fn(), select: vi.fn(), eq: vi.fn(), order: vi.fn(), limit: vi.fn(),
}));
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.create }));
vi.mock('@/lib/auth/verified-mfa', () => ({ getVerifiedMfaState: mocks.mfa }));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: mocks.flag }));

const userId = 'fixture-user';
const org = '11111111-1111-4111-8111-111111111111';
let signedIn: boolean;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-02T10:00:00Z'));
  signedIn = true;
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
  mocks.create.mockImplementation(() => ({
    auth: { getClaims: mocks.getClaims },
    from: mocks.from,
  }));
  mocks.getClaims.mockImplementation(async () => ({
    data: signedIn ? { claims: { sub: userId } } : null, error: null,
  }));
  mocks.mfa.mockResolvedValue({ status: 'verified', user: { id: userId } });
  const query = { select: mocks.select, eq: mocks.eq, order: mocks.order, limit: mocks.limit };
  mocks.from.mockReturnValue(query); mocks.select.mockReturnValue(query);
  mocks.eq.mockReturnValue(query); mocks.order.mockReturnValue(query);
  mocks.limit.mockResolvedValue({ data: [], error: null });
  mocks.flag.mockResolvedValue(false);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

async function proxyFor(path: string, method = 'GET') {
  const { updateSession } = await import('@/lib/supabase/middleware');
  return updateSession(new NextRequest('https://app.example.test' + path, {
    method,
    headers: { cookie: ACTIVE_ORG_COOKIE + '=' + org, accept: 'text/html' },
  }));
}

it.each([['/invoices', 'GET'], ['/dashboard', 'GET'], ['/invoices', 'POST'], ['/onboarding', 'GET']])(
  'przy włączonej przerwie kieruje panel %s (%s) na stronę przerwy',
  async (path, method) => {
    mocks.flag.mockResolvedValue(true);
    const response = await proxyFor(path, method);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.example.test/przerwa-techniczna');
    expect(mocks.flag).toHaveBeenCalledWith('maintenanceMode');
  },
);

it('przy włączonej przerwie prywatne API odpowiada 503 bez dotykania danych firmy', async () => {
  mocks.flag.mockResolvedValue(true);
  const response = await proxyFor('/api/invoices/fixture/pdf');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'maintenance' });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(mocks.from).not.toHaveBeenCalled();
});

it.each(['/admin', '/api/health', '/przerwa-techniczna', '/pricing'])(
  'przerwa nie blokuje %s',
  async (path) => {
    mocks.flag.mockResolvedValue(true);
    const response = await proxyFor(path);
    expect(response.headers.get('location') ?? '').not.toContain('/przerwa-techniczna');
    expect(response.status).not.toBe(503);
  },
);

it('niezalogowany idzie na logowanie jak dotąd, bez odczytu flagi', async () => {
  signedIn = false;
  mocks.flag.mockResolvedValue(true);
  const response = await proxyFor('/invoices');
  expect(response.headers.get('location')).toContain('/login');
  expect(mocks.flag).not.toHaveBeenCalled();
});

it('bez przerwy panel działa normalnie', async () => {
  const response = await proxyFor('/invoices');
  expect(response.status).toBe(200);
  expect(response.headers.get('x-middleware-next')).toBe('1');
});

it('błąd odczytu bez znanej wartości — panel działa (fail-open)', async () => {
  mocks.flag.mockRejectedValue(new Error('fixture offline'));
  const response = await proxyFor('/invoices');
  expect(response.status).toBe(200);
  expect(response.headers.get('x-middleware-next')).toBe('1');
});

it('błąd odczytu po włączeniu przerwy — przerwa trwa (ostatnia znana wartość)', async () => {
  const { updateSession } = await import('@/lib/supabase/middleware');
  const req = () => new NextRequest('https://app.example.test/invoices', {
    headers: { cookie: ACTIVE_ORG_COOKIE + '=' + org, accept: 'text/html' },
  });
  mocks.flag.mockResolvedValueOnce(true);
  expect((await updateSession(req())).headers.get('location')).toContain('/przerwa-techniczna');

  vi.setSystemTime(new Date('2026-10-02T10:05:00Z'));
  mocks.flag.mockRejectedValueOnce(new Error('fixture offline'));
  const response = await updateSession(req());
  expect(response.headers.get('location')).toBe('https://app.example.test/przerwa-techniczna');
  expect(mocks.flag).toHaveBeenCalledTimes(2);
});

it('odczyt flagi jest pamiętany krótko — nie pyta bazy przy każdym żądaniu', async () => {
  const { updateSession } = await import('@/lib/supabase/middleware');
  const req = () => new NextRequest('https://app.example.test/invoices', {
    headers: { cookie: ACTIVE_ORG_COOKIE + '=' + org, accept: 'text/html' },
  });
  await updateSession(req());
  await updateSession(req());
  expect(mocks.flag).toHaveBeenCalledTimes(1);

  vi.setSystemTime(new Date('2026-10-02T10:01:00Z'));
  mocks.flag.mockResolvedValueOnce(true);
  expect((await updateSession(req())).headers.get('location')).toContain('/przerwa-techniczna');
  expect(mocks.flag).toHaveBeenCalledTimes(2);
});
