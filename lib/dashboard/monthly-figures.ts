import {
  fetchSettledAdvancesTotals,
  type SettledAdvanceTotals,
} from '@/lib/invoices/settled-advances';
import type { PageContext } from '@/lib/supabase/page-context';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { assertOutgoingInvoicesInPln } from '@/lib/exports/currency-guard';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { roundToCents } from '@/lib/xml/invoice-calculator';
import type { KsefEnvironment } from '@/types/ksef';

/**
 * WŁAŚCICIEL: Bartosz (tor silnika) — rama panelu.
 *
 * Liczby miesiąca dla szyny dashboardu i dla podsumowania VAT na `/przeplywy`.
 * Wyciągnięte z `app/(dashboard)/dashboard/page.tsx` przy przebudowie na układ
 * z agentem, żeby dwa miejsca nie liczyły tego samego dwoma zapytaniami.
 *
 * ⚠️ NAPRAWA PRZY OKAZJI: stary dashboard filtrował `direction = 'issued'`,
 * a kolumna `invoices.direction` dopuszcza WYŁĄCZNIE `'outgoing' | 'incoming'`
 * (`00001_initial_schema.sql:54`; migracja `00044_phase21_performance.sql:18`
 * ostrzega o tym wprost). Każda z czterech kart KPI pokazywała więc zero,
 * niezależnie od tego, ile faktur miał klient. Tutaj jest `'outgoing'`.
 */

const OUTGOING = 'outgoing' as const;

/** Kolumny, po których `fetchSettledAdvancesTotals` rozpoznaje ROZ i jej zaliczki. */
const SETTLEMENT_COLUMNS = 'id, invoice_kind, advance_invoice_ids';

/**
 * Kwota faktury bez zaliczek, które rozlicza. ROZ trzyma w bazie PEŁNE
 * zamówienie, a VAT i sprzedaż zaliczki pulpit liczy już w jej miesiącu —
 * z ROZ zostaje więc reszta, jak w KPiR i JPK (AUD-26). Inne faktury
 * przechodzą bez zmian.
 */
function remainder(
  settled: ReadonlyMap<string, SettledAdvanceTotals>,
  row: { id: string },
  amount: number | string | null,
  part: keyof SettledAdvanceTotals,
): number {
  return Number(amount ?? 0) - (settled.get(row.id)?.[part] ?? 0);
}

export interface MonthlyFigures {
  /** „sierpień 2026" */
  monthName: string;
  prevAcceptedCount: number;
  acceptedCount: number;
  /** Niezłożone szkice bez przypisanego środowiska KSeF. */
  draftCount: number;
  totalNet: number;
  totalVat: number;
  totalGross: number;
  /** Zmiana LICZBY przyjętych faktur miesiąc do miesiąca, w procentach. */
  momCountPct: number;
  /** Zmiana KWOTY sprzedaży brutto miesiąc do miesiąca, w procentach. */
  momGrossPct: number;
  /** „25.09.2026" */
  vatDueLabel: string;
  daysToVatDue: number;
  /** Bieżący miesiąc jest najlepszy w roku pod względem sprzedaży brutto. */
  isBestMonthOfYear: boolean;
  /** Czy poprzedni miesiąc ma przyjętą fakturę — bez tego procent nie istnieje. */
  hasPrevMonth: boolean;
}

/** Wiersz przyjętej faktury sprzedaży, z którego liczą `buildMonthlyFigures` i `buildSalesSeries`. */
export type InvoiceSummary = {
  id: string;
  issue_date: string;
  invoice_kind: string | null;
  advance_invoice_ids: string[] | null;
  gross_total: number | string | null;
  net_total: number | string | null;
  vat_total: number | string | null;
  currency: string | null;
};

/**
 * Pierwszy dzień miesiąca jako RRRR-MM-DD. Arytmetyka w UTC na polach
 * kalendarza (`monthIndex` może wyjść poza 0–11), więc wynik nie zależy od
 * strefy procesu.
 */
