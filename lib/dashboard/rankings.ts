import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { assertAcceptedEnvironmentKnown } from '@/lib/dashboard/monthly-figures';
import { normalizeProductName } from '@/lib/dashboard/product-name';
import { assertOutgoingInvoicesInPln } from '@/lib/exports/currency-guard';
import { shortCompanyName } from '@/lib/format/company-name';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { fetchSettledAdvancesTotals } from '@/lib/invoices/settled-advances';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import type { PageContext } from '@/lib/supabase/page-context';
import { roundToCents } from '@/lib/xml/invoice-calculator';

/**
 * Rankingi Pulpitu (PLAN-FINORA §5 P1): „Najlepiej sprzedające się”
 * (§2.4 pkt 13) i „Najwięksi klienci” (§2.4 pkt 2, 4, 5).
 *
 * Oba czytają tylko faktury sprzedaży przyjęte w AKTYWNYM środowisku KSeF,
 * w PLN, przez `readCompletePages`. Przyjęta faktura bez środowiska w oknie
 * zatrzymuje kartę tym samym komunikatem co `getMonthlyFigures`.
 */

/** Podpis karty produktów (§2.4 pkt 13). */
export const PRODUCTS_NOTE = 'Bez korekt i nierozliczonych zaliczek';

/** Nazwa jednej pozycji rankingu klientów dla nabywców B2C (`is_b2c`). */
export const CONSUMERS_NAME = 'Konsumenci';
/** Pozycja faktury bez nazwy — w bazie `name` dopuszcza NULL. */
const UNNAMED_PRODUCT = 'Pozycja bez nazwy';
/** Tyle identyfikatorów faktur na jedno `.in()` — długość adresu PostgREST. */
const LOOKUP_CHUNK = 100;
/**
 * Tyle paczek pozycji naraz (QRY-05, sesja 19 planu skalowania): paczki
 * szły jedna po drugiej, a pełne naraz zapchałyby pulę PostgREST jednym
 * wejściem na Pulpit.
 */
const LOOKUP_CONCURRENCY = 4;
/** Rodzaje faktur, których pozycje wchodzą do rankingu produktów (§2.4 pkt 5 i 13). */
export const PRODUCT_INVOICE_KINDS: readonly string[] = ['regular', 'final'];
/** Etykiety błędów odczytu kart rankingów. */
export const PRODUCT_INVOICES_READ_ERROR = 'Nie można odczytać faktur do rankingu produktów';
export const CLIENT_INVOICES_READ_ERROR = 'Nie można odczytać faktur do rankingu klientów';

export interface TopProduct {
  /** Klucz grupy: znormalizowana nazwa + j.m. */
  key: string;
  /** Nazwa z najnowszej pozycji grupy. */
  name: string;
  unit: string | null;
  /** Suma netto pozycji, PLN. */
  net: number;
}

export interface TopClient {
  /** `b2c`, `nip:<cyfry>` albo `name:<nazwa małymi literami>`. */
  key: string;
  /** Nazwa z najnowszej faktury klienta, forma prawna skrócona. */
  name: string;
  nip: string | null;
  consumers: boolean;
  /** Netto bieżących 12 miesięcy, PLN. */
  net: number;
  /** Netto poprzednich 12 miesięcy, PLN. */
  prevNet: number;
  /** Zmiana w procentach; null, gdy poprzednie 12 miesięcy ≤ 0. */
  changePct: number | null;
}

/** Okno N miesięcy kalendarzowych kończące się bieżącym miesiącem w Polsce. */
export interface MonthWindow {
  /** 1. dzień najstarszego miesiąca, RRRR-MM-DD. */
  from: string;
  /** 1. dzień miesiąca po bieżącym, RRRR-MM-DD (wyłącznie). */
  toExclusive: string;
}

/**
 * Pierwszy dzień miesiąca jako RRRR-MM-DD. Arytmetyka w UTC na polach
 * kalendarza (`monthIndex` może wyjść poza 0–11), jak `monthStartIso`
 * w `lib/dashboard/monthly-figures.ts`.
 */
