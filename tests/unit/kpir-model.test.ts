import { describe, expect, it } from 'vitest';

import {
  blockingSaleInvoices,
  buildKpirEntries,
  COLUMN_BADGE_TEXT,
  COLUMN_FILTER_LABELS,
  COLUMN_FILTER_ORDER,
  costSlices,
  entryMatchesSearch,
  formatZlCompact,
  kpirAxisTicks,
  kpirDailySeries,
  kpirMonthTitle,
  kpirPeriodFromParams,
  marginPct,
  nonDeductedVatSum,
  uncountedCosts,
} from '@/components/reports/kpir/kpir-model';
import { assertOutgoingInvoicesInPln } from '@/lib/exports/currency-guard';
import { formatPlCompactMoney } from '@/lib/format/pl';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { resolveKpirPeriod } from '@/lib/reports/kpir-data';
import { kpirTotals, type KpirExpenseRow, type KpirInvoiceRow } from '@/lib/reports/kpir-totals';

/**
 * Model ekranu KPiR (poprawka Bartosza 21.10.2026: przeprojektowanie
 * Księgowości). Nowe liczby ekranu — wykres narastający, pierścień kosztów,
 * notka „poza sumą” — muszą się zgadzać z `kpirTotals`, z których liczą
 * Pulpit, Przepływy i eksport. Lp. i daty sprzedaży jak dotąd.
 */

const sprzedaz = (o: Partial<KpirInvoiceRow> & { currency?: string | null }): KpirInvoiceRow => ({
  id: 'fv', internal_number: 'FV/1', issue_date: '2026-09-05', sale_date: null, gross_total: 1230,
  net_total: 1000, buyer_data: { name: 'Klient', nip: '1234567890' }, invoice_kind: 'regular',
  settled_advances_net: null, ...o,
});

const koszt = (o: Partial<KpirExpenseRow>): KpirExpenseRow => ({
  id: 'exp', issue_date: '2026-09-03', seller_name: 'Dostawca', seller_nip: '5260001246', document_number: 'ZAK/7',
  category_label: 'Paliwo', kpir_column: 'col_13', is_deductible: true, net_amount: 100, vat_amount: 23,
  gross_amount: 123, vat_deductible_amount: 23, document_type: 'invoice', ...o,
} as KpirExpenseRow);

const WRZESIEN = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };

