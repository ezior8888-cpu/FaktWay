import { PULPIT_EMPTY } from '@/components/dashboard/pulpit/card-states';
import type { InflowTerms } from '@/lib/dashboard/inflow-terms';
import type { ReceivablesAging } from '@/lib/dashboard/receivables-aging';
import { buildMonthReport } from '@/lib/dashboard/pulpit-report';
import type { TopClient, TopProduct } from '@/lib/dashboard/rankings';
import type { VatLimitOverview } from '@/lib/dashboard/vat-limit';
import type { TrybDanych } from '@/lib/demo/tryb-danych';
import { formatTimestampDatePl } from '@/lib/format/iso-date';
import {
  formatPlCompactMoney,
  formatPlCompactNumber,
  formatPlInt,
  formatPlMoney,
  formatPlPercentChange,
} from '@/lib/format/pl';
import { plural } from '@/lib/i18n/plural';

import type { FinanceCardProps, FinanseMiesiac } from './chart-finance';
import type { TotalVisitorsColumn } from './chart-total-visitors';
import type { StatisticsImpressionCardProps } from './statistics-impression-card';
import type { StatisticsTotalRevenueCardProps } from './statistics-total-revenue-card';

/**
 * Adaptery Pulpitu (PLAN-PRAWDZIWE-DANE §5.3, §6.1, E5): wynik loaderów
 * `lib/dashboard/*` → propsy kart Finory. Jeden adapter dla obu trybów — dane
 * przykładowe (atrapa bazy) i prawdziwe mają ten sam kształt aż do propsów.
 *
 * Zasada Bartosza 23.10.2026: karty IDENTYCZNE rozmiarowo i designowo, więc
 * adaptery dają tylko napisy w istniejących miejscach (tytuł, podpis,
 * plakietka, dymek) o długości dawnych napisów szablonu. Liczba jest
 * prawdziwa albo jej nie ma: brak podstawy procentu → `null` („—”), a dana
 * częściowa dostaje zastrzeżenie w istniejącym miejscu, nigdy nową linię.
 * Formatowanie robi serwer (strefa Warszawa), do kart klienckich idą napisy
 * i liczby.
 */

/** Pusty stan karty w stanie B (historia sprzedaży z KSeF się pobiera). */
export const POBIERAMY = 'Pobieramy faktury z KSeF…';
/** To samo na plakietkę okresu (dawne „Ostatnie 4 miesiące”, 19 znaków). */
export const POBIERAMY_KROTKO = 'Pobieramy z KSeF…';
/** Podpis karty z wykresem (dawne „Ostatni rok”, 11 znaków — tekst nie może dojść do drugiej linii). */
export const POBIERAMY_PODPIS = 'Pobieramy…';

/** Pozycja „Odśwież” menu ⋯ (E7 pkt 1); stała tutaj, nie w pliku `'use client'`. */
export const ODSWIEZ = { label: 'Odśwież', akcja: 'odswiez' } as const;

const zl = (n: number) => `${formatPlMoney(n)} zł`;

/** Zmiana procentowa; `null`, gdy którejś wartości brak albo podstawa ≤ 0 (procent nie istnieje). */
export function zmianaProcentowa(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  return previous > 0 ? ((current - previous) / previous) * 100 : null;
}

const synchronizacja = (tryb: TrybDanych) => tryb === 'synchronizacja';

/**
 * Z9 / E10: koszty z KSeF są pełne od `kosztyKsefOd` (`trybDanych`: data
 * weryfikacji, dopóki historia zakupów z KSeF się pobiera; potem `null`),
 * więc koszty okna karty od `from` dostają „KSeF od DD.MM”, jeśli ta data
 * wypadła w tym oknie. `from` to miesiąc „RRRR-MM” (karty miesięczne) albo
 * dzień „RRRR-MM-DD” (kalendarz 180 dni) — porównanie z tą samą
 * dokładnością. Przykład, pełna historia zakupów i okno po dacie — nic.
 * Jedno źródło dla Pulpitu, Przepływów i Analiz (`components/analizy/podpisy.ts`).
 */
