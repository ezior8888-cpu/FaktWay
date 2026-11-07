import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

import { isLocalBaseUrl, isLocalDatabase, SESJA_KONTA_DEV } from '../helpers/konto-dev';

/**
 * Testy wizualne: wygląd panelu na Macu jest zamrożony od 03.11.2026
 * (`docs/runbooks/zmiany-na-telefon.md`), a ten plik pilnuje tego automatem.
 * Każdy ekran ma wzorcowy zrzut w `wizualne.spec.ts-snapshots/`; zmiana
 * wyglądu na desktopie (Chromium 1440x900) albo na telefonie (WebKit,
 * iPhone 13) oblewa test i zostawia obraz różnicy w raporcie HTML.
 *
 * Na tych samych ekranach axe zbiera naruszenia `serious` i `critical`.
 * Na razie tylko raport (załącznik testu i `test-results/wizualne-axe/`),
 * bez oblewania.
 *
 * Uruchomienie i odświeżenie wzorców: `e2e/README.md`, „Testy wizualne”.
 * Pulpit i lista faktur: lokalne konto dev (`pnpm db:local`), zalogowane raz
 * na przebieg w `wizualne-logowanie.ts`.
 */

// Data zamrożenia wyglądu. Zegar przeglądarki stoi w miejscu, więc daty
// liczone po stronie klienta są stałe; te z serwera zasłaniają maski.
const FROZEN_TIME = new Date('2026-11-03T10:00:00+01:00');

/**
 * Tolerancja różnic. Wzorce i porównanie powstają na tej samej maszynie i w tej
 * samej przeglądarce, więc render jest powtarzalny co do piksela (07.11.2026:
 * trzy przebiegi pod rząd bez jednego różnego piksela, także przy
 * `threshold` 0). `threshold` 0.05 zamiast domyślnego 0.2, bo 0.2 przepuszcza
 * zmianę odcienia (np. `blue-600` na `blue-700`), a `maxDiffPixels` 50
 * zostawia margines na pojedyncze piksele wygładzania tekstu. To mniej niż
 * zmiana jednej klasy: inny odstęp przesuwa wszystko pod nim (tysiące pikseli),
 * inny kolor przycisku to setki. Ułamek (`maxDiffPixelRatio`) byłby zły dla
 * długiej strony głównej: 0,1% z 390x7400 px (iPhone) to prawie 2900 px,
 * czyli zmiana koloru całego przycisku przeszłaby niezauważona.
 */
const SCREENSHOT = {
  animations: 'disabled',
  caret: 'hide',
  maxDiffPixels: 50,
  threshold: 0.05,
  stylePath: resolve(process.cwd(), 'e2e/wizualne.css'),
} as const;

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

type AxeFinding = { id: string; impact: string; help: string; nodes: number; targets: string[] };

async function prepare(page: Page): Promise<void> {
  await page.clock.setFixedTime(FROZEN_TIME);
  // Baner zgody na analitykę zasłania dół ekranu; klient, który go zamknął,
  // widzi stronę bez niego.
  await page.addInitScript(() => window.localStorage.setItem('ff_analytics_consent', 'denied'));
}

/**
 * Strony przed logowaniem odsłaniają sekcje przy przewijaniu
 * (`components/site/motion.tsx`, krycie 0 do wejścia w ekran). Przewijanie
 * całej strony co kilkaset pikseli bywało za szybkie i część sekcji zostawała
 * pusta, więc przewijamy do każdego ukrytego elementu po kolei, aż nic nie
 * zostanie ukryte, i wracamy na górę.
 */
async function revealAll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    document.documentElement.style.scrollBehavior = 'auto';
    const hidden = () =>
      Array.from(document.querySelectorAll('body *')).filter(
        (el) => getComputedStyle(el).opacity === '0' && el.getBoundingClientRect().height > 0,
      );
    for (let round = 0; round < 5; round += 1) {
      const list = hidden();
      if (list.length === 0) break;
      for (const el of list) {
        el.scrollIntoView({ block: 'center' });
        await new Promise((done) => setTimeout(done, 120));
      }
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1000);
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  // Kursor w rogu: podświetlenie wiersza pod myszą nie trafia na zrzut.
  await page.mouse.move(0, 0);
}

