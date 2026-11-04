import { describe, expect, it } from 'vitest';

import { dailyTotals } from '@/lib/analytics-finance/breakdown';
import {
  costCategoryBreakdown,
  costMonthStats,
  costOfMonth,
  costTrend,
  costVatSummary,
  recentCosts,
} from '@/lib/analytics-finance/costs';
import { analyticsDataRange, monthKeysEnding } from '@/lib/analytics-finance/months';
import { recurringSuppliers } from '@/lib/analytics-finance/recurring';
import { getCosts, type CostEntry } from '@/lib/dashboard/costs';
import { KsefExpenseCurrencyNotSupportedError } from '@/lib/expenses/ksef-currency-review';

import { fakePostgrest, type Row } from '../helpers/fake-postgrest';

/**
 * Analiza kosztów `/analizy/koszty` (plan Finora P10, N2, N3). Agregaty to
 * czyste funkcje na wyniku `getCosts` (§2.4 pkt 12 — jedna droga kosztów,
 * KSEF_ENV = 'test'): wypływ brutto do kart wydatków, koszt KPiR do
 * „Przychody a koszty”, VAT do odliczenia według rodzaju dokumentu.
 */

const TENANT = 'firma-a';
const NOW = new Date('2026-10-17T10:00:00Z');
const TODAY = '2026-10-17';

let seq = 0;
function cost(fields: Partial<CostEntry> = {}): CostEntry {
  seq += 1;
  return {
    id: `e-${String(seq).padStart(5, '0')}`,
    issueDate: '2026-10-05',
    // Pola dodane przez E5/E6 do `CostEntry` (zbiorcze scalenie etapów).
    source: 'manual',
    documentNumber: null,
    sellerNip: '1234567890',
    sellerName: 'Dostawca',
    cost: 100,
    outflow: 123,
    vatDeductible: 23,
    categoryLabel: 'Biuro',
    vat: 23,
    isReviewed: true,
    ...fields,
  };
}

function expenseRow(id: string, fields: Row = {}): Row {
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
    net_amount: 10,
    vat_amount: 2.3,
    gross_amount: 12.3,
    vat_deductible_amount: 2.3,
    category_label: 'Biuro',
    ocr_extracted_data: null,
    ...fields,
  };
}

describe('getCosts → agregaty analizy (§2.4 pkt 12)', () => {
  it('ponad 1000 wydatków: Wydano liczy pełny miesiąc', async () => {
    const expenses = Array.from({ length: 1203 }, (_, i) => expenseRow(`e-${String(i).padStart(5, '0')}`));
    const entries = await getCosts(fakePostgrest({ expenses, invoices: [] }), TENANT, analyticsDataRange(NOW));
    const stats = costMonthStats(entries, '2026-10', '2026-09', TODAY);
    expect(stats.total).toBe(14796.9);
    expect(costOfMonth(entries, '2026-10')).toBe(12030);
  });

  it('wydatek ze skrzynki KSeF z innego środowiska nie wchodzi do analizy', async () => {
    const entries = await getCosts(fakePostgrest({
      expenses: [
        expenseRow('e-1'),
        expenseRow('e-2', { source: 'ksef_inbox', ksef_invoice_id: 'inv-prod', gross_amount: 9999 }),
      ],
      invoices: [{
        id: 'inv-prod', tenant_id: TENANT, direction: 'incoming', ksef_status: 'accepted',
        ksef_environment: 'production', currency: 'PLN',
      }],
    }), TENANT, analyticsDataRange(NOW));
    expect(costMonthStats(entries, '2026-10', '2026-09', TODAY).total).toBe(12.3);
  });

  it('koszt KSeF w EUR bez przeglądu i kursu zatrzymuje kartę (nie sumujemy EUR z PLN)', async () => {
    await expect(getCosts(fakePostgrest({
      expenses: [expenseRow('e-1', { source: 'ksef_inbox', ksef_invoice_id: 'inv-eur', is_reviewed: false })],
      invoices: [{
        id: 'inv-eur', tenant_id: TENANT, direction: 'incoming', ksef_status: 'accepted',
        ksef_environment: 'test', currency: 'EUR',
      }],
    }), TENANT, analyticsDataRange(NOW))).rejects.toBeInstanceOf(KsefExpenseCurrencyNotSupportedError);
  });

  it('wydatek bez prawa do kosztu (is_deductible = false) odpada już w zapytaniu', async () => {
    const entries = await getCosts(fakePostgrest({
      expenses: [expenseRow('e-1'), expenseRow('e-2', { is_deductible: false, gross_amount: 5000 })],
      invoices: [],
    }), TENANT, analyticsDataRange(NOW));
    expect(entries.map((e) => e.id)).toEqual(['e-1']);
  });
});