export function ksefOd(tryb: TrybDanych, kosztyKsefOd: string | null | undefined, from: string): string {
  if (tryb === 'przyklad' || !kosztyKsefOd) return '';
  const date = formatTimestampDatePl(kosztyKsefOd);
  if (date === '—') return '';
  const [dd, mm, yyyy] = date.split('.');
  if (`${yyyy}-${mm}-${dd}`.slice(0, from.length) < from) return '';
  return `KSeF od ${dd}.${mm}`;
}

/** `ksefOd` jako dopisek w nawiasie: „Koszty (KSeF od 12.10)”. */
export function notaKosztowKsef(tryb: TrybDanych, kosztyKsefOd: string | null, fromMonthKey: string): string {
  const od = ksefOd(tryb, kosztyKsefOd, fromMonthKey);
  return od ? ` (${od})` : '';
}

// ─── Finanse + Raport ─────────────────────────────────────────────────────

export interface FinanseWejscie {
  /** Miesiące okna, od najstarszego; ostatni = bieżący. */
  months: readonly { key: string; label: string }[];
  /** Przychód netto miesięcy (`getSalesSeries().netSeries`). */
  net: readonly number[];
  /** VAT należny miesięcy (`vatSeries`). */
  vat: readonly number[];
  /** Koszty miesięcy (`sumCostsByMonth(getCostsWithKsefPurchases())`, E10). */
  costs: readonly number[];
  tryb: TrybDanych;
  /** Od kiedy koszty z KSeF są pełne (`trybDanych().kosztyKsefOd`); `null` — bez zastrzeżenia. */
  kosztyKsefOd: string | null;
}

export type FinanseDane = Omit<FinanceCardProps, 'financeMenu' | 'reportMenu' | 'className'>;

const cents = (n: number) => Math.round(n * 100) / 100 || 0;

export function finanseProps(w: FinanseWejscie): FinanseDane {
  const months: FinanseMiesiac[] = w.months.map((m, i) => {
    const revenue = w.net[i] ?? 0;
    const vatDue = w.vat[i] ?? 0;
    const costsAmount = w.costs[i] ?? 0;
    const result = cents(revenue - costsAmount);
    return {
      month: m.label,
      profit: Math.max(0, result),
      vat: Math.max(0, vatDue),
      costs: Math.max(0, costsAmount),
      revenue,
      result,
      vatDue,
      costsAmount,
    };
  });
  const empty = months.every((m) => m.revenue === 0 && m.costsAmount === 0 && m.vatDue === 0);
  const count = w.months.length;
  const firstKey = w.months[0]?.key ?? '';
  const currentKey = w.months.at(-1)?.key ?? '';

  const report = buildMonthReport(w.net, w.costs);
  const loss = report.profit < 0;

  return {
    subTitle: empty && synchronizacja(w.tryb)
      ? POBIERAMY
      : `Ostatnie ${count} ${plural(count, ['miesiąc', 'miesiące', 'miesięcy'])}`,
    costsLabel: `Koszty${notaKosztowKsef(w.tryb, w.kosztyKsefOd, firstKey)}`,
    months,
    report: {
      subTitle: report.monthlyAverageNet === null
        ? 'Ten miesiąc'
        : `Ten miesiąc · średnio ${formatPlCompactMoney(report.monthlyAverageNet)}`,
      rows: [
        { kind: 'profit', title: loss ? 'Strata' : 'Zysk', amount: zl(Math.abs(report.profit)) },
        { kind: 'revenue', title: 'Przychody netto', amount: zl(report.revenue) },
        { kind: 'costs', title: `Koszty${notaKosztowKsef(w.tryb, w.kosztyKsefOd, currentKey)}`, amount: zl(report.costs) },
      ],
    },
  };
}

// ─── Kafle ────────────────────────────────────────────────────────────────

export interface KafelDane {
  value: string;
  valueTitle?: string;
  changePct: number | null;
  badge: string;
}

