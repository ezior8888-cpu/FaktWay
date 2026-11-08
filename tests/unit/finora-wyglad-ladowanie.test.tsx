import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prerenderToNodeStream } from 'react-dom/static';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Poprawka Bartosza 23.10.2026 po obejrzeniu produkcji: „przejścia pomiędzy
 * zakładkami nie są już takie clean, zmieniłeś rozmiary słupków i
 * zmodyfikowałeś wykresy — przywróć stare wykresy, słupki i animacje jak
 * w Finorze; pierwsze wrażenie ma być: o jezu, ale to jest ładne”.
 *
 * 1. Ładowanie: Pulpit i Przepływy renderują się RAZ, w całości — bez
 *    szkieletów kart wskakujących po kolei (`Suspense` w każdym slocie)
 *    i bez obcego szkieletu segmentu w `loading.tsx` tych tras.
 * 2. Dane przykładowe mają kształt wykresów Finory: sumy słupków „Finance”,
 *    kolumny 17/65/18, wpływy „Miesięcznie”, wydatki 55–90% wpływów (zrzuty
 *    24.10.2026), pięć lat „Rocznie”.
 */

type Proof = { verifiedAt: string | null; verifiedEnvironment: string | null };

const state = vi.hoisted(() => ({
  ctx: null as unknown as { supabase: unknown; tenantId: string; user: { id: string; email: string | null }; role: 'owner' },
  proof: null as Proof | null,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => { throw new Error(`redirect ${to}`); },
}));
vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: async () => state.ctx }));
vi.mock('@/lib/dashboard-shell-data', () => ({ getTenantKsefProof: async () => state.proof }));

const { memoryClient } = await import('./helpers/baza-w-pamieci');
const { default: PulpitPage } = await import('@/app/(dashboard)/dashboard/page');
const { default: PrzeplywyPage } = await import('@/app/(dashboard)/przeplywy/page');
const { default: PulpitLoading } = await import('@/app/(dashboard)/dashboard/loading');
const { default: PrzeplywyLoading } = await import('@/app/(dashboard)/przeplywy/loading');
const { financeYAxis } = await import('@/components/dashboard/finora/chart-finance');
const adaptery = await import('@/components/dashboard/finora/adaptery');
const { analizyDemoSupabase, DEMO_TENANT } = await import('@/lib/demo/analizy-przykladowe');
const { getSalesSeries } = await import('@/lib/dashboard/monthly-figures');
const { getCostsWithKsefPurchases, sumCostsByMonth } = await import('@/lib/dashboard/costs');
const { warsawMonthWindow } = await import('@/lib/dashboard/rankings');
const { getInflows } = await import('@/lib/dashboard/inflows');
const { inflowTerms } = await import('@/lib/dashboard/inflow-terms');
const { buildCashFlowChart, nextMonthStart, przykladoweWplywy, yearsWindowStart } = await import('@/lib/dashboard/cash-movements');
const { todayInWarsaw } = await import('@/lib/format/warsaw-date');

/** Piątek 23.10.2026, 10:00 w Warszawie. */
const NOW = new Date('2026-10-23T08:00:00Z');
const T = DEMO_TENANT;

/**
 * Sumy słupków „Finance” Finory (Sty–Lip: profit + income + expense), tys. — nasze 7 miesięcy w zł brutto.
 * Szczyt 49,05 zamiast 50 świadomie (poprawka ze zrzutów 24.10.2026): netto poniżej 40 tys. trzyma
 * automatyczną oś recharts kart „Przychód netto” i „Trend sprzedaży” na 0–40 tys. (przy 50 była 0–60
 * i słupki miały 2/3 wysokości); na osi „Finanse” 0–50 tys. różnicy nie widać.
 */
const FINANCE_FINORY = [20, 28, 40, 25, 44, 49.05, 44];

async function html(node: ReactNode): Promise<string> {
  const { prelude } = await prerenderToNodeStream(<>{node}</>);
  let out = '';
  for await (const chunk of prelude) out += String(chunk);
  return out;
}

/** Ślady szkieletu ładowania: prymityw `Skeleton`, puls, `aria-busy`, granica `Suspense` czekająca na podmianę. */
function szkielety(markup: string): string[] {
  return ['data-slot="skeleton"', 'animate-pulse', 'aria-busy', '<!--$?-->', '<template id="B:'].filter((z) => markup.includes(z));
}

