import { createHmac, hkdfSync } from 'node:crypto';

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Stan `challenge_required` stał się osiągalny w panelu dopiero przez logowanie
 * biometrią. Każda operacja, która dalej wymaga kodu, ma dać komunikat i przejście
 * na `/login/two-factor?redirect=<tu>`: nigdy martwy błąd ani pętla przekierowań.
 */

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(), redirect: vi.fn(), cookies: vi.fn(),
  getSession: vi.fn(), getUser: vi.fn(), getClaims: vi.fn(), listFactors: vi.fn(),
  from: vi.fn(),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/headers', () => ({ cookies: mocks.cookies, headers: async () => new Headers() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient, createAdminClient: () => { throw new Error('bez klucza serwisowego'); } }));
vi.mock('@/app/(auth)/login/two-factor/actions', () => ({ verifyMfaChallengeAction: vi.fn() }));
vi.mock('@/app/(dashboard)/settings/security/actions', () => ({
  enrollTotpAction: vi.fn(), unenrollTotpAction: vi.fn(), verifyTotpEnrollmentAction: vi.fn(),
  regenerateRecoveryCodesAction: vi.fn(), changePasswordAction: vi.fn(), requestPasswordChangeNonceAction: vi.fn(),
}));

import TwoFactorChallengePage from '@/app/(auth)/login/two-factor/page';
import SecuritySettingsPage from '@/app/(dashboard)/settings/security/page';
import { getVerifiedUserContext, requireVerifiedUserForPage } from '@/lib/auth/verified-user';
import { mfaStepUpHref } from '@/lib/auth/mfa-step-up';
import { MfaStepUpNotice } from '@/components/auth/mfa-step-up-notice';

const SERVICE_ROLE = 'fixture-service-role-key-do-testow';
const SESSION = 'session-a';
const user = { id: 'user-a', email: 'a@example.test', factors: [{ id: 'totp-1', factor_type: 'totp', status: 'verified' }] };

function marker(): string {
  const expiry = String(Math.floor(Date.now() / 1000) + 3600);
  const key = Buffer.from(hkdfSync('sha256', SERVICE_ROLE, Buffer.alloc(0), 'faktway/passkey-session-marker/v1', 32));
  const mac = createHmac('sha256', key).update(['v1', user.id, SESSION, expiry].join('\n')).digest('base64url');
  return ['v1', expiry, mac].join('.');
}

function html(markup: string): string {
  return markup.replaceAll('&amp;', '&');
}

