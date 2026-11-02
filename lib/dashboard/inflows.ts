import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { OutgoingInvoiceCurrencyNotSupportedError } from '@/lib/exports/currency-guard';
import { addDaysToIsoDate, todayInWarsaw } from '@/lib/format/warsaw-date';
import { amountDueOf } from '@/lib/invoices/amount-due';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import type { PageContext } from '@/lib/supabase/page-context';
import { roundToCents } from '@/lib/xml/invoice-calculator';

/**
 * Wpływy pieniędzy: JEDNA droga odczytu dla Przepływów (PLAN-PRAWDZIWE-DANE E11).
 *
 * Wpływ to wyłącznie prawdziwe pieniądze (FaktWay 1.0 §3 pkt 3). Decyzję D-W
 * z 23.10.2026 („klient nic nie oznacza, zakładamy zapłatę w terminie”)
 * odwołano 02.11.2026 na polecenie Bartosza; klient oznacza zapłatę jednym
 * dotknięciem (`mark_invoice_paid`, 00158).
 *
 * `getInflows` zwraca faktury sprzedaży z ich dniem (`inflowDay`), a podstawa
 * dnia mówi, czy to pieniądze:
 * 1. `paid`: `paid_at` (wpłaty, „Zapłacone”, FLO; wyzwalacz ustawia go dopiero
 *    przy pełnej zapłacie), dzień w Europe/Warsaw, kwota `paid_amount`; albo
 *    `Zaplacono = 1` + `DataZaplaty` z FA(3) (`fa3_data.parsed.paidDate`, import
 *    pliku i historii KSeF), kwota brutto do zapłaty;
 * 2. `correction`: korekta in minus wystawiona po zapłacie faktury zapłaconej naprawdę (niżej);
 * 3. `due`: faktura bez wpłaty z terminem, dniem jest termin;
 * 4. `issued`: faktura bez wpłaty i bez terminu, dniem jest wystawienie.
 * Tylko 1–2 są wpływem (`receivedInflows` w `cash-movements`). Faktura z 3–4 to
 * należność: `outstanding` to reszta po korektach i wpłatach częściowych,
 * a z terminem dziś lub później jest spodziewanym wpływem (`isExpectedInflow`).
 * Miniony termin bez wpłaty to należność po terminie (`getReceivables`
 * i `/payments/overdue`), nie wpływ. Wpłaty częściowej nie dzielimy na osobny
 * wpływ: bez odczytu `payments` (zablokowane dla sesji, 00074) jej dnia nie
 * znamy, więc faktura wchodzi do wpływów, gdy jest zapłacona w całości.
 *
 * Faktury jak przychód (`getSalesInvoices`): sprzedaż przyjęta w KSeF
 * w aktywnym środowisku, z każdego pochodzenia (FaktWay, plik, historia
 * KSeF), korekta jako różnica ze znakiem. Strażniki jak przychód, ale tylko
 * dla faktur z dniem w zakresie: przyjęta faktura bez środowiska
 * (`ENVIRONMENT_ERROR`) i faktura spoza PLN (`InflowCurrencyError`, ten sam
 * typ co strażnik przychodu, z numerem dokumentu) zatrzymują kartę.
 *
 * Korekta (`parent_invoice_id`) wystawiona najpóźniej w dniu terminu faktury
 * pierwotnej bez wpłaty zmienia kwotę TEJ należności: nabywca zapłaci kwotę po
 * korekcie (w KSeF nie ma anulowania, korekta do zera zdejmuje fakturę ze
 * spodziewanych). Taka korekta nie jest osobną pozycją, chyba że ma własną
 * wpłatę: korekta zapłacona (własne „Zapłacone”) jest osobnym wpływem w dniu
 * swojej zapłaty, a Spodziewane jej już nie liczą. Korekty wystawione
 * przed `from` do faktur z dniem w zakresie czytamy osobnym zapytaniem
 * (`correctionsBefore`), tylko gdy takie faktury są.
 *
 * Korekta in minus do faktury zapłaconej naprawdę: wpłata jest na całą fakturę
 * (`mark_invoice_paid` zapisuje całą resztę brutto, a `paid_amount` po korekcie
 * zostaje), więc korekta wystawiona najpóźniej w dniu zapłaty wchodzi do wpływu
 * z tej wpłaty: jeden ruch w dniu zapłaty, w kwocie po korekcie. Dopiero korekta
 * późniejsza niż zapłata to osobny ruch w dniu jej wystawienia (`correction`).
 * Suma ruchów jest ta sama, zmienia się tylko dzień. Korekta in minus do faktury
 * bez wpłaty nie jest ruchem, bo żadne pieniądze się nie ruszyły. Korekta in plus
 * to osobny dług: ma własne „Zapłacone”.
 */

