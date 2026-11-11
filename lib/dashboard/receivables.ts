import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { outstandingOf } from '@/lib/invoices/amount-due';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import type { PaymentFilterOp } from '@/lib/invoices/list-query';
import { RECEIPT_REVENUE_COLUMNS } from '@/lib/invoices/receipt-revenue-guard';
import { isReminderInvoiceChaseable } from '@/lib/reminders/delivery-schema';
import type { PageContext } from '@/lib/supabase/page-context';
import { roundToCents } from '@/lib/xml/invoice-calculator';
import type { KsefEnvironment } from '@/types/ksef';

/**
 * Należności — JEDNA funkcja dla całej aplikacji (PLAN-FINORA §2.4 pkt 11).
 * E3 ją tworzy (lista faktur), E4/E5/E8 tylko importują.
 *
 * Warunki są te same co w widoku `invoices_overdue` (00145) i na stronie
 * `/payments/overdue`, ale BEZ warunku daty: faktura sprzedaży z aplikacji
 * (`origin = 'app'`), przyjęta w AKTYWNYM środowisku KSeF, w PLN (albo bez
 * waluty — jak widok), rodzaje VAT/UPR, ZAL, ROZ, `gross_total > 0`, bez
 * dzieci (korekta przez `parent_invoice_id`, ROZ przez `advance_invoice_ids`
 * — każde dziecko tej firmy, w dowolnym statusie, jak NOT EXISTS w widoku),
 * `payment_status ∈ (unpaid, partial, overdue)`. Kwota: `outstandingOf`
 * (uwzględnia wpłaty częściowe i resztę ROZ po zaliczkach).
 *
 * „Po terminie” wyłącznie z DATY: `payment_due_date < dziś` w Europe/Warsaw.
 * Nigdy z `payment_status = 'overdue'` — wyzwalacz ustawia go tylko przy
 * zapisie wiersza, więc faktura nieruszana po terminie zostaje `unpaid`.
 *
 * Przyjęta faktura bez środowiska KSeF (albo z nieznanym) jest błędem, nie
 * cichym zerem — ten sam komunikat co `getMonthlyFigures`. Strażnik działa
 * na KANDYDATACH należności (jak `/payments/overdue`), nie na całej historii:
 * stara, opłacona faktura bez środowiska nie blokuje karty.
 */

export { RECEIVABLES_NOTE } from '@/lib/dashboard/receivables-note';

const ENVIRONMENT_ERROR = 'Przyjęte faktury wymagają uzgodnienia środowiska KSeF';
const KNOWN_ENVIRONMENTS: ReadonlySet<string> = new Set(['test', 'demo', 'production']);
const OPEN_PAYMENT_STATUSES = ['unpaid', 'partial', 'overdue'] as const;
/**
 * Pary rodzaj → typy faktury z pkt 11 (jak `isReminderInvoiceChaseable`
 * i widok 00145). Jedno źródło dla zapytania należności i filtra płatności
 * listy (`receivableBaseFilterOps`).
 */
const RECEIVABLE_KIND_TYPES = [
  { kind: 'regular', types: ['VAT', 'UPR'] },
  { kind: 'advance', types: ['ZAL'] },
  { kind: 'final', types: ['ROZ'] },
] as const;
const RECEIVABLE_KINDS = RECEIVABLE_KIND_TYPES.map((pair) => pair.kind);
const RECEIVABLE_TYPES = RECEIVABLE_KIND_TYPES.flatMap((pair) => pair.types);
const DAY_MS = 86_400_000;

/** Kolumny potrzebne predykatowi `isReceivableBase` i kwocie `outstandingOf`. */
export const RECEIVABLE_BASE_COLUMNS =
  `id, direction, origin, ksef_status, ksef_environment, invoice_kind, invoice_type, currency, gross_total, paid_amount, payment_data, payment_due_date, payment_status, ${RECEIPT_REVENUE_COLUMNS}`;

const RECEIVABLE_COLUMNS = `${RECEIVABLE_BASE_COLUMNS}, internal_number, buyer_data, buyer_nip` as const;

