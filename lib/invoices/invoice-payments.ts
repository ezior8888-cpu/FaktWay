/**
 * Wpłaty częściowe i historia wpłat przy fakturze sprzedaży (plan kompletnej
 * aplikacji, krok 3.1, migracja 00176): schemat pól „Zapisz wpłatę” (ten sam
 * w formularzu i w akcji serwerowej), odczyt historii z RPC `invoice_payments`,
 * przeliczenie i teksty. Moduł bez importów serwerowych: biorą go akcje,
 * strona faktury i komponent kliencki.
 *
 * Księga wpłat to `payments` (00014): piszą do niej „Zapłacone” jednym
 * dotknięciem (`mark_invoice_paid`, 00158), „Zapisz wpłatę” (`record_invoice_payment`,
 * 00176) i karta FLO. `invoices.paid_amount` to suma wpłat niecofniętych
 * (wyzwalacz `recalculate_invoice_paid_amount`), a stan płatności ustawia
 * `update_invoice_payment_status` (00145). Data wpłaty zasili kasowy PIT, metodę
 * kasową VAT i ulgę na złe długi (kroki 4.2 i 3.5), więc jest datą przelewu,
 * a nie dniem kliknięcia.
 */

import { z } from 'zod';

/** Najdłuższa notatka do wpłaty; ten sam limit stoi w RPC. */
export const PAYMENT_NOTE_MAX = 500;

/** Waluta wpłat dziś: faktury walutowe dojdą w kroku 2.1. */
export const PAYMENT_CURRENCY = 'PLN';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** „1 234,56”, „1234.5”, „1234”: ten sam kształt co pole kwoty w karcie FLO (`lib/flo/money.ts`). */
const AMOUNT_INPUT = /^\d{1,3}(?:[  ]?\d{3})*(?:[.,]\d{1,2})?$/;

function isRealDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Kwota wpisana przez człowieka, w złotych z groszami. Liczymy w groszach na
 * liczbach całkowitych, więc „0,30” to 0.3, a nie 0.30000000000000004. Napis,
 * którego nie rozumiemy, i kwota nie większa od zera to `null`, a nie zgadywanie.
 */
