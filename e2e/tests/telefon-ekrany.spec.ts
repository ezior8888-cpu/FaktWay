import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';

import {
  dashboardNavItems,
  dashboardSettingsNavItem,
} from '../../lib/dashboard-nav-config';
import { loginViaUI } from '../helpers/auth';
import { devCredentials } from '../helpers/konto-dev';

/**
 * Telefon: obchód po wszystkich ekranach panelu (FaktWay 1.0, pkt 2).
 *
 * Loguje lokalne konto dev (`pnpm db:local`), wchodzi na każdą trasę panelu
 * i sprawdza trzy rzeczy: brak poziomego przewijania strony, brak przycisków
 * uciętych albo wypchniętych poza ekran, brak błędów strony. Elementy
 * interaktywne mniejsze niż 44x44 NIE oblewają testu: lądują w raporcie
 * `test-results/telefon-raport.json` (większość to standardowe przyciski
 * 36 px, o których decyduje projekt, a nie usterka).
 *
 * Dane logowania: `helpers/konto-dev.ts`. Test działa wyłącznie na lokalnym
 * serwerze.
 */

const MIN_TARGET = 44;

// `TELEFON_SZEROKOSC=360` powtarza obchód na węższym ekranie (mały Android).
const NARROW = Number(process.env.TELEFON_SZEROKOSC ?? 0);
if (NARROW > 0) test.use({ viewport: { width: NARROW, height: 740 } });

const NAV_ROUTES = [
  ...dashboardNavItems.map((item) => item.href),
  dashboardSettingsNavItem.href,
];

// Trasy, których nie ma w menu: zakładki, warianty „nowej faktury”, ustawienia.
const EXTRA_ROUTES = [
  '/analizy/koszty',
  '/invoices/recurring',
  '/payments/overdue',
  '/inbox',
  '/reports',
  '/reports/exports',
  '/invoices/new/regular',
  '/invoices/new/advance',
  '/invoices/new/correction',
  '/invoices/new/final',
  '/flo',
  '/flo/wrapped',
  '/settings/account',
  '/settings/accountant',
  '/settings/audit',
  '/settings/billing',
  '/settings/flo',
  '/settings/ksef',
  '/settings/notifications',
  '/settings/reminders',
  '/settings/security',
  '/settings/team',
];

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

type SmallTarget = { name: string; w: number; h: number };
type AuditResult = {
  vw: number;
  scrollW: number;
  overflow: string[];
  clipped: string[];
  small: SmallTarget[];
  heading: string;
};
type RouteReport = {
  route: string;
  finalPath: string;
  status: number | null;
  vw: number;
  scrollW: number;
  overflow: string[];
  clipped: string[];
  small: SmallTarget[];
  pageErrors: string[];
  problem: string[];
};

/** Lokalne konto dev ma 40 szkiców faktur, ale ani jednego kosztu i kontrahenta. */
async function seedDevData(email: string): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: users } = await db.auth.admin.listUsers({ perPage: 200 });
  const user = users?.users.find((candidate) => candidate.email === email);
  if (!user) return;
  const { data: membership } = await db
    .from('memberships')
    .select('organization_id')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();
  const tenantId = membership?.organization_id as string | undefined;
  if (!tenantId) return;

  const expenses = await db.from('expenses').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
  if (!expenses.count) {
    await db.from('expenses').insert({
      tenant_id: tenantId,
      source: 'manual',
      seller_name: 'Dostawca testowy',
      document_number: 'FV/TEL/1',
      issue_date: new Date().toISOString().slice(0, 10),
      net_amount: 100,
      vat_amount: 23,
      gross_amount: 123,
    });
  }
  const contractors = await db.from('contractors').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
  if (!contractors.count) {
    await db.from('contractors').insert({ tenant_id: tenantId, nip: '9876543210', name: 'Kontrahent testowy' });
  }
}

/**
 * Wykonuje się w przeglądarce, dlatego jest samowystarczalna (żadnych
 * odwołań do zmiennych z zewnątrz).
 */
