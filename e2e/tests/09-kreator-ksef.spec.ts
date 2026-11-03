import { createHmac } from 'node:crypto';

import { devices, type Locator, type Page } from '@playwright/test';

import { makeSelfSignedCertificate } from '../../tests/helpers/self-signed-cert';
import { expect, test } from '../fixtures';

/**
 * Kreator podłączenia KSeF przy 390 px, z dotykiem, BEZ KSeF: kroki z serwera,
 * powrót do kroku po odświeżeniu, rozpoznawanie plików po treści (klucz podany
 * pierwszy, pliki z mylącymi rozszerzeniami), hasło tylko dla zaszyfrowanego
 * klucza i błąd hasła wykryty lokalnie (zanim cokolwiek poleci do KSeF), po
 * którym pliki zostają, a fokus ląduje w polu hasła. Prawdziwe logowanie do KSeF
 * sprawdza `scripts/test-ksef-kreator.ts` (KSeF TEST).
 */

// Projekty `mobile-*` ustawiają urządzenie dla strony, ale kontekst z sesją budujemy sami.
const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['iPhone 14'];
const PASSWORD = 'Testowe-Haslo-123!';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Kod TOTP (RFC 6238, SHA-1, 6 cyfr, krok 30 s) z sekretu pokazanego w karcie 2FA. */
function totp(secret: string, at = Date.now()): string {
  const bits = [...secret.replace(/[\s=]/g, '').toUpperCase()]
    .map((char) => BASE32.indexOf(char).toString(2).padStart(5, '0'))
    .join('');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'strona nie może przewijać się poziomo').toBeLessThanOrEqual(0);
}

async function expectTouchTarget(locator: Locator, name: string) {
  const box = await locator.boundingBox();
  expect(box, `${name} musi być widoczny`).not.toBeNull();
  expect(box!.height, `${name}: wysokość celu dotyku`).toBeGreaterThanOrEqual(44);
}

test.describe('Kreator KSeF (390 px, dotyk)', () => {
  test('kroki, powroty, rozpoznawanie plików i błąd hasła bez utraty plików', async ({ browser, seededUser, baseURL }) => {
    const context = await browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL });
    const page = await context.newPage();
    const step = page.getByTestId('ksef-wizard-step');

    // Sesja SSR siedzi w cookies, więc wstrzyknięcie localStorage z `injectSupabaseSession` nie wystarcza: logujemy się formularzem.
    // Baner zgód analitycznych przykrywa dolne przyciski, więc wybieramy „Tylko niezbędne” z góry.
    await context.addInitScript(() => window.localStorage.setItem('ff_analytics_consent', 'denied'));
    await page.goto('/login');
    await page.locator('#email').fill(seededUser.email);
    await page.locator('#password').fill(seededUser.password);
    await page.getByRole('button', { name: 'Zaloguj się', exact: true }).tap();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));

    // Krok 1: warunki. Właściciel i NIP są, brakuje 2FA, które włączamy w kreatorze.
    await page.goto('/settings/ksef');
    await expect(step).toHaveText('Krok 1 z 5');
    await expect(page.getByRole('heading', { name: 'Sprawdzenie warunków' })).toBeVisible();
    await expect(page.getByText('Jesteś właścicielem tej firmy w FaktWay.').first()).toBeVisible();
    await expectNoHorizontalScroll(page);

    await page.getByRole('button', { name: 'Włącz 2FA' }).tap();
    const secret = (await page.locator('code').first().textContent())!.trim();
    await page.getByLabel('Kod z aplikacji').fill(totp(secret));
    await page.getByRole('button', { name: 'Potwierdź' }).tap();
    await page.getByRole('button', { name: /Mam włączone 2FA, sprawdź ponownie/ }).tap();

    // Krok 2: instrukcja i link do właściwego środowiska (dev server ma KSEF_ENV=test).
    await expect(step).toHaveText('Krok 2 z 5');
    await expect(page.getByRole('heading', { name: 'Pobierz certyfikat z KSeF' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Otwórz Aplikację Podatnika' })).toHaveAttribute(
      'href',
      'https://ap-test.ksef.mf.gov.pl/',
    );
    await expect(page.getByTestId('ksef-instrukcja').locator('li')).toHaveCount(6);
    await expect(page.getByText('Uwierzytelnienie w systemie KSeF').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectTouchTarget(page.getByTestId('ksef-dalej'), 'przycisk „Dalej”');
    await page.getByTestId('ksef-dalej').tap();

    // Krok 3: pliki. Odświeżenie zostaje na tym kroku (stan w adresie i na serwerze).
    await expect(step).toHaveText('Krok 3 z 5');
    await expect(page).toHaveURL(/krok=pliki/);
    await page.reload();
    await expect(step).toHaveText('Krok 3 z 5');
    await expectNoHorizontalScroll(page);

    const material = makeSelfSignedCertificate({ kind: 'ec', nip: '1234567890' });
    const encryptedKey = material.privateKey.export({
      type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASSWORD,
    }) as string;
    const input = page.getByTestId('ksef-pliki');
    const submit = page.getByTestId('ksef-sprawdz');

    // Klucz jako pierwszy, z rozszerzeniem certyfikatu: rozpoznanie po treści, hasło dopiero teraz.
    await expect(page.getByLabel('Hasło do klucza')).toHaveCount(0);
    await input.setInputFiles({ name: 'moj-certyfikat.crt', mimeType: 'application/octet-stream', buffer: Buffer.from(encryptedKey) });
    await expect(page.getByTestId('ksef-plik-key')).toContainText('zabezpieczony hasłem');
    await expect(page.getByTestId('ksef-plik-key')).toContainText('moj-certyfikat.crt');
    await expect(page.getByLabel('Hasło do klucza')).toBeVisible();
    await expect(submit).toBeDisabled();

    // Plik, który nie jest ani certyfikatem, ani kluczem: komunikat i brak zmian w polach.
    await input.setInputFiles({ name: 'faktura.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 nie certyfikat') });
    await expect(page.getByText('nie wygląda na certyfikat ani na klucz z KSeF')).toBeVisible();
    await expect(page.getByTestId('ksef-plik-key')).toBeVisible();

    // Certyfikat z rozszerzeniem klucza, w DER (bajty, nie tekst).
    await input.setInputFiles({ name: 'moj-klucz.key', mimeType: 'application/octet-stream', buffer: material.certDer });
    await expect(page.getByTestId('ksef-plik-certificate')).toContainText('moj-klucz.key');
    await expect(submit).toBeDisabled();

    // Złe hasło: błąd z serwera jeszcze przed KSeF, pliki zostają, fokus w polu hasła.
    const password = page.getByLabel('Hasło do klucza');
    await password.fill('zle-haslo-12345!');
    await expect(submit).toBeEnabled();
    await expectTouchTarget(submit, 'przycisk „Sprawdź w KSeF”');
    await expectTouchTarget(password, 'pole hasła');
    await expectTouchTarget(page.getByRole('button', { name: /Usuń plik moj-klucz\.key/ }), 'przycisk usunięcia pliku');
    await submit.tap();

    await expect(page.getByTestId('ksef-blad')).toContainText('To hasło nie pasuje do klucza');
    await expect(step).toHaveText('Krok 3 z 5');
    await expect(page.getByTestId('ksef-plik-key')).toBeVisible();
    await expect(page.getByTestId('ksef-plik-certificate')).toBeVisible();
    await expect(password).toBeFocused();
    await expectNoHorizontalScroll(page);

    await context.close();
  });
});