export function parsePaymentAmount(text: string): number | null {
  const trimmed = text.trim();
  if (!AMOUNT_INPUT.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.replace(/[  ]/g, '').split(/[.,]/);
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return cents / 100;
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

/** Kwota po polsku z kodem waluty: „1 234,50 PLN”, jak „Do zapłaty” na szczegółach faktury. */
export function formatPaymentMoney(amount: number, currency: string = PAYMENT_CURRENCY): string {
  const digits = amount.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${digits} ${currency.trim().toUpperCase() || PAYMENT_CURRENCY}`;
}

/** „2026-11-05” → „05.11.2026”. */
function dayPl(iso: string | null | undefined): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

export interface PaymentEntrySchemaOptions {
  /** Dziś w Europe/Warsaw (RRRR-MM-DD): górna granica daty wpłaty. */
  today: string;
  /** Reszta do zapłaty, gdy formularz ją zna (podpowiedź; ostatnie słowo ma RPC). */
  maxAmount?: number | null;
}

/**
 * Pola „Zapisz wpłatę”: kwota (napis z formularza), data wpłaty i notatka.
 * Ten sam schemat sprawdza formularz i akcja serwerowa; RPC sprawdza wszystko
 * jeszcze raz na zablokowanym wierszu faktury.
 */
export function paymentEntrySchema({ today, maxAmount = null }: PaymentEntrySchemaOptions) {
  return z.object({
    amount: z
      .string()
      .trim()
      .min(1, 'Wpisz kwotę wpłaty.')
      .refine((value) => parsePaymentAmount(value) !== null, 'Wpisz kwotę większą od zera, np. 300 albo 1 234,56.')
      .refine(
        (value) => {
          const amount = parsePaymentAmount(value);
          return amount === null || maxAmount === null || toCents(amount) <= toCents(maxAmount);
        },
        { message: `Kwota jest większa niż pozostało do zapłaty (${formatPaymentMoney(maxAmount ?? 0)}).` },
      ),
    paidOn: z
      .string()
      .refine(isRealDay, 'Wpisz datę wpłaty.')
      .refine((value) => !isRealDay(value) || value >= '2000-01-01', 'Sprawdź rok w dacie wpłaty: wygląda na literówkę.')
      .refine((value) => !isRealDay(value) || value <= today, 'Data wpłaty nie może być z przyszłości. Wpisz dzisiejszą albo wcześniejszą datę.'),
    note: z
      .string()
      .trim()
      .max(PAYMENT_NOTE_MAX, `Notatka może mieć najwyżej ${PAYMENT_NOTE_MAX} znaków.`),
  });
}

export type PaymentEntryFields = z.infer<ReturnType<typeof paymentEntrySchema>>;
export type PaymentEntryField = keyof PaymentEntryFields;

/** Skąd jest wpłata (`payments.match_method`); nieznane źródło to `other`. */
export const INVOICE_PAYMENT_SOURCES = ['manual_entry', 'manual', 'flo_confirmation', 'bank_import', 'other'] as const;
export type InvoicePaymentSource = (typeof INVOICE_PAYMENT_SOURCES)[number];

export interface InvoicePaymentEntry {
  id: string;
  amount: number;
  /** Dzień wpłaty RRRR-MM-DD (data przelewu podana przez klienta). */
  paidOn: string;
  source: InvoicePaymentSource;
  /** Notatka klienta; tylko przy wpłatach wpisanych ręcznie. */
  note: string | null;
  recordedAt: string | null;
  /** Cofnięcie: wiersz zostaje jako ślad i nie liczy się do sumy. */
  voidedAt: string | null;
}

/** Sekcja „Wpłaty” na szczegółach faktury: liczy serwer (`loadPaymentHistory` strony faktury). */
export interface InvoicePaymentsData {
  entries: InvoicePaymentEntry[];
  /** `invoices.payment_status` (wyzwalacz 00145). */
  status: string | null;
  /** Do zapłaty na tej fakturze (`amountDueOf`: ROZ to reszta po zaliczkach). */
  due: number;
  /** `invoices.paid_amount`: suma wpłat niecofniętych. */
  paid: number;
  /** Pozostało do zapłaty (`outstandingOf`). */
  remaining: number;
  currency: string;
  /** „Zapisz wpłatę”: te same warunki co „Zapłacone” (00158) i faktura w PLN. */
  canRecord: boolean;
  /** „Cofnij wpłatę”: rola z prawem zmiany płatności (właściciel, administrator, członek). */
  canVoid: boolean;
  /** Dziś w Europe/Warsaw: domyślna data i górna granica wyboru. */
  today: string;
  /** Historii nie udało się wczytać: komunikat zamiast listy, bez zapisu. */
  loadError: boolean;
  /** Suma wpłat niecofniętych z historii różni się od `paid_amount`: ostrzeżenie, bez zapisu. */
  mismatch: boolean;
}

function finiteAmount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function sourceOf(value: unknown): InvoicePaymentSource {
  return typeof value === 'string' && (INVOICE_PAYMENT_SOURCES as readonly string[]).includes(value)
    ? (value as InvoicePaymentSource)
    : 'other';
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/**
 * Wynik RPC `invoice_payments` (00176). Kształt inny niż lista wierszy z kwotą
 * dodatnią, dniem i identyfikatorem to `null`: ekran mówi wtedy, że historii nie
 * udało się wczytać, zamiast pokazać pustą (fałszywą) historię.
 */
export function parseInvoicePaymentsRpc(data: unknown): InvoicePaymentEntry[] | null {
  if (!Array.isArray(data)) return null;
  const entries: InvoicePaymentEntry[] = [];
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    const amount = finiteAmount(row.amount);
    if (typeof row.id !== 'string' || row.id === '' || amount === null || amount <= 0) return null;
    if (typeof row.paid_on !== 'string' || !isRealDay(row.paid_on)) return null;
    entries.push({
      id: row.id,
      amount,
      paidOn: row.paid_on,
      source: sourceOf(row.source),
      note: textOrNull(row.note),
      recordedAt: textOrNull(row.recorded_at),
      voidedAt: textOrNull(row.voided_at),
    });
  }
  return entries;
}

export interface PaymentsSummary {
  /** Suma wpłat niecofniętych. */
  paid: number;
  remaining: number;
  state: 'unpaid' | 'partial' | 'paid';
  /** Ile wpłat cofnięto (zostają w historii). */
  voided: number;
}

/**
 * Lustro wyzwalacza `recalculate_invoice_paid_amount` (00176) i stanu z 00145:
 * liczą się tylko wpłaty niecofnięte, w groszach. Strona porównuje tę sumę
 * z `paid_amount` faktury (niezmiennik z planu: suma niecofniętych wpłat
 * równa się zapłaconej kwocie).
 */
export function summarizeInvoicePayments(entries: readonly InvoicePaymentEntry[], due: number): PaymentsSummary {
  const active = entries.filter((entry) => entry.voidedAt === null);
  const paidCents = active.reduce((sum, entry) => sum + toCents(entry.amount), 0);
  const dueCents = toCents(due);
  const state = paidCents === 0 ? 'unpaid' : paidCents >= dueCents ? 'paid' : 'partial';
  return {
    paid: paidCents / 100,
    remaining: Math.max(0, dueCents - paidCents) / 100,
    state,
    voided: entries.length - active.length,
  };
}

/** Czy suma wpłat z historii zgadza się z `paid_amount` faktury (co do grosza). */
export function paymentsMatchInvoice(entries: readonly InvoicePaymentEntry[], paidAmount: number): boolean {
  return toCents(summarizeInvoicePayments(entries, 0).paid) === toCents(paidAmount);
}

/** Stan płatności z bazy po polsku; nieznany stan to `null` (ekran go nie pokazuje). */
export function paymentStateLabel(status: string | null | undefined): string | null {
  switch (status) {
    case 'unpaid':
      return 'nieopłacona';
    case 'overdue':
      return 'nieopłacona, po terminie';
    case 'partial':
      return 'częściowo opłacona';
    case 'paid':
      return 'opłacona';
    default:
      return null;
  }
}

/** Podpis źródła wpłaty w historii; wpłata wpisana ręcznie go nie potrzebuje. */
export function paymentSourceLabel(source: InvoicePaymentSource): string | null {
  switch (source) {
    case 'manual_entry':
      return null;
    case 'manual':
      return 'Oznaczona przyciskiem „Zapłacone” (cała reszta)';
    case 'flo_confirmation':
      return 'Potwierdzona w karcie FLO';
    case 'bank_import':
      return 'Z wyciągu bankowego';
    case 'other':
      return 'Zapisana automatycznie';
  }
}

/**
 * Co wolno cofnąć w historii: wpłaty wpisane przez człowieka (ręcznie, przyciskiem
 * „Zapłacone”, w karcie FLO). Wpłatę z wyciągu cofa jego własna droga.
 */
export function isVoidableSource(source: InvoicePaymentSource): boolean {
  return source === 'manual_entry' || source === 'manual' || source === 'flo_confirmation';
}

/** Powód odmowy `record_invoice_payment` (00176). */
export type RecordPaymentRefusal =
  | 'not_found'
  | 'not_sales'
  | 'not_accepted'
  | 'invoice_currency'
  | 'payment_currency'
  | 'invalid_amount'
  | 'future_date'
  | 'invalid_date'
  | 'note_too_long'
  | 'already_paid'
  | 'nothing_to_pay'
  | 'corrected_to_zero'
  | 'over_remaining'
  | 'key_reused';

/** Powód odmowy `void_invoice_payment` (00176). */
export type VoidPaymentRefusal = 'not_found' | 'not_voidable' | 'manual_first';

const RECORD_REFUSALS: ReadonlySet<string> = new Set<RecordPaymentRefusal>([
  'not_found', 'not_sales', 'not_accepted', 'invoice_currency', 'payment_currency', 'invalid_amount',
  'future_date', 'invalid_date', 'note_too_long', 'already_paid', 'nothing_to_pay', 'corrected_to_zero',
  'over_remaining', 'key_reused',
]);
const VOID_REFUSALS: ReadonlySet<string> = new Set<VoidPaymentRefusal>(['not_found', 'not_voidable', 'manual_first']);

/** Kod odmowy z bazy, który ma tekst; nieznany kod dostaje ogólny komunikat. */
export function isRecordPaymentRefusal(code: unknown): code is RecordPaymentRefusal {
  return typeof code === 'string' && RECORD_REFUSALS.has(code);
}

export function isVoidPaymentRefusal(code: unknown): code is VoidPaymentRefusal {
  return typeof code === 'string' && VOID_REFUSALS.has(code);
}

const faktura = (number: string | null | undefined) => (number ? `Faktura ${number}` : 'Ta faktura');
const naFakturze = (number: string | null | undefined) => (number ? `na fakturze ${number}` : 'na tej fakturze');

/** Pole formularza, którego dotyczy odmowa z bazy (komunikat stoi przy nim). */
export function recordRefusalField(code: string): PaymentEntryField | undefined {
  switch (code) {
    case 'invalid_amount':
    case 'over_remaining':
    case 'payment_currency':
      return 'amount';
    case 'future_date':
    case 'invalid_date':
      return 'paidOn';
    case 'note_too_long':
      return 'note';
    default:
      return undefined;
  }
}

/** Odmowa nazywa dokument i mówi, co zrobić (protokół napraw, pkt 4). */
export function recordPaymentRefusalText(
  code: RecordPaymentRefusal,
  ctx: { number?: string | null; remaining?: number | null; currency?: string | null } = {},
): string {
  const { number } = ctx;
  switch (code) {
    case 'not_found':
      return 'Nie znaleziono tej faktury w aktywnej firmie. Odśwież stronę albo przełącz firmę.';
    case 'not_sales':
      return `${faktura(number)} to faktura zakupu. Wpłaty zapisujemy tylko przy fakturach sprzedaży.`;
    case 'not_accepted':
      return `${faktura(number)} nie jest jeszcze przyjęta w KSeF. Wpłatę zapiszesz po jej przyjęciu.`;
    case 'invoice_currency':
      return `${faktura(number)} jest w walucie ${ctx.currency?.trim().toUpperCase() || 'obcej'}. Wpłaty zapisujemy na razie tylko do faktur w złotych (PLN). Wpłatę tej faktury trzeba na razie odnotować poza FaktWay.`;
    case 'payment_currency':
      return 'Wpłaty zapisujemy na razie tylko w złotych (PLN). Wpisz kwotę w złotych.';
    case 'invalid_amount':
      return 'Kwota wpłaty musi być większa od zera i mieć najwyżej dwa miejsca po przecinku.';
    case 'future_date':
      return 'Data wpłaty nie może być z przyszłości. Wpisz dzisiejszą albo wcześniejszą datę.';
    case 'invalid_date':
      return 'Sprawdź rok w dacie wpłaty: wygląda na literówkę.';
    case 'note_too_long':
      return `Notatka może mieć najwyżej ${PAYMENT_NOTE_MAX} znaków.`;
    case 'already_paid':
      return `${faktura(number)} jest już zapłacona w całości, więc nie ma na co zapisać wpłaty. Jeśli któraś wpłata to pomyłka, cofnij ją w historii wpłat.`;
    case 'nothing_to_pay':
      return `${faktura(number)} nie ma kwoty do zapłaty, więc nie ma na co zapisać wpłaty.`;
    case 'corrected_to_zero':
      return `${faktura(number)} jest skorygowana do zera. Nabywca nic nie jest winien, więc nie ma na co zapisać wpłaty.`;
    case 'over_remaining': {
      const rest = typeof ctx.remaining === 'number' && Number.isFinite(ctx.remaining) ? ` (${formatPaymentMoney(ctx.remaining)})` : '';
      return `Kwota jest większa niż pozostało do zapłaty ${naFakturze(number)}${rest}. FaktWay nie zapisuje nadpłat: wpisz kwotę najwyżej do tej reszty.`;
    }
    case 'key_reused':
      return 'Ta wpłata była już zapisana z innymi danymi. Odśwież stronę i zapisz ją jeszcze raz.';
  }
}

export function voidPaymentRefusalText(
  code: VoidPaymentRefusal,
  ctx: { number?: string | null; manualPaidOn?: string | null; manualAmount?: number | null } = {},
): string {
  switch (code) {
    case 'not_found':
      return 'Nie znaleziono tej wpłaty w aktywnej firmie. Odśwież stronę albo przełącz firmę.';
    case 'not_voidable':
      return 'Tej wpłaty nie da się cofnąć tutaj, bo nie wpisano jej ręcznie. Napisz do nas przez Pomoc, a sprawdzimy ją.';
    case 'manual_first': {
      const day = dayPl(ctx.manualPaidOn);
      const when = day ? ` z ${day}` : '';
      const amount = typeof ctx.manualAmount === 'number' && Number.isFinite(ctx.manualAmount) ? ` na ${formatPaymentMoney(ctx.manualAmount)}` : '';
      return `${faktura(ctx.number)} ma oznaczenie „Zapłacone”${when}${amount}, policzone jako reszta po tej wpłacie. Najpierw cofnij to oznaczenie, potem tę wpłatę.`;
    }
  }
}

export const RECORD_PAYMENT_FAILED = 'Nie udało się zapisać wpłaty. Sprawdź połączenie i spróbuj ponownie.';
export const VOID_PAYMENT_FAILED = 'Nie udało się cofnąć wpłaty. Sprawdź połączenie i spróbuj ponownie.';
export const PAYMENTS_LOAD_FAILED = 'Nie udało się wczytać historii wpłat. Odśwież stronę.';
export const PAYMENTS_MISMATCH =
  'Suma wpłat w historii nie zgadza się z kwotą zapłaconą na fakturze. Odśwież stronę, a jeśli to się powtórzy, napisz do nas przez Pomoc.';
export const ALREADY_RECORDED_TOAST = 'Ta wpłata jest już zapisana.';
export const ALREADY_VOIDED_TOAST = 'Ta wpłata była już cofnięta.';

export function recordedPaymentToast(amount: number, number: string | null | undefined, paidInFull: boolean): string {
  const base = `Zapisano wpłatę ${formatPaymentMoney(amount)}${number ? ` do faktury ${number}` : ''}.`;
  return paidInFull ? `${base} Faktura jest zapłacona w całości.` : base;
}

export function voidedPaymentToast(amount: number | null): string {
  return amount === null ? 'Cofnięto wpłatę.' : `Cofnięto wpłatę ${formatPaymentMoney(amount)}.`;
}

/** Wejście akcji „Zapisz wpłatę”: pola formularza jako napisy, jak w formularzu. */
export interface RecordInvoicePaymentInput {
  invoiceId: string;
  /** Klucz od klienta (UUID z chwili otwarcia okna): ponowienie zapisuje wpłatę raz. */
  idempotencyKey: string;
  amount: string;
  paidOn: string;
  note?: string;
  /** Dziś tylko PLN; inna waluta to odmowa. */
  currency?: string;
}

export type RecordInvoicePaymentResult =
  | {
      success: true;
      status: 'recorded' | 'already_recorded';
      paymentId: string;
      amount: number;
      paidOn: string;
      remaining: number;
      /** Faktura zapłacona w całości po tej wpłacie. */
      paidInFull: boolean;
      number: string | null;
    }
  | { success: false; error: string; field?: PaymentEntryField };

export type VoidInvoicePaymentResult =
  | { success: true; status: 'voided' | 'already_voided'; amount: number | null; number: string | null }
  | { success: false; error: string };
