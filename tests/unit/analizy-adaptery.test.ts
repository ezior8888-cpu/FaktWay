import {
  RiAlarmWarningLine,
  RiBox3Line,
  RiCalendarLine,
  RiCarLine,
  RiFileEditLine,
  RiFileList3Line,
  RiHourglassLine,
  RiMoneyDollarCircleLine,
  RiMoreLine,
  RiPercentLine,
  RiPriceTag3Line,
  RiReceiptLine,
  RiRepeatLine,
  RiTimeLine,
} from '@remixicon/react';
import { describe, expect, it } from 'vitest';

import {
  costVatRows,
  incomeExpenseNet,
  isAllZero,
  isOtherSlice,
  RECURRING_LIST_LIMIT,
  receivablesRows,
  receivablesRowsPrzyklad,
  recentCostItems,
  recentSaleItems,
  salesAvgDaily,
  toCategorySlices,
  toRankedItems,
  toSubscriptionItems,
  toTrendData,
} from '@/components/analizy/adapters';
import { costCategoryIcon } from '@/components/analizy/finora-1do1/expense-category-icons';
import type { BreakdownSlice } from '@/lib/analytics-finance/breakdown';
import { costTrend } from '@/lib/analytics-finance/costs';
import { monthKeysEnding } from '@/lib/analytics-finance/months';
import { recurringClients } from '@/lib/analytics-finance/recurring';
import type { SaleInvoice } from '@/lib/analytics-finance/sales';
import type { CostEntry } from '@/lib/dashboard/costs';

/**
 * Adaptery `/analizy/*` (poprawka Bartosza 21.10.2026: Analizy 1:1 z Finory):
 * prawdziwe dane z `lib/analytics-finance` → kształty kart Finory. Adapter
 * niczego nie liczy od nowa — tylko przekłada pola, dobiera ikonę i formatuje
 * wiersze. Każdy przypadek tu pada, gdy adapter zgubi albo zmyśli liczbę.
 */

let seq = 0;

function cost(over: Partial<CostEntry> = {}): CostEntry {
  seq += 1;
  return {
    id: `c-${String(seq).padStart(3, '0')}`,
    issueDate: '2026-10-05',
    source: 'manual',
    sellerNip: '1234567890',
    sellerName: 'Dostawca spółka z ograniczoną odpowiedzialnością',
    cost: 100,
    outflow: 123,
    vatDeductible: 23,
    categoryLabel: 'Paliwo',
    vat: 23,
    documentNumber: null,
    isReviewed: true,
    ...over,
  };
}

function sale(over: Partial<SaleInvoice> = {}): SaleInvoice {
  seq += 1;
  return {
    id: `s-${String(seq).padStart(3, '0')}`,
    issueDate: '2026-10-05',
    number: 'FV/1/10/2026',
    kind: 'regular',
    net: 1000,
    documentGross: 1230,
    buyer_nip: '1234567890',
    buyer_data: { name: 'Klient Testowy spółka akcyjna' },
    is_b2c: false,
    origin: 'app',
    invoiceType: 'VAT',
    ...over,
  };
}

describe('trend', () => {
  it('podpis miesiąca → `month`, kwota bez zmian (także ujemna po korekcie)', () => {
    expect(
      toTrendData([
        { key: '2026-09', label: 'Wrz', amount: 0 },
        { key: '2026-10', label: 'Paź', amount: -230.5 },
      ]),
    ).toEqual([
      { month: 'Wrz', amount: 0 },
      { month: 'Paź', amount: -230.5 },
    ]);
  });

  it('z prawdziwego `costTrend`: 6 słupków, jeden miesiąc z kwotą to NIE pusto (D8)', () => {
    const data = toTrendData(costTrend([cost({ outflow: 99 })], monthKeysEnding('2026-10', 6)));
    expect(data).toHaveLength(6);
    expect(data.at(-1)).toEqual({ month: 'Paź', amount: 99 });
    expect(isAllZero(data)).toBe(false);
  });

  it('pusto tylko, gdy wszystkie kwoty to zero — miesiąc ujemny to dane, nie brak', () => {
    expect(isAllZero([{ month: 'Wrz', amount: 0 }, { month: 'Paź', amount: 0 }])).toBe(true);
    expect(isAllZero([{ month: 'Wrz', amount: 0 }, { month: 'Paź', amount: -10 }])).toBe(false);
  });
});