describe('costMonthStats — kafle P10', () => {
  it('Wydano, Średnio dziennie (bieżący miesiąc — dni do dziś), vs poprzedni, Największa kategoria', () => {
    const stats = costMonthStats([
      cost({ issueDate: '2026-09-10', outflow: 1000 }),
      cost({ outflow: 1020, categoryLabel: 'Paliwo' }),
      cost({ outflow: 680 }),
      cost({ outflow: -200, categoryLabel: 'Paliwo' }), // korekta zakupu
    ], '2026-10', '2026-09', TODAY);
    expect(stats.total).toBe(1500);
    expect(stats.avgDaily).toBe(88.24); // 1500 / 17 dni
    expect(stats.changePct).toBeCloseTo(50);
    expect(stats.topCategory).toBe('Paliwo'); // 1020 − 200 = 820 > 680
  });

  it('miesiąc miniony dzieli przez wszystkie dni; bez poprzedniego — brak procentu', () => {
    const stats = costMonthStats([cost({ issueDate: '2026-09-10', outflow: 300 })], '2026-09', '2026-08', TODAY);
    expect(stats.avgDaily).toBe(10);
    expect(stats.changePct).toBeNull();
  });

  it('pusty miesiąc: zero i bez kategorii', () => {
    expect(costMonthStats([], '2026-10', '2026-09', TODAY)).toEqual({
      total: 0, avgDaily: 0, changePct: null, topCategory: null,
    });
  });
});

