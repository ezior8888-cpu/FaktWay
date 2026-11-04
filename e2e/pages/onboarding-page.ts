import type { Locator, Page } from '@playwright/test';

/**
 * Page Object Model dla `/onboarding`. Trzy zakładki:
 *  - Załóż firmę: NIP → GUS lookup → "Załóż organizację"
 *  - Mam zaproszenie: wklej token → akceptuję
 *  - Poproś o dostęp: NIP → wybierz org → wyślij
 *
 * Selektory bazują na `id` (Input ma `id={fieldName}`), żeby nie zależeć
 * od polskich labelek.
 */
export class OnboardingPage {
  readonly heading: Locator;
  readonly createTab: Locator;
  readonly inviteTab: Locator;
  readonly joinTab: Locator;
  readonly nipInput: Locator;
  readonly inviteTokenInput: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: /witaj w faktway|dodaj kolejn/i });
    this.createTab = page.getByRole('tab', { name: /załóż firmę/i });
    this.inviteTab = page.getByRole('tab', { name: /mam zaproszenie/i });
    this.joinTab = page.getByRole('tab', { name: /poproś o dostęp/i });
    this.nipInput = page.locator('#nip');
    this.inviteTokenInput = page.locator('#invite-token');
  }

  async goto(): Promise<void> {
    await this.page.goto('/onboarding');
    await this.heading.waitFor({ state: 'visible' });
  }

  async typeNipAndLookup(nip: string): Promise<void> {
    await this.createTab.click();
    await this.nipInput.fill(nip);
    // Search button: ikonka lupy w prawym górnym rogu inputa NIP.
    await this.page.locator('#nip').locator('..').getByRole('button').click();
  }

  async confirmOrganization(): Promise<void> {
    await this.page.getByRole('button', { name: /załóż organizację|mimo to/i }).click();
  }
}
