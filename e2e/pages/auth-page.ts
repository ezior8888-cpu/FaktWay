import type { Locator, Page } from '@playwright/test';

/**
 * Page Object Model dla `/login`, `/register`, `/forgot-password`.
 * Selektory bazują na `id` (Input ma `id={fieldName}` w shadcn), żeby
 * nie zależeć od polskich labelek (które się zmieniają w copy-roundach).
 */
export class AuthPage {
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly errorBanner: Locator;
  readonly successBanner: Locator;

  constructor(private readonly page: Page) {
    this.emailInput = page.locator('#email');
    this.passwordInput = page.locator('#password');
    this.submitButton = page.locator('button[type="submit"]');
    // Komunikaty to `Alert` Finory (`AuthMessage`): błąd `role=alert`,
    // potwierdzenie `role=status` (plan Finora P15, E10b).
    this.errorBanner = page.locator('[data-slot="alert"][data-tone="error"], [role="alert"]').first();
    this.successBanner = page.locator('[data-slot="alert"][data-tone="success"]').first();
  }

  async gotoLogin(): Promise<void> {
    await this.page.goto('/login');
  }

  async gotoRegister(): Promise<void> {
    await this.page.goto('/register');
  }

  async gotoForgotPassword(): Promise<void> {
    await this.page.goto('/forgot-password');
  }

  async submitLogin(email: string, password: string): Promise<void> {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.page.getByRole('button', { name: 'Zaloguj się', exact: true }).click();
  }

  async submitRegister(email: string, password: string): Promise<void> {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    // Dokładna nazwa: przy włączonym Google obok stoi „Zarejestruj przez
    // Google”, które dawny wzorzec `/(zarejestruj|utwórz konto)/i` też łapał.
    await this.page.getByRole('button', { name: 'Utwórz konto', exact: true }).click();
  }
}
