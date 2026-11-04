import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { assertAcceptedEnvironmentKnown } from '@/lib/dashboard/monthly-figures';
import { assertOutgoingInvoicesInPln } from '@/lib/exports/currency-guard';
import {
  EXCEEDED,
  forecast,
  THRESHOLDS,
  vatLimitState,
  type SalesEntry,
  type VatLimitInput,
} from '@/lib/flo/functions/vat-limit';
import { paramsFor } from '@/lib/flo/tax-params';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { readTenantBusinessStart } from '@/lib/invoices/business-start';
import { MAX_SALE_DAYS_AFTER_ISSUE } from '@/lib/invoices/sale-date';
import {
  fetchSettledAdvancesTotals,
  type SettledAdvanceTotals,
} from '@/lib/invoices/settled-advances';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import type { PageContext } from '@/lib/supabase/page-context';
import { roundToCents } from '@/lib/xml/invoice-calculator';

/**
 * Karta „Limit zwolnienia z VAT” na Pulpicie (plan Finora P1, potem P2;
 * decyzja Bartosza 19.10.2026 „opcja A”).
 *
 * Reguła prawna NIE jest tu powtórzona: limit proporcjonalny, procent,
 * wzór i prognozę liczą czyste funkcje z `lib/flo/functions/vat-limit.ts`
 * (`vatLimitState`, `forecast`). Ten moduł tylko składa wejście — sprzedaż
 * netto od 1 stycznia według §2.4 planu — i zamienia wynik na kształt karty.
 *
 * Import `vat-limit.ts` ciągnie łańcuchem `lib/flo/fingerprint.ts` →
 * `lib/supabase/admin` → `next/headers`. Przy imporcie nic się nie wykonuje
 * (żadnych zapytań, tylko stałe i `Intl.DateTimeFormat`), ale to kod
 * serwerowy: kartę liczymy na serwerze i do komponentu podajemy gotowy
 * `VatLimitOverview`.
 *
 * SPRZEDAŻ (§2.4 pkt 2, 4, 5, 6, 7):
 * - `direction = 'outgoing'`, `ksef_status = 'accepted'`, środowisko KSeF
 *   aktywne; przyjęta faktura bez środowiska zatrzymuje kartę;
 * - WSZYSTKIE rodzaje: korekta to różnica (ujemna obniża), zaliczka liczy
 *   się w swojej dacie, z ROZ tylko reszta ponad przyjęte zaliczki;
 * - tylko złotówki (`assertOutgoingInvoicesInPln`), komplet stron.
 *
 * DATA: dzień zdarzenia według VAT (`vatLimitEventDate`) — data sprzedaży
 * (dostawy, wykonania usługi), gdy jest poprawną datą, a bez niej data
 * wystawienia. Data sprzedaży wygrywa w OBIE strony: faktura z 3.01 za
 * sprzedaż z 30.12 należy do poprzedniego roku, a faktura z 10.12 za
 * sprzedaż z 15.01 — do bieżącego. To NIE jest reguła KPiR
 * (`kpirSaleEventDate`, art. 14 ust. 1c PIT), która bierze datę sprzedaży
 * tylko wcześniejszą niż wystawienie.
 *
 * PRÓG (art. 113 ust. 5): zwolnienie traci się, gdy sprzedaż PRZEKROCZY
 * limit. Sprzedaż równa limitowi to jeszcze poziom 90, nie 100.
 *
 * WLICZAMY WSZYSTKO (reguła 1 w `vat-limit.ts`): ta wersja nie wyłącza
 * żadnej sprzedaży z limitu.
 */

export type VatLimitLevel = 'ok' | 60 | 80 | 90 | 100;

export interface VatLimitOverview {
  year: number;
  /** RRRR-MM-DD w Europe/Warsaw. */
  today: string;
  /** Od stycznia do bieżącego miesiąca; podpisy jak w `getSalesSeries`. */
  months: { key: string; label: string }[];
  /**
   * Sprzedaż netto narastająco na koniec każdego miesiąca, w złotych
   * (zaokrąglona do groszy).
   */
  cumulative: number[];
  /**
   * Sprzedaż wliczona od 1 stycznia (= ostatni element `cumulative`), w złotych
   * zaokrąglonych do groszy.
   */
  used: number;
  /** `paramsFor(today).vatExemptionLimit`. */
  annualLimit: number;
  /** Data rozpoczęcia działalności z ustawień firmy; `null` = nie podano. */
  startedOn: string | null;
  /** `null`, gdy `startedOn === null` — karta prosi o datę, bez procentu. */
  limit: null | {
    effectiveLimit: number;
    prorated: boolean;
    activeDays: number;
    daysInYear: number;
    /** Wykorzystanie w procentach, bez zaokrąglenia; może przekroczyć 100. */
    pct: number;
    remaining: number;
    level: VatLimitLevel;
    formula: string;
    /** `null` = przy obecnym tempie limit wystarczy do końca roku. */
    crossesOn: string | null;
  };
  /**
   * Tylko gdy `limit === null` (data rozpoczęcia nieznana): wykorzystanie
   * względem PEŁNEGO limitu rocznego. Limit proporcjonalny nigdy nie jest
   * wyższy niż pełny, więc ten procent to dolna granica prawdziwego, a poziom
   * 100 oznacza pewne przekroczenie niezależnie od daty startu. Bez prognozy:
   * tempo z pełnego roku byłoby dla firmy założonej w trakcie roku mylące.
   * Przy znanej dacie — `null`.
   */
  lowerBound: null | {
    pct: number;
    level: VatLimitLevel;
    remaining: number;
  };
}

