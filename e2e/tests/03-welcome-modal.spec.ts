import { test, expect } from '../fixtures';

test.describe('Welcome modal (Faza 19)', () => {
  test('modal pokazuje się przy ?welcome=1 i ma 3 ścieżki', async ({
    authenticatedContext,
  }) => {
    const page = await authenticatedContext.newPage();
    await page.goto('/dashboard?welcome=1');

    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/witaj w faktway/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /wystaw pierwszą fakturę/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /sfotografuj paragon/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /importuj historię/i })).toBeVisible();
  });

  test('"Wystaw fakturę" przekierowuje do /invoices/new', async ({
    authenticatedContext,
  }) => {
    const page = await authenticatedContext.newPage();
    await page.goto('/dashboard?welcome=1');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: /wystaw pierwszą fakturę/i }).click();
    await page.waitForURL(/\/invoices\/new/);
    expect(page.url()).toContain('/invoices/new');
  });

  test('"Pominę" zamyka modal i czyści ?welcome z URL', async ({
    authenticatedContext,
  }) => {
    const page = await authenticatedContext.newPage();
    await page.goto('/dashboard?welcome=1');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: /pomin.*dashboard/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5_000 });
    await page.waitForURL((url) => !url.search.includes('welcome'));
    expect(page.url()).not.toContain('welcome=1');
  });

  test('brak ?welcome → modal niewidoczny', async ({ authenticatedContext }) => {
    const page = await authenticatedContext.newPage();
    await page.goto('/dashboard');
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });
});
