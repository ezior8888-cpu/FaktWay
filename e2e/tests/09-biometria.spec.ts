import { createClient } from '@supabase/supabase-js';
import { devices, type BrowserContext, type CDPSession, type Page } from '@playwright/test';

import { totpCode } from '../../tests/helpers/totp';
import { test, expect } from '../fixtures';

/**
 * Logowanie biometrią i „zapamiętaj mnie” na prawdziwej bazie i GoTrue,
 * z wirtualnym uwierzytelniaczem Chromium (CDP WebAuthn). Inne przeglądarki
 * tego domeny nie mają.
 *
 * Uruchomienie lokalne (serwer już działa na porcie 3106):
 *   E2E_SKIP_WEBSERVER=1 E2E_BASE_URL=http://localhost:3106 \
 *     pnpm exec playwright test e2e/tests/09-biometria.spec.ts --project=chromium
 */

test.skip(({ browserName }) => browserName !== 'chromium', 'Wirtualny uwierzytelniacz CDP działa tylko w Chromium.');

/** Limiter kodów TOTP odmawia bez Redisa (fail-closed, `lib/rate-limit/mfa.ts`). */
const skipWithoutMfaLimiter = () => test.skip(!process.env.UPSTASH_REDIS_REST_URL, 'Kod TOTP wymaga Redisa (limit prób).');

const BIOMETRIC_BUTTON = { name: 'Zaloguj biometrią', exact: true };
const STEP_UP_LINK = { name: 'Potwierdź kodem z aplikacji' };
/** Panel lub onboarding: wszystko poza prośbą o kod. */
const PANEL_URL = /\/(dashboard|onboarding)/;

interface VirtualAuthenticator {
  cdp: CDPSession;
  authenticatorId: string;
}

/**
 * Baner zgody na analitykę zasłania dół ekranu, a tu nie jest przedmiotem testu.
 * Osobny adres na kontekst: bez niego wszystkie przebiegi dzielą limit prób przypisany do „unknown”.
 *
 * Wirtualny uwierzytelniacz sam zatwierdza podpowiedź w polu e-mail (autofill), więc
 * poza testem tej podpowiedzi ją wyłączamy: inaczej przycisk ściga się z logowaniem w tle.
 */
async function prepareContext(context: BrowserContext, options: { autofill?: boolean } = {}) {
  await context.setExtraHTTPHeaders({ 'x-real-ip': `198.51.100.${Math.floor(Math.random() * 250) + 1}` });
  await context.addInitScript(() => window.localStorage.setItem('ff_analytics_consent', 'denied'));
  if (options.autofill) return;
  await context.addInitScript(() => {
    if (window.PublicKeyCredential) window.PublicKeyCredential.isConditionalMediationAvailable = async () => false;
  });
}

test.beforeEach(async ({ context }) => {
  await prepareContext(context);
});

async function addVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

async function storedCredentials({ cdp, authenticatorId }: VirtualAuthenticator) {
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  return credentials;
}

/** TOTP założony przez GoTrue, jak po przejściu `/settings/security`. Zwraca sekret. */
async function enableTotp(email: string, password: string): Promise<string> {
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  const enroll = await client.auth.mfa.enroll({ factorType: 'totp' });
  if (enroll.error || !enroll.data) throw enroll.error ?? new Error('E2E: enroll');
  const verified = await client.auth.mfa.challengeAndVerify({
    factorId: enroll.data.id,
    code: totpCode(enroll.data.totp.secret),
  });
  if (verified.error) throw verified.error;
  return enroll.data.totp.secret;
}

async function submitPassword(page: Page, email: string, password: string, options: { remember?: boolean } = {}) {
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  if (options.remember !== undefined) {
    const remember = page.getByRole('checkbox', { name: 'Zapamiętaj mnie' });
    if ((await remember.isChecked()) !== options.remember) await remember.click();
  }
  await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click();
}

async function enterCode(page: Page, secret: string) {
  await page.locator('#code').fill(totpCode(secret));
  await page.getByRole('button', { name: 'Zweryfikuj', exact: true }).click();
}

