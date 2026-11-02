import { test, expect } from '@playwright/test';

test.describe('Strona główna i strony marketingowe', () => {
  // Strona główna od 23.10.2026 (app/(home)), od FaktWay 1.0 z jednym zdaniem
  // oferty (lib/marketing/oferta.ts) i bez FLO. Wcześniejsze testy szukały
  // sekcji („Problem/Solution”, kalkulator), których nie było już na stronie Zova.
  test('hero: zdanie oferty i główne CTA', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: /faktury z\s+ksef, koszty i\s+należności/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /wypróbuj za darmo/i }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /od faktury do księgowej/i })).toBeVisible();
  });

  test('stare adresy o FLO prowadzą na stronę główną, pas o telefonie jest na miejscu', async ({ page }) => {
    await page.goto('/pomoc/flo-czym-jest');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: /także w\s+telefonie/i })).toBeVisible();
  });

  // Strony porównawcze wyłączone 15.10.2026 do weryfikacji treści
  // (lib/marketing/comparisons.ts, uzasadnienie w app/(marketing)/vs/layout.tsx).
  // Po włączeniu flagi wróć do sprawdzania, że się renderują.
  test('comparison subpages (vs Inni/inFakt/wFirma/iFirma) są wyłączone (404)', async ({
    page,
  }) => {
    const slugs = ['inni', 'infakt', 'wfirma', 'ifirma'] as const;
    for (const slug of slugs) {
      const response = await page.goto(`/vs/${slug}`);
      expect(response?.status()).toBe(404);
    }
  });

  test('/vs/fakturownia przekierowuje na /vs/inni', async ({ page }) => {
    await page.goto('/vs/fakturownia');
    await expect(page).toHaveURL(/\/vs\/inni/);
  });

  test('legal pages dostępne z footera', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /regulamin/i }).click();
    await page.waitForURL(/\/legal\/regulamin/);
    expect(page.url()).toContain('/legal/regulamin');
  });
});