/** Wiersz faktury sprzedaży potrzebny do licznika. */
export interface VatLimitInvoiceRow {
  id: string;
  issue_date: string;
  sale_date: string | null;
  invoice_kind: string | null;
  advance_invoice_ids: string[] | null;
  net_total: number | string | null;
  currency: string | null;
}

const OUTGOING = 'outgoing' as const;

const INVOICE_COLUMNS =
  'id, issue_date, sale_date, invoice_kind, advance_invoice_ids, net_total, currency';

/**
 * Poziom karty ze sprzedaży i limitu w złotych: 100 tylko przy przekroczeniu
 * (art. 113 ust. 5 — sprzedaż WIĘKSZA niż limit, porównanie w groszach, żeby
 * zaokrąglenie procentu nie dało fałszywego przekroczenia), inaczej
 * najwyższy osiągnięty próg. Sprzedaż równa limitowi to poziom 90.
 */
export function vatLimitLevel(used: number, limit: number): VatLimitLevel {
  if (roundToCents(used) > roundToCents(limit)) return EXCEEDED;
  const pct = limit > 0 ? (used / limit) * 100 : 100;
  let level: VatLimitLevel = 'ok';
  for (const threshold of THRESHOLDS) {
    if (pct >= threshold) level = threshold;
  }
  return level;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidIsoDay(value: string): boolean {
  const m = ISO_DAY.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/**
 * Dzień zdarzenia do limitu VAT: data sprzedaży (poprawna RRRR-MM-DD), a bez
 * niej data wystawienia. Wygrywa w obie strony — patrz nagłówek modułu.
 */
export function vatLimitEventDate(row: { sale_date: string | null; issue_date: string }): string {
  const sale = row.sale_date?.trim();
  return sale && isValidIsoDay(sale) ? sale : row.issue_date;
}

/** Pierwszy dzień okna odczytu: data sprzedaży bywa do N dni PO wystawieniu. */
export function vatLimitReadStart(year: number): string {
  return new Date(Date.UTC(year, 0, 1 - MAX_SALE_DAYS_AFTER_ISSUE)).toISOString().slice(0, 10);
}

/** „Sty”, „Lut”… — ten sam podpis co w `getSalesSeries`. */
function monthLabel(year: number, monthIndex: number): string {
  const raw = new Date(Date.UTC(year, monthIndex, 1))
    .toLocaleDateString('pl-PL', { month: 'short', timeZone: 'UTC' })
    .replace(/\./g, '')
    .trim();
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function utcDay(iso: string): Date {
  return new Date(
    Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))),
  );
}

/**
 * Czysta część licznika — wejście już przefiltrowane zapytaniem (kierunek,
 * status, środowisko, waluta). `today` to RRRR-MM-DD w Europe/Warsaw.
 */