/** Wiersz faktury z kolumnami `RECEIVABLE_BASE_COLUMNS`. */
export interface ReceivableBaseRow {
  id: string;
  direction: string | null;
  origin: string | null;
  ksef_status: string | null;
  ksef_environment: string | null;
  invoice_kind: string | null;
  invoice_type: string | null;
  currency: string | null;
  gross_total: number | string | null;
  paid_amount: number | string | null;
  payment_data: unknown;
  payment_due_date: string | null;
  payment_status: string | null;
  /** Znaczniki FP (`RECEIPT_REVENUE_COLUMNS`): FP nie jest należnością (zapłacona przy kasie). */
  receipt?: unknown;
  ksef_fp?: unknown;
}

export interface ReceivableContext {
  environment: KsefEnvironment;
  /** Faktury tej firmy, które mają dziecko (korektę albo ROZ). */
  childIds: ReadonlySet<string>;
}

export interface ReceivableInvoice {
  id: string;
  internalNumber: string | null;
  buyerName: string | null;
  /**
   * NIP nabywcy (`buyer_nip`, a bez niego `buyer_data.nip` — jak widok
   * `invoices_overdue`); null dla nabywcy bez NIP. Do sum per kontrahent (P13).
   */
  buyerNip?: string | null;
  /** RRRR-MM-DD albo null (brak terminu = „nie po terminie”). */
  paymentDueDate: string | null;
  /** `outstandingOf`, PLN. */
  outstanding: number;
  /** 0, gdy nie po terminie. */
  daysOverdue: number;
}