function auditInPage(minTarget: number): AuditResult {
  const vw = window.innerWidth;
  const root = document.documentElement;
  const INTERACTIVE =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, ' +
    '[role="button"], [role="tab"], [role="menuitem"], [role="link"], [role="switch"], [role="checkbox"], [role="combobox"]';

  const isShown = (el: Element): boolean => {
    if (el.closest('[aria-hidden="true"], [inert]')) return false;
    const html = el as HTMLElement;
    if (typeof html.checkVisibility === 'function') return html.checkVisibility({ checkVisibilityCSS: true });
    return html.getClientRects().length > 0;
  };
  const nameOf = (el: Element): string =>
    (
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      (el as HTMLElement).innerText ||
      el.getAttribute('placeholder') ||
      el.getAttribute('name') ||
      ''
    )
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 40);
  const describe = (el: Element): string => {
    const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''} "${nameOf(el)}"`;
  };
  // `scroller`: element siedzi w poziomo przewijanym kontenerem, więc da się
  // do niego dojechać. `clipped`: ucina go `overflow: hidden`. `free`: nic go nie pilnuje.
  const placement = (el: Element, r: DOMRect): 'scroller' | 'clipped' | 'free' => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return 'scroller';
      if (ox === 'hidden' || ox === 'clip') {
        const pr = p.getBoundingClientRect();
        if (r.left < pr.left - 1 || r.right > pr.right + 1) return 'clipped';
      }
    }
    return 'free';
  };

  const scrollW = Math.max(root.scrollWidth, document.body.scrollWidth);
  const overflow: string[] = [];
  const clipped: string[] = [];
  const small: SmallTarget[] = [];

  if (scrollW > vw + 1) {
    const offenders: { right: number; text: string }[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || (r.right <= vw + 1 && r.left >= -1)) continue;
      if (!isShown(el) || placement(el, r) !== 'free') continue;
      offenders.push({ right: Math.round(r.right), text: `${describe(el)} (prawa krawedz ${Math.round(r.right)} px)` });
    }
    offenders.sort((a, b) => b.right - a.right);
    for (const offender of offenders.slice(0, 6)) overflow.push(offender.text);
  }

  for (const el of Array.from(document.querySelectorAll(INTERACTIVE))) {
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2 || !isShown(el)) continue;
    // Link w zdaniu albo nazwa obcięta wielokropkiem: widać go i da się w niego stuknąć.
    if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') continue;
    const where = placement(el, r);
    const outside = r.right > vw + 1 || r.left < -1;
    if (where === 'clipped' || (where === 'free' && outside)) {
      clipped.push(describe(el));
      continue;
    }
    if (r.width >= minTarget && r.height >= minTarget) continue;
    const input = el as HTMLInputElement;
    if (input.type === 'checkbox' || input.type === 'radio') {
      const label = el.closest('label') ?? (el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
      const lr = label?.getBoundingClientRect();
      if (lr && lr.width >= minTarget && lr.height >= minTarget) continue;
    }
    small.push({ name: describe(el), w: Math.round(r.width), h: Math.round(r.height) });
  }

  const heading = document.querySelector('h1, h2')?.textContent?.trim().slice(0, 80) ?? '';
  return { vw, scrollW, overflow, clipped, small, heading };
}

async function inspect(
  page: Page,
  route: string,
  status: number | null,
  pageErrors: string[],
): Promise<RouteReport> {
  const audit = await page.evaluate(auditInPage, MIN_TARGET);
  const finalPath = new URL(page.url()).pathname;
  const problem: string[] = [];
  if (/^\/(login|mobile|onboarding)/.test(finalPath)) problem.push(`przekierowanie na ${finalPath}`);
  if ((status ?? 200) >= 400) problem.push(`status ${status}`);
  if (/Coś poszło nie tak|^404|Nie znaleziono/i.test(audit.heading)) problem.push(`ekran bledu: ${audit.heading}`);
  if (audit.scrollW > audit.vw + 1) problem.push(`poziome przewijanie ${audit.scrollW} > ${audit.vw}`);
  if (audit.clipped.length > 0) problem.push(`${audit.clipped.length} elementow ucietych lub poza ekranem`);
  if (pageErrors.length > 0) problem.push(`${pageErrors.length} bledow strony`);
  return {
    route,
    finalPath,
    status,
    vw: audit.vw,
    scrollW: audit.scrollW,
    overflow: audit.overflow,
    clipped: audit.clipped,
    small: audit.small,
    pageErrors: [...pageErrors],
    problem,
  };
}

async function visit(page: Page, route: string, pageErrors: string[]): Promise<RouteReport> {
  pageErrors.length = 0;
  const response = await page.goto(route, { waitUntil: 'load', timeout: 90_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  return inspect(page, route, response?.status() ?? null, pageErrors);
}

/** Arkusz „Więcej” to jedyna droga do Ustawień i Pomocy z dolnego paska. */
async function visitMoreSheet(page: Page, pageErrors: string[]): Promise<RouteReport> {
  pageErrors.length = 0;
  const response = await page.goto('/dashboard', { waitUntil: 'load', timeout: 90_000 });
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Więcej', exact: true }).first().click();
  await page.getByRole('dialog').first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  return inspect(page, '/dashboard + arkusz Więcej', response?.status() ?? null, pageErrors);
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`przekroczono ${ms / 1000} s na ${label}`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        done(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        fail(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function firstLink(page: Page, list: string, pattern: RegExp): Promise<string | null> {
  await page.goto(list, { waitUntil: 'load', timeout: 90_000 });
  const hrefs = await page.locator('a[href]').evaluateAll((links) =>
    links.map((link) => link.getAttribute('href') ?? ''),
  );
  return hrefs.find((href) => pattern.test(href)) ?? null;
}

test.describe('Telefon: ekrany panelu', () => {
  test.skip(
    ({ baseURL, isMobile }) => !isMobile || !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(baseURL ?? ''),
    'Tylko projekty telefonowe, na lokalnym koncie dev (pnpm db:local).',
  );

  test('wszystkie trasy: bez poziomego przewijania i bez bledow', async ({ page }, testInfo) => {
    test.setTimeout(20 * 60_000);
    const { email, password } = devCredentials();
    await seedDevData(email);

    const context = page.context();
    const pageErrors: string[] = [];
    const watch = (target: Page) =>
      target.on('pageerror', (error) => pageErrors.push(error.message.slice(0, 200)));
    watch(page);

    // Baner zgody na analitykę siedzi na dole ekranu i zasłania przycisk
    // logowania. Wybieramy „Tylko niezbędne”, jak klient, który go zamknął.
    await page.addInitScript(() => window.localStorage.setItem('ff_analytics_consent', 'denied'));

    // Telefon wchodzi na /login i zostaje na /login, bez odbicia na /mobile.
    await page.goto('/login');
    expect(new URL(page.url()).pathname).toBe('/login');
    await loginViaUI(page, email, password);
    expect(new URL(page.url()).pathname).not.toBe('/mobile');

    const invoiceDetail = await firstLink(page, '/invoices', new RegExp(`^/invoices/${UUID}$`));
    const expenseDetail = await firstLink(page, '/expenses', new RegExp(`^/expenses/${UUID}$`));
    const routes = [...new Set([...NAV_ROUTES, ...EXTRA_ROUTES])];
    for (const detail of [invoiceDetail, expenseDetail]) if (detail) routes.push(detail);
    // `TELEFON_TRASY=/settings/account,/inbox` powtarza tylko wskazane trasy.
    const only = process.env.TELEFON_TRASY?.split(',').map((route) => route.trim()).filter(Boolean);
    const selected = only?.length ? only : routes;

    const reports: RouteReport[] = [];
    // Każda trasa dostaje świeżą kartę tej samej sesji: WebKit potrafił zabić
    // jedną kartę po kilkunastu ekranach, a wtedy reszta raportu byłaby pusta.
    const run = async (label: string, job: (target: Page) => Promise<RouteReport>) => {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const tab = await context.newPage();
        watch(tab);
        try {
          reports.push(await withTimeout(job(tab), 150_000, label));
          return;
        } catch (error) {
          if (attempt === 2) {
            const message = (error as Error).message.split('\n')[0]?.slice(0, 160) ?? 'blad';
            reports.push({
              route: label, finalPath: '', status: null, vw: 0, scrollW: 0, overflow: [], clipped: [], small: [],
              pageErrors: [], problem: [`wyjatek: ${message}`],
            });
            return;
          }
        } finally {
          void tab.close().catch(() => undefined);
        }
      }
    };

    for (const route of selected) await run(route, (target) => visit(target, route, pageErrors));
    if (!only?.length) await run('/dashboard + arkusz Więcej', (target) => visitMoreSheet(target, pageErrors));

    mkdirSync('test-results', { recursive: true });
    const file = resolve('test-results', `telefon-raport-${testInfo.project.name}${NARROW > 0 ? `-${NARROW}` : ''}.json`);
    writeFileSync(file, JSON.stringify({ missing: { invoiceDetail, expenseDetail }, reports }, null, 2));
    await testInfo.attach('telefon-raport', { path: file, contentType: 'application/json' });

    const failing = reports.filter((report) => report.problem.length > 0);
    const summary = failing.map((report) => `${report.route}: ${report.problem.join('; ')}`);
    expect(summary, `Raport: ${file}`).toEqual([]);
  });
});
