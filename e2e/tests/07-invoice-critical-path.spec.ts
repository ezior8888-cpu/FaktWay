import { test, expect } from '../fixtures';
import { uniqueInvoiceNumber } from '../helpers/test-data';

/**
 * Krytyczna ścieżka biznesowa (audyt przedlaunchowy, blok A):
 * formularz faktury → zapis szkicu → widok szczegółu → PDF → lista.
 *
 * Świadomie B2C „bez identyfikatora": nie dotyka GUS/VIES (zero mocków
 * sieciowych) ani PESEL. Wysyłki do KSeF tu NIE testujemy — seedowany tenant
 * nie ma certyfikatu, a sam pipeline submit jest pokryty testami vitest
 * (`tests/ksef-mock.test.ts`, `tests/mf-outage-simulation.test.ts`).
 */
test.describe('Faktura — krytyczna ścieżka (szkic → PDF)', () => {
  test('wystaw szkic B2C, pobierz PDF, sprawdź listę', async ({
    authenticatedContext,
  }) => {
    const page = await authenticatedContext.newPage();
    const invoiceNumber = uniqueInvoiceNumber();

    // ── Formularz faktury zwykłej ──
    await page.goto('/invoices/new/regular');
    await expect(page.locator('#internalNumber')).toBeVisible();

    await page.locator('#internalNumber').fill(invoiceNumber);

    // Nabywca B2C bez identyfikatora (checkbox → select typu).
    await page.locator('#buyer-is-consumer').click();
    await page.getByRole('combobox').filter({ hasText: 'PESEL' }).click();
    await page
      .getByRole('option', { name: 'Bez identyfikatora (konsument)' })
      .click();

    await page.locator('input[name="buyerName"]').fill('Jan Testowy E2E');
    await page.locator('input[name="buyerAddressLine1"]').fill('ul. Testowa 1');
    await page
      .locator('input[name="buyerAddressLine2"]')
      .fill('00-001 Warszawa');

    // Pozycja: nazwa + cena (ilość 1 i jednostka „szt" są w defaultach).
    await page.locator('input[name="lines.0.name"]').fill('Usługa testowa E2E');
    await page.locator('input[name="lines.0.unitPriceNet"]').fill('100');

    // ── Zapis szkicu → redirect na szczegół ──
    await page.getByRole('button', { name: 'Zapisz szkic' }).click();
    await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);

    const invoiceId = page.url().split('/').pop()!;
    // Podgląd w układzie Finory (E3b): numer w tytule dokumentu, plakietka KSeF „Szkic”
    // w karcie „Status” (dokładny tekst — „Usuń szkic” też zawiera to słowo).
    await expect(page.getByRole('heading', { level: 1 })).toContainText(invoiceNumber);
    await expect(page.getByTestId('karta-statusu').getByText('Szkic', { exact: true })).toBeVisible();

    // ── PDF przez uwierzytelniony route (cookies z kontekstu strony) ──
    const pdfResponse = await page.request.get(
      `/api/invoices/${invoiceId}/pdf`,
    );
    expect(pdfResponse.status()).toBe(200);
    expect(pdfResponse.headers()['content-type']).toContain('application/pdf');
    const body = await pdfResponse.body();
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');

    // ── Lista faktur zawiera świeży szkic ──
    // Numer jest w tabeli (od `lg`) i w karcie wiersza (telefon) — sprawdzamy ten widoczny.
    await page.goto('/invoices');
    await expect(page.getByText(invoiceNumber, { exact: true }).filter({ visible: true }).first()).toBeVisible();
  });

  test('walidacja zatrzymuje pusty formularz (brak nazwy pozycji)', async ({
    authenticatedContext,
  }) => {
    const page = await authenticatedContext.newPage();
    await page.goto('/invoices/new/regular');
    await expect(page.locator('#internalNumber')).toBeVisible();

    await page.locator('#internalNumber').fill(uniqueInvoiceNumber());
    // Celowo bez nabywcy i pozycji — zapis musi zostać zablokowany,
    // a URL nie może się zmienić (nie powstaje szkic-śmieć w DB).
    await page.getByRole('button', { name: 'Zapisz szkic' }).click();

    await expect(page).toHaveURL(/\/invoices\/new\/regular/);
  });
});