export function buildVatLimitOverview(
  rows: readonly VatLimitInvoiceRow[],
  settled: ReadonlyMap<string, SettledAdvanceTotals>,
  startedOn: string | null,
  today: string,
  annualLimit: number,
): VatLimitOverview {
  const year = Number(today.slice(0, 4));
  const currentMonthIndex = Number(today.slice(5, 7)) - 1;
  const yearStart = `${year}-01-01`;
  const nextYearStart = `${year + 1}-01-01`;

  const months: { key: string; label: string }[] = [];
  for (let m = 0; m <= currentMonthIndex; m++) {
    months.push({
      key: `${year}-${String(m + 1).padStart(2, '0')}`,
      label: monthLabel(year, m),
    });
  }
  const lastKey = months[months.length - 1]!.key;

  const sales: SalesEntry[] = [];
  const byMonth = new Map<string, number>();
  for (const row of rows) {
    const date = vatLimitEventDate(row);
    if (date < yearStart || date >= nextYearStart) continue;
    // ROZ: tylko reszta ponad przyjęte zaliczki (AUD-26). Inne faktury bez zmian.
    const net = roundToCents(Number(row.net_total ?? 0) - (settled.get(row.id)?.net ?? 0));
    sales.push({ net, date });
    // Zdarzenie po bieżącym miesiącu (faktura z datą z przyszłości) liczymy
    // w bieżącym miesiącu, a nie gubimy: zaniżony licznik to gorsza pomyłka.
    const key = date.slice(0, 7) > lastKey ? lastKey : date.slice(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? 0) + net);
  }

  const cumulative: number[] = [];
  let running = 0;
  for (const { key } of months) {
    running = roundToCents(running + (byMonth.get(key) ?? 0)) || 0;
    cumulative.push(running);
  }
  const used = cumulative[cumulative.length - 1] ?? 0;

  // Data startu z przyszłości (wpisana poza aplikacją — akcja i schemat jej
  // nie przepuszczą) dałaby limit 0 i fałszywe „przekroczenie”: traktujemy
  // ją jak nieznaną, a karta prosi o poprawną datę.
  const knownStart = startedOn !== null && startedOn <= today ? startedOn : null;
  const base = { year, today, months, cumulative, used, annualLimit, startedOn: knownStart };
  const inputFor = (startedOnForLimit: string): VatLimitInput => ({
    year,
    limit: annualLimit,
    startedOn: startedOnForLimit,
    sales,
    // Funkcje FLO liczą na dobach w UTC — „dziś” jako północ UTC polskiej daty.
    today: utcDay(today),
  });

  if (knownStart === null) {
    // Pełny rok (start 1.01) daje najwyższy możliwy limit — dolna granica %.
    const full = vatLimitState(inputFor(yearStart));
    return {
      ...base,
      limit: null,
      lowerBound: {
        pct: full.pct,
        level: vatLimitLevel(full.used, full.effectiveLimit),
        remaining: full.remaining,
      },
    };
  }

  const input = inputFor(knownStart);
  const state = vatLimitState(input);
  const prognosis = forecast(input, state);

  return {
    ...base,
    lowerBound: null,
    limit: {
      effectiveLimit: state.effectiveLimit,
      prorated: state.prorated,
      activeDays: state.activeDays,
      daysInYear: state.daysInYear,
      pct: state.pct,
      remaining: state.remaining,
      level: vatLimitLevel(state.used, state.effectiveLimit),
      formula: state.formula,
      crossesOn: prognosis.crossesOn,
    },
  };
}

/** Etykieta błędu odczytu sprzedaży do limitu VAT. */
export const VAT_LIMIT_READ_ERROR = 'Nie można odczytać sprzedaży do limitu VAT';

/** „Dziś”, limit roczny i okno odczytu licznika (opis przy `getVatLimit`). */
export interface VatLimitPlan {
  today: string;
  annualLimit: number;
  from: string;
  toExclusive: string;
}

export function vatLimitPlan(now: Date): VatLimitPlan {
  const today = todayInWarsaw(now);
  const params = paramsFor(utcDay(today));
  if (!params) throw new Error('Brak parametrów limitu zwolnienia z VAT na ten rok');
  const year = Number(today.slice(0, 4));
  return {
    today,
    annualLimit: params.vatExemptionLimit,
    from: vatLimitReadStart(year),
    toExclusive: `${year + 1}-01-01`,
  };
}

/**
 * Licznik limitu zwolnienia z VAT dla Pulpitu. Rok i „dziś” w Europe/Warsaw.
 *
 * Odczyt po `issue_date` od (1 stycznia − `MAX_SALE_DAYS_AFTER_ISSUE` dni)
 * do 1 stycznia następnego roku: data sprzedaży może wypaść do tylu dni PO
 * wystawieniu (art. 106i ust. 7), więc faktura z grudnia za sprzedaż ze
 * stycznia mieści się w oknie. Rok odcina dopiero filtr po dacie zdarzenia
 * w `buildVatLimitOverview` (faktura z 3.01 za sprzedaż z 30.12 wypada).
 */
export async function getVatLimit(
  supabase: PageContext['supabase'],
  tenantId: string,
  now: Date = new Date(),
): Promise<VatLimitOverview> {
  const plan = vatLimitPlan(now);
  const environment = requireConfiguredKsefEnvironment();

  await assertAcceptedEnvironmentKnown(supabase, tenantId, plan.from, plan.toExclusive);
  const [rows, startedOn] = await Promise.all([
    readCompletePages<VatLimitInvoiceRow>(VAT_LIMIT_READ_ERROR, (from, to) =>
      supabase
        .from('invoices')
        .select(INVOICE_COLUMNS, { count: 'exact' })
        .eq('tenant_id', tenantId)
        .eq('direction', OUTGOING)
        .eq('ksef_status', 'accepted')
        .eq('ksef_environment', environment)
        .gte('issue_date', plan.from)
        .lt('issue_date', plan.toExclusive)
        .order('id', { ascending: true })
        .range(from, to)),
    readTenantBusinessStart(supabase, tenantId),
  ]);
  // C-11: limit w złotych — faktura walutowa albo bez waluty zatrzymuje kartę.
  assertOutgoingInvoicesInPln(rows);
  const settled = await fetchSettledAdvancesTotals(supabase, tenantId, rows);

  return buildVatLimitOverview(rows, settled, startedOn, plan.today, plan.annualLimit);
}