function monthStartIso(year: number, monthIndex: number): string {
  const date = new Date(Date.UTC(year, monthIndex, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * Rok i miesiąc (0–11) „dziś” w Polsce. Plan Finora §2.4 pkt 10: serwer
 * i worker chodzą w UTC, więc `now.getMonth()` 1. dnia miesiąca między
 * 00:00 a 02:00 czasu polskiego dawał jeszcze poprzedni miesiąc — faktura
 * z dziś wypadała z liczb miesiąca, a termin VAT był o miesiąc za wcześnie.
 */
function warsawCalendar(now: Date): { today: string; year: number; monthIndex: number } {
  const today = todayInWarsaw(now);
  return {
    today,
    year: Number(today.slice(0, 4)),
    monthIndex: Number(today.slice(5, 7)) - 1,
  };
}

/** Dni kalendarzowe między dwiema datami RRRR-MM-DD (bez stref i zmian czasu). */
function daysBetweenIsoDates(fromIso: string, toIso: string): number {
  const utc = (iso: string) =>
    Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return Math.round((utc(toIso) - utc(fromIso)) / 86_400_000);
}

/** Pierwszy dzień miesiąca jako `Date` w UTC — tylko do podpisów z `timeZone: 'UTC'`. */
function monthStartUtc(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex, 1));
}

/** Komunikaty strażnika środowiska; `ENVIRONMENT_UNKNOWN` rzuca też wspólny odczyt Pulpitu (`sales-history.ts`). */
const ENVIRONMENT_CHECK_FAILED = 'Nie można sprawdzić środowiska faktur KSeF';
export const ENVIRONMENT_UNKNOWN = 'Przyjęte faktury wymagają uzgodnienia środowiska KSeF';

/**
 * An accepted invoice with no stored environment could belong to TEST or
 * production. A zero-only dashboard would hide that historical ambiguity.
 * Known invoices in another environment are excluded by the monetary query.
 *
 * Eksport dla kart Pulpitu (plan Finora §2.4 pkt 2 i 15): każda karta
 * sprzedaży zatrzymuje się tym samym komunikatem.
 */
export async function assertAcceptedEnvironmentKnown(
  supabase: PageContext['supabase'],
  tenantId: string,
  start: string,
  endExclusive: string,
): Promise<void> {
  const { count, error } = await supabase
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('direction', OUTGOING)
    .eq('ksef_status', 'accepted')
    .is('ksef_environment', null)
    .gte('issue_date', start)
    .lt('issue_date', endExclusive);
  if (error || typeof count !== 'number') {
    throw new Error(ENVIRONMENT_CHECK_FAILED);
  }
  if (count > 0) {
    throw new Error(ENVIRONMENT_UNKNOWN);
  }
}

/**
 * PostgREST can cap a successful response. Counted pages make an incomplete
 * month a visible error instead of silently understating VAT and sales.
 */
async function fetchAcceptedInvoices(
  supabase: PageContext['supabase'],
  tenantId: string,
  environment: KsefEnvironment,
  start: string,
  endExclusive: string,
  errorMessage: string,
): Promise<InvoiceSummary[]> {
  const rows = await readCompletePages(errorMessage, (from, to) => supabase
      .from('invoices')
      .select(`issue_date, gross_total, net_total, vat_total, currency, ${SETTLEMENT_COLUMNS}`, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('direction', OUTGOING)
      .eq('ksef_status', 'accepted')
      .eq('ksef_environment', environment)
      .gte('issue_date', start)
      .lt('issue_date', endExclusive)
      .order('id', { ascending: true })
      .range(from, to));
  // C-11: sumy w złotych — faktura walutowa albo bez waluty zatrzymuje pulpit.
  assertOutgoingInvoicesInPln(rows);
  return rows;
}

export async function countLocalDrafts(
  supabase: PageContext['supabase'],
  tenantId: string,
  start: string,
  endExclusive: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('direction', OUTGOING)
    .eq('ksef_status', 'draft')
    .is('ksef_environment', null)
    .gte('issue_date', start)
    .lt('issue_date', endExclusive);
  if (error || typeof count !== 'number') {
    throw new Error('Nie można odczytać liczby szkiców');
  }
  return count;
}

/**
 * Formatery przeniesione do `lib/format/pl.ts` (moduł bez importów, więc
 * nadaje się też do komponentów klienckich). Re-eksport zostaje, żeby nie
 * przepisywać wywołań w stronach, które już go stąd biorą.
 */
export { formatPlInt, formatPlMoney } from '@/lib/format/pl';

/** Etykieta błędu odczytu liczb miesiąca (karta „Faktury w KSeF”). */
export const MONTHLY_FIGURES_READ_ERROR = 'Nie można odczytać liczb miesiąca';

/** Okna `getMonthlyFigures`: odczyt od poprzedniego miesiąca albo 1 stycznia, szkice z bieżącego miesiąca. */
export interface MonthlyFiguresRange {
  /** Wcześniejszy z: 1. dzień poprzedniego miesiąca, 1 stycznia. */
  from: string;
  /** 1. dzień następnego miesiąca (wyłącznie). */
  toExclusive: string;
  /** 1. dzień bieżącego miesiąca — od niego liczą się szkice. */
  monthStart: string;
}

export function monthlyFiguresRange(now: Date): MonthlyFiguresRange {
  const { year, monthIndex } = warsawCalendar(now);
  const prevMonthStartIso = monthStartIso(year, monthIndex - 1);
  const yearStartIso = monthStartIso(year, 0);
  return {
    from: prevMonthStartIso < yearStartIso ? prevMonthStartIso : yearStartIso,
    toExclusive: monthStartIso(year, monthIndex + 1),
    monthStart: monthStartIso(year, monthIndex),
  };
}

export async function getMonthlyFigures(
  supabase: PageContext['supabase'],
  tenantId: string,
  now: Date = new Date(),
): Promise<MonthlyFigures> {
  const range = monthlyFiguresRange(now);
  const environment = requireConfiguredKsefEnvironment();

  await assertAcceptedEnvironmentKnown(
    supabase, tenantId, range.from, range.toExclusive,
  );
  const [acceptedInvoices, draftCount] = await Promise.all([
    fetchAcceptedInvoices(
      supabase, tenantId, environment, range.from, range.toExclusive,
      MONTHLY_FIGURES_READ_ERROR,
    ),
    countLocalDrafts(supabase, tenantId, range.monthStart, range.toExclusive),
  ]);

  // ROZ bez rozliczonych zaliczek (AUD-26). Okno odczytu to poprzedni miesiąc
  // i rok do dziś, więc jedno odczytanie obejmuje wszystkie trzy zbiory.
  const settled = await fetchSettledAdvancesTotals(supabase, tenantId, acceptedInvoices);
  return buildMonthlyFigures(now, acceptedInvoices, draftCount, settled);
}

/**
 * Liczby miesiąca z przyjętych faktur okna `monthlyFiguresRange` (już po
 * strażnikach środowiska i waluty), liczby szkiców i rozliczonych zaliczek.
 * Wspólne dla `getMonthlyFigures` i wspólnego odczytu Pulpitu.
 */
export function buildMonthlyFigures(
  now: Date,
  acceptedInvoices: readonly InvoiceSummary[],
  draftCount: number,
  settled: ReadonlyMap<string, SettledAdvanceTotals>,
): MonthlyFigures {
  const { today, year, monthIndex } = warsawCalendar(now);
  const startOfMonthIso = monthStartIso(year, monthIndex);
  const prevMonthStartIso = monthStartIso(year, monthIndex - 1);
  const nextMonthStartIso = monthStartIso(year, monthIndex + 1);
  const yearStartIso = monthStartIso(year, 0);

  const monthInvoices = acceptedInvoices.filter((invoice) =>
    invoice.issue_date >= startOfMonthIso);
  const prevInvoices = acceptedInvoices.filter((invoice) =>
    invoice.issue_date >= prevMonthStartIso && invoice.issue_date < startOfMonthIso);
  const ytdInvoices = acceptedInvoices.filter((invoice) =>
    invoice.issue_date >= yearStartIso);

  const acceptedCount = monthInvoices.length;
  const totalNet =
    monthInvoices.reduce((sum, i) => sum + remainder(settled, i, i.net_total, 'net'), 0);
  const totalVat =
    monthInvoices.reduce((sum, i) => sum + remainder(settled, i, i.vat_total, 'vat'), 0);
  const totalGross =
    monthInvoices.reduce((sum, i) => sum + remainder(settled, i, i.gross_total, 'gross'), 0);

  const ytdByMonth = new Map<string, number>();
  ytdInvoices.forEach((inv) => {
    const key = inv.issue_date.slice(0, 7);
    ytdByMonth.set(key, (ytdByMonth.get(key) ?? 0) + remainder(settled, inv, inv.gross_total, 'gross'));
  });
  const maxYtdMonthGross = Math.max(0, ...Array.from(ytdByMonth.values()));

  const prevAcceptedCount = prevInvoices.length;
  const prevGross =
    prevInvoices.reduce((sum, i) => sum + remainder(settled, i, i.gross_total, 'gross'), 0);

  /**
   * Zmiana procentowa liczona osobno dla liczby faktur i dla kwoty — te dwie
   * rzeczy rozjeżdżają się przy jednej dużej fakturze i podpisanie kwoty
   * zmianą liczby sztuk było zwykłym kłamstwem na ekranie.
   *
   * Brak poprzedniego miesiąca nie jest wzrostem o 100%: przy zerowej
   * podstawie procent nie istnieje, więc zwracamy `null` i interfejs
   * pokazuje wtedy co innego.
   */
  const zmiana = (teraz: number, przedtem: number): number | null =>
    przedtem > 0 ? Math.round(((teraz - przedtem) / przedtem) * 100) : null;

  // Termin VAT: 25. dzień miesiąca po polskim „dziś”. Dni po dobach
  // kalendarzowych od polskiej daty, nie po milisekundach od `now`.
  const vatDueIso = `${nextMonthStartIso.slice(0, 8)}25`;
  const daysToVatDue = Math.max(0, daysBetweenIsoDates(today, vatDueIso));

  return {
    monthName: monthStartUtc(year, monthIndex).toLocaleDateString('pl-PL', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }),
    prevAcceptedCount,
    acceptedCount,
    draftCount,
    totalNet,
    totalVat,
    totalGross,
    momCountPct: zmiana(acceptedCount, prevAcceptedCount) ?? 0,
    momGrossPct: zmiana(totalGross, prevGross) ?? 0,
    hasPrevMonth: prevAcceptedCount > 0,
    vatDueLabel: `${vatDueIso.slice(8, 10)}.${vatDueIso.slice(5, 7)}.${vatDueIso.slice(0, 4)}`,
    daysToVatDue,
    isBestMonthOfYear:
      totalGross > 0 &&
      maxYtdMonthGross > 0 &&
      totalGross >= maxYtdMonthGross - 0.01,
  };
}

export interface SalesSeries {
  months: { key: string; label: string }[];
  /** Sprzedaż BRUTTO per miesiąc okna (ROZ bez rozliczonych zaliczek), w groszach. */
  currentSeries: number[];
  /** Brutto tego samego okna rok wcześniej; `[]` przy `withPrevYear: false`. */
  prevSeries: number[];
  /**
   * NETTO tego samego okna rok wcześniej (te same wiersze co `prevSeries`);
   * `[]` przy `withPrevYear: false`. Karta „Przychód netto” Pulpitu
   * (PLAN-PRAWDZIWE-DANE E5) porównuje netto z netto.
   */
  prevNetSeries: number[];
  currentMonthKey: string;
  /** Sprzedaż NETTO per miesiąc okna — te same wiersze co `currentSeries`. */
  netSeries: number[];
  /**
   * VAT należny per miesiąc okna — te same wiersze co `currentSeries`.
   * Bieżący miesiąc równa się `roundToCents(getMonthlyFigures().totalVat)`.
   * Wszystkie serie są zaokrąglone do groszy per miesiąc.
   */
  vatSeries: number[];
}

export interface SalesSeriesOptions {
  /** Długość okna w miesiącach kalendarzowych, z bieżącym. Domyślnie 6. */
  months?: number;
  /**
   * Czy czytać to samo okno rok wcześniej (linia odniesienia). Domyślnie
   * `true`. Przy `false` nie ma ani zapytania o faktury, ani strażnika
   * środowiska za rok wcześniej, a `prevSeries` to `[]`.
   */
  withPrevYear?: boolean;
}

/** Etykieta błędu odczytu serii sprzedaży (Finanse, VAT należny, Przychód netto). */
export const SALES_SERIES_READ_ERROR = 'Nie można odczytać wykresu sprzedaży';

/** Miesiące i okna odczytu serii sprzedaży — z nich liczy `buildSalesSeries`. */
export interface SalesSeriesPlan {
  today: string;
  months: { key: string; prevKey: string; label: string }[];
  /** Okno bieżące `[from, toExclusive)` po `issue_date`. */
  current: { from: string; toExclusive: string };
  /** To samo okno rok wcześniej; `null` przy `withPrevYear: false`. */
  previous: { from: string; toExclusive: string } | null;
}

export function salesSeriesPlan(now: Date, options: SalesSeriesOptions = {}): SalesSeriesPlan {
  const monthCount = options.months ?? 6;
  const withPrevYear = options.withPrevYear ?? true;
  if (!Number.isSafeInteger(monthCount) || monthCount < 1) {
    throw new Error('Okno wykresu sprzedaży musi mieć co najmniej jeden miesiąc');
  }
  const { today, year, monthIndex } = warsawCalendar(now);
  const months: { key: string; prevKey: string; label: string }[] = [];
  for (let i = monthCount - 1; i >= 0; i--) {
    const d = monthStartUtc(year, monthIndex - i);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const prevKey = `${d.getUTCFullYear() - 1}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const raw = d
      .toLocaleDateString('pl-PL', { month: 'short', timeZone: 'UTC' })
      .replace(/\./g, '')
      .trim();
    months.push({
      key,
      prevKey,
      label: raw.charAt(0).toUpperCase() + raw.slice(1),
    });
  }

  return {
    today,
    months,
    current: { from: `${months[0]!.key}-01`, toExclusive: monthStartIso(year, monthIndex + 1) },
    previous: withPrevYear
      ? { from: `${months[0]!.prevKey}-01`, toExclusive: monthStartIso(year - 1, monthIndex + 1) }
      : null,
  };
}

/**
 * Miesiące kalendarzowe (domyślnie sześć, z bieżącym) + to samo okno rok
 * wcześniej (linia odniesienia). Wywołanie bez `options` zwraca dokładnie
 * to, co przed planem Finora E4 (6 miesięcy, brutto, z rokiem wcześniej),
 * plus `netSeries` i `vatSeries`.
 */
export async function getSalesSeries(
  supabase: PageContext['supabase'],
  tenantId: string,
  now: Date = new Date(),
  options: SalesSeriesOptions = {},
): Promise<SalesSeries> {
  const plan = salesSeriesPlan(now, options);
  const { current: currentRange, previous: previousRange } = plan;
  const environment = requireConfiguredKsefEnvironment();
  await Promise.all([
    assertAcceptedEnvironmentKnown(
      supabase, tenantId, currentRange.from, currentRange.toExclusive,
    ),
    ...(previousRange
      ? [assertAcceptedEnvironmentKnown(
          supabase, tenantId, previousRange.from, previousRange.toExclusive,
        )]
      : []),
  ]);
  const [current, previous] = await Promise.all([
    fetchAcceptedInvoices(
      supabase, tenantId, environment, currentRange.from, currentRange.toExclusive,
      SALES_SERIES_READ_ERROR,
    ),
    previousRange
      ? fetchAcceptedInvoices(
          supabase, tenantId, environment, previousRange.from, previousRange.toExclusive,
          SALES_SERIES_READ_ERROR,
        )
      : Promise.resolve<InvoiceSummary[]>([]),
  ]);

  const settled = await fetchSettledAdvancesTotals(supabase, tenantId, [
    ...current,
    ...previous,
  ]);
  return buildSalesSeries(plan, current, previous, settled);
}

/**
 * Serie z przyjętych faktur okien `plan` (już po strażnikach środowiska
 * i waluty) i rozliczonych zaliczek. Wspólne dla `getSalesSeries`
 * i wspólnego odczytu Pulpitu.
 */
export function buildSalesSeries(
  plan: SalesSeriesPlan,
  current: readonly InvoiceSummary[],
  previous: readonly InvoiceSummary[],
  settled: ReadonlyMap<string, SettledAdvanceTotals>,
): SalesSeries {
  const { today, months } = plan;
  const withPrevYear = plan.previous !== null;

  const sumByMonth = (
    rows: readonly InvoiceSummary[],
    pick: (inv: InvoiceSummary) => number,
  ) => {
    const map = new Map<string, number>();
    rows.forEach((inv) => {
      const key = inv.issue_date.slice(0, 7);
      map.set(key, (map.get(key) ?? 0) + pick(inv));
    });
    return map;
  };

  const gross = (inv: InvoiceSummary) => remainder(settled, inv, inv.gross_total, 'gross');
  const currentByMonth = sumByMonth(current, gross);
  const prevByMonth = sumByMonth(previous, gross);
  const netByMonth = sumByMonth(current, (inv) => remainder(settled, inv, inv.net_total, 'net'));
  const prevNetByMonth = sumByMonth(previous, (inv) => remainder(settled, inv, inv.net_total, 'net'));
  const vatByMonth = sumByMonth(current, (inv) => remainder(settled, inv, inv.vat_total, 'vat'));

  /**
   * Suma miesiąca w groszach. 10,10 + 20,20 − 30,30 w double daje −3,55e-15:
   * bez zaokrąglenia karta pokazywała „-0 zł”, liczyła miesiąc jako „z danymi”,
   * a procent zmiany przy podstawie 5,55e-17 wybuchał. `|| 0` zamienia −0
   * z `roundToCents` na 0, bo `Intl` formatuje −0 jako „-0 zł”.
   */
  const cents = (byMonth: Map<string, number>, key: string) =>
    roundToCents(byMonth.get(key) ?? 0) || 0;

  return {
    months: months.map(({ key, label }) => ({ key, label })),
    currentSeries: months.map((m) => cents(currentByMonth, m.key)),
    prevSeries: withPrevYear ? months.map((m) => cents(prevByMonth, m.prevKey)) : [],
    prevNetSeries: withPrevYear ? months.map((m) => cents(prevNetByMonth, m.prevKey)) : [],
    currentMonthKey: today.slice(0, 7),
    netSeries: months.map((m) => cents(netByMonth, m.key)),
    vatSeries: months.map((m) => cents(vatByMonth, m.key)),
  };
}