describe('kpirDailySeries — przychody i koszty narastająco', () => {
  const invoices = [
    sprzedaz({ id: 'a', issue_date: '2026-09-03', sale_date: '2026-08-31', net_total: 1000 }), // sprzedaż sprzed okresu
    sprzedaz({ id: 'roz', issue_date: '2026-09-10', invoice_kind: 'final', net_total: 5000, settled_advances_net: 2000 }),
    sprzedaz({ id: 'kor', issue_date: '2026-09-20', invoice_kind: 'correction', net_total: -300 }),
  ];
  const expenses = [
    koszt({ id: 'k1', issue_date: '2026-09-02', document_type: 'receipt', net_amount: 100, vat_amount: 23 }), // 123
    koszt({ id: 'k2', issue_date: '2026-09-12', kpir_column: 'col_10', net_amount: 400.1, vat_amount: 92.02, vat_deductible_amount: 92.02 }),
    koszt({ id: 'k3', issue_date: '2026-09-15', kpir_column: 'col_15', net_amount: 0.1 }),
    koszt({ id: 'k4', issue_date: '2026-09-15', kpir_column: 'col_15', net_amount: 0.2 }),
    koszt({ id: 'bez', issue_date: '2026-09-05', kpir_column: null, net_amount: 9999 }),
    koszt({ id: 'poza', issue_date: '2026-09-06', kpir_column: 'col_16', net_amount: 7777 }),
  ];

  it('ostatni punkt miesiąca = sumy kpirTotals (przychód i koszty)', () => {
    const series = kpirDailySeries({ invoices, expenses, ...WRZESIEN, today: '2026-10-21' });
    const totals = kpirTotals(expenses, invoices);
    expect(series).toHaveLength(30);
    expect(series.at(-1)!.revenue).toBeCloseTo(totals.totalRevenue, 2);
    expect(series.at(-1)!.costs).toBeCloseTo(totals.totalExpenses, 2);
    // 1000 + (5000 − 2000) − 300; koszty 123 + 400,10 + 0,30 — bez 9999 i 7777 spoza sum.
    expect(series.at(-1)).toMatchObject({ day: 30, date: '2026-09-30', revenue: 3700, costs: 523.4 });
  });

  it('sprzedaż z wcześniejszego okresu liczy się od 1. dnia', () => {
    const series = kpirDailySeries({ invoices, expenses: [], ...WRZESIEN, today: '2026-10-21' });
    expect(series[0]).toMatchObject({ day: 1, revenue: 1000 });
    expect(series[8]).toMatchObject({ day: 9, revenue: 1000 });
    expect(series[9]).toMatchObject({ day: 10, revenue: 4000 });
  });

  it('koszty poza sumą (bez kolumny, kol. 16) nie wchodzą do serii', () => {
    const series = kpirDailySeries({
      invoices: [], expenses: [koszt({ kpir_column: null }), koszt({ id: 'x', kpir_column: 'col_16' })],
      ...WRZESIEN, today: '2026-10-21',
    });
    expect(series.every((point) => point.costs === 0)).toBe(true);
  });

  it('bieżący miesiąc kończy się dziś, a później datowany dokument przedłuża serię do swojego dnia', () => {
    const october = { periodStart: '2026-10-01', periodEnd: '2026-10-31' };
    const doDzis = kpirDailySeries({ invoices: [], expenses: [koszt({ issue_date: '2026-10-05' })], ...october, today: '2026-10-21' });
    expect(doDzis).toHaveLength(21);
    const zapowiedziany = koszt({ id: 'p', issue_date: '2026-10-25' });
    const dalej = kpirDailySeries({ invoices: [], expenses: [zapowiedziany], ...october, today: '2026-10-21' });
    expect(dalej).toHaveLength(25);
    expect(dalej.at(-1)!.costs).toBe(kpirTotals([zapowiedziany], []).totalExpenses);
  });

  it('korekta in minus na początku miesiąca: seria schodzi poniżej zera', () => {
    const series = kpirDailySeries({
      invoices: [
        sprzedaz({ id: 'kor', issue_date: '2026-09-02', invoice_kind: 'correction', net_total: -500 }),
        sprzedaz({ id: 'fv', issue_date: '2026-09-10', net_total: 1000 }),
      ],
      expenses: [], ...WRZESIEN, today: '2026-10-21',
    });
    expect(series[1]).toMatchObject({ day: 2, revenue: -500 });
    expect(series[8]).toMatchObject({ day: 9, revenue: -500 });
    expect(series[9]).toMatchObject({ day: 10, revenue: 500 });
  });

  it('przyszły miesiąc nie ma serii', () => {
    expect(kpirDailySeries({ invoices, expenses, periodStart: '2027-01-01', periodEnd: '2027-01-31', today: '2026-10-21' })).toEqual([]);
  });
});

