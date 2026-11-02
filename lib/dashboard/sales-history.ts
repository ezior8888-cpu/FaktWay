import 'server-only';

import { cache } from 'react';

import { readCompletePages, readCompletePagesByKey } from '@/lib/accounting/read-complete-pages';
import { SALES_INVOICES_READ_ERROR, saleInvoicesOf, type SaleInvoice } from '@/lib/analytics-finance/sales';
import {
  ENVIRONMENT_UNKNOWN,
  MONTHLY_FIGURES_READ_ERROR,
  SALES_SERIES_READ_ERROR,
  assertAcceptedEnvironmentKnown,
  buildMonthlyFigures,
  buildSalesSeries,
  countLocalDrafts,
  monthlyFiguresRange,
  salesSeriesPlan,
  type MonthlyFigures,
  type SalesSeries,
} from '@/lib/dashboard/monthly-figures';
import {
  CLIENT_INVOICES_READ_ERROR,
  PRODUCT_INVOICES_READ_ERROR,
  PRODUCT_INVOICE_KINDS,
  clientInvoicesOf,
  fetchLinesOfInvoices,
  rankClients,
  rankProducts,
  warsawMonthWindow,
  type TopClient,
  type TopProduct,
} from '@/lib/dashboard/rankings';
import {
  VAT_LIMIT_READ_ERROR,
  buildVatLimitOverview,
  vatLimitPlan,
  type VatLimitOverview,
} from '@/lib/dashboard/vat-limit';
import { assertOutgoingInvoicesInPln } from '@/lib/exports/currency-guard';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { readTenantBusinessStart } from '@/lib/invoices/business-start';
import { fetchSettledAdvancesTotals, type SettledAdvanceTotals } from '@/lib/invoices/settled-advances';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import type { PageContext } from '@/lib/supabase/page-context';
import type { KsefEnvironment } from '@/types/ksef';

/**
 * Wspólny odczyt sprzedaży Pulpitu (sesja 19 planu skalowania: QRY-02,
 * QAL-05, CPU-13). Karty sprzedaży czytały te same przyjęte faktury sześć
 * razy w nakładających się oknach, każda z własnym licznikiem środowiska
 * (COUNT) i własnym odczytem zaliczek ROZ. Teraz jedno wejście na Pulpit
 * czyta RAZ (`cache()` na żądanie):
 *
 * - przyjęte faktury sprzedaży w aktywnym środowisku od początku okna 24
 *   miesięcy do 1 stycznia następnego roku (limit VAT liczy też faktury
 *   z datą z przyszłości), z sumą kolumn wszystkich kart;
 * - daty przyjętych faktur BEZ środowiska w tym samym oknie (zamiast siedmiu
 *   liczników `assertAcceptedEnvironmentKnown`);
 * - zaliczki rozliczone fakturami ROZ z tego zbioru (raz, gdy karta ich
 *   potrzebuje).
 *
 * Każda karta bierze z tego swoje okna i przechodzi te same kroki, z tymi
 * samymi komunikatami i w tej samej kolejności, co dawny osobny odczyt:
 * środowisko → odczyt (z etykietą KARTY) → waluta PLN → zaliczki ROZ.
 * Strażnik liczy się na oknie karty, więc faktura w EUR albo bez
 * środowiska sprzed 20 miesięcy dalej zabiera tylko „Najwięksi klienci”.
 * Liczby liczą te same funkcje co dawne loadery (`buildMonthlyFigures`,
 * `buildSalesSeries`, `saleInvoicesOf`, `rankClients`, `rankProducts`,
 * `buildVatLimitOverview`), na wierszach w tej samej kolejności (po `id`).
 *
 * Gdy wspólny odczyt padnie (awaria, ucięta strona, zapis w trakcie odczytu
 * kilku stron), błąd idzie raz do logu, a każda karta czyta swoje okna jak
 * dawniej — osobno, z własnymi strażnikami i komunikatem. Taniej jest tylko
 * wtedy, gdy wszystko działa; zachowanie przy błędach zostaje dawne.
 *
 * `cache()` klucze obiekty po tożsamości: wszystkie karty dostają ten sam
 * `supabase` z propsów strony (`app/(dashboard)/dashboard/page.tsx`).
 * Poza renderem RSC `cache()` niczego nie pamięta — wtedy każda karta
 * czyta sama, z tym samym wynikiem.
 */

