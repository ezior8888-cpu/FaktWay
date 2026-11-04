import AxeBuilder from '@axe-core/playwright';

import { test, expect } from '../fixtures';

/**
 * Automatyczny audit a11y (Faza 32 Krok 1).
 *
 * Skanuje kluczowe strony regułami WCAG 2.0/2.1 poziom A + AA — łapie
 * regresje dostępności przy każdym CI run.
 *
 * Reguły WCAG 2.x A/AA — pełen zakres jaki axe-core potrafi sprawdzić
 * automatycznie (~30-40% kryteriów WCAG; reszta wymaga testu ręcznego
 * screen readerem — patrz instrukcja w raporcie Fazy 32).
 */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Strony publiczne — bez logowania. */
const PUBLIC_PAGES = [
  '/',
  '/login',
  '/register',
  '/forgot-password',
  '/pricing',
  '/pomoc',
  // Od 23.10.2026 wszystkie strony przed logowaniem w jednym stylu.
  '/blog',
  '/kontakt',
  '/about',
  '/legal/regulamin',
  '/kalkulator-oszczednosci',
];

/** Strony za loginem — wymagają `authenticatedContext`. */
const AUTHENTICATED_PAGES = [
  '/dashboard',
  '/invoices',
  // Plan Finora E9 (P6).
  '/invoices/recurring',
  '/contractors',
  '/settings',
  '/settings/security',
];

/**
 * Strony publiczne mają animacje wejścia i odsłaniania przy przewijaniu
 * (`components/site/motion.tsx`). W trakcie animacji tekst jest
 * półprzezroczysty i axe zgłasza fałszywe braki kontrastu, więc przed
 * skanem przewijamy stronę do końca i czekamy, aż wszystko się odsłoni.
 */
async function settleAnimations(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    document.documentElement.style.scrollBehavior = 'auto';
    for (let y = 0; y < document.body.scrollHeight; y += 300) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1500);
}

test.describe('Accessibility — axe-core WCAG 2.1 AA', () => {
  for (const path of PUBLIC_PAGES) {
    test(`a11y publiczna: ${path}`, async ({ page }) => {
      await page.goto(path);
      await settleAnimations(page);
      const results = await new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
        .analyze();

      // Komunikat z listą naruszeń trafia do raportu testu — łatwiej
      // zdiagnozować niż samo "expected []".
      expect(
        results.violations,
        formatViolations(path, results.violations),
      ).toEqual([]);
    });
  }

  for (const path of AUTHENTICATED_PAGES) {
    test(`a11y zalogowana: ${path}`, async ({ authenticatedContext }) => {
      const page = await authenticatedContext.newPage();
      await page.goto(path);
      const results = await new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
        .analyze();

      expect(
        results.violations,
        formatViolations(path, results.violations),
      ).toEqual([]);
      await page.close();
    });
  }
});

/** Czytelne podsumowanie naruszeń do komunikatu asercji. */
function formatViolations(
  path: string,
  violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations'],
): string {
  if (violations.length === 0) return `${path}: brak naruszeń`;
  const lines = violations.map(
    (v) => `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length}×)`,
  );
  return `${path} — ${violations.length} naruszeń a11y:\n${lines.join('\n')}`;
}