let aal: 'aal1' | 'aal2';
let markerCookie: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE);
  aal = 'aal1';
  markerCookie = marker();
  mocks.redirect.mockImplementation((path: string) => { throw new Error('redirect:' + path); });
  mocks.cookies.mockImplementation(async () => ({
    get: (name: string) => name === 'ksef.passkey_session' && markerCookie ? { value: markerCookie } : undefined,
  }));
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'signed-token' } }, error: null });
  mocks.getUser.mockResolvedValue({ data: { user }, error: null });
  mocks.getClaims.mockImplementation(async () => ({ data: { claims: { sub: user.id, aal, session_id: SESSION } }, error: null }));
  mocks.listFactors.mockResolvedValue({ data: { all: user.factors, totp: user.factors }, error: null });
  const query = {
    select: () => query, eq: () => query, order: () => query,
    then: (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null }),
  };
  mocks.from.mockReturnValue(query);
  mocks.createClient.mockResolvedValue({
    auth: {
      getSession: mocks.getSession, getUser: mocks.getUser, getClaims: mocks.getClaims,
      mfa: { listFactors: mocks.listFactors },
    },
    from: mocks.from,
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('mfaStepUpHref', () => {
  it('niesie bezpieczną ścieżkę powrotu', () => {
    expect(mfaStepUpHref('/settings/security')).toBe('/login/two-factor?redirect=%2Fsettings%2Fsecurity&potwierdzenie=1');
    expect(mfaStepUpHref('/invoices?strona=2')).toBe('/login/two-factor?redirect=%2Finvoices%3Fstrona%3D2&potwierdzenie=1');
  });
  it.each(['https://zly.example', '//zly.example', 'javascript:alert(1)'])('cudzy adres %s sprowadza do pulpitu', (target) => {
    expect(mfaStepUpHref(target)).toBe('/login/two-factor?redirect=%2Fdashboard&potwierdzenie=1');
  });
});

describe('MfaStepUpNotice', () => {
  it('mówi, co zrobić, i prowadzi na ekran kodu z powrotem tutaj', () => {
    const markup = html(renderToStaticMarkup(<MfaStepUpNotice returnTo="/settings/security">Zmiana hasła wymaga kodu.</MfaStepUpNotice>));
    expect(markup).toContain('Zmiana hasła wymaga kodu.');
    expect(markup).toContain('href="/login/two-factor?redirect=%2Fsettings%2Fsecurity&potwierdzenie=1"');
    expect(markup).toContain('Potwierdź kodem z aplikacji');
  });
});

describe('ekran kodu po przejściu z operacji wrażliwej', () => {
  it('sesja po biometrii widzi formularz, powrót i powód; bez pętli', async () => {
    const markup = html(renderToStaticMarkup(await TwoFactorChallengePage({
      searchParams: Promise.resolve({ redirect: '/settings/security', potwierdzenie: '1' }),
    })));
    expect(markup).toContain('name="redirect" value="/settings/security"');
    expect(markup).toMatch(/Ta operacja wymaga kodu z aplikacji/);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('bez parametru: zwykły ekran kodu', async () => {
    const markup = renderToStaticMarkup(await TwoFactorChallengePage({ searchParams: Promise.resolve({}) }));
    expect(markup).not.toMatch(/Ta operacja wymaga kodu z aplikacji/);
  });

  it('po podaniu kodu (AAL2) ekran odsyła od razu z powrotem, bez ponownego pytania', async () => {
    aal = 'aal2';
    await expect(TwoFactorChallengePage({
      searchParams: Promise.resolve({ redirect: '/settings/security', potwierdzenie: '1' }),
    })).rejects.toThrow('redirect:/settings/security');
  });
});

describe('Ustawienia → Bezpieczeństwo', () => {
  const render = async () => html(renderToStaticMarkup(await SecuritySettingsPage({ searchParams: Promise.resolve({}) })));

  it('sesja po biometrii: od razu widać, że zmiany wymagają kodu, i jest przejście', async () => {
    const markup = await render();
    expect(markup).toContain('href="/login/two-factor?redirect=%2Fsettings%2Fsecurity&potwierdzenie=1"');
    expect(markup).toMatch(/Zalogowano biometrią/);
    expect(markup).toContain('Logowanie biometrią');
  });

  it('sesja po kodzie: bez baneru', async () => {
    aal = 'aal2';
    const markup = await render();
    expect(markup).not.toMatch(/Zalogowano biometrią/);
    expect(markup).toContain('Logowanie biometrią');
  });
});

describe('getVerifiedUserContext', () => {
  it('panel (onboarding, zaproszenia, preferencje): sesja ze znacznikiem przechodzi', async () => {
    await expect(getVerifiedUserContext()).resolves.toMatchObject({ ok: true, user: { id: user.id } });
    await expect(requireVerifiedUserForPage('/onboarding')).resolves.toMatchObject({ ok: true });
  });

  it('bez znacznika: dalej prośba o kod z powrotem na stronę', async () => {
    markerCookie = undefined;
    await expect(getVerifiedUserContext()).resolves.toMatchObject({ ok: false, reason: 'mfa_required' });
    await expect(requireVerifiedUserForPage('/onboarding')).rejects.toThrow('redirect:/login/two-factor?redirect=%2Fonboarding');
  });

  it('pełne MFA (eksport danych konta): znacznik nie wystarcza', async () => {
    await expect(getVerifiedUserContext({ fullMfa: true })).resolves.toMatchObject({ ok: false, reason: 'mfa_required' });
    aal = 'aal2';
    await expect(getVerifiedUserContext({ fullMfa: true })).resolves.toMatchObject({ ok: true });
  });
});