type Supabase = PageContext['supabase'];

interface Range {
  from: string;
  toExclusive: string;
}

/** Suma kolumn kart sprzedaży Pulpitu (Finanse, kafle, Przychód, VAT, limit VAT, rankingi). */
const COLUMNS =
  'id, issue_date, sale_date, invoice_kind, advance_invoice_ids, net_total, vat_total, gross_total, currency, internal_number, buyer_nip, buyer_data, is_b2c, origin, invoice_type';

export interface SalesHistoryRow {
  id: string;
  issue_date: string;
  sale_date: string | null;
  invoice_kind: string | null;
  advance_invoice_ids: string[] | null;
  net_total: number | string | null;
  vat_total: number | string | null;
  gross_total: number | string | null;
  currency: string | null;
  internal_number: string | null;
  buyer_nip: string | null;
  buyer_data: unknown;
  is_b2c: boolean | null;
  origin: string | null;
  invoice_type: string | null;
}

/** Strona odczytu tak, jak widzą ją pomocnicy stron (wiersze typowane ręcznie, jak w `getVatLimit`). */
type RowsPage = { data: SalesHistoryRow[] | null; count?: number | null; error: { message: string } | null };

/** Etykiety wspólnych odczytów — tylko w logu; karta pokazuje swój dawny komunikat. */
const SHARED_READ_LABEL = 'Wspólny odczyt sprzedaży Pulpitu';
const UNKNOWN_ENVIRONMENT_READ_LABEL = 'Wspólny odczyt faktur bez środowiska';

const NO_SETTLEMENTS: ReadonlyMap<string, SettledAdvanceTotals> = new Map();

interface SalesHistory {
  environment: KsefEnvironment;
  range: Range;
  /** Przyjęte faktury w aktywnym środowisku, po `id` rosnąco. */
  rows: Promise<SalesHistoryRow[]>;
  /** `issue_date` przyjętych faktur bez środowiska. */
  unknownEnvironmentDates: Promise<string[]>;
  /** Zaliczki ROZ całego zbioru — leniwie, przy pierwszej karcie, która ich potrzebuje. */
  settled(): Promise<Map<string, SettledAdvanceTotals>>;
}

/**
 * Błąd wspólnego odczytu idzie raz do logu (karty i tak przechodzą wtedy na
 * osobne odczyty), a odrzucona obietnica nie kończy się `unhandledRejection`.
 */
function logged<T>(promise: Promise<T>, what: string): Promise<T> {
  promise.catch((error: unknown) => {
    console.warn(`[pulpit] ${what} nie przeszedł — karty czytają osobno:`, error);
  });
  return promise;
}

/** Obietnica startująca przed czekaniem na inną: jej błąd odbiera karta, gdy do niej dojdzie. */
function handled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

/** Okno wspólnego odczytu: od 24 miesięcy wstecz do 1 stycznia następnego roku (Europe/Warsaw). */
export function salesHistoryRange(now: Date): Range {
  const year = Number(todayInWarsaw(now).slice(0, 4));
  return { from: warsawMonthWindow(now, 24).from, toExclusive: `${year + 1}-01-01` };
}

