/**
 * Model ekranu KPiR — wpisy księgi, sumy dla karty wyniku, seria wykresu
 * narastającego, plasterki kosztów i teksty plakietek kolumn. Moduł bez
 * Reacta i bez zapytań, więc liczy go i komponent kliencki (`KpirView`),
 * i strona serwerowa (stan „Raport wstrzymany”), a testy sprawdzają go
 * bez renderu.
 *
 * Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): plik leży
 * w `components/reports/kpir/`, nie w `lib/`, bo to pochodne widoku
 * (`lib/reports/*`, `lib/categorization/*`, `lib/exports/*` są w tej zmianie
 * zamrożone). Wszystkie kwoty liczą funkcje z `lib` bez zmian:
 * przychód `kpirInvoiceRevenue` (ROZ minus własne zaliczki), koszt
 * `kpirCostAmount` (netto + VAT bez odliczenia), sumy `kpirTotals`.
 */

import { kpirShortLabel } from '@/components/expenses/finora/labels';
import { kpirCostAmount, nonDeductedVat } from '@/lib/categorization/kpir-cost';
import { earlierSaleRemark, kpirSaleEventDate } from '@/lib/categorization/kpir-revenue';
import { monthLabel } from '@/lib/expenses/month';
import { formatPlCompactMoney, formatPlMoney } from '@/lib/format/pl';
import { roundToCents } from '@/lib/xml/invoice-calculator';
import {
  kpirInvoiceRevenue,
  type KpirExpenseRow,
  type KpirInvoiceRow,
  type KpirTotals,
} from '@/lib/reports/kpir-totals';

/**
 * Wartość kolumny „Kolumna” (i filtra): przychód „7”, koszt liczony w sumach
 * „10”–„13” i „15”, koszt bez kolumny „brak”, koszt w kolumnie spoza sum
 * ekranu (kol. 7, 8, 16 przy wydatku) „poza”.
 */
export type KpirColumnKey = '7' | '10' | '11' | '12' | '13' | '15' | 'brak' | 'poza';

/** Jeden wpis księgi: przychód (faktura) albo koszt (wydatek). */
export interface KpirEntry {
  id: string;
  /** Lp. — kolejność w księdze (data zdarzenia, przychody przed kosztami w tym samym dniu). */
  lp: number;
  kind: 'revenue' | 'cost';
  /** RRRR-MM-DD — dzień sprzedaży (kol. 2) albo data dowodu kosztu. */
  date: string;
  /** RRRR-MM-DD — data wystawienia dokumentu. */
  issueDate: string;
  /** Pełna uwaga o sprzedaży z wcześniejszego okresu (`earlierSaleRemark`). */
  dateRemark: string | null;
  /** Krótki znacznik pod datą: „faktura z 03.09”. */
  saleChip: string | null;
  documentNumber: string | null;
  counterparty: string;
  counterpartyNip: string | null;
  description: string;
  column: KpirColumnKey;
  /** Czy kwota wchodzi do sum KPiR (przychód zawsze; koszt tylko z kolumną 10–13 lub 15). */
  inSum: boolean;
  amount: number;
  /** Dopisek pod kwotą (rozbicie ROZ, VAT bez odliczenia). */
  amountRemark: string | null;
  amountRemarkTone: 'muted' | 'warning';
  href: string;
}

/** Kolumny kosztów, które `kpirTotals` sumuje (kol. 14 = 10–13 + 15). */
export const COUNTED_COLUMNS = ['col_10', 'col_11', 'col_12', 'col_13', 'col_15'] as const;
export type CountedColumn = (typeof COUNTED_COLUMNS)[number];

const COUNTED = new Set<string>(COUNTED_COLUMNS);

/** Koszt wchodzi do sum KPiR — ta sama reguła co w `kpirTotals`. */
export function isCountedCost(exp: Pick<KpirExpenseRow, 'kpir_column'>): boolean {
  return exp.kpir_column !== null && COUNTED.has(exp.kpir_column);
}

/** Koszty poza sumą (bez kolumny albo w kolumnie spoza sum ekranu) — „Do sprawdzenia”. */
export function uncountedCosts(expenses: readonly KpirExpenseRow[]): { count: number; amount: number; ids: string[] } {
  const rest = expenses.filter((exp) => !isCountedCost(exp));
  return {
    count: rest.length,
    amount: cents(rest.reduce((sum, exp) => sum + kpirCostAmount(exp), 0)),
    ids: rest.map((exp) => exp.id),
  };
}

