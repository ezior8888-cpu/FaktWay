import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  getUser: vi.fn(),
  listFactors: vi.fn(),
  countRecovery: vi.fn(),
  enroll: vi.fn(),
  unenroll: vi.fn(),
  verify: vi.fn(),
  regenerate: vi.fn(),
  password: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.client }));
vi.mock('@/lib/auth/mfa-recovery', () => ({
  countRemainingRecoveryCodes: mocks.countRecovery,
}));
vi.mock('@/app/(dashboard)/settings/security/actions', () => ({
  enrollTotpAction: mocks.enroll,
  unenrollTotpAction: mocks.unenroll,
  verifyTotpEnrollmentAction: mocks.verify,
  regenerateRecoveryCodesAction: mocks.regenerate,
  changePasswordAction: mocks.password,
}));

import SecuritySettingsPage from '@/app/(dashboard)/settings/security/page';
import { TwoFactorCard } from '@/app/(dashboard)/settings/security/_components/two-factor-card';
import { SUPPORT_EMAIL } from '@/lib/site';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network call in UI test'); }));
  mocks.client.mockResolvedValue({ auth: {
    getUser: mocks.getUser, mfa: { listFactors: mocks.listFactors },
  } });
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-fixture' } }, error: null });
  mocks.listFactors.mockResolvedValue({ data: { all: [], totp: [] }, error: null });
  mocks.countRecovery.mockImplementation(() => { throw new Error('Recovery data must not be queried by settings'); });
});
afterEach(() => vi.unstubAllGlobals());

it('explains the risk of losing TOTP before offering enrollment', () => {
  const markup = renderToStaticMarkup(<TwoFactorCard isEnabled={false} />);
  expect(markup).toContain('Utrata dostępu do aplikacji TOTP może zablokować logowanie.');
  expect(markup).toContain('Samodzielne odzyskiwanie dostępu, także kodami ratunkowymi, jest obecnie');
  expect(markup).toContain('niedostępne.');
  expect(markup).toContain(`href="mailto:${SUPPORT_EMAIL}"`);
  expect(markup.indexOf('Utrata dostępu')).toBeLessThan(markup.indexOf('Włącz 2FA'));
  expect(mocks.enroll).not.toHaveBeenCalled();
});

it.each([true, false])('does not offer recovery generation when MFA is enabled=%s', (isEnabled) => {
  const markup = renderToStaticMarkup(<TwoFactorCard isEnabled={isEnabled} />);
  expect(markup).not.toContain('Nowe kody ratunkowe');
  expect(markup).not.toContain('Wygeneruj nowe kody');
  expect(markup).not.toContain('Pozostało');
  expect(markup).not.toContain('Skopiuj do schowka');
  expect(mocks.regenerate).not.toHaveBeenCalled();
});

it('still offers turning off active MFA and provides a support contact', () => {
  const markup = renderToStaticMarkup(<TwoFactorCard isEnabled />);
  expect(markup).toContain('Wyłącz aplikację TOTP');
  expect(markup).toContain(`href="mailto:${SUPPORT_EMAIL}"`);
  expect(markup).toContain('niedostępne.');
});

it.each([true, false])('does not query recovery codes on the settings page with enabled=%s', async (isEnabled) => {
  // Czynniki MFA z odczytu użytkownika (`user.factors`), bez drugiego
  // `getUser()` w `mfa.listFactors()` — sesja 9 planu skalowania.
  mocks.getUser.mockResolvedValue({ data: { user: {
    id: 'user-fixture',
    factors: isEnabled ? [{ id: 'factor-fixture', factor_type: 'totp', status: 'verified' }] : [],
  } }, error: null });
  const markup = renderToStaticMarkup(await SecuritySettingsPage({
    searchParams: Promise.resolve({ notice: 'admin_mfa_required' }),
  }));
  expect(markup).toContain('Panel administratora wymaga weryfikacji dwuetapowej.');
  expect(markup).toContain('potwierdź kod z aplikacji TOTP');
  expect(markup).toContain(isEnabled ? 'Wyłącz aplikację TOTP' : 'Włącz 2FA');
  expect(markup).not.toContain('zapisz kody ratunkowe');
  expect(mocks.countRecovery).not.toHaveBeenCalled();
  expect(mocks.listFactors).not.toHaveBeenCalled();
});