describe('buildKpirEntries', () => {
  it('Lp.: data zdarzenia, w tym samym dniu przychód przed kosztem, dalej kolejność wejścia', () => {
    const entries = buildKpirEntries(
      [sprzedaz({ id: 'f2', issue_date: '2026-09-05' }), sprzedaz({ id: 'f1', issue_date: '2026-09-07', sale_date: '2026-09-03' })],
      [koszt({ id: 'k1', issue_date: '2026-09-03' }), koszt({ id: 'k2', issue_date: '2026-09-05' }), koszt({ id: 'k3', issue_date: '2026-09-05' })],
      { periodStart: '2026-09-01', settledUnavailable: false },
    );
    expect(entries.map((e) => [e.lp, e.id])).toEqual([
      [1, 'inv-f1'], [2, 'exp-k1'], [3, 'inv-f2'], [4, 'exp-k2'], [5, 'exp-k3'],
    ]);
  });

  it('kolumny: sprzedaż 7, koszty 10–13 i 15 w sumie, bez kolumny i kol. 7/8/16 poza sumą', () => {
    const entries = buildKpirEntries(
      [sprzedaz({})],
      (['col_10', 'col_11', 'col_12', 'col_13', 'col_15', null, 'col_7', 'col_8', 'col_16'] as const).map((col, i) =>
        koszt({ id: `k${i}`, kpir_column: col })),
      { periodStart: '2026-09-01', settledUnavailable: false },
    );
    expect(entries.map((e) => [e.column, e.inSum])).toEqual([
      ['10', true], ['11', true], ['12', true], ['13', true], ['15', true],
      ['brak', false], ['poza', false], ['poza', false], ['poza', false],
      ['7', true],
    ]);
  });

  it('B+R (col_15) ma plakietkę „B+R” bez numeru kolumny; teksty i kolejność filtra', () => {
    expect(COLUMN_BADGE_TEXT['15']).toBe('B+R');
    expect(COLUMN_BADGE_TEXT['7']).toBe('7 · Sprzedaż');
    expect(COLUMN_BADGE_TEXT['13']).toBe('13 · Pozostałe');
    expect(COLUMN_BADGE_TEXT.brak).toBe('Bez kolumny');
    expect(COLUMN_BADGE_TEXT.poza).toBe('Poza sumą');
    expect(COLUMN_FILTER_LABELS).toEqual(COLUMN_BADGE_TEXT);
    expect(COLUMN_FILTER_ORDER).toEqual(['7', '10', '11', '12', '13', '15', 'brak', 'poza']);
  });

  it('opis sprzedaży, znacznik „faktura z DD.MM” i pełna uwaga przy sprzedaży sprzed okresu', () => {
    const entries = buildKpirEntries(
      [sprzedaz({ id: 'r', issue_date: '2026-09-10' }), sprzedaz({ id: 'e', issue_date: '2026-09-03', sale_date: '2026-08-31' })],
      [],
      { periodStart: '2026-09-01', settledUnavailable: false },
    );
    const early = entries.find((e) => e.id === 'inv-e');
    const regular = entries.find((e) => e.id === 'inv-r');
    expect(early).toMatchObject({ date: '2026-08-31', saleChip: 'faktura z 03.09', description: 'Faktura' });
    expect(early!.dateRemark).toContain('przychód okresu sprzedaży');
    expect(regular).toMatchObject({ saleChip: null, dateRemark: null });
  });

  it('ROZ: rozbicie „zamówienie X, minus zaliczki Y”; bez odczytu zaliczek — „zaliczek nie odczytano”', () => {
    const roz = sprzedaz({ invoice_kind: 'final', net_total: 1000, settled_advances_net: 400 });
    const [ok] = buildKpirEntries([roz], [], { periodStart: '2026-09-01', settledUnavailable: false });
    expect(ok).toMatchObject({ amount: 600, amountRemark: 'zamówienie 1000,00, minus zaliczki 400,00', amountRemarkTone: 'muted' });
    const [blad] = buildKpirEntries([{ ...roz, settled_advances_net: null }], [], { periodStart: '2026-09-01', settledUnavailable: true });
    expect(blad).toMatchObject({ amountRemark: 'zaliczek nie odczytano', amountRemarkTone: 'warning' });
  });

  it('wyszukiwarka: numer, kontrahent, NIP, opis i cyfry kwoty (także z kropką)', () => {
    const [entry] = buildKpirEntries([], [koszt({ document_type: 'receipt', net_amount: 1000, vat_amount: 230 })], {
      periodStart: '2026-09-01', settledUnavailable: false,
    });
    for (const query of ['zak/7', 'dostawca', '5260001246', 'paliwo', '1230,00', '1230.00', '1230']) {
      expect(entryMatchesSearch(entry!, query), query).toBe(true);
    }
    expect(entryMatchesSearch(entry!, '999')).toBe(false);
  });
});