/** Kliknięcie przed hydratacją nie otwiera menu, więc ponawiamy, aż pozycja się pokaże. */
async function openAccountMenu(page: Page) {
  await expect(async () => {
    await page.getByRole('button', { name: 'Menu konta' }).click();
    await expect(page.getByRole('menuitem', { name: 'Wyloguj' })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

async function signOutViaMenu(page: Page) {
  await page.goto('/dashboard');
  await openAccountMenu(page);
  await page.getByRole('menuitem', { name: 'Wyloguj' }).click();
  await page.waitForURL(/\/login/);
}

async function addDevice(page: Page) {
  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Dodaj urządzenie', exact: true }).click();
}

function passkeyCookies(context: BrowserContext) {
  return context.cookies().then((all) => ({
    marker: all.find((cookie) => cookie.name === 'ksef.passkey_session'),
    remember: all.find((cookie) => cookie.name === 'ksef.remember_me'),
    session: all.filter((cookie) => /^sb-.*-auth-token/.test(cookie.name)),
  }));
}

test.describe('Logowanie biometrią', () => {
  test('konto z TOTP: dodanie, wylogowanie, logowanie bez kodu, operacja wrażliwa z kodem', async ({ page, context, seededUser }) => {
    skipWithoutMfaLimiter();
    const secret = await enableTotp(seededUser.email, seededUser.password);
    const authenticator = await addVirtualAuthenticator(page);

    // Hasło + kod: tylko pełne AAL2 dodaje urządzenie.
    await submitPassword(page, seededUser.email, seededUser.password);
    await page.waitForURL(/\/login\/two-factor/);
    await enterCode(page, secret);
    await page.waitForURL(PANEL_URL);

    await addDevice(page);
    await expect(page.getByTestId('passkey-device')).toHaveCount(1);
    await expect(page.getByTestId('passkey-device')).toContainText(/Jeszcze nieużywane/);
    const credentials = await storedCredentials(authenticator);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]!.isResidentCredential).toBe(true);

    await signOutViaMenu(page);
    const afterSignOut = await passkeyCookies(context);
    expect(afterSignOut.marker).toBeUndefined();
    expect(afterSignOut.remember).toBeUndefined();
    expect(afterSignOut.session).toEqual([]);

    // Biometria: bez prośby o kod.
    const twoFactorVisits: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && frame.url().includes('/login/two-factor')) twoFactorVisits.push(frame.url());
    });
    await page.goto('/login');
    await expect(page.locator('#email')).toHaveAttribute('autocomplete', 'username webauthn');
    await page.getByRole('button', BIOMETRIC_BUTTON).click();
    await page.waitForURL(PANEL_URL);
    expect(twoFactorVisits).toEqual([]);

    const cookies = await passkeyCookies(context);
    expect(cookies.marker).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(cookies.remember).toMatchObject({ httpOnly: true, sameSite: 'Lax' });

    // Panel działa bez kodu: strona z danymi i API.
    await page.goto('/invoices');
    await expect(page).toHaveURL(/\/invoices/);
    const api = await page.request.get('/api/auth/passkey');
    expect(api.status()).toBe(200);
    expect(await api.json()).toMatchObject({ canManage: false });
    const lastUsed = await page.request.get('/api/auth/passkey');
    expect((await lastUsed.json()).devices[0].lastUsedAt).toEqual(expect.any(String));

    // Sesja w panelu trwa, ale /admin ignoruje znacznik.
    await page.goto('/admin');
    await page.waitForURL(/\/login\/two-factor\?redirect=%2Fadmin/);

    // Dodanie urządzenia prosi o kod: komunikat i przejście, nie martwy błąd.
    await page.goto('/settings/security');
    await page.getByRole('button', { name: 'Dodaj urządzenie', exact: true }).click();
    await expect(page.getByRole('link', STEP_UP_LINK).first()).toBeVisible();
    const addApi = await page.request.post('/api/auth/passkey/register/options', { data: {} });
    expect(addApi.status()).toBe(403);
    expect(await addApi.json()).toEqual({ error: 'mfa_required' });

    // Prawdziwy kod otwiera operacje wrażliwe i wraca na tę samą stronę.
    await page.getByRole('link', STEP_UP_LINK).first().click();
    await page.waitForURL(/\/login\/two-factor\?.*redirect=%2Fsettings%2Fsecurity/);
    await enterCode(page, secret);
    await page.waitForURL(/\/settings\/security/);
    await expect(page.getByRole('link', STEP_UP_LINK)).toHaveCount(0);
    const stepped = await page.request.get('/api/auth/passkey');
    expect(await stepped.json()).toMatchObject({ canManage: true });
  });

  test('podrobiony znacznik: kolejne wejście kończy się prośbą o kod', async ({ page, context, seededUser }) => {
    skipWithoutMfaLimiter();
    const secret = await enableTotp(seededUser.email, seededUser.password);
    await addVirtualAuthenticator(page);
    await submitPassword(page, seededUser.email, seededUser.password);
    await page.waitForURL(/\/login\/two-factor/);
    await enterCode(page, secret);
    await page.waitForURL(PANEL_URL);
    await addDevice(page);
    await expect(page.getByTestId('passkey-device')).toHaveCount(1);
    await signOutViaMenu(page);

    await page.goto('/login');
    await page.getByRole('button', BIOMETRIC_BUTTON).click();
    await page.waitForURL(PANEL_URL);

    const { marker } = await passkeyCookies(context);
    // Pierwszy znak podpisu: końcówka base64url ma bity bez znaczenia i mogłaby wyjść na to samo.
    const [version, expiry, mac] = marker!.value.split('.');
    const forgedMac = (mac!.startsWith('A') ? 'B' : 'A') + mac!.slice(1);
    await context.addCookies([{ ...marker!, value: [version, expiry, forgedMac].join('.') }]);
    const refused = await page.request.get('/api/auth/passkey');
    expect(refused.status()).toBe(403);
    expect(await refused.json()).toEqual({ error: 'mfa_required' });
    await page.goto('/invoices');
    await page.waitForURL(/\/login\/two-factor\?.*redirect=%2Finvoices/);
  });

  test('konto bez 2FA: dodanie bez kodu; usunięcie wylogowuje pozostałe urządzenia', async ({ browser, page, baseURL, seededUser }) => {
    const authenticator = await addVirtualAuthenticator(page);
    await submitPassword(page, seededUser.email, seededUser.password);
    await page.waitForURL(PANEL_URL);
    await addDevice(page);
    await expect(page.getByTestId('passkey-device')).toHaveCount(1);
    expect(await storedCredentials(authenticator)).toHaveLength(1);

    // Drugie urządzenie: osobna przeglądarka zalogowana hasłem.
    const otherContext = await browser.newContext({ baseURL });
    await prepareContext(otherContext);
    const otherPage = await otherContext.newPage();
    await submitPassword(otherPage, seededUser.email, seededUser.password);
    await otherPage.waitForURL(PANEL_URL);

    // Ten sam uwierzytelniacz drugi raz: po polsku, że urządzenie już jest dodane.
    await page.getByRole('button', { name: 'Dodaj urządzenie', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: /już dodane/ })).toBeVisible();

    await page.getByRole('button', { name: /^Usuń/ }).click();
    await page.getByRole('button', { name: 'Tak, usuń', exact: true }).click();
    await expect(page.getByTestId('passkey-device')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: /wylogowaliśmy pozostałe urządzenia/i })).toBeVisible();

    await otherPage.goto('/invoices');
    await otherPage.waitForURL(/\/login/);
    await otherContext.close();

    // Ta przeglądarka zostaje zalogowana, a usunięte poświadczenie już nie loguje.
    await page.goto('/invoices');
    await expect(page).toHaveURL(/\/invoices/);
    await signOutViaMenu(page);
    await page.goto('/login');
    await page.getByRole('button', BIOMETRIC_BUTTON).click();
    await expect(page.getByRole('alert').filter({ hasText: /Nie udało się zalogować biometrią/ })).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('anulowanie okna systemowego: komunikat po polsku, można spróbować hasłem', async ({ page, seededUser }) => {
    const authenticator = await addVirtualAuthenticator(page);
    await submitPassword(page, seededUser.email, seededUser.password);
    await page.waitForURL(PANEL_URL);
    await addDevice(page);
    await expect(page.getByTestId('passkey-device')).toHaveCount(1);
    await signOutViaMenu(page);

    await authenticator.cdp.send('WebAuthn.setUserVerified', {
      authenticatorId: authenticator.authenticatorId,
      isUserVerified: false,
    });
    await page.goto('/login');
    await page.getByRole('button', BIOMETRIC_BUTTON).click();
    await expect(page.getByRole('alert').filter({ hasText: /anulowane|nie potwierdzono|Spróbuj ponownie/i })).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('#password')).toBeVisible();
  });

  test('podpowiedź w polu e-mail: wybranie passkey loguje bez przycisku i bez hasła', async ({ browser, baseURL, seededUser }) => {
    const context = await browser.newContext({ baseURL });
    await prepareContext(context, { autofill: true });
    const page = await context.newPage();
    await addVirtualAuthenticator(page);
    await submitPassword(page, seededUser.email, seededUser.password);
    await page.waitForURL(PANEL_URL);
    await addDevice(page);
    await expect(page.getByTestId('passkey-device')).toHaveCount(1);
    await signOutViaMenu(page);

    // Tu uwierzytelniacz zatwierdza sam; w przeglądarce klient wybiera passkey z listy pod polem.
    await page.goto('/login?redirect=%2Finvoices');
    await page.waitForURL(/\/invoices/);
    expect((await passkeyCookies(context)).remember).toMatchObject({ httpOnly: true });
    await context.close();
  });

  test('przeglądarka bez WebAuthn nie widzi przycisku', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    await context.addInitScript(() => {
      Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true });
    });
    const page = await context.newPage();
    await page.goto('/login');
    await expect(page.locator('#email')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByRole('button', BIOMETRIC_BUTTON)).toHaveCount(0);
    await context.close();
  });
});

