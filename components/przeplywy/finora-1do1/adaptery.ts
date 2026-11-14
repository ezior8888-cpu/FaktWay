import { POBIERAMY } from '@/components/dashboard/finora/adaptery';
import {
  receivedInflows,
  type CashFlowChartData,
  type CashFlowOperation,
  type CashFlowSource,
  type FlowBucket,
  type MonthFlow,
  type UpcomingInflow,
} from '@/lib/dashboard/cash-movements';
import type { CostEntry } from '@/lib/dashboard/costs';
import type { InflowEntry } from '@/lib/dashboard/inflows';
import type { TaxEstimate } from '@/lib/dashboard/tax-estimate';
import { monthLabel } from '@/lib/expenses/month';
import type { Odlozyc } from '@/lib/ksiegowosc/odlozyc';
import { podpisKwotMiesiaca } from '@/lib/ksiegowosc/podpis-kwot';
import type { VatLimitOverview } from '@/lib/dashboard/vat-limit';
import type { TrybDanych } from '@/lib/demo/tryb-danych';
import { formatPlCompactMoney, formatPlInt, formatPlMoney, formatPlPercentChange } from '@/lib/format/pl';
import { addDaysToIsoDate } from '@/lib/format/warsaw-date';
import {
  INFLOW_EMPTY,
  INFLOW_EMPTY_LINK,
  INFLOW_EMPTY_LIST,
  INFLOW_EMPTY_TITLE,
  INFLOW_NOTE,
} from '@/lib/dashboard/inflow-labels';
import { plural } from '@/lib/i18n/plural';

/**
 * Adaptery Przepływów (PLAN-PRAWDZIWE-DANE §5.3, §6.2, E6): wynik loaderów
 * `lib/dashboard/*` → propsy kart Finory (`finora-1do1/*`). Jeden adapter
 * dla obu trybów — dane przykładowe (atrapa bazy) i prawdziwe mają ten sam
 * kształt aż do propsów; tryb decyduje tylko o linkach (`href: null`
 * w przykładzie — demo nie ma prawdziwych dokumentów, §11 pkt 6) i o tekście
 * pustego stanu („Pobieramy faktury z KSeF…” w stanie B).
 *
 * Zasada Bartosza 23.10.2026: karty IDENTYCZNE rozmiarowo i designowo, więc
 * adaptery dają tylko napisy w istniejących miejscach i o długości dawnych
 * napisów szablonu. Liczba jest prawdziwa albo jej nie ma („—”): wpływy to
 * oznaczone wpłaty (FaktWay 1.0 §3 pkt 3, D-W odwołane 02.11.2026), a pusty stan
 * prowadzi do oznaczenia; koszty z KSeF przed końcem historii zakupów — „KSeF od
 * DD.MM”. Dłuższe wyjaśnienie idzie do dymku (`title`).
 * Formatowanie robi serwer; do kart klienckich idą napisy i liczby.
 */

const zl = (n: number) => `${formatPlMoney(n)} zł`;
/** Kwota bez groszy jak w szablonie („34 600 zł”). */
const zlCale = (n: number) => `${formatPlInt(Math.round(n))} zł`;

const synchronizacja = (tryb: TrybDanych) => tryb === 'synchronizacja';
const prawdziwe = (tryb: TrybDanych) => tryb !== 'przyklad';