function monthStartIso(year: number, monthIndex: number): string {
  const date = new Date(Date.UTC(year, monthIndex, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * `months` miesięcy kalendarzowych kończących się bieżącym polskim miesiącem
 * (§2.4 pkt 10): od 1. dnia miesiąca −(months−1) do 1. dnia następnego.
 */
export function warsawMonthWindow(now: Date, months: number): MonthWindow {
  const today = todayInWarsaw(now);
  const year = Number(today.slice(0, 4));
  const monthIndex = Number(today.slice(5, 7)) - 1;
  return {
    from: monthStartIso(year, monthIndex - (months - 1)),
    toExclusive: monthStartIso(year, monthIndex + 1),
  };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * `run` dla każdego elementu, najwyżej `limit` naraz; wyniki w kolejności
 * wejścia. Pierwszy błąd odrzuca całość i wstrzymuje branie kolejnych.
 */
async function inOrderWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await run(items[index]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function amount(value: number | string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Nowsza z dwóch: data wystawienia, potem identyfikator. */
function isNewer(a: { date: string; id: string }, b: { date: string; id: string }): boolean {
  return a.date > b.date || (a.date === b.date && a.id > b.id);
}

function byNetThenKey<T extends { key: string; net: number }>(a: T, b: T): number {
  return b.net - a.net || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

// ─── Produkty (§2.4 pkt 13) ────────────────────────────────────────────────

/** Pozycja faktury z datą wystawienia jej faktury. */
export interface ProductLine {
  id: string;
  issue_date: string;
  name: string | null;
  unit: string | null;
  net_amount: number | string | null;
}

/**
 * Ranking pozycji: grupa = nazwa bez okresu i numeru umowy, małymi literami
 * (`normalizeProductName`) + `unit` (NULL to osobna j.m.), kwota = suma
 * `net_amount`, nazwa z najnowszej pozycji grupy (też bez okresu). Tylko
 * grupy z netto > 0, malejąco po netto, potem po kluczu.
 *
 * Wejście ma już być zawężone do faktur `regular` i `final` — zaliczki
 * i korekty odpada wcześniej (`getTopProducts`).
 */
export function rankProducts(lines: readonly ProductLine[], limit = 5): TopProduct[] {
  const groups = new Map<string, {
    key: string;
    unit: string | null;
    net: number;
    newest: { date: string; id: string; name: string };
  }>();
  for (const line of lines) {
    // Nazwa bez okresu i numeru umowy (`normalizeProductName`): „Usługi – październik 2026”
    // i „Usługi – listopad 2026” to ten sam produkt. Wielkość liter bierze najnowsza pozycja.
    const normalized = normalizeProductName(line.name);
    // J.m. z formularza bywa z odstępem albo pusta — „ szt ” to „szt”, a pusta to brak.
    const unit = line.unit?.trim() || null;
    const key = JSON.stringify([normalized.key, unit]);
    const candidate = { date: line.issue_date, id: line.id, name: normalized.display };
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { key, unit, net: amount(line.net_amount), newest: candidate });
      continue;
    }
    group.net += amount(line.net_amount);
    if (isNewer(candidate, group.newest)) group.newest = candidate;
  }
  return [...groups.values()]
    .map((g) => ({
      key: g.key,
      name: g.newest.name || UNNAMED_PRODUCT,
      unit: g.unit,
      net: roundToCents(g.net),
    }))
    .filter((p) => p.net > 0)
    .sort(byNetThenKey)
    .slice(0, limit);
}

/**
 * Pozycje faktur do rankingu produktów z zakresu `[from, toExclusive)` po
 * `issue_date` (§2.4 pkt 13). Wspólny odczyt „Najlepiej sprzedających się”
 * na Pulpicie i „Sprzedaży według produktów” na `/analizy/sprzedaz`.
 *
 * Tylko faktury `regular` i `final`: zaliczka ma wartość w pozycjach ROZ
 * (ROZ trzyma w bazie stan PEŁNEGO zamówienia) albo na nią czeka, a pozycje
 * korekty to stan PO (`before_after`) albo jedna sztuczna pozycja kwotowa —
 * dodane do sprzedaży dublowałyby ją (§2.4 pkt 5 i 13).
 *
 * `invoice_line_items` nie ma `tenant_id`, więc najpierw faktury tej firmy,
 * potem ich pozycje paczkami po 100 identyfikatorów (`fetchLinesOfInvoices`).
 */
export async function fetchProductLines(
  supabase: PageContext['supabase'],
  tenantId: string,
  range: MonthWindow,
): Promise<ProductLine[]> {
  const environment = requireConfiguredKsefEnvironment();
  const { from, toExclusive } = range;

  await assertAcceptedEnvironmentKnown(supabase, tenantId, from, toExclusive);
  const invoices = await readCompletePages(PRODUCT_INVOICES_READ_ERROR, (start, end) => supabase
    .from('invoices')
    .select('id, issue_date, currency, invoice_kind', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .eq('ksef_status', 'accepted')
    .eq('ksef_environment', environment)
    .in('invoice_kind', [...PRODUCT_INVOICE_KINDS])
    .gte('issue_date', from)
    .lt('issue_date', toExclusive)
    .order('id', { ascending: true })
    .range(start, end));
  // §2.4 pkt 6: kwoty w złotych — faktura walutowa zatrzymuje kartę.
  assertOutgoingInvoicesInPln(invoices);
  return fetchLinesOfInvoices(supabase, invoices);
}

/**
 * Pozycje podanych faktur (już zawężonych do rodzajów rankingu i po
 * strażnikach) z datą wystawienia ich faktury: paczki po 100 identyfikatorów,
 * do czterech naraz, każda paczka w komplecie (`readCompletePages`; paczka
 * 100 faktur to zwykle jedna strona, więc licznik i tak idzie raz).
 * Kolejność jak przy paczkach jedna po drugiej: paczki w kolejności faktur,
 * w paczce po `id` pozycji — sumy rankingu wychodzą co do bitu te same.
 */
export async function fetchLinesOfInvoices(
  supabase: PageContext['supabase'],
  invoices: ReadonlyArray<{ id: string; issue_date: string }>,
): Promise<ProductLine[]> {
  if (invoices.length === 0) return [];
  const issueDateById = new Map(invoices.map((inv) => [inv.id, inv.issue_date]));
  const pages = await inOrderWithLimit(chunks(invoices.map((inv) => inv.id), LOOKUP_CHUNK), LOOKUP_CONCURRENCY, (chunk) =>
    readCompletePages('Nie można odczytać pozycji faktur', (start, end) => supabase
      .from('invoice_line_items')
      .select('id, invoice_id, name, unit, net_amount', { count: 'exact' })
      .in('invoice_id', chunk)
      .order('id', { ascending: true })
      .range(start, end)));
  const lines: ProductLine[] = [];
  for (const page of pages) {
    for (const item of page) {
      const issueDate = issueDateById.get(item.invoice_id);
      if (issueDate === undefined) continue;
      lines.push({ id: item.id, issue_date: issueDate, name: item.name, unit: item.unit, net_amount: item.net_amount });
    }
  }
  return lines;
}

/** „Najlepiej sprzedające się” — 12 miesięcy po `issue_date` (`fetchProductLines`). */
export async function getTopProducts(
  supabase: PageContext['supabase'],
  tenantId: string,
  now: Date = new Date(),
  limit = 5,
): Promise<TopProduct[]> {
  return rankProducts(await fetchProductLines(supabase, tenantId, warsawMonthWindow(now, 12)), limit);
}

// ─── Klienci ───────────────────────────────────────────────────────────────

/** Faktura z netto już pomniejszonym o rozliczone zaliczki (ROZ). */
export interface ClientInvoice {
  id: string;
  issue_date: string;
  /** Netto do rankingu: korekta jako różnica, ROZ jako reszta po zaliczkach. */
  net: number;
  buyer_nip: string | null;
  buyer_data: unknown;
  is_b2c: boolean | null;
}

export function buyerNameOf(buyerData: unknown): string | null {
  if (typeof buyerData !== 'object' || buyerData === null || Array.isArray(buyerData)) return null;
  const name = (buyerData as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() !== '' ? name : null;
}

/**
 * Klucz klienta (plan Finora P1, P11, N3): B2C → jedna pozycja „Konsumenci”,
 * potem NIP (same cyfry), potem nazwa małymi literami; `null` bez NIP-u i nazwy.
 */
export function clientIdentity(inv: Pick<ClientInvoice, 'buyer_nip' | 'buyer_data' | 'is_b2c'>): { key: string; nip: string | null; consumers: boolean } | null {
  if (inv.is_b2c === true) return { key: 'b2c', nip: null, consumers: true };
  const nip = (inv.buyer_nip ?? '').replace(/\D/g, '');
  if (nip !== '') return { key: `nip:${nip}`, nip, consumers: false };
  const name = buyerNameOf(inv.buyer_data);
  if (name !== null) return { key: `name:${name.trim().toLowerCase()}`, nip: null, consumers: false };
  return null;
}

/**
 * Ranking klientów: faktury z `issue_date ≥ currentFrom` to bieżące 12
 * miesięcy, wcześniejsze — poprzednie 12. Klucz: B2C → „Konsumenci”,
 * potem NIP (same cyfry), potem nazwa małymi literami; faktura bez NIP-u
 * i nazwy odpada. Nazwa z najnowszej faktury klienta, która ją ma (bez
 * nazwy — NIP), forma prawna skrócona. Tylko klienci z netto > 0 w bieżących 12 miesiącach.
 */
export function rankClients(
  invoices: readonly ClientInvoice[],
  currentFrom: string,
  limit = 5,
): TopClient[] {
  const groups = new Map<string, {
    key: string;
    nip: string | null;
    consumers: boolean;
    net: number;
    prevNet: number;
    /** Najnowsza faktura klienta z nazwą nabywcy (null, gdy żadna jej nie ma). */
    newest: { date: string; id: string; name: string } | null;
  }>();
  for (const inv of invoices) {
    const identity = clientIdentity(inv);
    if (identity === null) continue;
    let group = groups.get(identity.key);
    if (!group) {
      group = { ...identity, net: 0, prevNet: 0, newest: null };
      groups.set(identity.key, group);
    }
    const name = buyerNameOf(inv.buyer_data);
    const candidate = name === null ? null : { date: inv.issue_date, id: inv.id, name };
    if (candidate && (group.newest === null || isNewer(candidate, group.newest))) {
      group.newest = candidate;
    }
    if (inv.issue_date >= currentFrom) group.net += inv.net;
    else group.prevNet += inv.net;
  }
  return [...groups.values()]
    .map((g): TopClient => {
      const net = roundToCents(g.net);
      const prevNet = roundToCents(g.prevNet);
      const name = g.consumers
        ? CONSUMERS_NAME
        : shortCompanyName(g.newest?.name ?? g.nip ?? '');
      return {
        key: g.key,
        name,
        nip: g.nip,
        consumers: g.consumers,
        net,
        prevNet,
        changePct: prevNet > 0 ? Math.round(((net - prevNet) / prevNet) * 100) : null,
      };
    })
    .filter((c) => c.net > 0)
    .sort(byNetThenKey)
    .slice(0, limit);
}

/**
 * „Najwięksi klienci” — bieżące 12 miesięcy vs poprzednie 12.
 *
 * Wszystkie rodzaje faktur, jak sumy sprzedaży: korekta to RÓŻNICA i wchodzi
 * w swoim miesiącu (§2.4 pkt 5), ROZ bez rozliczonych zaliczek (pkt 4) —
 * także gdy zaliczka jest sprzed okna.
 */
export async function getTopClients(
  supabase: PageContext['supabase'],
  tenantId: string,
  now: Date = new Date(),
  limit = 5,
): Promise<TopClient[]> {
  const environment = requireConfiguredKsefEnvironment();
  const { from, toExclusive } = warsawMonthWindow(now, 24);
  const { from: currentFrom } = warsawMonthWindow(now, 12);

  await assertAcceptedEnvironmentKnown(supabase, tenantId, from, toExclusive);
  const rows = await readCompletePages(CLIENT_INVOICES_READ_ERROR, (start, end) => supabase
    .from('invoices')
    .select('id, issue_date, net_total, invoice_kind, advance_invoice_ids, currency, buyer_nip, buyer_data, is_b2c', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .eq('ksef_status', 'accepted')
    .eq('ksef_environment', environment)
    .gte('issue_date', from)
    .lt('issue_date', toExclusive)
    .order('id', { ascending: true })
    .range(start, end));
  assertOutgoingInvoicesInPln(rows);
  if (rows.length === 0) return [];

  const settled = await fetchSettledAdvancesTotals(supabase, tenantId, rows);
  return rankClients(clientInvoicesOf(rows, settled), currentFrom, limit);
}

/** Faktury do rankingu klientów: netto ROZ bez rozliczonych zaliczek (§2.4 pkt 4). */
export function clientInvoicesOf(
  rows: ReadonlyArray<{
    id: string;
    issue_date: string;
    net_total: number | string | null;
    buyer_nip: string | null;
    buyer_data: unknown;
    is_b2c: boolean | null;
  }>,
  settled: ReadonlyMap<string, { net: number }>,
): ClientInvoice[] {
  return rows.map((row) => ({
    id: row.id,
    issue_date: row.issue_date,
    net: amount(row.net_total) - (settled.get(row.id)?.net ?? 0),
    buyer_nip: row.buyer_nip,
    buyer_data: row.buyer_data,
    is_b2c: row.is_b2c,
  }));
}