describe('sumy karty wyniku i pierścienia', () => {
  const expenses = [
    koszt({ id: 'a', kpir_column: 'col_13', document_type: 'receipt', net_amount: 1000, vat_amount: 230 }), // 1230, VAT 230 w koszcie
    koszt({ id: 'b', kpir_column: 'col_10', net_amount: 500 }),
    koszt({ id: 'c', kpir_column: 'col_15', net_amount: 250 }),
    koszt({ id: 'd', kpir_column: null, document_type: 'receipt', net_amount: 80, vat_amount: 20 }),
    koszt({ id: 'e', kpir_column: 'col_16', net_amount: 70 }),
  ];
  const totals = kpirTotals(expenses, [sprzedaz({ net_total: 4000 })]);

  it('plasterki w stałej kolejności, bez zer; suma = totalExpenses', () => {
    const slices = costSlices(totals);
    expect(slices.map((s) => [s.key, s.filterKey, s.label])).toEqual([
      ['col_10', '10', 'Towary i materiały'],
      ['col_13', '13', 'Pozostałe wydatki'],
      ['col_15', '15', 'Koszty B+R'],
    ]);
    expect(slices.reduce((sum, s) => sum + s.amount, 0)).toBeCloseTo(totals.totalExpenses, 2);
    expect(slices.reduce((sum, s) => sum + (s.share ?? 0), 0)).toBeCloseTo(1, 10);
  });

  it('kolumna na minusie (korekty) bez udziału', () => {
    const slices = costSlices({ ...totals, col_11: -50 });
    expect(slices.find((s) => s.key === 'col_11')).toMatchObject({ amount: -50, share: null });
  });

  it('koszty poza sumą: liczba, kwota i id — tylko bez kolumny i spoza kolumn sum', () => {
    expect(uncountedCosts(expenses)).toEqual({ count: 2, amount: 170, ids: ['d', 'e'] });
    // VAT bez odliczenia tylko z kosztów w sumie (paragon z kol. 13), nie z „d”.
    expect(nonDeductedVatSum(expenses)).toBe(230);
  });

  it('marża: zaokrąglona, ujemna przy stracie, null bez przychodu', () => {
    expect(marginPct({ profit: 2020, totalRevenue: 4000 })).toBe(51);
    expect(marginPct({ profit: -230, totalRevenue: 1000 })).toBe(-23);
    expect(marginPct({ profit: -500, totalRevenue: 0 })).toBeNull();
    expect(marginPct({ profit: -1, totalRevenue: 1000 })).toBe(0);
  });

  it('tytuł miesiąca', () => {
    expect(kpirMonthTitle(9, 2026)).toBe('Wrzesień 2026');
    expect(kpirMonthTitle(1, 2027)).toBe('Styczeń 2027');
  });
});

describe('blockingSaleInvoices — ten sam warunek co assertOutgoingInvoicesInPln', () => {
  it.each([
    ['PLN', false],
    ['pln ', false],
    [' Pln', false],
    [null, true],
    [undefined, true],
    ['', true],
    ['EUR', true],
  ])('waluta %j → wstrzymuje: %s', (currency, blocks) => {
    const invoice = sprzedaz({ id: 'x', internal_number: 'FV/9', currency });
    const guardThrows = (() => {
      try {
        assertOutgoingInvoicesInPln([invoice as { currency?: string | null }]);
        return false;
      } catch {
        return true;
      }
    })();
    expect(guardThrows).toBe(blocks);
    expect(blockingSaleInvoices([invoice])).toEqual(blocks ? [{ id: 'x', number: 'FV/9' }] : []);
  });

  it('lista faktur do linków: tylko wstrzymujące, z numerem albo opisem', () => {
    expect(blockingSaleInvoices([
      sprzedaz({ id: 'a', currency: 'PLN' }),
      sprzedaz({ id: 'b', internal_number: 'FV/2', currency: 'EUR' }),
      sprzedaz({ id: 'c', internal_number: null, currency: 'USD' }),
    ])).toEqual([{ id: 'b', number: 'FV/2' }, { id: 'c', number: 'Faktura bez numeru' }]);
  });
});

