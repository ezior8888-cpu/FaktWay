import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prerenderToNodeStream } from 'react-dom/static';
import { describe, expect, it, vi } from 'vitest';

import { fakePostgrest, type Row } from '../helpers/fake-postgrest';

const verified = vi.hoisted(() => ({ value: true }));

vi.mock('@/lib/dashboard-shell-data', () => ({
  getDashboardActiveOrgVerified: async () => verified.value,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/analizy/sprzedaz',
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const koszty = await import('@/components/analizy/koszty-grid');
const sprzedaz = await import('@/components/analizy/sprzedaz-grid');
const { AnalizySiatka } = await import('@/components/analizy/card-slot');
const { ANALIZY_EMPTY } = await import('@/components/analizy/finora/empty');

/**
 * Siatka `/analizy/*` 1:1 z Finory (poprawka Bartosza 21.10.2026: „weź na
 * razie wszystko 1:1 z Finory z przełącznikiem kosztów i sprzedaży”): obie
 * strony to dokładnie dziewięć kart Monthly Analytics w kolejności i z
 * rozpiętościami Finory, bez dodatkowego rzędu „Klienci”, a karty rysują
 * wykresy Finory z prawdziwych danych — pusty stan tylko wtedy, gdy zera
 * byłyby nieprawdą. KSEF_ENV = 'test'.
 */

const TENANT = 'firma-a';
const NOW_ISO = '2026-10-17T10:00:00.000Z';

function html(node: ReactNode): string {
  return renderToStaticMarkup(<>{node}</>).replace(/<!-- -->/g, '');
}

function invoice(id: string, fields: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT,
    direction: 'outgoing',
    ksef_status: 'accepted',
    ksef_environment: 'test',
    invoice_kind: 'regular',
    advance_invoice_ids: [],
    currency: 'PLN',
    issue_date: '2026-10-05',
    internal_number: `FV/${id}`,
    net_total: 1000,
    gross_total: 1230,
    buyer_nip: '1234567890',
    buyer_data: { name: 'Klient Testowy' },
    is_b2c: false,
    origin: 'app',
    invoice_type: 'VAT',
    payment_status: 'unpaid',
    payment_due_date: '2026-10-01',
    paid_amount: 0,
    ...fields,
  };
}

function expense(id: string, fields: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT,
    source: 'manual',
    ksef_invoice_id: null,
    issue_date: '2026-10-05',
    seller_nip: '1234567890',
    seller_name: 'Dostawca',
    is_deductible: true,
    is_reviewed: true,
    document_type: 'invoice',
    net_amount: 100,
    vat_amount: 23,
    gross_amount: 123,
    vat_deductible_amount: 23,
    category_label: 'Paliwo',
    ocr_extracted_data: null,
    ...fields,
  };
}

function props(tables: Record<string, Row[]>, month = '2026-10') {
  // Tryb danych strony (`kontekstDanych`): bez KSeF = przykład; tu karty czytają podaną bazę.
  const tryb = verified.value ? ('prawdziwe' as const) : ('przyklad' as const);
  return { supabase: fakePostgrest(tables), tenantId: TENANT, nowIso: NOW_ISO, month, tryb };
}

async function withoutKsef<T>(run: () => Promise<T>): Promise<T> {
  verified.value = false;
  try {
    return await run();
  } finally {
    verified.value = true;
  }
}

/** Finora `monthly-analytics/index.tsx`: rozpiętości dziewięciu kart. */
const FINORA_GRID = [
  'md:col-span-4',
  'md:col-span-2 2xl:col-span-3',
  'md:max-2xl:col-span-2',
  'md:col-span-2',
  'md:col-span-2',
  'md:col-span-2',
  'md:col-span-2',
  'md:col-span-2',
  'md:col-span-2',
] as const;

async function prerender(node: ReactNode): Promise<string> {
  const { prelude } = await prerenderToNodeStream(<>{node}</>);
  let out = '';
  for await (const chunk of prelude) out += String(chunk);
  return out;
}

describe('siatka 1:1 z Finory', () => {
  const p = props({});

  // Poprawka Bartosza 23.10.2026 („przejścia nie są już takie clean”): karty
  // bez `Suspense` i szkieletów — siatka (`AnalizySiatka`) czeka na wszystkie
  // naraz, jak Pulpit i Przepływy. Dawniej test sprawdzał tu warianty
  // szkieletów `AnalizySlot`; kolejność i rozpiętości kart zostają te same.
  it('koszty: jedna siatka `grid gap-6 md:grid-cols-4`, 9 kart w kolejności i rozpiętościach Finory', () => {
    const grid = koszty.KosztyGrid(p);
    expect(grid.type).toBe(AnalizySiatka);
    expect(grid.props.karty).toBe(koszty.SIATKA_KOSZTOW);
    expect(koszty.SIATKA_KOSZTOW.map(([, className]) => className)).toEqual(FINORA_GRID);
    expect(koszty.SIATKA_KOSZTOW.map(([, , karta]) => karta)).toEqual([
      koszty.CostStatsSlot,
      koszty.CostTrendSlot,
      koszty.CostCategoriesChartSlot,
      koszty.CostCategoriesListSlot,
      koszty.RecentCostsSlot,
      koszty.CostVatSlot,
      koszty.CostIncomeExpenseSlot,
      koszty.RecurringCostsSlot,
      koszty.CostHeatmapSlot,
    ]);
  });

  it('sprzedaż: ta sama siatka, bez rzędu „Udział klientów” / „Klienci: rośnie / spada”', () => {
    const grid = sprzedaz.SprzedazGrid(p);
    expect(grid.type).toBe(AnalizySiatka);
    expect(grid.props.karty).toBe(sprzedaz.SIATKA_SPRZEDAZY);
    expect(sprzedaz.SIATKA_SPRZEDAZY.map(([, className]) => className)).toEqual(FINORA_GRID);
    const karty = sprzedaz.SIATKA_SPRZEDAZY.map(([, , karta]) => karta);
    expect(karty).toEqual([
      sprzedaz.SalesStatsSlot,
      sprzedaz.SalesTrendSlot,
      sprzedaz.ProductsChartSlot,
      sprzedaz.ProductsListSlot,
      sprzedaz.RecentSalesSlot,
      sprzedaz.ReceivablesSlot,
      sprzedaz.SalesIncomeExpenseSlot,
      sprzedaz.RecurringClientsSlot,
      sprzedaz.SalesHeatmapSlot,
    ]);
    // Karty spoza siatki zostają w kodzie (wrócimy do nich), ale nie są renderowane.
    expect(typeof sprzedaz.ClientSharesSlot).toBe('function');
    expect(typeof sprzedaz.ClientMoversSlot).toBe('function');
    expect(karty).not.toContain(sprzedaz.ClientSharesSlot);
    expect(karty).not.toContain(sprzedaz.ClientMoversSlot);
  });

  it.each([
    ['koszty', () => koszty.KosztyGrid(p)],
    ['sprzedaż', () => sprzedaz.SprzedazGrid(p)],
  ] as const)('%s: HTML w całości — 9 kart z klasami siatki, bez szkieletów i granic Suspense', async (_name, grid) => {
    const markup = await prerender(grid());
    expect(markup.startsWith('<div class="grid gap-6 md:grid-cols-4">')).toBe(true);
    for (const span of new Set(FINORA_GRID)) expect(markup, span).toContain(span);
    for (const slad of ['data-slot="skeleton"', 'animate-pulse', 'aria-busy', '<!--$?-->', '<template id="B:']) {
      expect(markup, slad).not.toContain(slad);
    }
  });
});

describe('trend: słupki Finory zawsze, pusto tylko przy samych zerach (D8)', () => {
  it('jeden miesiąc ze sprzedażą rysuje wykres (bez „Wykres pojawi się po drugim miesiącu”)', async () => {
    const out = html(await sprzedaz.SalesTrendSlot(props({ invoices: [invoice('a')] })));
    expect(out).toContain('data-slot="chart"');
    expect(out).toContain('max-h-70 w-full');
    expect(out).not.toContain('Wykres pojawi się po drugim miesiącu');
    expect(out).not.toContain(ANALIZY_EMPTY.noSalesInTrend.message);
  });

  it('faktury tylko sprzed 6 miesięcy: komunikat w pudełku o wymiarach wykresu', async () => {
    const out = html(await sprzedaz.SalesTrendSlot(props({ invoices: [invoice('stara', { issue_date: '2026-04-10' })] })));
    expect(out).toContain(ANALIZY_EMPTY.noSalesInTrend.message);
    expect(out).toContain('flex aspect-video max-h-70 w-full items-center justify-center');
    expect(out).not.toContain('data-slot="chart"');
  });

  it('bez faktur: „wystaw pierwszą fakturę” z przyciskiem', async () => {
    const out = html(await sprzedaz.SalesTrendSlot(props({ invoices: [] })));
    expect(out).toContain(ANALIZY_EMPTY.noInvoices.message);
    expect(out).toContain('href="/invoices/new"');
  });

  it('koszty: jeden wydatek → wykres; bez wydatków i bez KSeF → „Podłącz KSeF”', async () => {
    expect(html(await koszty.CostTrendSlot(props({ expenses: [expense('e')] })))).toContain('data-slot="chart"');
    const out = await withoutKsef(async () => html(await koszty.CostTrendSlot(props({ expenses: [] }))));
    expect(out).toContain(ANALIZY_EMPTY.connectKsef.message);
    expect(out).toContain('href="/settings/ksef"');
  });
});

describe('kafle sprzedaży (D9)', () => {
  it('„Średnio dziennie” = netto ÷ dni do dziś, pełna kwota w title; bez poprzedniego miesiąca „—”', async () => {
    const out = html(await sprzedaz.SalesStatsSlot(props({ invoices: [invoice('a')] })));
    expect(out).toContain('Średnio dziennie');
    expect(out).not.toContain('Średnio na fakturę');
    // 1000 zł netto do 17 października → 58,82 zł dziennie.
    expect(out).toContain('title="58,82 zł"');
    expect(out).toContain('title="Brak sprzedaży w poprzednim miesiącu"');
    expect(out).toContain('Najlepszy klient');
  });
});

describe('kalendarz: siatka zawsze, gdy w oknie jest choć jeden dokument (D10)', () => {
  it('sprzedaż: komórki z datą i kwotą; bez faktur — komunikat zamiast siatki', async () => {
    const out = html(await sprzedaz.SalesHeatmapSlot(props({ invoices: [invoice('a')] })));
    expect(out).toContain('role="region"');
    expect(out).toContain('aria-label="05.10.2026 — 1000,00 zł"');
    const empty = html(await sprzedaz.SalesHeatmapSlot(props({ invoices: [] })));
    expect(empty).toContain(ANALIZY_EMPTY.noInvoices.message);
    expect(empty).not.toContain('role="region"');
  });

  it('koszty: wydatek spoza 180 dni, ale w oknie strony — siatka z zerami, nie komunikat', async () => {
    const out = html(await koszty.CostHeatmapSlot(props({ expenses: [expense('stary', { issue_date: '2026-04-10' })] })));
    expect(out).toContain('role="region"');
    expect(out).not.toContain(ANALIZY_EMPTY.noCostsInWindow.message);
  });

  it('koszty bez wydatków: z KSeF „Brak wydatków w ostatnich 180 dniach”, bez KSeF „Podłącz KSeF”', async () => {
    expect(html(await koszty.CostHeatmapSlot(props({ expenses: [] })))).toContain(ANALIZY_EMPTY.noCostsInWindow.message);
    const out = await withoutKsef(async () => html(await koszty.CostHeatmapSlot(props({ expenses: [] }))));
    expect(out).toContain(ANALIZY_EMPTY.connectKsef.message);
    expect(out).not.toContain('role="region"');
  });
});

/** Opis karty w HTML-u (`data-slot="card-description"`). */
function description(out: string): string {
  return /data-slot="card-description"[^>]*>([^<]*)</.exec(out)?.[1] ?? '';
}

describe('opisy kart: jedna linia jak w Finorze i prawdziwe w obu motywach', () => {
  // Najdłuższy opis Finory (Spend Heatmap, 53 znaki, 290,5 px) mieści się
  // w jednej linii karty przy 375 px (pole 312 px, 12px Outfit). Polskie
  // opisy po 60–64 znaki zawijały się i podnosiły kartę o 19,5 px; 54 znaki
  // naszego najdłuższego to 294 px (pomiar 21.10.2026).
  const MAX_ONE_LINE_DESCRIPTION = 54;

  it('kalendarze, VAT i ostatnie faktury: jedna linia, bez „ciemniejsze” (w ciemnym motywie więcej = jaśniej)', async () => {
    const cards = [
      html(await koszty.CostHeatmapSlot(props({ expenses: [expense('e')] }))),
      html(await sprzedaz.SalesHeatmapSlot(props({ invoices: [invoice('a')] }))),
      html(await koszty.CostVatSlot(props({ expenses: [expense('e')] }))),
      html(await sprzedaz.RecentSalesSlot(props({ invoices: [invoice('a')] }))),
    ].map(description);
    for (const text of cards) {
      expect(text).not.toBe('');
      expect(text.length, text).toBeLessThanOrEqual(MAX_ONE_LINE_DESCRIPTION);
      expect(text).not.toMatch(/ciemn/i);
    }
  });
});

describe('listy z prawdziwych danych', () => {
  it('stali klienci: 6 wierszy jak w Finorze, link faktury cyklicznej w linii', async () => {
    const invoices = Array.from({ length: 7 }, (_, i) =>
      ['2026-08-05', '2026-09-05', '2026-10-05'].map((d) =>
        invoice(`k${i}-${d}`, { issue_date: d, buyer_nip: null, buyer_data: { name: `Klient ${i + 1}` }, net_total: 100 + i })),
    ).flat();
    const out = html(await sprzedaz.RecurringClientsSlot(props({ invoices })));
    expect(out.match(/Średnio \/ mies\./g)).toHaveLength(6);
    expect(out.match(/Zrób fakturę cykliczną</g)).toHaveLength(6);
    // Po poprawce karty (jedna linia, bez dodatkowej wysokości) dzień i link stoją w jednym wierszu
    // jako osobne elementy: dzień, separator „ · ”, link.
    expect(out).toMatch(/Zwykle ok\. 5\. dnia miesiąca<\/span><span[^>]*> · <\/span><a/);
    // Najmniejszy z siedmiu (100 zł) wypada poza listę.
    expect(out).not.toContain('Klient 1<');
  });

  it('stałe koszty: też 6 wierszy jak w Finorze (limit przy wywołaniu, lib domyślnie 5), bez linku faktury cyklicznej', async () => {
    const expenses = Array.from({ length: 7 }, (_, i) =>
      ['2026-08-05', '2026-09-05', '2026-10-05'].map((d) =>
        expense(`d${i}-${d}`, { issue_date: d, seller_nip: null, seller_name: `Dostawca ${i + 1}`, gross_amount: 100 + i })),
    ).flat();
    const out = html(await koszty.RecurringCostsSlot(props({ expenses })));
    expect(out.match(/Średnio \/ mies\./g)).toHaveLength(6);
    expect(out).not.toContain('Zrób fakturę cykliczną');
    // Najmniejszy z siedmiu (100 zł) wypada poza listę.
    expect(out).not.toContain('Dostawca 1<');
    expect(out).toContain('Dostawca 7<');
  });

  it('ostatnie faktury: opis mówi, że to faktury przyjęte w KSeF (loader czyta tylko `accepted`)', async () => {
    const out = html(await sprzedaz.RecentSalesSlot(props({ invoices: [invoice('a')] })));
    expect(out).toContain('Przyjęte w KSeF w wybranym miesiącu · brutto');
  });

  it('stałe koszty bez dostawcy w 3 z 4 miesięcy: komunikat N3', async () => {
    expect(html(await koszty.RecurringCostsSlot(props({ expenses: [expense('e')] })))).toContain(
      ANALIZY_EMPTY.noRecurringSuppliers.message,
    );
  });

  it('produkty: koło Finory i ranking z pozycji faktur wybranego miesiąca', async () => {
    const tables = {
      invoices: [invoice('a')],
      invoice_line_items: [
        { id: 'l1', invoice_id: 'a', name: 'Hosting', unit: 'szt.', net_amount: 600 },
        { id: 'l2', invoice_id: 'a', name: 'Wdrożenie', unit: 'usł.', net_amount: 400 },
      ],
    };
    const chart = html(await sprzedaz.ProductsChartSlot(props(tables)));
    expect(chart).toContain('data-slot="chart"');
    expect(chart).toContain('mx-auto aspect-square max-h-70');
    // Podpis produktu z lib: nazwa i jednostka (`productBreakdown`).
    expect(chart).toContain('Hosting (szt.): 600,00 zł (60%)');
    const list = html(await sprzedaz.ProductsListSlot(props(tables)));
    expect(list).toContain('Hosting');
    expect(list).toContain('600,00 zł');
    expect(list).toContain('aria-label="Wdrożenie (usł.): 40%"');
  });

  it('ostatnie wydatki: ikona kategorii w kółku Finory i kwota brutto', async () => {
    const out = html(await koszty.RecentCostsSlot(props({ expenses: [expense('e', { category_label: 'Paliwo' })] })));
    expect(out).toContain('bg-muted flex size-10 shrink-0 items-center justify-center rounded-full');
    expect(out).toContain('123,00 zł');
    expect(out).toContain('05.10.2026');
  });
});