const loadSalesHistory = cache((supabase: Supabase, tenantId: string, nowIso: string): SalesHistory => {
  const environment = requireConfiguredKsefEnvironment();
  const range = salesHistoryRange(new Date(nowIso));

  const rows = logged(readCompletePagesByKey<SalesHistoryRow>(SHARED_READ_LABEL, ({ afterId, limit, count, head }) => {
    let query = supabase
      .from('invoices')
      .select(COLUMNS, count ? { count: 'exact', head } : undefined)
      .eq('tenant_id', tenantId)
      .eq('direction', 'outgoing')
      .eq('ksef_status', 'accepted')
      .eq('ksef_environment', environment)
      .gte('issue_date', range.from)
      .lt('issue_date', range.toExclusive);
    if (afterId !== null) query = query.gt('id', afterId);
    return query.order('id', { ascending: true }).limit(limit) as unknown as PromiseLike<RowsPage>;
  }), 'wspólny odczyt sprzedaży');

  const unknownEnvironmentDates = logged(readCompletePagesByKey<{ id: string; issue_date: string }>(
    UNKNOWN_ENVIRONMENT_READ_LABEL,
    ({ afterId, limit, count, head }) => {
      let query = supabase
        .from('invoices')
        .select('id, issue_date', count ? { count: 'exact', head } : undefined)
        .eq('tenant_id', tenantId)
        .eq('direction', 'outgoing')
        .eq('ksef_status', 'accepted')
        .is('ksef_environment', null)
        .gte('issue_date', range.from)
        .lt('issue_date', range.toExclusive);
      if (afterId !== null) query = query.gt('id', afterId);
      return query.order('id', { ascending: true }).limit(limit);
    },
  ).then((found) => found.map((row) => row.issue_date)), 'wspólny odczyt faktur bez środowiska');

  let settled: Promise<Map<string, SettledAdvanceTotals>> | null = null;
  return {
    environment,
    range,
    rows,
    unknownEnvironmentDates,
    // Do logu tylko błąd samego odczytu zaliczek — błąd wierszy jest już w logu wyżej.
    settled: () => (settled ??= rows.then((all) =>
      logged(fetchSettledAdvancesTotals(supabase, tenantId, all), 'wspólny odczyt zaliczek ROZ'))),
  };
});

const inRange = (date: string, range: Range) => date >= range.from && date < range.toExclusive;

interface CardWindow {
  range: Range;
  /** Komunikat błędu odczytu — ten sam co w dawnym osobnym odczycie karty. */
  label: string;
  /** Tylko te rodzaje faktur (ranking produktów: `regular`, `final`). */
  kinds?: readonly string[];
}

/**
 * Strażnik środowiska na WSZYSTKICH oknach karty, bez względu na rodzaj
 * faktury (jak dawny COUNT). Gdy wspólny odczyt faktur bez środowiska padł —
 * jak dawniej: COUNT na każde okno karty.
 */
async function assertWindowsEnvironmentKnown(
  history: SalesHistory,
  supabase: Supabase,
  tenantId: string,
  windows: readonly CardWindow[],
): Promise<void> {
  for (const { range } of windows) {
    if (range.from < history.range.from || range.toExclusive > history.range.toExclusive) {
      throw new Error('Okno karty Pulpitu wychodzi poza wspólny odczyt sprzedaży');
    }
  }
  let unknownDates: string[];
  try {
    unknownDates = await history.unknownEnvironmentDates;
  } catch {
    await Promise.all(windows.map(({ range }) =>
      assertAcceptedEnvironmentKnown(supabase, tenantId, range.from, range.toExclusive)));
    return;
  }
  if (windows.some(({ range }) => unknownDates.some((date) => inRange(date, range)))) {
    throw new Error(ENVIRONMENT_UNKNOWN);
  }
}