/** „2026-10-21” → „21.10.2026” (bez `Date`, więc bez strefy). */
function dataPl(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/** „2026-10-21” → „21.10”. */
function dzienMiesiac(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}.${m[1]}` : iso;
}

/**
 * Kierunek pieniędzy, nie dokumentu: korekta kosztu in minus to zwrot (na
 * plus), korekta sprzedaży in minus — oddanie pieniędzy (na minus).
 */
function wplywa(op: Pick<CashFlowOperation, 'direction' | 'amount'>): boolean {
  return op.direction === 'in' ? op.amount >= 0 : op.amount < 0;
}

// ─── Przepływy pieniężne (wykres) ─────────────────────────────────────────

export type ZakladkaWykresu = 'weekly' | 'monthly' | 'yearly';

export interface WykresDane {
  subTitle: string;
  subTitleHint: string;
  tabs: Record<ZakladkaWykresu, FlowBucket[]>;
}

/**
 * Podtytuł wykresu: oznaczone wpłaty i koszty brutto. Pełne zdanie w dymku
 * podtytułu (`PODTYTUL_WYKRESU_DYMEK`).
 */
export const PODTYTUL_WYKRESU = 'Oznaczone wpłaty i koszty brutto';
export const PODTYTUL_WYKRESU_DYMEK =
  'Wpływy z faktur sprzedaży według oznaczonych wpłat: faktura bez wpłaty nie jest wpływem, także po terminie. Koszty brutto według daty dokumentu.';

export function wykresProps(chart: CashFlowChartData, tryb: TrybDanych): WykresDane {
  const empty = [...chart.week, ...chart.month, ...chart.year].every((b) => b.inflowCount === 0 && b.outflow === 0);
  return {
    subTitle: empty && synchronizacja(tryb) ? POBIERAMY : PODTYTUL_WYKRESU,
    subTitleHint: PODTYTUL_WYKRESU_DYMEK,
    tabs: { weekly: chart.week, monthly: chart.month, yearly: chart.year },
  };
}

// ─── Kafle „Wpłynęło / Koszty w tym miesiącu” ─────────────────────────────

export interface KafelMiesiacaDane {
  amount: string;
  amountTitle: string;
  changePercentage: string;
  comparison: string;
  chartData: { label: string; value: number }[];
}

/** Dawny podpis plakietki — zostaje, gdy procent ma podstawę. */
const WOBEC = 'wobec poprzedniego miesiąca';

/** Tyle punktów ma krzywa kafla — jak 8 punktów krzywej Finory. */
export const TYGODNIE_KRZYWEJ = 8;

/** Kwota w dniu (RRRR-MM-DD) — wpływ albo dokument kosztowy. */
export interface RuchKrzywej {
  date: string;
  amount: number;
}

/** Poniedziałek tygodnia (pn–nd) dnia `iso`; arytmetyka UTC na polach daty, bez strefy procesu. */
function poniedzialek(iso: string): string {
  const dow = new Date(`${iso.slice(0, 10)}T12:00:00Z`).getUTCDay(); // 0 = niedziela
  return addDaysToIsoDate(iso.slice(0, 10), -((dow + 6) % 7)) ?? iso;
}

const centy = (n: number) => Math.round(n * 100) / 100 || 0;

/**
 * Krzywa kafla (poprawka ze zrzutów 24.10.2026): 8 punktów = sumy 8 ostatnich
 * tygodni pn–nd, ostatni = bieżący tydzień. Dawniej suma narastająca od
 * 1. dnia miesiąca — zawsze rosła (a 1. dnia była płaska), w Finorze to
 * falista linia z 8 punktów. Kwota, procent i tytuł kafla zostają
 * miesięczne; krzywa pokazuje rytm ostatnich tygodni, a dymek punktu —
 * zakres tygodnia („13.10–19.10”) i jego sumę. Ruchy spoza 8 tygodni (także
 * dokument z datą po bieżącym tygodniu) się nie liczą; które ruchy wchodzą,
 * wybiera wywołujący (`krzywaWplywow`, `krzywaKosztow`).
 */
export function krzywaTygodni(ruchy: readonly RuchKrzywej[], today: string): KafelMiesiacaDane['chartData'] {
  const ten = poniedzialek(today);
  const starty = Array.from(
    { length: TYGODNIE_KRZYWEJ },
    (_, i) => addDaysToIsoDate(ten, -7 * (TYGODNIE_KRZYWEJ - 1 - i)) ?? ten,
  );
  const sumy = new Map(starty.map((s) => [s, 0]));
  for (const r of ruchy) {
    const tydzien = poniedzialek(r.date);
    const suma = sumy.get(tydzien);
    if (suma !== undefined) sumy.set(tydzien, suma + r.amount);
  }
  return starty.map((s) => ({
    label: `${dzienMiesiac(s)}–${dzienMiesiac(addDaysToIsoDate(s, 6) ?? s)}`,
    value: centy(sumy.get(s)!),
  }));
}

/** Wpływy, czyli prawdziwe pieniądze (`receivedInflows`), według dnia zapłaty. */
export function krzywaWplywow(inflows: readonly InflowEntry[], today: string): KafelMiesiacaDane['chartData'] {
  return krzywaTygodni(receivedInflows(inflows, today).map((i) => ({ date: i.date, amount: i.amount })), today);
}

/** Koszty brutto według daty dokumentu — jak kwota kafla i słupki wydatków wykresu. */
export function krzywaKosztow(costs: readonly CostEntry[], today: string): KafelMiesiacaDane['chartData'] {
  return krzywaTygodni(costs.map((c) => ({ date: c.issueDate, amount: c.outflow })), today);
}

/**
 * „Wpłynęło w tym miesiącu”: oznaczone wpłaty od 1. dnia miesiąca do dziś; bez
 * żadnej wpłaty „—” i pusty stan prowadzący do oznaczenia, nie „0 zł”. Krzywa:
 * 8 tygodni (`krzywaWplywow`).
 */
export function wplywyMiesiacaProps(
  flow: MonthFlow,
  krzywa: KafelMiesiacaDane['chartData'],
  tryb: TrybDanych,
): KafelMiesiacaDane {
  const brak = flow.count === 0;
  return {
    amount: brak ? '—' : zlCale(flow.amount),
    amountTitle: brak ? INFLOW_EMPTY_TITLE : `${zl(flow.amount)} · ${INFLOW_NOTE}`,
    changePercentage: brak || flow.changePct === null ? '—' : formatPlPercentChange(flow.changePct),
    comparison: brak ? (synchronizacja(tryb) ? POBIERAMY : INFLOW_EMPTY) : WOBEC,
    chartData: krzywa,
  };
}

/** „Koszty w tym miesiącu (brutto)”: dokumenty kosztowe według daty dokumentu; krzywa — 8 tygodni (`krzywaKosztow`). */
export function kosztyMiesiacaProps(
  flow: MonthFlow,
  krzywa: KafelMiesiacaDane['chartData'],
  tryb: TrybDanych,
  notaKsef = '',
): KafelMiesiacaDane {
  return {
    amount: zlCale(flow.amount),
    amountTitle: `${zl(flow.amount)} brutto, według daty dokumentu${notaKsef}`,
    changePercentage: flow.changePct === null ? '—' : formatPlPercentChange(flow.changePct),
    comparison: flow.count === 0 && synchronizacja(tryb) ? POBIERAMY : WOBEC,
    chartData: krzywa,
  };
}

// ─── Odłóż na podatek / Limit zwolnienia z VAT (pierścień) ────────────────

export interface PierscienDane {
  title: string;
  subtitle: string;
  /** 0–100; 100 = pełny łuk. */
  pct: number;
  /** Trzy wiersze w środku pierścienia (rozmiary jak w szablonie: procent, kwota, podpis). */
  lines: [string, string, string];
  caption: string;
}

/** Stawka podatku liniowego w środku pierścienia „Odłóż na podatek” (procent). */
const STAWKA_LINIOWA = 19;

/**
 * Płatnik VAT (Z10): szacunek PIT od 1 stycznia. W środku stawka, kwota
 * i „do odłożenia” — te same trzy wiersze i rozmiary co „68% / 6,8 tys. zł
 * / z celu”. Łuk = pokazany procent (19% obwodu na jasnym torze, jak 68%
 * w Finorze; poprawka ze zrzutów 24.10.2026) — dawniej pełny łuk przy
 * napisie „19%” był niespójny i zasłaniał tor.
 */
export function podatekProps(estimate: TaxEstimate, tryb: TrybDanych): PierscienDane {
  return {
    title: 'Odłóż na podatek',
    subtitle: estimate.amount === 0 && synchronizacja(tryb)
      ? POBIERAMY
      : estimate.fullYear
        ? 'Szacunek PIT od 1 stycznia'
        : estimate.label.replace('Szac. podatek', 'Szacunek PIT'),
    pct: STAWKA_LINIOWA,
    lines: [`${STAWKA_LINIOWA}%`, formatPlCompactMoney(estimate.amount), 'do odłożenia'],
    caption: 'Szacunek: liniowy, bez ZUS',
  };
}

/** Brak profilu w pierwszym powodzie z „Ten miesiąc” (`tenMiesiac`, K4). */
const BEZ_PROFILU = /nie ma ustawień podatkowych/;

/**
 * Firma w pilotażu księgowości (K5, D13): szacunek z modułu za bieżący
 * miesiąc (podatek, składki społeczne, zdrowotna, a przy czynnym VAT także VAT, K7.1) zamiast 19 % liniowego.
 * W środku udział w przychodzie miesiąca, kwota i „do odłożenia”. Bez kwot
 * (brak profilu, parametry czekające na księgową, D7) karta mówi, dlaczego.
 * Kwota ma podpis jak na stronie „Ten miesiąc” (NZ-TRESC-02), z rokiem
 * miesiąca szacunku i, w styczniu, rokiem składkowym zdrowotnej.
 */
export function odlozycProps(w: Odlozyc): PierscienDane {
  const subtitle = `Szacunek za ${monthLabel(w.miesiac)} z danych do dziś`;
  if (!w.ok) {
    return {
      title: 'Odłóż na podatek',
      subtitle,
      pct: 0,
      lines: ['0%', formatPlCompactMoney(0), 'bez szacunku'],
      caption: w.braki.some((b) => BEZ_PROFILU.test(b))
        ? 'Bez ustawień podatkowych nie liczymy szacunku.'
        : 'Szacunku jeszcze nie liczymy; powód jest w „Ten miesiąc”.',
    };
  }
  const pct = w.przychodGr && w.przychodGr > 0 ? Math.round((w.kwotaGr / w.przychodGr) * 100) : 0;
  const podpis = podpisKwotMiesiaca(w.miesiac, w.pozycje.some((p) => p.rodzaj === 'zdrowotna'));
  return {
    title: 'Odłóż na podatek',
    subtitle,
    pct: Math.min(100, Math.max(0, pct)),
    lines: [`${pct}%`, formatPlCompactMoney(w.kwotaGr / 100), 'do odłożenia'],
    caption: w.braki.length > 0 ? `${podpis} Część kwot bez szacunku, szczegóły w „Ten miesiąc”.` : podpis,
  };
}

const procent = (pct: number) => Math.max(0, Math.floor(pct));

/**
 * Firma zwolniona z VAT (art. 113): wykorzystanie limitu i prognoza. Bez
 * daty rozpoczęcia działalności procent od pełnego limitu to dolna granica
 * („≥”) — limit proporcjonalny nie jest wyższy niż pełny.
 */
export function limitProps(o: VatLimitOverview, tryb: TrybDanych): PierscienDane {
  const subtitle = o.used === 0 && synchronizacja(tryb) ? POBIERAMY : 'Sprzedaż od 1 stycznia';
  if (o.limit) {
    const l = o.limit;
    return {
      title: 'Limit zwolnienia z VAT',
      subtitle,
      pct: Math.min(100, Math.max(0, l.pct)),
      lines: [`${procent(l.pct)}%`, formatPlCompactMoney(o.used), `z ${formatPlCompactMoney(l.effectiveLimit)}`],
      caption: l.level === 100
        ? 'Limit przekroczony — sprawdź VAT'
        : l.remaining === 0
          ? 'Limit wykorzystany w całości'
          : l.crossesOn
            ? `Limit skończy się ok. ${dataPl(l.crossesOn)}`
            : 'Limit wystarczy do końca roku',
    };
  }
  const pct = o.lowerBound?.pct ?? 0;
  return {
    title: 'Limit zwolnienia z VAT',
    subtitle,
    pct: Math.min(100, Math.max(0, pct)),
    lines: [`≥${procent(pct)}%`, formatPlCompactMoney(o.used), `z ${formatPlCompactMoney(o.annualLimit)}`],
    caption: o.lowerBound?.level === 100 ? 'Pełny limit przekroczony' : 'Uzupełnij datę rozpoczęcia firmy',
  };
}

// ─── Największe źródła przepływów ─────────────────────────────────────────

export interface ZrodloDane {
  sourceName: string;
  sourceType: string;
  amount: string;
  amountTitle: string;
  share: number;
  direction: 'in' | 'out';
  href: string | null;
}

export interface ListaDane<T> {
  items: T[];
  /** Tekst pustej listy (karta bez pozycji). */
  empty: string;
  /** Dokąd iść z pustej listy, żeby oznaczyć zapłatę; `null` w przykładzie i przy pobieraniu z KSeF. */
  emptyLink?: { label: string; href: string } | null;
}

/** Pusty stan kart ze wpływami: prawdziwa firma dostaje drogę do oznaczenia zapłaty. */
function pustaListaWplywow(tryb: TrybDanych): Pick<ListaDane<never>, 'empty' | 'emptyLink'> {
  if (synchronizacja(tryb)) return { empty: POBIERAMY, emptyLink: null };
  return { empty: INFLOW_EMPTY_LIST, emptyLink: prawdziwe(tryb) ? INFLOW_EMPTY_LINK : null };
}

const OKRES_12 = 'w ostatnich 12 miesiącach';

export function zrodlaProps(sources: readonly CashFlowSource[], tryb: TrybDanych): ListaDane<ZrodloDane> {
  return {
    items: sources.map((s) => ({
      sourceName: s.name,
      sourceType: s.direction === 'in'
        ? `${s.consumers ? 'B2C' : 'Klient'} · ${s.count} ${plural(s.count, ['wpłata', 'wpłaty', 'wpłat'])}`
        : `Dostawca · ${s.count} ${plural(s.count, ['dokument', 'dokumenty', 'dokumentów'])}`,
      amount: zlCale(s.amount),
      amountTitle: s.direction === 'in' ? `${zl(s.amount)} ${OKRES_12}, ${INFLOW_NOTE}` : `${zl(s.amount)} ${OKRES_12}`,
      share: s.share,
      direction: s.direction,
      // Konsumenci nie mają karty kontrahenta.
      href: prawdziwe(tryb) && !s.consumers ? '/contractors' : null,
    })),
    ...pustaListaWplywow(tryb),
  };
}

// ─── Spodziewane wpływy (dawne „Nadchodzące rachunki”) ────────────────────

export interface SpodziewanyDane {
  title: string;
  titleHint: string;
  dueDate: string;
  amount: string;
  href: string | null;
}

/**
 * Otwarte faktury sprzedaży z terminem w 30 dni, kwota = reszta do zapłaty.
 * Podtytuł karty („Następne 30 dni”) nie ma miejsca na zdanie: idzie do dymku
 * podtytułu i czytnika ekranu.
 */
export const SPODZIEWANE_NOTA =
  'Otwarte faktury sprzedaży z terminem płatności dziś lub w najbliższych 30 dniach, bez oznaczonej zapłaty.';

function termin(daysLeft: number): string {
  if (daysLeft === 0) return 'Termin dziś';
  if (daysLeft === 1) return 'Termin jutro';
  return `Termin za ${daysLeft} dni`;
}

export function wplywySpodziewaneProps(
  items: readonly UpcomingInflow[],
  tryb: TrybDanych,
): ListaDane<SpodziewanyDane> & { note: string } {
  return {
    items: items.map((i) => ({
      title: i.name,
      titleHint: i.internalNumber ? `${i.name} · ${i.internalNumber}` : i.name,
      dueDate: termin(i.daysLeft),
      amount: zl(i.amount),
      href: prawdziwe(tryb) ? `/invoices/${i.id}` : null,
    })),
    empty: synchronizacja(tryb) ? POBIERAMY : 'Brak faktur z terminem w 30 dni',
    note: SPODZIEWANE_NOTA,
  };
}

// ─── Ostatnia aktywność ───────────────────────────────────────────────────

export interface AktywnoscDane {
  /** Rodzaj dokumentu (ikona): wpłata za fakturę albo dokument kosztowy. */
  rodzaj: 'wplata' | 'koszt';
  label: string;
  subLabel: string;
  subLabelTitle: string;
  amount: string;
  direction: 'in' | 'out';
  href: string | null;
}

/** Skąd data w drugim wierszu: wpłata albo wystawienie korekty zapłaconej faktury. */
const PODSTAWA: Record<CashFlowOperation['status'], { krotko: string; dymek: string }> = {
  paid: { krotko: 'Wpłata', dymek: 'Wpłata' },
  correction: { krotko: 'Korekta', dymek: 'Korekta zapłaconej faktury' },
  reviewed: { krotko: 'Koszt', dymek: 'Koszt' },
  pending: { krotko: 'Koszt', dymek: 'Koszt' },
  ksef: { krotko: 'Koszt', dymek: 'Koszt' },
};

export function aktywnoscProps(ops: readonly CashFlowOperation[], tryb: TrybDanych): ListaDane<AktywnoscDane> {
  return {
    items: ops.map((op) => {
      const podstawa = op.direction === 'in' ? PODSTAWA[op.status] : PODSTAWA.reviewed;
      return {
        rodzaj: op.direction === 'in' ? 'wplata' : 'koszt',
        label: op.counterparty,
        subLabel: `${podstawa.krotko} · ${dataPl(op.date)}`,
        subLabelTitle: [podstawa.dymek, op.reference, dataPl(op.date)].filter(Boolean).join(' · '),
        amount: zl(Math.abs(op.amount)),
        direction: wplywa(op) ? 'in' : 'out',
        href: prawdziwe(tryb) ? op.href : null,
      };
    }),
    ...pustaListaWplywow(tryb),
  };
}

// ─── Tabela operacji ──────────────────────────────────────────────────────

export interface WierszTabeli {
  id: string;
  /** Inicjały zamiast nieistniejących awatarów (ten sam rozmiar). */
  initials: string;
  counterparty: string;
  /** Druga linia: „NIP … · numer dokumentu”. */
  detail: string;
  category: string;
  direction: 'in' | 'out';
  /** Kwota bez znaku; znak i kolor z `direction` (kierunek pieniędzy). */
  amount: number;
  status: CashFlowOperation['status'];
  /** „Otwórz fakturę” / „Otwórz wydatek” w menu wiersza. */
  openLabel: string;
  href: string | null;
}

/** „Alfa sp. z o.o.” → „AL”, „Beta Paliwa” → „BP”. */
export function inicjaly(name: string): string {
  const words = name.split(/\s+/).filter((w) => /^\p{Lu}/u.test(w));
  if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`;
  const letters = (words[0] ?? name).replace(/[^\p{L}]/gu, '');
  return letters.slice(0, 2).toUpperCase() || '—';
}

export function tabelaProps(
  ops: readonly CashFlowOperation[],
  tryb: TrybDanych,
): { rows: WierszTabeli[]; empty: string } {
  return {
    rows: ops.map((op) => ({
      id: op.id,
      initials: inicjaly(op.counterparty),
      counterparty: op.counterparty,
      detail: [op.nip ? `NIP ${op.nip}` : null, op.reference].filter(Boolean).join(' · ') || '—',
      // Kategoria wpisana przez klienta małą literą — wielka na początku, jak dawne `capitalize`.
      category: op.category.charAt(0).toLocaleUpperCase('pl-PL') + op.category.slice(1),
      direction: wplywa(op) ? 'in' : 'out',
      amount: Math.abs(op.amount),
      status: op.status,
      // Koszt z faktury zakupu z KSeF bez wydatku (E10) otwiera fakturę.
      openLabel: op.direction === 'in' || op.status === 'ksef' ? 'Otwórz fakturę' : 'Otwórz wydatek',
      href: prawdziwe(tryb) ? op.href : null,
    })),
    empty: synchronizacja(tryb) ? POBIERAMY : 'Brak operacji. Oznacz zapłatę przy fakturze, a pojawi się tutaj.',
  };
}