describe('koło i ranking', () => {
  const slices: BreakdownSlice[] = [
    { key: 'kat:paliwo', label: 'Paliwo', amount: 600, percentage: 60, other: false },
    { key: 'kat:biuro', label: 'Materiały biurowe', amount: 300, percentage: 30, other: false },
    { key: 'pozostale', label: 'Pozostałe', amount: 100, percentage: 10, other: true },
  ];

  it('klucz serii bezpieczny dla CSS i kolor po miejscu; „Pozostałe” na końcu, muted-foreground', () => {
    // Świadoma zmiana: Analizy 1:1 z Finory (21.10.2026) — „Pozostałe” dostaje
    // klucz po miejscu ('s2'), nie 'other': legenda recharts sortuje po kluczu
    // i 'other' < 's0' stawiało „Pozostałe” na początku legendy.
    expect(toCategorySlices(slices)).toEqual([
      { category: 's0', label: 'Paliwo', amount: 600, percentage: 60, color: 'var(--chart-1)' },
      { category: 's1', label: 'Materiały biurowe', amount: 300, percentage: 30, color: 'var(--chart-2)' },
      { category: 's2', label: 'Pozostałe', amount: 100, percentage: 10, color: 'var(--muted-foreground)' },
    ]);
  });

  it('legenda recharts sortuje po kluczu — kolejność kluczy = kolejność rankingu, „Pozostałe” ostatnie', () => {
    // recharts 3 (`Legend` `itemSorter: 'value'`) układa pozycje koła po
    // wartości `nameKey`, czyli po naszym kluczu. Top 5 + „Pozostałe” (lib).
    const topWithRest: BreakdownSlice[] = [
      ...Array.from({ length: 5 }, (_, i): BreakdownSlice => ({
        key: `k${i}`, label: `Kategoria ${i + 1}`, amount: 100 - i * 10, percentage: 15, other: false,
      })),
      { key: 'pozostale', label: 'Pozostałe', amount: 25, percentage: 25, other: true },
    ];
    const keys = toCategorySlices(topWithRest).map((s) => s.category);
    expect([...keys].sort()).toEqual(keys);
    const legend = [...toCategorySlices(topWithRest)].sort((a, b) => (a.category < b.category ? -1 : 1));
    expect(legend.at(-1)?.label).toBe('Pozostałe');
    expect(legend.map((s) => isOtherSlice(s))).toEqual([false, false, false, false, false, true]);
  });

  it('kolory `chart-1…5` zawijają się po piątym miejscu', () => {
    const many = Array.from({ length: 6 }, (_, i): BreakdownSlice => ({
      key: `k${i}`, label: `P${i}`, amount: 10 - i, percentage: 10, other: false,
    }));
    expect(toCategorySlices(many).map((s) => s.color)).toEqual([
      'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-1)',
    ]);
  });

  it('ranking: te same wycinki z ikoną z `iconOf` (kategoria kosztu → ikona Finory)', () => {
    const ranked = toRankedItems(toCategorySlices(slices), (s) => costCategoryIcon(s.label));
    expect(ranked.map((r) => [r.label, r.amount, r.icon])).toEqual([
      ['Paliwo', 600, RiCarLine],
      ['Materiały biurowe', 300, costCategoryIcon('Materiały biurowe')],
      ['Pozostałe', 100, RiMoreLine],
    ]);
    const products = toRankedItems(toCategorySlices(slices), (s) => (isOtherSlice(s) ? RiMoreLine : RiBox3Line));
    expect(products.map((r) => r.icon)).toEqual([RiBox3Line, RiBox3Line, RiMoreLine]);
  });
});

describe('„Średnio dziennie” sprzedaży (D9 — reguła dni jak w kosztach)', () => {
  it('bieżący miesiąc: dzielone przez dni do dziś', () => {
    expect(salesAvgDaily(1700, '2026-10', '2026-10-17')).toBe(100);
  });

  it('miniony miesiąc: przez wszystkie jego dni', () => {
    expect(salesAvgDaily(3000, '2026-09', '2026-10-17')).toBe(100);
    expect(salesAvgDaily(1000, '2026-09', '2026-10-17')).toBe(33.33);
  });

  it('zero i korekta in minus', () => {
    expect(salesAvgDaily(0, '2026-10', '2026-10-17')).toBe(0);
    expect(Object.is(salesAvgDaily(0, '2026-10', '2026-10-17'), -0)).toBe(false);
    expect(salesAvgDaily(-170, '2026-10', '2026-10-17')).toBe(-10);
  });
});

