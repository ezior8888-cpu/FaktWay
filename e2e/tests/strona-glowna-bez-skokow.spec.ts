import { expect, test } from '@playwright/test';

/**
 * Strona główna nie przesuwa treści sama z siebie (przegląd przed wdrożeniem
 * 05.11.2026, PD-13). Podgląd panelu pod nagłówkiem odtwarza pętlę co 8,5 s.
 * Gdy nowa faktura rozwijała wiersz tabeli, sekcja pod spodem skakała o 56 px
 * na telefonie i o 40 px na komputerze, a CLS na produkcji dochodził do 0,16.
 *
 * Test trzyma podgląd na ekranie przez pełną pętlę i sumuje przesunięcia
 * układu z Layout Instability API, które jest tylko w Chromium. Strona bez
 * logowania, więc wystarczy `--no-deps`:
 *
 *   pnpm exec playwright test e2e/tests/strona-glowna-bez-skokow.spec.ts --project=chromium --no-deps
 */

const CASES = [
  { name: 'telefon', viewport: { width: 390, height: 844 }, scrollY: 700 },
  { name: 'komputer', viewport: { width: 1440, height: 900 }, scrollY: 420 },
] as const;

// Pętla podglądu trwa 8,5 s; patrzymy dłużej, żeby złapać wejście i reset.
const WATCH_MS = 10_000;

test.skip(({ browserName }) => browserName !== 'chromium', 'Layout Instability API jest tylko w Chromium');

for (const { name, viewport, scrollY } of CASES) {
  test(`${name}: podgląd panelu nie przesuwa treści pod sobą`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => window.localStorage.setItem('ff_analytics_consent', 'denied'));
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), scrollY);
    await page.waitForTimeout(1_500);

    const { shift, sawConfirmation } = await page.evaluate(
      (watchMs) =>
        new Promise<{ shift: number; sawConfirmation: boolean }>((resolve) => {
          let sum = 0;
          let sawConfirmation = false;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) {
              if (!entry.hadRecentInput) sum += entry.value;
            }
          }).observe({ type: 'layout-shift' });
          // Kontrola, że pętla naprawdę działała: dymek z UPO pojawia się w każdej pętli.
          const poll = setInterval(() => {
            if (document.body.textContent?.includes('UPO pobrane')) sawConfirmation = true;
          }, 200);
          setTimeout(() => {
            clearInterval(poll);
            resolve({ shift: sum, sawConfirmation });
          }, watchMs);
        }),
      WATCH_MS,
    );

    expect(sawConfirmation).toBe(true);
    expect(shift).toBeLessThan(0.01);
  });
}