/** „Faktury w KSeF”: przyjęte w tym miesiącu, % m/m (bez poprzedniego miesiąca „—”). */
export function kafelFaktur(
  f: { acceptedCount: number; hasPrevMonth: boolean; momCountPct: number },
  tryb: TrybDanych,
): KafelDane {
  return {
    value: formatPlInt(f.acceptedCount),
    // Przy zerowej podstawie `momCountPct` = 0, więc decyduje `hasPrevMonth`.
    changePct: f.hasPrevMonth ? f.momCountPct : null,
    badge: f.acceptedCount === 0 && synchronizacja(tryb) ? POBIERAMY_KROTKO : 'Ten miesiąc',
  };
}

/**
 * „Średnia faktura” (Z5): netto na fakturę w tym miesiącu, bez korekt
 * (`salesMonthStats().avgPerInvoice`), % względem średniej poprzedniego.
 */
export function kafelSredniej(current: number | null, previous: number | null, tryb: TrybDanych): KafelDane {
  return {
    value: current === null ? '—' : formatPlCompactMoney(current),
    valueTitle: current === null ? undefined : `${zl(current)} netto na fakturę, bez korekt`,
    changePct: zmianaProcentowa(current, previous),
    badge: current === null && synchronizacja(tryb) ? POBIERAMY_KROTKO : 'Ten miesiąc',
  };
}

// ─── Przychód netto ───────────────────────────────────────────────────────

export type PrzychodDane = Omit<StatisticsTotalRevenueCardProps, 'className'>;

export function przychodProps(
  s: { months: readonly { label: string }[]; netSeries: readonly number[]; prevNetSeries: readonly number[] },
  tryb: TrybDanych,
): PrzychodDane {
  const current = s.netSeries.at(-1) ?? 0;
  const empty = s.netSeries.every((v) => v === 0);
  return {
    value: formatPlCompactMoney(current),
    valueTitle: zl(current),
    changePct: zmianaProcentowa(current, s.netSeries.at(-2)),
    description: empty && synchronizacja(tryb) ? POBIERAMY_PODPIS : 'Przychód netto',
    descriptionTitle: 'Przychód netto w tym miesiącu; słupki: ten rok i rok wcześniej',
    series: s.months.map((m, i) => ({ month: m.label, current: s.netSeries[i] ?? 0, previous: s.prevNetSeries[i] ?? 0 })),
    hasPrevYear: s.prevNetSeries.some((v) => v !== 0),
  };
}

// ─── VAT należny / limit zwolnienia ───────────────────────────────────────

export type LiniaDane = Omit<StatisticsImpressionCardProps, 'className'>;

/** Płatnik VAT: VAT należny 12 miesięcy, wartość = bieżący miesiąc, % m/m ze znakiem. */
export function vatNaleznyProps(
  s: { months: readonly { label: string }[]; vatSeries: readonly number[] },
  tryb: TrybDanych,
): LiniaDane {
  const current = s.vatSeries.at(-1) ?? 0;
  const change = zmianaProcentowa(current, s.vatSeries.at(-2));
  const empty = s.vatSeries.every((v) => v === 0);
  return {
    title: 'VAT należny',
    description: empty && synchronizacja(tryb) ? POBIERAMY_PODPIS : 'Ostatni rok',
    value: formatPlCompactMoney(current),
    valueTitle: `${zl(current)} w tym miesiącu`,
    // Kolor napisu jak w Finorze (`text-primary`) — spadek niesie minus, nie nowy kolor (zasada 23.10.2026).
    side: change === null ? null : formatPlPercentChange(change),
    seriesLabel: 'VAT należny',
    points: s.months.map((m, i) => ({ month: m.label, value: s.vatSeries[i] ?? 0 })),
  };
}

/**
 * Firma zwolniona z VAT (art. 113): wykorzystanie limitu, linia = sprzedaż
 * narastająco od stycznia. Bez daty rozpoczęcia działalności — dolna granica
 * („≥”), bo limit proporcjonalny nie jest wyższy niż pełny.
 */