export interface Receivables {
  /** overdue + notDue, PLN. */
  total: number;
  /** `payment_due_date < todayInWarsaw(now)`. */
  overdue: number;
  /** Reszta, w tym faktury bez terminu. */
  notDue: number;
  count: number;
  overdueCount: number;
  /** Największe opóźnienie w dniach; null, gdy nic nie jest po terminie. */
  oldestOverdueDays: number | null;
  /** Najpierw najstarsze zaległości (daysOverdue malejąco), potem id. */
  byInvoice: ReceivableInvoice[];
  /** Należności w walucie obcej pominięte w sumie PLN (§2.4 pkt 6). */
  foreignCurrencyCount: number;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Waluta należności PLN: `PLN` albo brak (jak widok 00145 i `/payments/overdue`). */
function isPlnOrUnset(currency: string | null): boolean {
  return currency === null || currency === 'PLN';
}

/** Wszystkie warunki pkt 11 poza walutą i statusem płatności. */
function isReceivableIgnoringCurrency(row: ReceivableBaseRow, ctx: ReceivableContext): boolean {
  const gross = finiteNumber(row.gross_total);
  const paid = finiteNumber(row.paid_amount);
  return row.direction === 'outgoing'
    && isReminderInvoiceChaseable(row) // origin = 'app' + pary rodzaj/typ VAT/UPR, ZAL, ROZ
    && row.ksef_status === 'accepted'
    && row.ksef_environment === ctx.environment
    && gross !== null && gross > 0
    && paid !== null && paid >= 0
    && !ctx.childIds.has(row.id);
}

/**
 * Czysty predykat §2.4 pkt 11 BEZ warunku `payment_status` — ten sam dla sumy
 * należności i dla kolumny „Do zapłaty” / ikony płatności na liście faktur
 * (P3). Faktura, która go nie spełnia (szkic, import, korekta, waluta obca,
 * inne środowisko, faktura z dzieckiem), dostaje na liście „—”.
 */
export function isReceivableBase(row: ReceivableBaseRow, ctx: ReceivableContext): boolean {
  return isReceivableIgnoringCurrency(row, ctx) && isPlnOrUnset(row.currency);
}

/**
 * Predykat `isReceivableBase` zapisany jako warunki PostgREST — dla filtra
 * płatności listy faktur (P3, `paymentFilterSpec`, C1). Dzięki niemu
 * „Opłacone”, „Nieopłacone” i „Po terminie” pokazują te same faktury, którym
 * kolumny „Płatność” i „Do zapłaty” dają stan płatności, a nie importy,
 * szkice czy korekty. Zgodność z predykatem pilnuje test w
 * `tests/unit/receivables.test.ts` (pełny iloczyn wartości kolumn).
 *
 * Jedyna różnica to warunek dzieci: PostgREST nie wyrazi „NOT EXISTS
 * dziecko” na wierszu rodzica, więc oryginał z korektą albo zaliczka z ROZ
 * zostaje w wyniku filtra, a jego wiersz pokazuje „—” (jak bez filtra).
 */
export function receivableBaseFilterOps(environment: KsefEnvironment): PaymentFilterOp[] {
  return [
    { op: 'eq', column: 'direction', value: 'outgoing' },
    { op: 'eq', column: 'origin', value: 'app' },
    { op: 'eq', column: 'ksef_status', value: 'accepted' },
    { op: 'eq', column: 'ksef_environment', value: environment },
    {
      op: 'or',
      anyOf: RECEIVABLE_KIND_TYPES.map(({ kind, types }) => [
        { op: 'eq', column: 'invoice_kind', value: kind },
        { op: 'in', column: 'invoice_type', value: types },
      ]),
    },
    { op: 'gt', column: 'gross_total', value: 0 },
    { op: 'gte', column: 'paid_amount', value: 0 },
    // `isPlnOrUnset`: PLN albo brak waluty (jak widok 00145).
    { op: 'or', anyOf: [[{ op: 'is', column: 'currency', value: null }], [{ op: 'eq', column: 'currency', value: 'PLN' }]] },
  ];
}

/** Data zapłaty z FA(3) zapisana przy imporcie (`ParsedInvoice.paidDate`), jak w `lib/dashboard/inflows.ts`. */
export const FA3_PAID_DATE_COLUMN = 'fa3_data->parsed->>paidDate';

/**
 * Warunki filtra „Opłacone” listy faktur. Zapłata jest faktem bez względu na
 * pochodzenie i rodzaj dokumentu: „Zapłacone” działa też na imporcie, historii
 * KSeF i korekcie (00158), a data zapłaty z FA(3) to faktura wystawiona po zapłacie.
 * Te same warunki co `isSettledSale` w `lib/invoices/list-row-facts.ts`.
 */
export function settledFilterOps(environment: KsefEnvironment): PaymentFilterOp[] {
  return [
    { op: 'eq', column: 'direction', value: 'outgoing' },
    { op: 'eq', column: 'ksef_status', value: 'accepted' },
    { op: 'eq', column: 'ksef_environment', value: environment },
    {
      op: 'or',
      anyOf: [
        [{ op: 'eq', column: 'payment_status', value: 'paid' }],
        [{ op: 'not_null', column: FA3_PAID_DATE_COLUMN }],
      ],
    },
  ];
}

function isOpenPaymentStatus(status: string | null): boolean {
  return (OPEN_PAYMENT_STATUSES as readonly (string | null)[]).includes(status);
}

/** Dni kalendarzowe między dwiema datami RRRR-MM-DD (bez strefy czasowej). */
function daysBetween(fromIso: string, toIso: string): number {
  const utc = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return Math.round((utc(toIso) - utc(fromIso)) / DAY_MS);
}

function isIsoDate(value: string | null): value is string {
  return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Faktura ma „dziecko”, gdy jakikolwiek wiersz tej firmy wskazuje ją
 * w `parent_invoice_id` (korekta) albo w `advance_invoice_ids` (ROZ),
 * w dowolnym statusie i kierunku — jak NOT EXISTS w widoku 00145.
 * PostgREST nie wyrazi „NOT EXISTS dziecko” na wierszu rodzica, więc czytamy
 * stronę dzieci w całości i odejmujemy zbiory w JS.
 */
export async function loadTenantChildIds(
  supabase: PageContext['supabase'],
  tenantId: string,
): Promise<Set<string>> {
  const [corrections, settlements] = await Promise.all([
    readCompletePages('Nie można odczytać korekt faktur', (from, to) => supabase
      .from('invoices')
      .select('id, parent_invoice_id', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .not('parent_invoice_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, to)),
    readCompletePages('Nie można odczytać faktur rozliczających zaliczki', (from, to) => supabase
      .from('invoices')
      .select('id, advance_invoice_ids', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .not('advance_invoice_ids', 'eq', '{}')
      .order('id', { ascending: true })
      .range(from, to)),
  ]);
  const childIds = new Set<string>();
  for (const row of corrections) {
    if (row.parent_invoice_id) childIds.add(row.parent_invoice_id);
  }
  for (const row of settlements) {
    for (const id of row.advance_invoice_ids ?? []) childIds.add(id);
  }
  return childIds;
}

function buyerNipOf(buyerNip: string | null | undefined, buyerData: unknown): string | null {
  if (typeof buyerNip === 'string' && buyerNip.trim() !== '') return buyerNip.trim();
  if (typeof buyerData !== 'object' || buyerData === null || Array.isArray(buyerData)) return null;
  const nip = (buyerData as Record<string, unknown>).nip;
  return typeof nip === 'string' && nip.trim() !== '' ? nip.trim() : null;
}

function buyerNameOf(buyerData: unknown): string | null {
  if (typeof buyerData !== 'object' || buyerData === null || Array.isArray(buyerData)) return null;
  const name = (buyerData as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() !== '' ? name : null;
}

export async function getReceivables(
  supabase: PageContext['supabase'],
  tenantId: string,
  now: Date = new Date(),
): Promise<Receivables> {
  const environment = requireConfiguredKsefEnvironment();
  const today = todayInWarsaw(now);

  // Bez filtra środowiska: przyjęta faktura bez środowiska musi być widoczna,
  // żeby strażnik mógł ją zgłosić. Pozostałe warunki zawężają odczyt;
  // predykat i tak sprawdza każdy z nich jeszcze raz.
  const [candidates, childIds] = await Promise.all([
    readCompletePages('Nie można odczytać należności', (from, to) => supabase
      .from('invoices')
      .select(RECEIVABLE_COLUMNS, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('direction', 'outgoing')
      .eq('origin', 'app')
      .eq('ksef_status', 'accepted')
      .in('payment_status', [...OPEN_PAYMENT_STATUSES])
      .in('invoice_kind', [...RECEIVABLE_KINDS])
      .in('invoice_type', [...RECEIVABLE_TYPES])
      .gt('gross_total', 0)
      .order('id', { ascending: true })
      .range(from, to)),
    loadTenantChildIds(supabase, tenantId),
  ]);

  if (candidates.some((row) => row.ksef_environment === null || !KNOWN_ENVIRONMENTS.has(row.ksef_environment))) {
    throw new Error(ENVIRONMENT_ERROR);
  }

  const ctx: ReceivableContext = { environment, childIds };
  const byInvoice: ReceivableInvoice[] = [];
  let foreignCurrencyCount = 0;
  let overdue = 0;
  let notDue = 0;

  for (const row of candidates) {
    if (!isOpenPaymentStatus(row.payment_status)) continue;
    if (!isReceivableIgnoringCurrency(row, ctx)) continue;
    const outstanding = outstandingOf(row);
    if (outstanding <= 0) continue;
    if (!isPlnOrUnset(row.currency)) {
      foreignCurrencyCount += 1;
      continue;
    }
    const due = isIsoDate(row.payment_due_date) ? row.payment_due_date : null;
    const isOverdue = due !== null && due < today;
    const daysOverdue = isOverdue ? daysBetween(due, today) : 0;
    if (isOverdue) overdue += outstanding;
    else notDue += outstanding;
    byInvoice.push({
      id: row.id,
      internalNumber: row.internal_number,
      buyerName: buyerNameOf(row.buyer_data),
      buyerNip: buyerNipOf(row.buyer_nip, row.buyer_data),
      paymentDueDate: due,
      outstanding,
      daysOverdue,
    });
  }

  byInvoice.sort((a, b) => b.daysOverdue - a.daysOverdue || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const overdueRows = byInvoice.filter((inv) => inv.daysOverdue > 0);

  return {
    total: roundToCents(overdue + notDue),
    overdue: roundToCents(overdue),
    notDue: roundToCents(notDue),
    count: byInvoice.length,
    overdueCount: overdueRows.length,
    oldestOverdueDays: overdueRows.length > 0
      ? overdueRows.reduce((max, inv) => Math.max(max, inv.daysOverdue), 0)
      : null,
    byInvoice,
    foreignCurrencyCount,
  };
}