/** VAT bez odliczenia zawarty w kosztach z sum (dopisek pod „Koszty” na karcie wyniku). */
export function nonDeductedVatSum(expenses: readonly KpirExpenseRow[]): number {
  return cents(expenses.filter(isCountedCost).reduce((sum, exp) => sum + nonDeductedVat(exp), 0));
}

// Teksty plakietek: numer kolumny i słowo z `kpirShortLabel` (to samo co na
// liście wydatków). B+R bez numeru — plik KPiR ma tu 16, formularz wydatku 15;
// trzecia numeracja tylko by myliła.
export const COLUMN_BADGE_TEXT: Record<KpirColumnKey, string> = {
  '7': '7 · Sprzedaż',
  '10': `10 · ${kpirShortLabel('col_10')}`,
  '11': `11 · ${kpirShortLabel('col_11')}`,
  '12': `12 · ${kpirShortLabel('col_12')}`,
  '13': `13 · ${kpirShortLabel('col_13')}`,
  '15': kpirShortLabel('col_15'),
  brak: 'Bez kolumny',
  poza: 'Poza sumą',
};

const OUTSIDE_SUM_TITLE = 'Nie wchodzi do sum KPiR — przypisz kolumnę w wydatku';

/** Pełna nazwa kolumny w `title` plakietki. */
export const COLUMN_TITLES: Record<KpirColumnKey, string> = {
  '7': 'Kolumna 7 — wartość sprzedanych towarów i usług',
  '10': 'Kolumna 10 — zakup towarów handlowych i materiałów',
  '11': 'Kolumna 11 — koszty uboczne zakupu',
  '12': 'Kolumna 12 — wynagrodzenia',
  '13': 'Kolumna 13 — pozostałe wydatki',
  '15': 'Koszty działalności badawczo-rozwojowej',
  brak: OUTSIDE_SUM_TITLE,
  poza: OUTSIDE_SUM_TITLE,
};

/** Etykiety filtra „Kolumna KPiR” — te same teksty co na plakietkach. */
export const COLUMN_FILTER_LABELS: Record<KpirColumnKey, string> = COLUMN_BADGE_TEXT;

/** Kolejność opcji filtra: sprzedaż, koszty po numerze, B+R, braki. */
export const COLUMN_FILTER_ORDER: readonly KpirColumnKey[] = ['7', '10', '11', '12', '13', '15', 'brak', 'poza'];

function costColumn(col: KpirExpenseRow['kpir_column']): KpirColumnKey {
  switch (col) {
    case 'col_10':
      return '10';
    case 'col_11':
      return '11';
    case 'col_12':
      return '12';
    case 'col_13':
      return '13';
    case 'col_15':
      return '15';
    case null:
      return 'brak';
    default:
      return 'poza';
  }
}

const INVOICE_KIND_LABELS: Record<string, string> = {
  regular: 'Faktura',
  advance: 'Zaliczka',
  final: 'Faktura rozliczeniowa',
  correction: 'Korekta sprzedaży',
};