describe('ostatnie wydatki i faktury', () => {
  it('wydatki: tylko wybrany miesiąc, najnowsze, data DD.MM.RRRR, wypływ brutto, ikona z kategorii', () => {
    const entries = [
      cost({ id: 'a', issueDate: '2026-10-03', categoryLabel: 'Paliwo', outflow: 200 }),
      cost({ id: 'b', issueDate: '2026-10-09', categoryLabel: null, sellerName: null, sellerNip: '1234567890', outflow: 50 }),
      cost({ id: 'c', issueDate: '2026-10-07', categoryLabel: 'Coś nowego', outflow: 10 }),
      cost({ id: 'z', issueDate: '2026-09-30', outflow: 999 }),
    ];
    expect(recentCostItems(entries, '2026-10')).toEqual([
      { id: 'b', merchant: 'NIP 1234567890', subtitle: '09.10.2026', amount: 50, icon: RiMoreLine },
      { id: 'c', merchant: 'Dostawca sp. z o.o.', subtitle: '07.10.2026', amount: 10, icon: RiPriceTag3Line },
      { id: 'a', merchant: 'Dostawca sp. z o.o.', subtitle: '03.10.2026', amount: 200, icon: RiCarLine },
    ]);
  });

  it('faktury: nabywca, „numer · data”, brutto dokumentu, ikona dokumentu', () => {
    const [item] = recentSaleItems([sale({ id: 'x' })], '2026-10');
    expect(item).toEqual({
      id: 'x',
      merchant: 'Klient Testowy S.A.',
      subtitle: 'FV/1/10/2026 · 05.10.2026',
      amount: 1230,
      icon: RiFileList3Line,
    });
  });

  it('korekta: „Korekta · numer · data” i ujemne brutto bez zmian; faktura bez numeru — sama data', () => {
    const items = recentSaleItems(
      [
        sale({ id: 'k', issueDate: '2026-10-08', kind: 'correction', number: 'KOR/1', net: -1000, documentGross: -1230 }),
        sale({ id: 'n', issueDate: '2026-10-02', number: null }),
      ],
      '2026-10',
    );
    expect(items.map((i) => [i.subtitle, i.amount])).toEqual([
      ['Korekta · KOR/1 · 08.10.2026', -1230],
      ['02.10.2026', 1230],
    ]);
  });
});

describe('stałe koszty i stali klienci (N3 → Finora „Subscriptions”)', () => {
  const months = monthKeysEnding('2026-10', 4);

  it('wiersz: klucz, nazwa, ikona powtarzalności, średnia, typowy dzień, „Średnio / mies.”', () => {
    expect(
      toSubscriptionItems([{ key: 'nip:1', name: 'Hosting sp. z o.o.', averageAmount: 123, typicalDay: 11, months: 3 }], 'supplier'),
    ).toEqual([
      {
        id: 'nip:1',
        name: 'Hosting sp. z o.o.',
        icon: RiRepeatLine,
        amount: 123,
        renewsLabel: 'Zwykle ok. 11. dnia miesiąca',
        billingCycle: 'Średnio / mies.',
        action: null,
      },
    ]);
  });

  it('„Zrób fakturę cykliczną” tylko przy kliencie z fakturą-wzorem', () => {
    const [withTemplate, withoutTemplate] = toSubscriptionItems(
      [
        { key: 'nip:1', name: 'Stały S.A.', averageAmount: 200, typicalDay: 6, months: 3, templateInvoiceId: 'wzor-1' },
        { key: 'nip:2', name: 'Inny', averageAmount: 50, typicalDay: 2, months: 3 },
      ],
      'client',
    );
    expect(withTemplate?.action).toEqual({
      href: '/invoices/recurring?wzor=wzor-1',
      label: 'Zrób fakturę cykliczną',
      ariaLabel: 'Zrób fakturę cykliczną dla: Stały S.A.',
    });
    expect(withoutTemplate?.action).toBeNull();
  });

  it('dostawca nigdy nie dostaje akcji faktury cyklicznej, nawet z polem wzoru', () => {
    const [item] = toSubscriptionItems(
      [{ key: 'nip:1', name: 'Dostawca', averageAmount: 1, typicalDay: 1, months: 3, templateInvoiceId: 'x' }],
      'supplier',
    );
    expect(item?.action).toBeNull();
  });

  it('„Konsumenci” z prawdziwego `recurringClients` — bez akcji', () => {
    const rows = ['2026-07-05', '2026-08-05', '2026-09-05'].map((d, i) =>
      sale({ issueDate: d, is_b2c: true, buyer_nip: null, buyer_data: { name: `Osoba ${i}` } }),
    );
    const [item] = toSubscriptionItems(recurringClients(rows, months), 'client');
    expect(item?.name).toBe('Konsumenci');
    expect(item?.action).toBeNull();
  });

  it('limit listy = 6 wierszy jak w Finorze (argument wywołania; domyślne 5 z lib zostaje)', () => {
    expect(RECURRING_LIST_LIMIT).toBe(6);
    const rows = Array.from({ length: 7 }, (_, i) =>
      ['2026-08-05', '2026-09-05', '2026-10-05'].map((d) =>
        sale({ issueDate: d, buyer_nip: null, buyer_data: { name: `Klient ${i + 1}` }, net: 100 + i })),
    ).flat();
    expect(recurringClients(rows, months)).toHaveLength(5);
    expect(toSubscriptionItems(recurringClients(rows, months, RECURRING_LIST_LIMIT), 'client')).toHaveLength(6);
  });
});

