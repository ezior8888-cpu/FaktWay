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
const { costVatRows } = await import('@/components/analizy/adapters');

/**
 * E7 pkt 3 dla Analiz (PLAN-PRAWDZIWE-DANE): wiersze „Ostatnie faktury /
 * wydatki” i „Do opisania” prowadzą do dokumentów — tylko na prawdziwych
 * danych (id z przykładu nie istnieją w bazie). Wygląd bez zmian.
 */

const TENANT = 'firma-a';
const NOW_ISO = '2026-10-17T10:00:00.000Z';

const html = (node: ReactNode) => renderToStaticMarkup(<>{node}</>).replace(/<!-- -->/g, '');

const invoice = (id: string): Row => ({
  id, tenant_id: TENANT, direction: 'outgoing', ksef_status: 'accepted', ksef_environment: 'test',
  invoice_kind: 'regular', advance_invoice_ids: [], currency: 'PLN', issue_date: '2026-10-05',
  internal_number: `FV/${id}`, net_total: 1000, gross_total: 1230, buyer_nip: '1234567890',
  buyer_data: { name: 'Klient Testowy' }, is_b2c: false, origin: 'app', invoice_type: 'VAT',
  payment_status: 'unpaid', payment_due_date: '2026-10-01', paid_amount: 0,
});

const expense = (id: string): Row => ({
  id, tenant_id: TENANT, source: 'manual', ksef_invoice_id: null, issue_date: '2026-10-05',
  seller_nip: '5555555555', seller_name: 'Dostawca', is_deductible: true, is_reviewed: false,
  document_type: 'invoice', net_amount: 100, vat_amount: 23, gross_amount: 123,
  vat_deductible_amount: 23, category_label: 'Biuro', ocr_extracted_data: null,
});

const props = (tables: Record<string, Row[]>, tryb: 'przyklad' | 'prawdziwe') => ({
  supabase: fakePostgrest(tables), tenantId: TENANT, nowIso: NOW_ISO, month: '2026-10', tryb,
});

describe('E7 pkt 3: wiersze Analiz jako linki do dokumentów', () => {
  it('Ostatnie faktury: nazwa klienta prowadzi do /invoices/[id] (prawdziwe)', async () => {
    const out = html(await sprzedaz.RecentSalesSlot(props({ invoices: [invoice('a')], invoice_line_items: [] }, 'prawdziwe')));
    expect(out).toContain('href="/invoices/a"');
  });

  it('Ostatnie faktury w przykładzie: bez linków', async () => {
    const out = html(await sprzedaz.RecentSalesSlot(props({ invoices: [invoice('a')], invoice_line_items: [] }, 'przyklad')));
    expect(out).toContain('Klient Testowy');
    expect(out).not.toContain('href=');
  });

  it('Ostatnie wydatki: dostawca prowadzi do /expenses/[id] (prawdziwe), w przykładzie bez linku', async () => {
    const real = html(await koszty.RecentCostsSlot(props({ expenses: [expense('e1')], invoices: [] }, 'prawdziwe')));
    expect(real).toContain('href="/expenses/e1"');
    const demo = html(await koszty.RecentCostsSlot(props({ expenses: [expense('e1')], invoices: [] }, 'przyklad')));
    expect(demo).toContain('Dostawca');
    expect(demo).not.toContain('href=');
  });

  it('„Do opisania” w VAT z wydatków: lista nieopisanych wybranego miesiąca (prawdziwe), bez linku w przykładzie', async () => {
    const real = html(await koszty.CostVatSlot(props({ expenses: [expense('e1')], invoices: [] }, 'prawdziwe')));
    expect(real).toContain('href="/expenses?filter=unreviewed&amp;miesiac=2026-10"');
    const demo = html(await koszty.CostVatSlot(props({ expenses: [expense('e1')], invoices: [] }, 'przyklad')));
    expect(demo).toContain('Do opisania');
    expect(demo).not.toContain('href=');
  });

  it('wygląd bez zmian: link bez własnych klas (ani `hover:underline`), jak nazwy w kartach Przepływów', async () => {
    const sales = html(await sprzedaz.RecentSalesSlot(props({ invoices: [invoice('a')], invoice_line_items: [] }, 'prawdziwe')));
    expect(sales).toContain('<a href="/invoices/a">Klient Testowy</a>');
    const vat = html(await koszty.CostVatSlot(props({ expenses: [expense('e1')], invoices: [] }, 'prawdziwe')));
    expect(vat).toMatch(/<a href="\/expenses\?filter=unreviewed&amp;miesiac=2026-10">[^<]+<\/a>/);
    expect(sales + vat).not.toContain('hover:underline');
  });

  it('adapter: link dostaje tylko wiersz „Do opisania”', () => {
    const rows = costVatRows({ vat: 23, vatDeductible: 23, toReview: 2 }, '/expenses?filter=unreviewed&miesiac=2026-10');
    expect(rows.map((r) => r.href ?? null)).toEqual([null, null, '/expenses?filter=unreviewed&miesiac=2026-10']);
    expect(costVatRows({ vat: 0, vatDeductible: 0, toReview: 0 }).every((r) => !r.href)).toBe(true);
  });
});