/** Dawny osobny odczyt okna karty: komplet stron (`readCompletePages`) z etykietą karty. */
function readWindow(supabase: Supabase, tenantId: string, environment: KsefEnvironment, window: CardWindow) {
  return readCompletePages<SalesHistoryRow>(window.label, (from, to) => {
    let query = supabase
      .from('invoices')
      .select(COLUMNS, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('direction', 'outgoing')
      .eq('ksef_status', 'accepted')
      .eq('ksef_environment', environment);
    if (window.kinds) query = query.in('invoice_kind', [...window.kinds]);
    return query
      .gte('issue_date', window.range.from)
      .lt('issue_date', window.range.toExclusive)
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<RowsPage & { count: number | null }>;
  });
}

/**
 * Wiersze okien karty ze wspólnego zbioru (po `id`, jak dawne strony).
 * Waluty nie sprawdza — kolejność tego kroku zależy od karty.
 *
 * Gdy wspólny odczyt padł, karta czyta swoje okna jak dawniej: osobno,
 * z własną etykietą. Błąd wspólnego odczytu nie zabiera więc kart, których
 * dawny odczyt by przeszedł; przy kilku błędach wygrywa pierwsze okno z listy.
 */
async function windowRows(
  history: SalesHistory,
  supabase: Supabase,
  tenantId: string,
  windows: readonly CardWindow[],
): Promise<SalesHistoryRow[][]> {
  let rows: SalesHistoryRow[];
  try {
    rows = await history.rows;
  } catch {
    const results = await Promise.allSettled(
      windows.map((window) => readWindow(supabase, tenantId, history.environment, window)));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    return results.map((result) => (result as PromiseFulfilledResult<SalesHistoryRow[]>).value);
  }
  return windows.map(({ range, kinds }) =>
    rows.filter((row) => inRange(row.issue_date, range) && (!kinds || kinds.includes(row.invoice_kind ?? ''))));
}

/** Zaliczki ROZ dla wierszy karty; bez ROZ z zaliczkami — bez odczytu, jak `fetchSettledAdvancesTotals`. */
async function settledFor(
  history: SalesHistory,
  supabase: Supabase,
  tenantId: string,
  rows: readonly SalesHistoryRow[],
): Promise<ReadonlyMap<string, SettledAdvanceTotals>> {
  if (!rows.some((row) => row.invoice_kind === 'final' && (row.advance_invoice_ids?.length ?? 0) > 0)) {
    return NO_SETTLEMENTS;
  }
  try {
    return await history.settled();
  } catch {
    // Odczyt zaliczek całego zbioru padł (jest w logu): karta pyta o zaliczki
    // SWOICH ROZ, jak dawniej — błąd zabiera tylko karty, których okno ma tę ROZ.
    return fetchSettledAdvancesTotals(supabase, tenantId, rows);
  }
}

// ─── Karty ────────────────────────────────────────────────────────────────

/** „Faktury w KSeF” — to samo co `getMonthlyFigures`. */
export async function pulpitMonthlyFigures(supabase: Supabase, tenantId: string, nowIso: string): Promise<MonthlyFigures> {
  const now = new Date(nowIso);
  const range = monthlyFiguresRange(now);
  const history = loadSalesHistory(supabase, tenantId, nowIso);
  const windows = [{ range, label: MONTHLY_FIGURES_READ_ERROR }];
  await assertWindowsEnvironmentKnown(history, supabase, tenantId, windows);
  // Jak w `getMonthlyFigures`: wiersze z walutą i liczba szkiców naraz, pierwszy błąd wygrywa.
  const [rows, draftCount] = await Promise.all([
    windowRows(history, supabase, tenantId, windows).then(([found = []]) => {
      assertOutgoingInvoicesInPln(found);
      return found;
    }),
    countLocalDrafts(supabase, tenantId, range.monthStart, range.toExclusive),
  ]);
  return buildMonthlyFigures(now, rows, draftCount, await settledFor(history, supabase, tenantId, rows));
}

/** Seria sprzedaży (Finanse, VAT należny, Przychód netto) — to samo co `getSalesSeries`. */
export async function pulpitSalesSeries(
  supabase: Supabase,
  tenantId: string,
  nowIso: string,
  months: number,
  withPrevYear: boolean,
): Promise<SalesSeries> {
  const plan = salesSeriesPlan(new Date(nowIso), { months, withPrevYear });
  const history = loadSalesHistory(supabase, tenantId, nowIso);
  const windows = [plan.current, ...(plan.previous ? [plan.previous] : [])]
    .map((range) => ({ range, label: SALES_SERIES_READ_ERROR }));
  await assertWindowsEnvironmentKnown(history, supabase, tenantId, windows);
  const [current = [], previous = []] = await windowRows(history, supabase, tenantId, windows);
  assertOutgoingInvoicesInPln(current);
  assertOutgoingInvoicesInPln(previous);
  return buildSalesSeries(plan, current, previous, await settledFor(history, supabase, tenantId, [...current, ...previous]));
}

/** „Średnia faktura” — to samo co `getSalesInvoices` dla okna `range`. */
export async function pulpitSalesInvoices(
  supabase: Supabase,
  tenantId: string,
  nowIso: string,
  range: Range,
): Promise<SaleInvoice[]> {
  const history = loadSalesHistory(supabase, tenantId, nowIso);
  const windows = [{ range, label: SALES_INVOICES_READ_ERROR }];
  await assertWindowsEnvironmentKnown(history, supabase, tenantId, windows);
  const [rows = []] = await windowRows(history, supabase, tenantId, windows);
  assertOutgoingInvoicesInPln(rows);
  if (rows.length === 0) return [];
  return saleInvoicesOf(rows, await settledFor(history, supabase, tenantId, rows));
}

/** „Limit VAT” firmy zwolnionej — to samo co `getVatLimit`. */
export async function pulpitVatLimit(supabase: Supabase, tenantId: string, nowIso: string): Promise<VatLimitOverview> {
  const plan = vatLimitPlan(new Date(nowIso));
  const history = loadSalesHistory(supabase, tenantId, nowIso);
  const windows = [{ range: plan, label: VAT_LIMIT_READ_ERROR }];
  await assertWindowsEnvironmentKnown(history, supabase, tenantId, windows);
  // Jak w `getVatLimit`: wiersze i data rozpoczęcia działalności naraz, waluta po obu.
  const [[rows = []], startedOn] = await Promise.all([
    windowRows(history, supabase, tenantId, windows),
    readTenantBusinessStart(supabase, tenantId),
  ]);
  assertOutgoingInvoicesInPln(rows);
  return buildVatLimitOverview(rows, await settledFor(history, supabase, tenantId, rows), startedOn, plan.today, plan.annualLimit);
}

/**
 * Karta rankingów: „Najlepiej sprzedające się” (`getTopProducts`) i „Najwięksi
 * klienci” (`getTopClients`) z jednego zbioru. Kolejność błędów jak przy
 * dwóch dawnych odczytach naraz (krótszy łańcuch klientów odpowiadał
 * pierwszy): środowisko w którymkolwiek oknie, odczyt klientów, potem
 * produktów, waluta, zaliczki klientów, pozycje produktów.
 */
export async function pulpitRankings(
  supabase: Supabase,
  tenantId: string,
  nowIso: string,
): Promise<{ products: TopProduct[]; clients: TopClient[] }> {
  const now = new Date(nowIso);
  const products = warsawMonthWindow(now, 12);
  const history = loadSalesHistory(supabase, tenantId, nowIso);
  const windows = [
    { range: warsawMonthWindow(now, 24), label: CLIENT_INVOICES_READ_ERROR },
    { range: products, label: PRODUCT_INVOICES_READ_ERROR, kinds: PRODUCT_INVOICE_KINDS },
  ];
  await assertWindowsEnvironmentKnown(history, supabase, tenantId, windows);
  const [clientRows = [], productInvoices = []] = await windowRows(history, supabase, tenantId, windows);
  assertOutgoingInvoicesInPln(productInvoices);
  assertOutgoingInvoicesInPln(clientRows);
  // Pozycje idą równolegle z zaliczkami; błąd zaliczek wygrywa jak dawniej.
  const lines = handled(fetchLinesOfInvoices(supabase, productInvoices));
  const settled = clientRows.length > 0 ? await settledFor(history, supabase, tenantId, clientRows) : NO_SETTLEMENTS;
  return {
    products: rankProducts(await lines),
    clients: clientRows.length > 0 ? rankClients(clientInvoicesOf(clientRows, settled), products.from) : [],
  };
}