describe('przychody a koszty', () => {
  it('wynik = przychody − koszty, do groszy (także ujemny, bez szumu zmiennoprzecinkowego)', () => {
    expect(incomeExpenseNet(1000, 1500.5)).toEqual({ income: 1000, expense: 1500.5, net: -500.5 });
    expect(incomeExpenseNet(0.3, 0.1).net).toBe(0.2);
    expect(Object.is(incomeExpenseNet(0, 0).net, -0)).toBe(false);
  });
});

describe('wiersze w miejscu „Spending Streaks”', () => {
  it('VAT z wydatków: kwoty po polsku, „Do opisania” czerwone, gdy jest co opisać', () => {
    const rows = costVatRows({ vat: 46, vatDeductible: 23, toReview: 2 });
    expect(rows.map((r) => [r.title, r.value, r.icon, r.iconClassName])).toEqual([
      ['VAT naliczony', '46,00 zł', RiReceiptLine, 'text-foreground'],
      ['VAT do odliczenia', '23,00 zł', RiPercentLine, 'text-primary'],
      ['Do opisania', '2 dokumenty', RiFileEditLine, 'text-destructive'],
    ]);
    expect(costVatRows({ vat: 0, vatDeductible: 0, toReview: 0 })[2]).toMatchObject({
      value: '0 dokumentów',
      iconClassName: 'text-foreground',
    });
  });

  // D-W odwołane 02.11.2026: faktura bez wpłaty z minionym terminem to należność po terminie, nie wpływ.
  it('należności: do zapłaty, po terminie (czerwone) i najstarsza zaległość', () => {
    const rows = receivablesRows({ total: 13_575.6, count: 6, overdue: 1230, overdueCount: 1, oldestOverdueDays: 12 });
    expect(rows.map((r) => [r.title, r.value, r.icon, r.iconClassName])).toEqual([
      ['Do zapłaty', '13\u00a0575,60 zł · 6 faktur', RiMoneyDollarCircleLine, 'text-foreground'],
      ['Po terminie', '1230,00 zł · 1 faktura', RiAlarmWarningLine, 'text-destructive'],
      ['Najstarsza zaległość', '12 dni', RiHourglassLine, 'text-foreground'],
    ]);
    const bezZaleglosci = receivablesRows({ total: 100, count: 1, overdue: 0, overdueCount: 0, oldestOverdueDays: null });
    expect(bezZaleglosci.map((r) => [r.title, r.value, r.iconClassName])).toEqual([
      ['Do zapłaty', '100,00 zł · 1 faktura', 'text-foreground'],
      ['Po terminie', '0,00 zł · 0 faktur', 'text-foreground'],
      ['Najstarsza zaległość', 'Brak zaległości', 'text-foreground'],
    ]);
  });

  // Dane przykładowe nie mają wpłat (`lib/demo`): ich należności to same przyszłe terminy.
  it('należności w danych przykładowych: trzy przedziały terminów, kwota i liczba faktur, ikony bez czerwieni', () => {
    const rows = receivablesRowsPrzyklad({
      total: 13_575.6,
      count: 6,
      buckets: [
        { key: 'thisWeek', label: 'x', amount: 12_345.6, count: 5, pct: 91 },
        { key: 'upTo30', label: 'x', amount: 1230, count: 1, pct: 9 },
        { key: 'later', label: 'x', amount: 0, count: 0, pct: 0 },
      ],
    });
    expect(rows.map((r) => [r.title, r.value, r.icon, r.iconClassName])).toEqual([
      // Separator tysięcy z `toLocaleString('pl-PL')` to twarda spacja (U+00A0).
      ['Ten tydzień', '12\u00a0345,60 zł · 5 faktur', RiCalendarLine, 'text-foreground'],
      ['Do 30 dni', '1230,00 zł · 1 faktura', RiTimeLine, 'text-foreground'],
      ['Później', '0,00 zł · 0 faktur', RiHourglassLine, 'text-foreground'],
    ]);
  });
});
