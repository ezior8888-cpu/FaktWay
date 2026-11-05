import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { fakePostgrest, type Row } from '../helpers/fake-postgrest';

vi.mock('@/lib/dashboard-shell-data', () => ({
  getDashboardActiveOrgVerified: async () => true,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/analizy/sprzedaz',
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const koszty = await import('@/components/analizy/koszty-grid');
const sprzedaz = await import('@/components/analizy/sprzedaz-grid');

/**
 * E4 (PLAN-PRAWDZIWE-DANE §6.3) + zasada Bartosza 23.10.2026: tylko napisy
 * w istniejących miejscach. Podpisy kart mówią prawdę o źródle liczby
 * (koszty z KSeF i wydatków — E10, należności według terminów płatności — E11),
 * demo nie linkuje do nieistniejącej faktury-wzoru, a stan „synchronizacja”
 * (B) mówi „Pobieramy faktury z KSeF…” zamiast „Wystaw fakturę”.
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
    seller_nip: '5555555555',
    seller_name: 'Dostawca',
    is_deductible: true,
    is_reviewed: false,
    document_type: 'invoice',
    net_amount: 100,
    vat_amount: 23,
    gross_amount: 123,
    vat_deductible_amount: 23,
    category_label: 'Biuro',
    ocr_extracted_data: null,
    ...fields,
  };
}

type Tryb = 'przyklad' | 'synchronizacja' | 'prawdziwe';

/** `kosztyKsefOd` — od kiedy koszty z KSeF są pełne (E10: data weryfikacji, dopóki historia zakupów się pobiera). */
function props(tables: Record<string, Row[]>, tryb: Tryb = 'prawdziwe', kosztyKsefOd: string | null = null) {
  return { supabase: fakePostgrest(tables), tenantId: TENANT, nowIso: NOW_ISO, month: '2026-10', tryb, kosztyKsefOd };
}

/** Karta Finory: opis to `CardDescription` (`data-slot="card-description"`). */
function description(out: string): string {
  return out.match(/data-slot="card-description"[^>]*>([^<]*)</)?.[1] ?? '';
}

describe('E4, E10: podpisy kart kosztów mówią, że to faktury z KSeF i wydatki', () => {
  const p = props({ expenses: [expense('e')], invoices: [] });

  it('Wydatki miesiąca: etykieta kafla nie udaje wypłaty', async () => {
    const out = html(await koszty.CostStatsSlot(p));
    expect(out).toContain('Dokumenty (brutto)');
    expect(out).not.toContain('Wydano (brutto)');
  });

  it('Trend, Koło i Kalendarz: „Z KSeF i wydatków” (E10: krótsze od dawnego „Z dokumentów w FaktWay”)', async () => {
    expect(description(html(await koszty.CostTrendSlot(p)))).toBe('Z KSeF i wydatków · brutto, 6 mies.');
    expect(description(html(await koszty.CostCategoriesChartSlot(p)))).toBe('Z KSeF i wydatków · wybrany miesiąc');
    expect(description(html(await koszty.CostHeatmapSlot(p)))).toBe('Z KSeF i wydatków · ostatnie 180 dni');
  });

  it('historia zakupów z KSeF niepełna, data w oknie karty: „KSeF od DD.MM” (jedna linia, krótsza od dawnej)', async () => {
    const withProof = props({ expenses: [expense('e')], invoices: [] }, 'prawdziwe', '2026-10-09T08:00:00.000Z');
    expect(description(html(await koszty.CostTrendSlot(withProof)))).toBe('Z wydatków, KSeF od 09.10 · brutto, 6 mies.');
    expect(description(html(await koszty.CostCategoriesChartSlot(withProof)))).toBe('Z wydatków, KSeF od 09.10 · wybrany miesiąc');
    expect(description(html(await koszty.CostHeatmapSlot(withProof)))).toBe('Z wydatków, KSeF od 09.10 · ostatnie 180 dni');
  });

  it('Kalendarz: okno to 180 dni, nie 6 miesięcy kalendarzowych (dzień, nie miesiąc)', async () => {
    // NOW 17.10.2026: kalendarz od 21.04.2026, trend (6 miesięcy) od 01.05.2026.
    const wOknie = props({ expenses: [expense('e')], invoices: [] }, 'prawdziwe', '2026-04-25T08:00:00.000Z');
    expect(description(html(await koszty.CostHeatmapSlot(wOknie)))).toBe('Z wydatków, KSeF od 25.04 · ostatnie 180 dni');
    expect(description(html(await koszty.CostTrendSlot(wOknie)))).toBe('Z KSeF i wydatków · brutto, 6 mies.');
    // Ten sam miesiąc, ale przed pierwszym dniem kalendarza — wszystkie dni okna mają już KSeF.
    const przedOknem = props({ expenses: [expense('e')], invoices: [] }, 'prawdziwe', '2026-04-10T08:00:00.000Z');
    expect(description(html(await koszty.CostHeatmapSlot(przedOknem)))).toBe('Z KSeF i wydatków · ostatnie 180 dni');
  });

  it('weryfikacja sprzed okna karty: bez dopisku', async () => {
    const old = props({ expenses: [expense('e')], invoices: [] }, 'prawdziwe', '2025-01-09T08:00:00.000Z');
    expect(description(html(await koszty.CostCategoriesChartSlot(old)))).toBe('Z KSeF i wydatków · wybrany miesiąc');
  });

  it('przykład: podpis bez „KSeF od” nawet z datą', async () => {
    const demo = props({ expenses: [expense('e')], invoices: [] }, 'przyklad', '2026-10-09T08:00:00.000Z');
    expect(description(html(await koszty.CostCategoriesChartSlot(demo)))).toBe('Z KSeF i wydatków · wybrany miesiąc');
  });

  it('Przychody a koszty: koszty z KSeF i wydatków (E10, nie tylko KPiR), „Wynik (netto)”', async () => {
    const out = html(await koszty.CostIncomeExpenseSlot(p));
    expect(description(out)).toBe('Netto · z KSeF i wydatków, bez VAT do odliczenia');
    expect(out).toContain('Wynik (netto)');
  });
});

describe('E4: podpisy kart sprzedaży', () => {
  const p = props({ invoices: [invoice('a')], invoice_line_items: [] });

  // Od 00158 klient oznacza zapłatę sam: podpis mówi, co liczymy, a dymek, jak zdjąć zapłaconą fakturę.
  it('Należności: faktury bez oznaczonej zapłaty, pełne zdanie w dymku', async () => {
    const out = html(await sprzedaz.ReceivablesSlot(p));
    expect(description(out)).toBe('Faktury z FaktWay bez oznaczonej zapłaty');
    expect(out).toContain('title="Faktury z FaktWay bez oznaczonej zapłaty, bez importów i faktur skorygowanych. Gdy klient zapłaci, dotknij „Zapłacone” przy fakturze."');
    expect(out).not.toMatch(/nie potwierdzamy/);
  });

  it('Przychody a koszty po stronie sprzedaży: ten sam podpis', async () => {
    const out = html(await sprzedaz.SalesIncomeExpenseSlot(p));
    expect(description(out)).toBe('Netto · z KSeF i wydatków, bez VAT do odliczenia');
    expect(out).toContain('Wynik (netto)');
  });
});

describe('E4: „Stali klienci” w demo nie linkują do nieistniejącej faktury-wzoru', () => {
  const rows = ['2026-07-05', '2026-08-05', '2026-09-05'].map((d, i) => invoice(`s${i}`, { issue_date: d }));

  it('prawdziwe: link „Zrób fakturę cykliczną” z id faktury-wzoru', async () => {
    const out = html(await sprzedaz.RecurringClientsSlot(props({ invoices: rows, invoice_line_items: [] })));
    expect(out).toContain('/invoices/recurring?wzor=s2');
    expect(out).toContain('Zrób fakturę cykliczną');
  });

  it('przykład: ten sam wiersz bez linku', async () => {
    const out = html(await sprzedaz.RecurringClientsSlot(props({ invoices: rows, invoice_line_items: [] }, 'przyklad')));
    expect(out).toContain('Klient Testowy');
    expect(out).not.toContain('recurring?wzor=');
    expect(out).not.toContain('Zrób fakturę cykliczną');
  });
});

describe('E4: stan „synchronizacja” — puste karty mówią „Pobieramy faktury z KSeF…”', () => {
  const empty = props({ invoices: [], invoice_line_items: [], expenses: [] }, 'synchronizacja');
  const POBIERAMY = 'Pobieramy faktury z KSeF…';

  it('sprzedaż: trend, produkty, ostatnie faktury, kalendarz, klienci', async () => {
    for (const out of [
      html(await sprzedaz.SalesTrendSlot(empty)),
      html(await sprzedaz.ProductsChartSlot(empty)),
      html(await sprzedaz.ProductsListSlot(empty)),
      html(await sprzedaz.RecentSalesSlot(empty)),
      html(await sprzedaz.SalesHeatmapSlot(empty)),
      html(await sprzedaz.ClientMoversSlot({ ...empty, mode: 'gainers' })),
      html(await sprzedaz.ClientSharesSlot(empty)),
    ]) {
      expect(out).toContain(POBIERAMY);
      expect(out).not.toContain('Wystaw fakturę');
    }
  });

  it('koszty: trend, koło, lista, ostatnie, kalendarz', async () => {
    for (const out of [
      html(await koszty.CostTrendSlot(empty)),
      html(await koszty.CostCategoriesChartSlot(empty)),
      html(await koszty.CostCategoriesListSlot(empty)),
      html(await koszty.RecentCostsSlot(empty)),
      html(await koszty.CostHeatmapSlot(empty)),
    ]) {
      expect(out).toContain(POBIERAMY);
    }
  });

  it('prawdziwe i puste: jak dotąd — sprzedaż „Wystaw fakturę”, koszty zwykły pusty miesiąc', async () => {
    const real = props({ invoices: [], invoice_line_items: [], expenses: [] }, 'prawdziwe');
    const sales = html(await sprzedaz.RecentSalesSlot(real));
    expect(sales).toContain('Wystaw fakturę');
    expect(sales).not.toContain(POBIERAMY);
    const costs = html(await koszty.RecentCostsSlot(real));
    expect(costs).toContain('Brak wydatków w tym miesiącu');
    expect(costs).not.toContain(POBIERAMY);
  });

  it('z danymi karta rysuje się normalnie także w „synchronizacji”', async () => {
    const withData = props({ invoices: [invoice('a')], invoice_line_items: [] }, 'synchronizacja');
    const out = html(await sprzedaz.RecentSalesSlot(withData));
    expect(out).toContain('FV/a');
    expect(out).not.toContain(POBIERAMY);
  });
});