export function limitVatProps(o: VatLimitOverview, tryb: TrybDanych): LiniaDane {
  const shownPct = (pct: number) => Math.max(0, Math.floor(pct));
  const value = o.limit
    ? `${shownPct(o.limit.pct)}%`
    : o.lowerBound
      ? `≥ ${shownPct(o.lowerBound.pct)}%`
      : '—';
  return {
    title: 'Limit VAT',
    description: o.used === 0 && synchronizacja(tryb) ? POBIERAMY_PODPIS : 'Od 1 stycznia',
    value,
    valueTitle: o.limit
      ? `Sprzedaż ${zl(o.used)} z limitu ${zl(o.limit.effectiveLimit)}`
      : `Co najmniej — podaj datę rozpoczęcia działalności w ustawieniach firmy`,
    // Bez „zł”: obok procentu w kaflu ~142 px „z 240 tys. zł” schodziło do drugiej linii (pomiar 23.10.2026).
    side: `z ${formatPlCompactNumber(o.limit?.effectiveLimit ?? o.annualLimit)}`,
    seriesLabel: 'Sprzedaż od 1 stycznia',
    points: o.months.map((m, i) => ({ month: m.label, value: o.cumulative[i] ?? 0 })),
  };
}

// ─── Należności według terminu ────────────────────────────────────────────

/**
 * Należności to faktury bez oznaczonej zapłaty, także po terminie (FaktWay 1.0
 * §3 pkt 3, D-W odwołane 02.11.2026). Karta nie ma miejsca na podpis: opis idzie
 * do dymku tytułu i czytnika ekranu.
 */
export const NALEZNOSCI_NOTA =
  'Faktury z FaktWay bez oznaczonej zapłaty, bez importów i faktur skorygowanych. Gdy klient zapłaci, dotknij „Zapłacone” przy fakturze.';

/**
 * Krótkie nazwy kolumn (miejsce jak „Komputer”), pełne w dymku i dla czytnika
 * ekranu. Strzałka ocenia: w terminie ↗, po terminie ↙.
 */
const KOLUMNY: Record<ReceivablesAging['buckets'][number]['key'], { name: string; trend: 'up' | 'down' }> = {
  notDue: { name: 'W terminie', trend: 'up' },
  upTo30: { name: '1-30 dni', trend: 'down' },
  over30: { name: '31+ dni', trend: 'down' },
};

/** Kolory kolumn Finory, po kolei. */
const KOLORY_KOLUMN = ['bg-chart-1', 'bg-chart-1/20', 'bg-chart-1/50'];

export interface NaleznosciDane {
  title: string;
  total: string;
  totalTitle: string;
  badge: string;
  note: string | null;
  detailsHref: string;
  visitorData: TotalVisitorsColumn[];
}

const faktury = (n: number) => `${n} ${plural(n, ['faktura', 'faktury', 'faktur'])}`;

/** Plakietka mówi, ile z sumy jest po terminie; „Szczegóły” prowadzą do listy, na której oznaczysz zapłatę. */
export function naleznosciProps(a: ReceivablesAging, tryb: TrybDanych): NaleznosciDane {
  const overdue = a.buckets.filter((b) => b.key !== 'notDue').reduce((sum, b) => sum + b.pct, 0);
  return {
    title: 'Należności',
    total: formatPlCompactMoney(a.total),
    totalTitle: `${zl(a.total)} · ${faktury(a.count)}`,
    badge: a.count === 0 && synchronizacja(tryb) ? POBIERAMY_KROTKO : `${overdue}% zaległe`,
    note: NALEZNOSCI_NOTA,
    detailsHref: '/payments/overdue',
    visitorData: a.buckets.map((b, i) => ({
      name: KOLUMNY[b.key].name,
      nameTitle: b.label,
      pct: b.pct,
      // Dwie cyfry znaczące: kolumna ma miejsce jak dawne „23.8” (pełna kwota w dymku).
      amount: formatPlCompactNumber(b.amount, 2),
      amountTitle: `${zl(b.amount)} · ${faktury(b.count)}`,
      trend: KOLUMNY[b.key].trend,
      color: KOLORY_KOLUMN[i] ?? 'bg-chart-1',
    })),
  };
}