function strona(page: () => Promise<ReactNode>) {
  state.ctx = { supabase: memoryClient({}), tenantId: 'firma-a', user: { id: 'uzytkownik-1', email: null }, role: 'owner' };
  return page().then(html);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  // Firma bez weryfikacji KSeF — tryb `przyklad` (dane przykładowe w pamięci).
  state.proof = { verifiedAt: null, verifiedEnvironment: null };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ładowanie: strona w całości, bez szkieletów kart', () => {
  it.each([
    ['/dashboard', () => PulpitPage()],
    ['/przeplywy', () => PrzeplywyPage()],
  ] as const)('%s w trybie przykład: HTML bez szkieletów i bez granic Suspense, jedno wejście `ff-route-content`', async (_path, page) => {
    const markup = await strona(page);
    expect(markup).toContain('Przykład');
    expect(szkielety(markup)).toEqual([]);
    expect(markup.startsWith('<div class="ff-route-content">')).toBe(true);
    expect(markup.split('ff-route-content').length - 1).toBe(1);
  });

  it.each([
    ['/dashboard', PulpitLoading],
    ['/przeplywy', PrzeplywyLoading],
  ] as const)('%s: `loading.tsx` trasy bez szkieletu (dawny ogólny szkielet segmentu migał przed siatką Finory)', (_path, Loading) => {
    const markup = renderToStaticMarkup(<Loading />);
    expect(markup).not.toContain('data-slot="skeleton"');
    expect(markup).not.toContain('animate-pulse');
    expect(markup).toContain('aria-label="Ładowanie"');
  });

  it('sloty bez `Suspense` i szkieletów; strony czekają na wszystkie karty naraz', () => {
    for (const file of ['components/dashboard/finora/sloty.tsx', 'components/przeplywy/finora-1do1/sloty.tsx']) {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      expect(src, file).not.toMatch(/<Suspense|from '@\/components\/ui\/skeleton'/);
    }
    for (const file of ['app/(dashboard)/dashboard/page.tsx', 'app/(dashboard)/przeplywy/page.tsx']) {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      expect(src, file).toMatch(/await Promise\.all\(\[/);
      expect(src, file).toContain('ff-route-content');
    }
    const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
    // Ten sam ruch co szablon trasy, `backwards` (bez trwałego `transform`), wyłączony przy ograniczonym ruchu.
    expect(css).toMatch(/\.ff-route-content \{\s*animation: ff-route-enter 220ms cubic-bezier\(0\.16, 1, 0\.3, 1\) backwards;/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.ff-route-content \{\s*animation: none;/);
  });
});

describe('dane przykładowe w kształcie wykresów Finory', () => {
  const sb = () => analizyDemoSupabase(NOW, 'test');
  const today = todayInWarsaw(NOW);

  it('Finanse: 7 słupków o sumach Finory (20, 28, 40, 25, 44, 50, 44 tys. zł brutto), maksimum ≤ 50 tys., oś 0–50 tys.', async () => {
    const db = sb();
    const series = await getSalesSeries(db, T, NOW, { months: 7, withPrevYear: false });
    const costs = sumCostsByMonth(await getCostsWithKsefPurchases(db, T, warsawMonthWindow(NOW, 7)), series.months.map((m) => m.key));
    const dane = adaptery.finanseProps({
      months: series.months, net: series.netSeries, vat: series.vatSeries, costs, tryb: 'przyklad', kosztyKsefOd: null,
    });
    const sumy = dane.months.map((m) => m.profit + m.vat + m.costs);
    sumy.forEach((v, i) => expect(Math.abs(v - FINANCE_FINORY[i]! * 1000)).toBeLessThan(1));
    expect(Math.max(...sumy)).toBeLessThanOrEqual(50_000);
    expect(financeYAxis(Math.max(...sumy)).ticks).toEqual([0, 10_000, 20_000, 30_000, 40_000, 50_000]);
    for (const m of dane.months) {
      // Spójność: zysk = przychód − koszty bez straty, VAT 23% netto.
      expect(m.result).toBeGreaterThan(0);
      expect(m.profit).toBeLessThan(m.revenue);
      expect(m.vat / m.revenue).toBeCloseTo(0.23, 2);
      // Zrzuty 24.10.2026: koszty to 55–90% wpływów, więc dolny segment (od tej poprawki Koszty, dawniej
      // Zysk — `financeChartConfig`) jest duży jak w Finorze (12–25 z 20–50): co najmniej połowa netto,
      // a VAT na wierzchu najmniejszy. Świadomie zastępuje dawne „zysk to najgrubszy segment”.
      expect(m.costs / m.revenue).toBeGreaterThanOrEqual(0.4);
      expect(m.vat).toBeLessThan(m.costs);
    }
  });

  it('VAT należny: 12 punktów, na początku pary jak linia „Wyświetlenia” (20-20, 50-50)', async () => {
    const { vatSeries } = await getSalesSeries(sb(), T, NOW, { months: 12, withPrevYear: false });
    const tys = vatSeries.map((v) => Math.round(v / 0.23 * 1.23 / 1000));
    expect(tys).toEqual([11, 11, 26, 26, 16, ...FINANCE_FINORY.map(Math.round)]);
  });

  it('Przychód netto i Trend sprzedaży: szczyt netto tuż pod 40 tys. — automatyczna oś 0–40 tys., najwyższy słupek pod górą wykresu', async () => {
    const s = await getSalesSeries(sb(), T, NOW, { months: 6, withPrevYear: true });
    const wszystkie = [...s.netSeries, ...s.prevNetSeries.slice(-5)];
    // recharts dzieli [0, max] na 4 kroki „ładne” co 500 zł do 40 tys., powyżej co 5 tys. (oś 0–60 tys.).
    expect(Math.max(...wszystkie)).toBeLessThan(40_000);
    expect(Math.max(...wszystkie)).toBeGreaterThan(0.95 * 40_000);
  });

  it('Przychód netto: ten rok i rok wcześniej na zmianę wyżej i niżej (seria „Telefon”)', async () => {
    const s = await getSalesSeries(sb(), T, NOW, { months: 5, withPrevYear: true });
    const wyzej = s.netSeries.map((v, i) => v > s.prevNetSeries[i]!);
    expect(wyzej).toEqual([true, false, true, true, true]);
    expect(s.prevNetSeries.every((v) => v > 0)).toBe(true);
  });

  it('Należności: kolumny 17% / 65% / 18% jak dawne „Odwiedzający”', async () => {
    const terms = inflowTerms(await getInflows(sb(), T, { from: today }), today);
    expect(terms.buckets.map((b) => b.pct)).toEqual([17, 65, 18]);
  });

  it('Przepływy: wpływy „Miesięcznie” jak w Finorze (±10%), pięć lat „Rocznie”', async () => {
    const db = sb();
    const range = { from: yearsWindowStart(today), toExclusive: nextMonthStart(today) };
    const chart = buildCashFlowChart(przykladoweWplywy(await getInflows(db, T, range), today), await getCostsWithKsefPurchases(db, T, range), today);
    // Finora Sty–Cze: 3200, 2800, 3500, 2600, 3800, 3000 (× 10 zł); bieżący miesiąc liczy się do wczoraj.
    const finora = [32_000, 28_000, 35_000, 26_000, 38_000, 30_000];
    chart.month.slice(0, 6).forEach((b, i) => expect(Math.abs(b.inflow / finora[i]! - 1), b.label).toBeLessThan(0.1));
    // Zrzuty 24.10.2026: wydatki 55–90% wpływów (dawniej 25–40% — słupki ledwie od ziemi), na zmianę
    // nisko i wysoko jak „Miesięcznie” Finory (1900/3420/2100/3250… przy 3400/3000/3800/2600…).
    const udzialy = chart.month.map((b) => b.outflow / b.inflow);
    udzialy.forEach((u, i) => {
      expect(u, chart.month[i]!.label).toBeGreaterThanOrEqual(0.54);
      expect(u, chart.month[i]!.label).toBeLessThanOrEqual(0.9);
    });
    udzialy.slice(1).forEach((u, i) => expect(Math.sign(u - udzialy[i]!), chart.month[i + 1]!.label).toBe(i % 2 === 0 ? 1 : -1));
    expect(chart.year.map((b) => b.label)).toEqual(['2022', '2023', '2024', '2025', '2026']);
    // „Rocznie” rośnie do zeszłego roku, bieżący (do dziś) niżej — jak 28,4 / 31,2 / 36,4 / 39,1 / 34,6.
    const lata = chart.year.map((b) => b.inflow);
    expect(lata[0]! < lata[1]! && lata[1]! < lata[2]! && lata[2]! < lata[3]! && lata[4]! < lata[3]!).toBe(true);
  });
});