const ENVIRONMENT_ERROR = 'Przyjęte faktury wymagają uzgodnienia środowiska KSeF';
const KNOWN_ENVIRONMENTS: ReadonlySet<string> = new Set(['test', 'demo', 'production']);

/** Data zapłaty z FA(3) zapisana przy imporcie (`ParsedInvoice.paidDate`). */
const FA3_PAID_DATE = 'fa3_data->parsed->>paidDate';

const INFLOW_COLUMNS = `id, direction, ksef_status, ksef_environment, invoice_kind, parent_invoice_id, currency, gross_total, paid_amount, payment_data, payment_due_date, paid_at, issue_date, internal_number, buyer_nip, buyer_data, is_b2c, fa3_paid_date:${FA3_PAID_DATE}` as const;

/**
 * Faktura sprzedaży spoza PLN z dniem wpływu w zakresie karty: bez kursu nie
 * zgadujemy złotówek (jak przychód, `assertOutgoingInvoicesInPln`). Ten sam
 * typ, więc karty pokazują komunikat (`pulpitErrorMessage`) z numerem
 * dokumentu; wyjście daje karta błędu (Przepływy: „napisz do nas”, Pulpit
 * i Analizy: link do Przepływów) — protokół napraw pkt 4.
 */
export class InflowCurrencyError extends OutgoingInvoiceCurrencyNotSupportedError {
  constructor(document: string, currency: string) {
    super();
    this.name = 'InflowCurrencyError';
    this.message =
      `Raport wstrzymany: faktura sprzedaży ${document} nie ma potwierdzonej waluty PLN (${currency || 'brak waluty'}). `
      + 'Faktury walutowe wymagają uzgodnienia z księgową.';
  }
}

/**
 * Skąd dzień faktury. Pieniądze: `paid` (zapłata) i `correction` (korekta in minus
 * wystawiona po zapłacie faktury). Należność bez wpłaty: `due` (termin) i `issued` (wystawienie).
 */
export type InflowBasis = 'paid' | 'correction' | 'due' | 'issued';

export interface InflowEntry {
  /** Id faktury. */
  id: string;
  /** Dzień w Europe/Warsaw, RRRR-MM-DD (`inflowDay`): zapłata, termin albo wystawienie. */
  date: string;
  basis: InflowBasis;
  /**
   * PLN ze znakiem dokumentu: wpłata (po korektach in minus wystawionych do dnia
   * zapłaty), brutto do zapłaty (z korektami wystawionymi do dnia terminu) albo
   * różnica korekty późniejszej niż zapłata.
   */
  amount: number;
  /** Reszta do zapłaty po korektach i wpłatach częściowych; 0 przy prawdziwej zapłacie i korekcie in minus. */
  outstanding: number;
  /** Termin płatności faktury, RRRR-MM-DD; `null` bez terminu. */
  dueDate: string | null;
  invoiceKind: string | null;
  internalNumber: string | null;
  /** `b2c`, `nip:<cyfry>`, `name:<nazwa małymi literami>` albo `invoice:<id>` (bez nabywcy). */
  buyerKey: string;
  /** Nazwa nabywcy z faktury; `null`, gdy faktura jej nie ma. */
  buyerName: string | null;
  buyerNip: string | null;
  /** Nabywca B2C (`is_b2c`) — w rankingach jedna pozycja „Konsumenci”. */
  consumers: boolean;
}

/** Kolumny dnia faktury (`inflowDay`). */
export interface InflowDayRow {
  paid_at: string | null;
  fa3_paid_date: string | null;
  payment_due_date: string | null;
  issue_date: string | null;
}

interface InflowRow extends InflowDayRow {
  id: string;
  direction: string | null;
  ksef_status: string | null;
  ksef_environment: string | null;
  invoice_kind: string | null;
  /** Faktura korygowana — tylko korekta ma tu wartość. */
  parent_invoice_id: string | null;
  currency: string | null;
  gross_total: number | string | null;
  paid_amount: number | string | null;
  payment_data: unknown;
  internal_number: string | null;
  buyer_nip: string | null;
  buyer_data: unknown;
  is_b2c: boolean | null;
}

function isIsoDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Dzień faktury: prawdziwa zapłata → data zapłaty z FA(3) → termin → wystawienie. */
export function inflowDay(row: InflowDayRow): { date: string; basis: InflowBasis } | null {
  if (row.paid_at) {
    const paidAt = new Date(row.paid_at);
    if (!Number.isNaN(paidAt.getTime())) return { date: todayInWarsaw(paidAt), basis: 'paid' };
  }
  const fa3Paid = row.fa3_paid_date?.trim();
  if (isIsoDate(fa3Paid)) return { date: fa3Paid, basis: 'paid' };
  const due = row.payment_due_date?.slice(0, 10);
  if (isIsoDate(due)) return { date: due, basis: 'due' };
  const issued = row.issue_date?.slice(0, 10);
  if (isIsoDate(issued)) return { date: issued, basis: 'issued' };
  return null;
}

function finiteNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function buyerNameOf(buyerData: unknown): string | null {
  if (typeof buyerData !== 'object' || buyerData === null || Array.isArray(buyerData)) return null;
  const name = (buyerData as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
}

/** Klucz nabywcy — ta sama reguła co ranking klientów Pulpitu (`rankings.ts`). */
function buyerIdentity(row: InflowRow): { key: string; nip: string | null; consumers: boolean } {
  if (row.is_b2c === true) return { key: 'b2c', nip: null, consumers: true };
  const nip = (row.buyer_nip ?? '').replace(/\D/g, '');
  if (nip !== '') return { key: `nip:${nip}`, nip, consumers: false };
  const name = buyerNameOf(row.buyer_data);
  if (name !== null) return { key: `name:${name.toLowerCase()}`, nip: null, consumers: false };
  return { key: `invoice:${row.id}`, nip: null, consumers: false };
}

/**
 * Korekty wystawione przed `from` do faktur pierwotnych z dniem wpływu
 * w zakresie — tych główne zapytanie nie ma (żadna ich data nie sięga
 * `from`). Korekta jest wystawiana nie wcześniej niż faktura, więc wystarczy
 * okno od najwcześniejszego wystawienia takiej faktury do `from`. Bez takich
 * faktur — bez zapytania.
 */
async function correctionsBefore(
  supabase: PageContext['supabase'],
  tenantId: string,
  from: string,
  fetched: readonly InflowRow[],
  parents: ReadonlyArray<{ row: InflowRow }>,
): Promise<InflowRow[]> {
  const issued = parents
    .map(({ row }) => row.issue_date?.slice(0, 10))
    .filter((date): date is string => isIsoDate(date) && date < from);
  if (issued.length === 0) return [];
  const earliest = issued.reduce((min, date) => (date < min ? date : min));
  const parentIds = new Set(parents.map(({ row }) => row.id));
  const fetchedIds = new Set(fetched.map((row) => row.id));
  const rows = await readCompletePages<InflowRow>('Nie można odczytać korekt faktur', (start, end) => supabase
    .from('invoices')
    .select(INFLOW_COLUMNS, { count: 'exact' })
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .eq('ksef_status', 'accepted')
    .not('parent_invoice_id', 'is', null)
    .gte('issue_date', earliest)
    .lt('issue_date', from)
    .order('id', { ascending: true })
    .range(start, end));
  return rows.filter((row) => parentIds.has(row.parent_invoice_id ?? '') && !fetchedIds.has(row.id));
}

const PARENT_LOOKUP_CHUNK = 100;

/**
 * Faktury pierwotne spoza głównego odczytu (wszystkie ich daty są przed `from`),
 * zapłacone naprawdę. Korekta in minus do takiej faktury to ruch pieniędzy,
 * a korekta do faktury bez wpłaty nie, więc bez tego odczytu suma byłaby zła.
 * Bez takich korekt: bez zapytania.
 */
async function paidParentsOutsideRead(
  supabase: PageContext['supabase'],
  tenantId: string,
  parentIds: readonly string[],
): Promise<Set<string>> {
  const paid = new Set<string>();
  for (let i = 0; i < parentIds.length; i += PARENT_LOOKUP_CHUNK) {
    const chunk = parentIds.slice(i, i + PARENT_LOOKUP_CHUNK);
    const rows = await readCompletePages('Nie można odczytać faktur korygowanych', (from, to) => supabase
      .from('invoices')
      .select(`id, paid_at, payment_due_date, issue_date, fa3_paid_date:${FA3_PAID_DATE}`, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .in('id', chunk)
      .order('id', { ascending: true })
      .range(from, to));
    for (const row of rows as unknown as Array<InflowDayRow & { id: string }>) {
      if (inflowDay(row)?.basis === 'paid') paid.add(row.id);
    }
  }
  return paid;
}

export interface InflowOptions {
  /**
   * Faktura spoza PLN z dniem w zakresie: `halt` (domyślnie, karty Przepływów,
   * Pulpitu i Analiz) zatrzymuje kartę `InflowCurrencyError`; `skip` pomija taką
   * fakturę (kafel „Opłacone” listy faktur nie zatrzymuje tabeli z powodu faktury
   * walutowej, tak jak należności pomijają waluty obce).
   */
  foreignCurrency?: 'halt' | 'skip';
}

/**
 * Faktury sprzedaży z dniem w `[from, toExclusive)` (RRRR-MM-DD, kalendarz
 * Europe/Warsaw); bez `toExclusive` także wszystkie przyszłe terminy.
 * Posortowane po dniu, potem po id faktury.
 */
export async function getInflows(
  supabase: PageContext['supabase'],
  tenantId: string,
  range: { from: string; toExclusive?: string },
  options: InflowOptions = {},
): Promise<InflowEntry[]> {
  const environment = requireConfiguredKsefEnvironment();
  // Dzień ≥ `from` wymaga, by któraś z jego kolumn była ≥ `from`.
  // `paid_at` to znacznik czasu: okno poszerzone o dobę, dokładny dzień
  // w Warszawie liczy filtr niżej. Sama data (bez „:” i „.”, które w `or`
  // PostgREST-a trzeba by cytować). Górnej granicy w zapytaniu nie ma.
  const paidFrom = addDaysToIsoDate(range.from, -1) ?? range.from;
  const anyDateFrom = [
    `paid_at.gte.${paidFrom}`,
    `${FA3_PAID_DATE}.gte.${range.from}`,
    `payment_due_date.gte.${range.from}`,
    `issue_date.gte.${range.from}`,
  ].join(',');

  const rows = await readCompletePages<InflowRow>('Nie można odczytać wpływów', (from, to) => supabase
    .from('invoices')
    .select(INFLOW_COLUMNS, { count: 'exact' })
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .eq('ksef_status', 'accepted')
    .or(anyDateFrom)
    .order('id', { ascending: true })
    .range(from, to));

  const inWindow = (date: string) =>
    date >= range.from && (range.toExclusive === undefined || date < range.toExclusive);

  // Faktury pierwotne z dniem, do którego korekta się składa w jedną kwotę: bez prawdziwej
  // zapłaty (korekta wystawiona do dnia terminu zmienia tę należność) i zapłacone naprawdę
  // (korekta in minus wystawiona do dnia zapłaty zmniejsza wpływ z tej wpłaty).
  const parents = new Map<string, { row: InflowRow; date: string; basis: InflowBasis }>();
  for (const row of rows) {
    const day = inflowDay(row);
    if (row.parent_invoice_id === null && day) parents.set(row.id, { row, ...day });
  }
  const corrections = [
    ...rows.filter((row) => row.parent_invoice_id !== null),
    ...await correctionsBefore(supabase, tenantId, range.from, rows, [...parents.values()].filter((p) => inWindow(p.date))),
  ];
  const folded = new Map<string, InflowRow[]>();
  const foldedIds = new Set<string>();
  for (const correction of corrections) {
    const parent = parents.get(correction.parent_invoice_id ?? '');
    const issued = correction.issue_date?.slice(0, 10);
    if (!parent || !isIsoDate(issued) || issued > parent.date) continue;
    if (correction.ksef_environment !== parent.row.ksef_environment) continue;
    // Korekta z własną wpłatą (`paid_at` albo data zapłaty z FA(3)) to osobny, już zapłacony dług:
    // zostaje własnym wpływem w dniu swojej zapłaty, a należność faktury pierwotnej jej nie obejmuje.
    if (inflowDay(correction)?.basis === 'paid') continue;
    // Do wpłaty składamy tylko korektę in minus. Korekta in plus to osobny dług z własnym „Zapłacone”.
    if (parent.basis === 'paid' && amountDueOf(correction) >= 0) continue;
    folded.set(parent.row.id, [...(folded.get(parent.row.id) ?? []), correction]);
    foldedIds.add(correction.id);
  }

  // Korekta in minus bez własnej wpłaty: czy faktura pierwotna ma prawdziwą zapłatę.
  const isPaidOff = (row: InflowRow) => inflowDay(row)?.basis === 'paid';
  const minusCorrections = rows.filter((row) =>
    row.parent_invoice_id !== null && !foldedIds.has(row.id) && !isPaidOff(row) && amountDueOf(row) < 0);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const paidParents = new Set(rows.filter((row) => row.parent_invoice_id === null && isPaidOff(row)).map((row) => row.id));
  const outsideRead = [...new Set(minusCorrections
    .filter((row) => inWindow(row.issue_date?.slice(0, 10) ?? '') && !byId.has(row.parent_invoice_id ?? ''))
    .map((row) => row.parent_invoice_id as string))];
  if (outsideRead.length > 0) {
    for (const id of await paidParentsOutsideRead(supabase, tenantId, outsideRead)) paidParents.add(id);
  }
  const moneyCorrections = new Set(minusCorrections
    .filter((row) => paidParents.has(row.parent_invoice_id ?? '') && isIsoDate(row.issue_date?.slice(0, 10)))
    .map((row) => row.id));

  const inRange: Array<{ row: InflowRow; date: string; basis: InflowBasis }> = [];
  for (const row of rows) {
    if (foldedIds.has(row.id)) continue;
    const day = moneyCorrections.has(row.id)
      ? { date: (row.issue_date as string).slice(0, 10), basis: 'correction' as const }
      : inflowDay(row);
    if (day && inWindow(day.date)) inRange.push({ row, ...day });
  }
  // Strażniki obejmują też korekty, które zmieniają kwotę należności z zakresu.
  const guarded = inRange.flatMap(({ row }) => [row, ...(folded.get(row.id) ?? [])]);
  if (guarded.some((row) => row.ksef_environment === null || !KNOWN_ENVIRONMENTS.has(row.ksef_environment))) {
    throw new Error(ENVIRONMENT_ERROR);
  }
  const inEnvironment = inRange.filter(({ row }) => row.ksef_environment === environment);
  // Jak przychód (`assertOutgoingInvoicesInPln`): brak waluty też nie potwierdza złotówek.
  const withFolded = (row: InflowRow) => [row, ...(folded.get(row.id) ?? [])];
  const isPln = (row: InflowRow) => row.currency?.trim().toUpperCase() === 'PLN';
  const foreign = inEnvironment.flatMap(({ row }) => withFolded(row)).find((row) => !isPln(row));
  if (foreign && options.foreignCurrency !== 'skip') {
    throw new InflowCurrencyError(foreign.internal_number ?? foreign.id, foreign.currency?.trim().toUpperCase() ?? '');
  }
  const active = foreign ? inEnvironment.filter(({ row }) => withFolded(row).every(isPln)) : inEnvironment;

  const entries: InflowEntry[] = [];
  for (const { row, date, basis } of active) {
    const paidByPayments = basis === 'paid' && Boolean(row.paid_at);
    // Różnice ze znakiem korekt złożonych w tę fakturę: wystawionych do dnia terminu (bez
    // wpłaty) albo do dnia zapłaty (zapłacona).
    const adjustments = (folded.get(row.id) ?? []).reduce((sum, correction) => sum + amountDueOf(correction), 0);
    const due = amountDueOf(row) + adjustments;
    // Wpłata w `payments` to cała reszta brutto faktury, a korekta nie zmienia `paid_amount`:
    // pieniądze to wpłata razem z korektami wystawionymi do dnia zapłaty (jeden ruch).
    const amount = roundToCents(paidByPayments ? finiteNumber(row.paid_amount) + adjustments : due) || 0;
    if (amount === 0) continue;
    const identity = buyerIdentity(row);
    const dueDate = row.payment_due_date?.slice(0, 10);
    entries.push({
      id: row.id,
      date,
      basis,
      amount,
      outstanding: basis === 'paid' || basis === 'correction'
        ? 0
        : Math.max(0, roundToCents(due - finiteNumber(row.paid_amount)) || 0),
      dueDate: isIsoDate(dueDate) ? dueDate : null,
      invoiceKind: row.invoice_kind,
      internalNumber: row.internal_number,
      buyerKey: identity.key,
      buyerName: buyerNameOf(row.buyer_data),
      buyerNip: identity.nip,
      consumers: identity.consumers,
    });
  }
  entries.sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return entries;
}