/**
 * Panel liczy kwoty, daty, osie wykresów i liczniki z dzisiejszej daty
 * serwera (zegar przeglądarki tu nie pomaga), a lista pokazuje dane konta dev.
 * Maski zasłaniają każdy tekst z cyfrą i wykresy; ramki, odstępy, nagłówki,
 * menu i przyciski zostają pod kontrolą. Maska ma wymiary elementu, więc
 * zmiana rozmiaru czcionki albo odstępu w zasłoniętym miejscu też wychodzi.
 */
function panelMasks(page: Page): Locator[] {
  const main = page.locator('main');
  return [main.getByText(/\d/), main.locator('[data-chart], [style*="height"]')];
}

/** Raport axe jako załącznik; nie oblewa testu (punkt 4.3 planu usprawnień). */
async function axeReport(page: Page, screen: string, testInfo: TestInfo): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const findings: AxeFinding[] = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? '',
      help: violation.help,
      nodes: violation.nodes.length,
      targets: violation.nodes.slice(0, 5).map((node) => node.target.join(' ')),
    }));
  const dir = resolve('test-results', 'wizualne-axe');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${testInfo.project.name}-${screen}.json`);
  writeFileSync(file, JSON.stringify({ screen, url: page.url(), findings }, null, 2));
  await testInfo.attach(`axe-${screen}`, { path: file, contentType: 'application/json' });
  testInfo.annotations.push({
    type: 'axe',
    description: `${screen}: ${findings.length} reguł serious/critical (${findings.map((f) => f.id).join(', ') || 'brak'})`,
  });
}

async function shoot(
  page: Page,
  screen: string,
  testInfo: TestInfo,
  options: { fullPage?: boolean; mask?: Locator[]; target?: Locator } = {},
): Promise<void> {
  await settle(page);
  const name = `${screen}.png`;
  if (options.target) {
    await expect(options.target).toHaveScreenshot(name, { ...SCREENSHOT, mask: options.mask });
  } else {
    await expect(page).toHaveScreenshot(name, { ...SCREENSHOT, fullPage: options.fullPage, mask: options.mask });
  }
  await axeReport(page, screen, testInfo);
}

// Wzorce powstały na Macu (`-darwin.png`). Na Linuksie (CI „E2E staging”,
// chmura) nie ma czego porównać, a brak wzorca oblałby cały przebieg e2e.
test.skip(process.platform !== 'darwin', 'Wzorce są tylko z macOS (e2e/README.md, „Testy wizualne”).');

test.describe('Wygląd: strony przed logowaniem', () => {
  test.beforeEach(async ({ page }) => prepare(page));

  test('strona główna', async ({ page }, testInfo) => {
    await page.goto('/');
    await revealAll(page);
    await shoot(page, 'strona-glowna', testInfo, { fullPage: true });
  });

  test('sekcja #telefon', async ({ page }, testInfo) => {
    await page.goto('/#telefon');
    await revealAll(page);
    const section = page.locator('#telefon');
    await section.scrollIntoViewIfNeeded();
    await shoot(page, 'sekcja-telefon', testInfo, { target: section });
  });

  test('menu hamburgera', async ({ page, isMobile }, testInfo) => {
    test.skip(!isMobile, 'Menu hamburgera jest tylko na telefonie.');
    await page.goto('/');
    // Klik przed hydratacją Reacta przepada (serwer dev kompiluje stronę), więc ponawiamy.
    await expect(async () => {
      await page.getByRole('button', { name: /menu/ }).first().click();
      await expect(page.locator('#menu-telefon')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await shoot(page, 'menu-hamburgera', testInfo);
  });

  test('/login', async ({ page }, testInfo) => {
    await page.goto('/login');
    await expect(page.locator('#email')).toBeVisible();
    await shoot(page, 'login', testInfo, { fullPage: true });
  });
});

test.describe('Wygląd: panel (konto dev)', () => {
  test.skip(
    ({ baseURL }) => !isLocalBaseUrl(baseURL) || !isLocalDatabase(),
    'Tylko lokalne konto dev (pnpm db:local).',
  );

  test.use({ storageState: SESJA_KONTA_DEV });
  test.beforeEach(async ({ page }) => prepare(page));

  test('pulpit', async ({ page }, testInfo) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Pulpit' })).toBeAttached();
    await shoot(page, 'pulpit', testInfo, { mask: panelMasks(page) });
  });

  test('lista faktur', async ({ page }, testInfo) => {
    await page.goto('/invoices');
    await shoot(page, 'lista-faktur', testInfo, { mask: panelMasks(page) });
  });
});
