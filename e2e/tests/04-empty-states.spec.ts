import { test, expect } from '../fixtures';

test.describe('Empty states (Faza 19)', () => {
  test('/invoices bez faktur pokazuje EmptyState z dwoma CTA', async ({
    authenticatedContext,
  }) => {
    const page = await authenticatedContext.newPage();
    await page.goto('/invoices');
    await expect(page.getByText(/brak faktur wystawionych/i)).toBeVisible();
    await expect(
      page.getByRole('link', { name: /wystaw pierwszą fakturę/i }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: /importuj historię/i }),
    ).toBeVisible();
  });

  test('/inbox bez faktur przychodzących pokazuje empty state', async ({
    authenticatedContext,
  }) => {
    const page = await authenticatedContext.newPage();
    await page.goto('/inbox');
    await expect(page.getByText(/brak faktur przychodzących/i)).toBeVisible();
  });

  // Plan Finora E9 (P6): nowa strona — pusty stan `Empty` z przyciskiem otwierającym arkusz.
  test('/invoices/recurring bez pozycji pokazuje empty state z „+ Nowa faktura cykliczna”', async ({
    authenticatedContext,
  }) => {
    const page = await authenticatedContext.newPage();
    await page.goto('/invoices/recurring');
    await expect(page.getByText('Brak faktur cyklicznych')).toBeVisible();
    await expect(
      page.getByRole('button', { name: '+ Nowa faktura cykliczna' }),
    ).toBeVisible();
  });

  test('/contractors bez kontrahentów pokazuje empty state', async ({
    authenticatedContext,
  }) => {
    const page = await authenticatedContext.newPage();
    await page.goto('/contractors');
    await expect(page.getByText(/brak kontrahentów/i)).toBeVisible();
  });
});
