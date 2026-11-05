import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
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
const { ANALIZY_EMPTY } = await import('@/components/analizy/finora/empty');

/**
 * Karty `/analizy/*` od odczytu do HTML (plan Finora §2.4 pkt 15): każda
 * karta sama pobiera dane, a strażnik, który rzuci (faktura w EUR, przyjęta
 * faktura bez środowiska), zabiera tylko TĘ kartę — z polską treścią
 * wyjątku — a karty kosztów działają dalej. KSEF_ENV = 'test'.
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

function props(tables: Record<string, Row[]>, month = '2026-10') {
  // Tryb danych strony (`kontekstDanych`): bez KSeF = przykład; tu karty czytają podaną bazę.
  const tryb = verified.value ? ('prawdziwe' as const) : ('przyklad' as const);
  return { supabase: fakePostgrest(tables), tenantId: TENANT, nowIso: NOW_ISO, month, tryb };
}

describe('karty analizy sprzedaży', () => {
  it('z danymi: kafle, ostatnia faktura i należności z zaległościami', async () => {
    const p = props({ invoices: [invoice('a')], invoice_line_items: [] });
    const stats = html(await sprzedaz.SalesStatsSlot(p));
    expect(stats).toContain('Sprzedano (netto)');
    expect(stats).toContain('Klient Testowy');

    const recent = html(await sprzedaz.RecentSalesSlot(p));
    expect(recent).toContain('FV/a · 05.10.2026');

    // D-W odwołane 02.11.2026: termin 01.10 minął, a wpłaty nie ma, więc to należność po terminie.
    const receivables = html(await sprzedaz.ReceivablesSlot(props({
      invoices: [invoice('a'), invoice('b', { payment_due_date: '2026-10-20' })],
    })));
    expect(receivables).toContain('Do zapłaty');
    expect(receivables).toContain('2460,00 zł · 2 faktury');
    expect(receivables).toContain('Po terminie');
    expect(receivables).toContain('1230,00 zł · 1 faktura');
    expect(receivables).toContain('Najstarsza zaległość');
  });

  it('faktura w EUR zabiera karty sprzedaży z polską treścią, karty kosztów działają', async () => {
    const p = props({ invoices: [invoice('a'), invoice('eur', { currency: 'EUR' })], expenses: [expense('e')] });
    const stats = html(await sprzedaz.SalesStatsSlot(p));
    expect(stats).toContain('Raport wstrzymany: faktura sprzedaży nie ma potwierdzonej waluty PLN.');
    expect(stats).toContain('href="/przeplywy"');

    const costs = html(await koszty.CostStatsSlot(p));
    expect(costs).toContain('Dokumenty (brutto)');
    expect(costs).not.toContain('Raport wstrzymany');
  });

  it('korekta in minus w „Ostatnich fakturach”: podpis „Korekta” i minus typograficzny', async () => {
    const p = props({
      invoices: [invoice('kor', { invoice_kind: 'correction', internal_number: 'KOR/1', net_total: -1000, gross_total: -1230 })],
      invoice_line_items: [],
    });
    const recent = html(await sprzedaz.RecentSalesSlot(p));
    expect(recent).toContain('Korekta · KOR/1 · 05.10.2026');
    expect(recent).toContain('\u22121230,00 zł');
    expect(recent).toContain('text-destructive');
  });

  it('przyjęta faktura bez środowiska: komunikat strażnika na karcie', async () => {
    const p = props({ invoices: [invoice('x', { ksef_environment: null })] });
    expect(html(await sprzedaz.SalesTrendSlot(p))).toContain('Przyjęte faktury wymagają uzgodnienia środowiska KSeF');
  });

  it('bez faktur: pusty stan „wystaw pierwszą fakturę”', async () => {
    const p = props({ invoices: [], invoice_line_items: [] });
    expect(html(await sprzedaz.RecentSalesSlot(p))).toContain(ANALIZY_EMPTY.noInvoices.message);
    expect(html(await sprzedaz.ProductsChartSlot(p))).toContain(ANALIZY_EMPTY.noInvoices.message);
    expect(html(await sprzedaz.ClientMoversSlot({ ...p, mode: 'losers' }))).toContain(ANALIZY_EMPTY.noInvoices.message);
  });
});

describe('karty analizy kosztów', () => {
  it('VAT z wydatków i ostatnie wydatki z tego samego odczytu', async () => {
    const p = props({ expenses: [expense('e1'), expense('e2', { document_type: 'receipt' })], invoices: [] });
    const vat = html(await koszty.CostVatSlot(p));
    expect(vat).toContain('46,00 zł'); // VAT naliczony z obu
    expect(vat).toContain('23,00 zł'); // do odliczenia tylko z faktury
    expect(vat).toContain('2 dokumenty');
    expect(html(await koszty.RecentCostsSlot(p))).toContain('Dostawca');
  });

  it('firma bez KSeF i bez wydatków: „Podłącz KSeF”', async () => {
    verified.value = false;
    try {
      const out = html(await koszty.CostCategoriesChartSlot(props({ expenses: [], invoices: [] })));
      expect(out).toContain(ANALIZY_EMPTY.connectKsef.message);
      expect(out).toContain('href="/settings/ksef"');
    } finally {
      verified.value = true;
    }
  });

  it('z KSeF, ale bez wydatków w miesiącu: zwykły pusty stan', async () => {
    const out = html(await koszty.RecentCostsSlot(props({ expenses: [expense('e', { issue_date: '2026-09-01' })], invoices: [] })));
    expect(out).toContain(ANALIZY_EMPTY.noCostsThisMonth.message);
  });

  it('strony /analizy/* nie wołają odczytów §2.4 same — robią to karty w Suspense (§2.4 pkt 15)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const page of ['koszty', 'sprzedaz']) {
      const source = readFileSync(join(process.cwd(), 'app', '(dashboard)', 'analizy', page, 'page.tsx'), 'utf8');
      expect(source, page).not.toMatch(
        /getCosts|getSalesInvoices|getReceivables|fetchProductLines|getSalesSeries|getMonthlyFigures|lib\/dashboard\//,
      );
    }
  });

  it('przychody a koszty: sprzedaż netto i koszt KPiR wybranego miesiąca', async () => {
    const out = html(await koszty.CostIncomeExpenseSlot(props({ invoices: [invoice('a')], expenses: [expense('e')] })));
    expect(out).toContain('1000,00 zł');
    expect(out).toContain('100,00 zł');
    expect(out).toContain('900,00 zł');
  });
});