const KOLUMNY_PRZYKLADU: Record<InflowTerms['buckets'][number]['key'], { name: string; trend: 'up' | 'down' }> = {
  thisWeek: { name: 'Ten tydzień', trend: 'up' },
  upTo30: { name: 'Do 30 dni', trend: 'up' },
  later: { name: 'Później', trend: 'up' },
};

/**
 * Tylko tryb `przyklad`: atrapa bazy nie ma wpłat, a miniony termin gra w niej
 * rolę wpłaty (`przykladoweWplywy`), więc jej należności to same przyszłe terminy
 * w trzech kolumnach. Prawdziwa firma ma `naleznosciProps` z zaległościami.
 */
export function naleznosciPrzykladProps(a: InflowTerms, tryb: TrybDanych): NaleznosciDane {
  return {
    title: 'Należności',
    total: formatPlCompactMoney(a.total),
    totalTitle: `${zl(a.total)} · ${faktury(a.count)}`,
    badge: a.count === 0 && synchronizacja(tryb) ? POBIERAMY_KROTKO : faktury(a.count),
    note: 'Faktury sprzedaży z terminem płatności dziś lub później, bez oznaczonej zapłaty.',
    detailsHref: '/przeplywy',
    visitorData: a.buckets.map((b, i) => ({
      name: KOLUMNY_PRZYKLADU[b.key].name,
      nameTitle: b.label,
      pct: b.pct,
      // Dwie cyfry znaczące: kolumna ma miejsce jak dawne „23.8” (pełna kwota w dymku).
      amount: formatPlCompactNumber(b.amount, 2),
      amountTitle: `${zl(b.amount)} · ${faktury(b.count)}`,
      trend: KOLUMNY_PRZYKLADU[b.key].trend,
      color: KOLORY_KOLUMN[i] ?? 'bg-chart-1',
    })),
  };
}

// ─── Rankingi ─────────────────────────────────────────────────────────────

export interface RankingProdukt {
  name: string;
  sub: string;
  amount: string;
  amountTitle: string;
}

export interface RankingKlient extends RankingProdukt {
  changePct: number | null;
}

export interface RankingiDane {
  products: RankingProdukt[];
  clients: RankingKlient[];
  productsEmpty: string | null;
  clientsEmpty: string | null;
}

const OKRES_RANKINGU = 'netto, ostatnie 12 miesięcy';

export function rankingiProps(products: readonly TopProduct[], clients: readonly TopClient[], tryb: TrybDanych): RankingiDane {
  const brakFaktur = synchronizacja(tryb) ? POBIERAMY : PULPIT_EMPTY.noInvoices;
  return {
    products: products.map((p) => ({
      name: p.name,
      // Faktura nie niesie marki; jednostka jak w dawnej karcie, bez zgadywania „Usługa”.
      sub: p.unit ? `j.m.: ${p.unit}` : '',
      amount: `${formatPlInt(Math.round(p.net))} zł`,
      amountTitle: `${zl(p.net)} ${OKRES_RANKINGU}`,
    })),
    clients: clients.map((c) => ({
      name: c.name,
      sub: c.consumers ? 'Nabywcy bez NIP (B2C)' : c.nip ? `NIP ${c.nip}` : '',
      amount: `${formatPlCompactNumber(c.net)} zł`,
      amountTitle: `${zl(c.net)} ${OKRES_RANKINGU}`,
      changePct: c.changePct,
    })),
    productsEmpty: products.length > 0 ? null : clients.length > 0 ? PULPIT_EMPTY.noProductSales : brakFaktur,
    clientsEmpty: clients.length > 0 ? null : brakFaktur,
  };
}