describe('wykres i pierścień: kwoty skrócone i oś Y', () => {
  // Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): oś, dymek
  // i środek pierścienia pisały minus z klawiatury („-500 zł”, toLocaleString),
  // a reszta ekranu ma typograficzny „−” (niezmiennik 8).
  it('formatZlCompact: minus typograficzny, bez „−0 zł” z szumu zaokrągleń', () => {
    expect(formatZlCompact(-500)).toBe('\u2212500\u00a0zł');
    expect(formatZlCompact(-1500)).toBe(`\u2212${formatPlCompactMoney(1500)}`);
    expect(formatZlCompact(-0.4)).toBe('0\u00a0zł');
    expect(formatZlCompact(0)).toBe('0\u00a0zł');
    expect(formatZlCompact(18_000)).toBe(formatPlCompactMoney(18_000));
    expect(formatZlCompact(-500)).not.toContain('-');
  });

  // Oś miała podziałki z recharts (0 / 4,5 / 9 / 18 tys., bez 13,5) — równe
  // odstępy i okrągłe kwoty bez „4,5 tys.”.
  it('kpirAxisTicks: równe, okrągłe podziałki od zera (albo od minusa) do maksimum', () => {
    const point = (revenue: number, costs: number) => ({ day: 1, date: '2026-09-01', revenue, costs });
    expect(kpirAxisTicks([point(0, 0), point(18_000, 3_000)])).toEqual([0, 10_000, 20_000]);
    expect(kpirAxisTicks([point(0, 0), point(1_700, 300)])).toEqual([0, 1_000, 2_000]);
    expect(kpirAxisTicks([point(0, 0), point(4_500, 5_500)])).toEqual([0, 5_000, 10_000]);
    expect(kpirAxisTicks([point(-500, 0), point(1_000, 0)])).toEqual([-1_000, 0, 1_000]);
    expect(kpirAxisTicks([point(0, 0), point(0, 0)])).toEqual([0, 1]);
    for (const ticks of [
      kpirAxisTicks([point(0, 0), point(18_000, 3_000)]),
      kpirAxisTicks([point(0, 0), point(123_456, 99_000)]),
      kpirAxisTicks([point(-2_000, 0), point(7_300, 6_100)]),
    ]) {
      const steps = ticks.slice(1).map((tick, i) => tick - ticks[i]!);
      expect(new Set(steps).size, ticks.join(',')).toBe(1);
      // Bez ułamkowych „tys.”: krok co najmniej tysiąc to pełne tysiące.
      expect(ticks.every((tick) => !formatPlCompactMoney(tick).includes(',')), ticks.join(',')).toBe(true);
    }
  });
});

describe('kpirPeriodFromParams — ten sam miesiąc co resolveKpirPeriod', () => {
  // Ekran błędu (`error.tsx`) jest kliencki i nie może importować
  // `lib/reports/kpir-data`, a musi pokazać ten sam miesiąc co strona.
  const now = new Date('2026-10-21T10:00:00Z');
  it.each([
    [{}],
    [{ month: '9', year: '2026' }],
    [{ month: '13', year: '2026' }],
    [{ month: '0' }],
    [{ month: 'abc', year: 'x' }],
    [{ month: '2.7', year: '2025.9' }],
    [{ month: '', year: '' }],
    [{ year: '1999' }],
    [{ year: '2101', month: '3' }],
    [{ month: '1', year: '2000' }],
  ])('%j', (sp: { month?: string; year?: string }) => {
    const expected = resolveKpirPeriod(sp, now);
    const actual = kpirPeriodFromParams(sp, todayInWarsaw(now));
    expect(actual).toEqual({
      month: expected.month,
      year: expected.year,
      period: expected.periodStart.slice(0, 7),
    });
  });
});