function buyerField(buyerData: KpirInvoiceRow['buyer_data'], key: 'name' | 'nip'): string | null {
  if (!buyerData || typeof buyerData !== 'object' || Array.isArray(buyerData)) return null;
  const value = (buyerData as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** „2026-09-03” → „03.09”. */
function dayMonth(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}` : iso;
}

/**
 * Wpisy księgi w kolejności Lp.: data zdarzenia, w tym samym dniu przychody
 * przed kosztami, dalej kolejność wejścia (strona podaje je już ułożone po
 * dacie i id) — ta sama reguła co przed przeprojektowaniem.
 */
export function buildKpirEntries(
  invoices: readonly KpirInvoiceRow[],
  expenses: readonly KpirExpenseRow[],
  { periodStart, settledUnavailable }: { periodStart: string; settledUnavailable: boolean },
): KpirEntry[] {
  const revenue: Omit<KpirEntry, 'lp'>[] = invoices.map((inv) => {
    const dates = { saleDate: inv.sale_date, issueDate: inv.issue_date };
    const dateRemark = earlierSaleRemark(dates, periodStart);
    const isFinal = inv.invoice_kind === 'final';
    return {
      id: `inv-${inv.id}`,
      kind: 'revenue',
      // Data zdarzenia gospodarczego — dzień sprzedaży, jak kol. 2 w eksporcie.
      date: kpirSaleEventDate(dates),
      issueDate: inv.issue_date,
      dateRemark,
      saleChip: dateRemark ? `faktura z ${dayMonth(inv.issue_date)}` : null,
      documentNumber: inv.internal_number,
      counterparty: buyerField(inv.buyer_data, 'name') ?? '—',
      counterpartyNip: buyerField(inv.buyer_data, 'nip'),
      description: INVOICE_KIND_LABELS[inv.invoice_kind ?? ''] ?? 'Faktura',
      column: '7',
      inSum: true,
      amount: kpirInvoiceRevenue(inv),
      // Bez odczytu zaliczek „minus zaliczki 0,00” byłoby nieprawdą — mówimy wprost.
      amountRemark: isFinal
        ? settledUnavailable
          ? 'zaliczek nie odczytano'
          : `zamówienie ${formatPlMoney(Number(inv.net_total ?? 0))}, minus zaliczki ${formatPlMoney(Number(inv.settled_advances_net ?? 0))}`
        : null,
      amountRemarkTone: isFinal && settledUnavailable ? 'warning' : 'muted',
      href: `/invoices/${inv.id}`,
    };
  });
  const costs: Omit<KpirEntry, 'lp'>[] = expenses.map((exp) => {
    const vat = nonDeductedVat(exp);
    return {
      id: `exp-${exp.id}`,
      kind: 'cost',
      date: exp.issue_date,
      issueDate: exp.issue_date,
      dateRemark: null,
      saleChip: null,
      documentNumber: exp.document_number,
      counterparty: exp.seller_name || '—',
      counterpartyNip: exp.seller_nip,
      description: exp.category_label ?? 'Koszt',
      column: costColumn(exp.kpir_column),
      inSum: isCountedCost(exp),
      amount: kpirCostAmount(exp),
      amountRemark: vat > 0 ? `w tym VAT bez odliczenia ${formatPlMoney(vat)}` : null,
      amountRemarkTone: 'muted',
      href: `/expenses/${exp.id}`,
    };
  });
  // Stabilne sortowanie: wejście jest już ułożone (data, id) przez stronę.
  return [...revenue, ...costs]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      a.entry.date.slice(0, 10).localeCompare(b.entry.date.slice(0, 10)) ||
      (a.entry.kind === b.entry.kind ? 0 : a.entry.kind === 'revenue' ? -1 : 1) ||
      a.index - b.index)
    .map(({ entry }, i) => ({ ...entry, lp: i + 1 }));
}

/** Kwota w złotych z minusem typograficznym (U+2212), nigdy „-” z klawiatury. */
export function formatZl(amount: number): string {
  return `${amount < 0 ? '−' : ''}${formatPlMoney(Math.abs(amount))} zł`;
}

/**
 * Kwota skrócona („1,5 tys. zł”) z minusem typograficznym — oś i środek
 * pierścienia. Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości):
 * spec podawał wprost `formatPlCompactMoney`, ale ten pisze minus
 * z klawiatury („-500 zł”, `toLocaleString`), a reszta ekranu ma „−”
 * (niezmiennik 8). Szum poniżej złotówki to „0 zł”, nie „−0 zł”.
 */
export function formatZlCompact(amount: number): string {
  const text = formatPlCompactMoney(Math.abs(amount));
  return amount < 0 && Math.round(Math.abs(amount)) !== 0 ? `−${text}` : text;
}

/** Najmniejszy „okrągły” krok (1, 2 albo 5 × 10ⁿ, co najmniej 1 zł) nie mniejszy niż `x`. */
function niceStep(x: number): number {
  if (!(x > 1)) return 1;
  const base = 10 ** Math.floor(Math.log10(x));
  const f = x / base;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * base;
}

/**
 * Podziałki osi Y wykresu narastającego: równe, okrągłe kwoty od zera (albo
 * od najniższej wartości poniżej zera) do maksimum, zwykle trzy-cztery.
 * Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): recharts na
 * wykresie wysokości 152 px gubił podziałkę (0 / 4,5 / 9 / 18 tys., bez 13,5)
 * i pisał ułamkowe „4,5 tys.”; krok 1/2/5 × 10ⁿ daje pełne tysiące.
 */
export function kpirAxisTicks(series: readonly KpirSeriesPoint[]): number[] {
  const values = series.flatMap((point) => [point.revenue, point.costs]);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const step = niceStep((max - min) / 2);
  const bottom = Math.floor(min / step);
  const top = Math.max(Math.ceil(max / step), bottom + 1);
  return Array.from({ length: top - bottom + 1 }, (_, i) => (bottom + i) * step || 0);
}

/** Kwota wpisu ze znakiem jak w Finorze: przychód „+”, koszt „−” (§7.1). */
export function signedEntryMoney(entry: Pick<KpirEntry, 'kind' | 'amount'>): string {
  // Korekta in minus to ujemny przychód — dostaje „−”, nie „+-”.
  const signed = entry.kind === 'revenue' ? entry.amount : -entry.amount;
  return `${signed < 0 ? '−' : '+'}${formatPlMoney(Math.abs(signed))} zł`;
}

/**
 * Wyszukiwarka księgi: numer dowodu, kontrahent, NIP, opis i cyfry kwoty
 * („1230,00”, także wpisane z kropką albo ze spacją tysięcy).
 */
export function entryMatchesSearch(entry: KpirEntry, query: string): boolean {
  const search = query.trim().toLowerCase();
  if (!search) return true;
  const text = [entry.documentNumber, entry.counterparty, entry.counterpartyNip, entry.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (text.includes(search)) return true;
  const digits = search.replace(/\s/g, '').replace('.', ',');
  return digits !== '' && formatPlMoney(Math.abs(entry.amount)).replace(/\s/g, '').includes(digits);
}

export interface KpirSeriesPoint {
  /** Dzień miesiąca 1–31 (oś X). */
  day: number;
  /** RRRR-MM-DD. */
  date: string;
  /** Przychód narastająco do tego dnia. */
  revenue: number;
  /** Koszty z sum narastająco do tego dnia. */
  costs: number;
}

/**
 * Przychody i koszty narastająco, dzień po dniu (wykres karty wyniku).
 *
 * - przychód po dacie zdarzenia (`kpirSaleEventDate`); sprzedaż sprzed okresu
 *   (faktura z 3.09 za 31.08) jest w księdze tego miesiąca, więc liczy się od
 *   1. dnia;
 * - koszty tylko z kolumn sum (`COUNTED_COLUMNS`), po dacie dowodu;
 * - w bieżącym miesiącu seria kończy się dziś, chyba że jest dokument z datą
 *   późniejszą — wtedy na nim, żeby ostatni punkt zawsze równał się sumom
 *   karty (`kpirTotals`); przyszły miesiąc nie ma serii.
 */
export function kpirDailySeries({
  invoices,
  expenses,
  periodStart,
  periodEnd,
  today,
}: {
  invoices: readonly KpirInvoiceRow[];
  expenses: readonly KpirExpenseRow[];
  periodStart: string;
  periodEnd: string;
  today: string;
}): KpirSeriesPoint[] {
  const month = periodStart.slice(0, 7);
  const todayMonth = today.slice(0, 7);
  if (month > todayMonth) return [];

  const lastDay = Number(periodEnd.slice(8, 10));
  const dayOf = (iso: string): number => {
    const date = iso.slice(0, 10);
    if (date < periodStart) return 1;
    if (date > periodEnd) return lastDay;
    return Number(date.slice(8, 10));
  };

  const revenueByDay = new Array<number>(lastDay + 1).fill(0);
  const costsByDay = new Array<number>(lastDay + 1).fill(0);
  let latestDay = 1;
  for (const inv of invoices) {
    const day = dayOf(kpirSaleEventDate({ saleDate: inv.sale_date, issueDate: inv.issue_date }));
    revenueByDay[day] = (revenueByDay[day] ?? 0) + kpirInvoiceRevenue(inv);
    latestDay = Math.max(latestDay, day);
  }
  for (const exp of expenses) {
    if (!isCountedCost(exp)) continue;
    const day = dayOf(exp.issue_date);
    costsByDay[day] = (costsByDay[day] ?? 0) + kpirCostAmount(exp);
    latestDay = Math.max(latestDay, day);
  }

  const endDay = month === todayMonth
    ? Math.min(lastDay, Math.max(Number(today.slice(8, 10)), latestDay))
    : lastDay;

  const series: KpirSeriesPoint[] = [];
  let revenue = 0;
  let costs = 0;
  for (let day = 1; day <= endDay; day += 1) {
    revenue += revenueByDay[day] ?? 0;
    costs += costsByDay[day] ?? 0;
    series.push({ day, date: `${month}-${String(day).padStart(2, '0')}`, revenue: cents(revenue), costs: cents(costs) });
  }
  return series;
}

/** Plasterki kosztów (karta „Koszty według kolumn”) w stałej kolejności. */
export const COST_SLICE_META: ReadonlyArray<{ key: CountedColumn; filterKey: KpirColumnKey; label: string }> = [
  { key: 'col_10', filterKey: '10', label: 'Towary i materiały' },
  { key: 'col_11', filterKey: '11', label: 'Koszty uboczne zakupu' },
  { key: 'col_12', filterKey: '12', label: 'Wynagrodzenia' },
  { key: 'col_13', filterKey: '13', label: 'Pozostałe wydatki' },
  { key: 'col_15', filterKey: '15', label: 'Koszty B+R' },
];

export interface CostSlice {
  key: CountedColumn;
  filterKey: KpirColumnKey;
  label: string;
  amount: number;
  /** Udział w kosztach dodatnich (0–1); `null` dla kolumny na minusie (korekty) — poza wykresem. */
  share: number | null;
}

/** Niezerowe kolumny kosztów z `kpirTotals`; udziały liczone z kolumn dodatnich. */
export function costSlices(totals: KpirTotals): CostSlice[] {
  const present = COST_SLICE_META
    .map((meta) => ({ ...meta, amount: cents(totals[meta.key]) }))
    .filter((slice) => slice.amount !== 0);
  const positive = present.reduce((sum, slice) => sum + Math.max(0, slice.amount), 0);
  return present.map((slice) => ({
    ...slice,
    share: slice.amount > 0 && positive > 0 ? slice.amount / positive : null,
  }));
}

/** Marża (dochód / przychód) w całych procentach; `null` bez przychodu. */
export function marginPct(totals: Pick<KpirTotals, 'profit' | 'totalRevenue'>): number | null {
  if (!(totals.totalRevenue > 0)) return null;
  return Math.round((totals.profit / totals.totalRevenue) * 100) || 0;
}

/** „Wrzesień 2026”. */
export function kpirMonthTitle(month: number, year: number): string {
  const label = monthLabel(`${year}-${String(month).padStart(2, '0')}`);
  return label.charAt(0).toLocaleUpperCase('pl-PL') + label.slice(1);
}

/**
 * Miesiąc KPiR z parametrów adresu (`?month=&year=`) — te same reguły co
 * `resolveKpirPeriod` w `lib/reports/kpir-data.ts` (miesiąc przycięty do
 * 1–12, rok spoza 2000–2100 → bieżący, domyślnie dziś w Polsce). Kopia, bo
 * czyta to kliencki ekran błędu (`error.tsx`), a `kpir-data` ciągnie odczyt
 * z bazy; zgodność pilnuje test `kpir-model` (poprawka Bartosza 21.10.2026:
 * przeprojektowanie Księgowości).
 */
export function kpirPeriodFromParams(
  sp: { month?: string | null; year?: string | null },
  today: string,
): { month: number; year: number; period: string } {
  const nowYear = Number(today.slice(0, 4));
  const rawMonth = Number(sp.month ?? Number(today.slice(5, 7)));
  const month = Number.isFinite(rawMonth) ? Math.min(12, Math.max(1, Math.floor(rawMonth))) : 1;
  const rawYear = Number(sp.year ?? nowYear);
  const flooredYear = Math.floor(rawYear);
  const year = Number.isFinite(rawYear) && flooredYear >= 2000 && flooredYear <= 2100 ? flooredYear : nowYear;
  return { month, year, period: `${year}-${String(month).padStart(2, '0')}` };
}

/**
 * Faktury sprzedaży, które wstrzymują raport (waluta inna niż PLN albo brak
 * waluty) — linki w stanie „Raport wstrzymany”. Ten sam warunek co
 * `assertOutgoingInvoicesInPln` (`lib/exports/currency-guard.ts`); zgodność
 * pilnuje test `kpir-model`.
 */
export function blockingSaleInvoices(invoices: readonly KpirInvoiceRow[]): { id: string; number: string }[] {
  return invoices
    .filter((inv) => (inv as { currency?: string | null }).currency?.trim().toUpperCase() !== 'PLN')
    .map((inv) => ({ id: inv.id, number: inv.internal_number?.trim() || 'Faktura bez numeru' }));
}

/** Grosze bez szumu dodawania (0,1 + 0,2) i bez „−0”. */
function cents(n: number): number {
  return roundToCents(n) || 0;
}