describe('kategorie, trend, ostatnie, VAT', () => {
  it('top 5 + „Pozostałe” (suma reszty); brak kategorii to „Bez kategorii”', () => {
    const entries = [
      ...['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((label, i) => cost({ categoryLabel: label, outflow: 70 - i * 10 })),
      cost({ categoryLabel: null, outflow: 5 }),
      cost({ issueDate: '2026-09-01', categoryLabel: 'Z', outflow: 999 }),
    ];
    const slices = costCategoryBreakdown(entries, '2026-10');
    expect(slices.map((s) => [s.label, s.amount, s.other])).toEqual([
      ['A', 70, false], ['B', 60, false], ['C', 50, false], ['D', 40, false], ['E', 30, false],
      ['Pozostałe', 35, true],
    ]);
    expect(costCategoryBreakdown([cost({ categoryLabel: null })], '2026-10')[0]?.label).toBe('Bez kategorii');
  });

  it('trend 6 miesięcy po wypływie brutto', () => {
    const trend = costTrend([cost({ issueDate: '2026-05-31', outflow: 10 }), cost({ outflow: 5 })],
      monthKeysEnding('2026-10', 6));
    expect(trend.map((t) => t.amount)).toEqual([10, 0, 0, 0, 0, 5]);
  });

  it('ostatnie wydatki: od najnowszego, nazwa sprzedawcy albo „NIP …”', () => {
    const recent = recentCosts([
      cost({ id: 'a', issueDate: '2026-10-01' }),
      cost({ id: 'b', issueDate: '2026-10-09', sellerName: null }),
      cost({ id: 'c', issueDate: '2026-09-30' }),
    ], '2026-10');
    expect(recent.map((r) => [r.id, r.name])).toEqual([['b', 'NIP 1234567890'], ['a', 'Dostawca']]);
  });

  it('ostatnie wydatki: forma prawna skrócona jak w „Stałych kosztach” (§7.2)', () => {
    const name = 'Alfa spółka z ograniczoną odpowiedzialnością';
    const [recent] = recentCosts([cost({ sellerName: name })], '2026-10');
    const [recurring] = recurringSuppliers(
      [cost({ sellerName: name, issueDate: '2026-08-05' }), cost({ sellerName: name, issueDate: '2026-09-05' }), cost({ sellerName: name })],
      monthKeysEnding('2026-10', 3),
    );
    expect(recent?.name).toBe('Alfa sp. z o.o.');
    expect(recurring?.name).toBe(recent?.name);
  });

  it('kategorie różniące się wielkością liter to jedna kategoria', () => {
    const entries = [
      cost({ categoryLabel: 'Paliwo', outflow: 600 }),
      cost({ categoryLabel: 'paliwo', outflow: 500 }),
      cost({ categoryLabel: 'Biuro', outflow: 800 }),
    ];
    const slices = costCategoryBreakdown(entries, '2026-10');
    expect(slices.map((s) => [s.label, s.amount])).toEqual([['Paliwo', 1100], ['Biuro', 800]]);
    expect(new Set(slices.map((s) => s.key)).size).toBe(slices.length);
    expect(costMonthStats(entries, '2026-10', '2026-09', TODAY).topCategory).toBe('Paliwo');
  });

  it('VAT z wydatków: naliczony, do odliczenia (reguła dokumentu z getCosts), do opisania', () => {
    expect(costVatSummary([
      cost({ vat: 23, vatDeductible: 23 }),
      cost({ vat: 46, vatDeductible: 0, isReviewed: false }), // paragon
      cost({ issueDate: '2026-09-01', vat: 1000, isReviewed: false }),
    ], '2026-10')).toEqual({ vat: 69, vatDeductible: 23, toReview: 1 });
  });

  it('kalendarz: suma na dzień przez 180 dni, dni bez wydatków to zero', () => {
    const days = dailyTotals(
      [cost({ issueDate: '2026-10-17', outflow: 10 }), cost({ issueDate: '2026-10-17', outflow: 5 }), cost({ issueDate: '2026-01-01' })],
      (e) => e.issueDate, (e) => e.outflow, TODAY, 180,
    );
    expect(days).toHaveLength(180);
    expect(days[0]?.date).toBe('2026-04-21');
    expect(days.at(-1)).toEqual({ date: '2026-10-17', amount: 15 });
  });
});

describe('recurringSuppliers — N3 stałe koszty', () => {
  const months = monthKeysEnding('2026-10', 4);

  it('dostawca w ≥ 3 z 4 miesięcy; paragon bez NIP-u po nazwie; nazwa skrócona', () => {
    const rows = [
      ...['2026-07-10', '2026-08-12', '2026-09-11'].map((issueDate) =>
        cost({ issueDate, sellerNip: '111-111-11-11', sellerName: 'Hosting spółka z ograniczoną odpowiedzialnością', outflow: 123 })),
      ...['2026-08-01', '2026-09-03', '2026-10-02'].map((issueDate) =>
        cost({ issueDate, sellerNip: null, sellerName: 'Stacja Paliw', outflow: 200 })),
      ...['2026-09-01', '2026-10-01'].map((issueDate) => cost({ issueDate, sellerNip: '999', outflow: 5000 })),
    ];
    expect(recurringSuppliers(rows, months)).toEqual([
      { key: 'name:stacja paliw', name: 'Stacja Paliw', averageAmount: 200, typicalDay: 2, months: 3 },
      { key: 'nip:1111111111', name: 'Hosting sp. z o.o.', averageAmount: 123, typicalDay: 11, months: 3 },
    ]);
  });
});