test.describe('Propozycja na telefonie', () => {
  test('po logowaniu hasłem raz proponuje biometrię, odrzucenie zapamiętane na urządzeniu', async ({ browser, baseURL, seededUser }) => {
    const context = await browser.newContext({ ...devices['Pixel 7'], baseURL });
    await prepareContext(context);
    const page = await context.newPage();
    await addVirtualAuthenticator(page);

    await submitPassword(page, seededUser.email, seededUser.password);
    await page.waitForURL(PANEL_URL);
    const offer = page.getByRole('region', { name: 'Włącz logowanie biometrią' });
    await expect(offer).toBeVisible();

    // Odrzucone: nie wraca ani po odświeżeniu, ani po kolejnym logowaniu na tym urządzeniu.
    await offer.getByRole('button', { name: 'Nie teraz', exact: true }).click();
    await expect(offer).toHaveCount(0);
    await page.reload();
    await expect(page.locator('body')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Włącz logowanie biometrią' })).toHaveCount(0);

    await context.clearCookies();
    await submitPassword(page, seededUser.email, seededUser.password);
    await page.waitForURL(PANEL_URL);
    await page.waitForTimeout(1500);
    await expect(page.getByRole('region', { name: 'Włącz logowanie biometrią' })).toHaveCount(0);
    await context.close();
  });

  test('przyjęcie dodaje urządzenie; pole „Zapamiętaj mnie” domyślnie włączone, cele dotyku co najmniej 44 px', async ({ browser, baseURL, seededUser }) => {
    const context = await browser.newContext({ ...devices['Pixel 7'], baseURL });
    // Telefon bez zapamiętanego klucza pokazuje przycisk tylko z podpowiedzią w polu e-mail
    // (`components/auth/passkey-login.tsx`), więc tu jej nie wyłączamy.
    await prepareContext(context, { autofill: true });
    const page = await context.newPage();
    const authenticator = await addVirtualAuthenticator(page);

    await page.goto('/login');
    await expect(page.getByRole('checkbox', { name: 'Zapamiętaj mnie' })).toBeChecked();
    for (const locator of [
      page.getByRole('button', BIOMETRIC_BUTTON),
      page.getByTestId('remember-me-field'),
    ]) {
      const box = await locator.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    await submitPassword(page, seededUser.email, seededUser.password);
    await page.waitForURL(PANEL_URL);
    const offer = page.getByRole('region', { name: 'Włącz logowanie biometrią' });
    await offer.getByRole('button', { name: 'Włącz', exact: true }).click();
    await expect(offer.getByRole('status')).toContainText(/Gotowe/);
    expect(await storedCredentials(authenticator)).toHaveLength(1);
    expect((await passkeyCookies(context)).remember).toMatchObject({ httpOnly: true });
    await context.close();
  });

  test('na komputerze propozycji nie ma, a „Zapamiętaj mnie” jest wyłączone', async ({ page, seededUser }) => {
    await addVirtualAuthenticator(page);
    await page.goto('/login');
    await expect(page.getByRole('checkbox', { name: 'Zapamiętaj mnie' })).not.toBeChecked();
    await submitPassword(page, seededUser.email, seededUser.password);
    await page.waitForURL(PANEL_URL);
    await page.waitForTimeout(1500);
    await expect(page.getByRole('region', { name: 'Włącz logowanie biometrią' })).toHaveCount(0);
  });
});

test.describe('Zapamiętaj mnie i bezczynność', () => {
  const IDLE_DIALOG = { name: 'Sesja wygasa' };

  test('bez zapamiętania po 60 min bezczynności pyta o wylogowanie', async ({ page, seededUser }) => {
    await page.clock.install();
    await submitPassword(page, seededUser.email, seededUser.password, { remember: false });
    await page.waitForURL(PANEL_URL);
    await page.goto('/invoices');
    // Zegar przesuwamy dopiero po hydratacji: wcześniej `IdleWatcher` nie ma jeszcze timerów.
    await openAccountMenu(page);
    await page.keyboard.press('Escape');
    await page.clock.fastForward('59:30');
    await expect(page.getByRole('dialog', IDLE_DIALOG)).toBeVisible();
  });

  test('zapamiętane logowanie hasłem: bez wylogowania po bezczynności; wylogowanie czyści', async ({ page, context, seededUser }) => {
    await page.clock.install();
    await submitPassword(page, seededUser.email, seededUser.password, { remember: true });
    await page.waitForURL(PANEL_URL);
    const { remember } = await passkeyCookies(context);
    expect(remember).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
    const days = ((remember!.expires * 1000) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(90);

    await page.goto('/invoices');
    await openAccountMenu(page);
    await page.keyboard.press('Escape');
    await page.clock.fastForward('01:01:00');
    await page.clock.fastForward('01:00');
    await expect(page.getByRole('dialog', IDLE_DIALOG)).toHaveCount(0);
    await expect(page).toHaveURL(/\/invoices/);

    await signOutViaMenu(page);
    expect((await passkeyCookies(context)).remember).toBeUndefined();
  });
});
