import type { InvoiceListRowFacts, InvoicePaymentState } from '@/lib/invoices/list-row-facts';

export interface InvoiceRow {
  id: string;
  internal_number: string | null;
  issue_date: string | null;
  buyer_data: {
    nip?: string;
    name?: string;
  } | null;
  gross_total: string | number | null;
  ksef_status: string;
  ksef_number: string | null;
  created_at: string;
  /** Obecność ścieżki = można pobrać XML (jak w `InvoiceActions`). */
  xml_storage_path?: string | null;
  /**
   * Pola P3 (lista z płatnościami). Opcjonalne, bo ładunek Realtime i stare
   * wywołania ich nie muszą mieć.
   */
  payment_status?: string | null;
  payment_due_date?: string | null;
  paid_amount?: string | number | null;
  currency?: string | null;
  invoice_kind?: string | null;
  last_error_code?: string | null;
  /**
   * N1: skąd faktura i jaki ma typ — z tych pól (razem z `invoice_kind`,
   * `ksef_status` i `currency`) lista wylicza „Duplikuj” i „Ustaw jako
   * cykliczną” (`lib/invoices/recurring/visibility.ts`). Strona listy je
   * wybiera; brak pola = przycisk ukryty.
   */
  origin?: string | null;
  invoice_type?: string | null;
  /** F12-G1: pozycja cykliczna, z której wystawiono fakturę (ukrywa „Ustaw jako cykliczną”). */
  recurring_invoice_id?: string | null;
}

/** Fakty wierszy (`loadInvoiceListRowFacts`) jako zwykły obiekt: id → fakty. */
export type InvoiceFactsById = Record<string, InvoiceListRowFacts>;

/**
 * Stan płatności wiersza nałożony optymistycznie, zanim odpowie serwer
 * („Zapłacone” i „Cofnij”): to, co liczą `resolvePaymentState` i `resolveOutstanding`.
 */
export interface InvoicePaymentOverlay {
  paymentStatus: string | null | undefined;
  facts: InvoiceListRowFacts | undefined;
}

/** Wiersz tuż po dotknięciu „Zapłacone”. */
export function paidOverlay(facts: InvoiceListRowFacts | undefined): InvoicePaymentOverlay {
  return {
    paymentStatus: 'paid',
    facts: { payment: 'paid', outstanding: 0, canCorrect: facts?.canCorrect ?? false, canMarkPaid: false },
  };
}

/** Wiersz z nałożonym stanem płatności; bez nakładki — bez zmian. */
export function withPaymentOverlay<T extends InvoiceRow>(
  invoice: T,
  overlay: InvoicePaymentOverlay | undefined,
): T {
  return overlay ? { ...invoice, payment_status: overlay.paymentStatus } : invoice;
}

/** Kolumny, których zmiana unieważnia fakty policzone na serwerze. */
export const PAYMENT_FACT_FIELDS = [
  'payment_status',
  'payment_due_date',
  'paid_amount',
  'gross_total',
  'currency',
  'invoice_kind',
  'ksef_status',
] as const satisfies ReadonlyArray<keyof InvoiceRow>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Stan płatności wyliczany przy renderze — nie przechowywany. Czy faktura w
 * ogóle ma płatność (§2.4 pkt 11), wie serwer (`facts.payment !== null`);
 * „po terminie” liczymy tu z DATY (`today` = Europe/Warsaw), nigdy ze
 * statusu `overdue`, który wyzwalacz ustawia tylko przy zapisie wiersza.
 * `payment_status` z Realtime wygrywa z faktami serwera tylko dla „paid”.
 */
export function resolvePaymentState(
  row: Pick<InvoiceRow, 'payment_status' | 'payment_due_date'>,
  facts: InvoiceListRowFacts | undefined,
  today: string,
): InvoicePaymentState | null {
  if (!facts || facts.payment === null) return null;
  if (facts.payment === 'paid' || row.payment_status === 'paid') return 'paid';
  const due = row.payment_due_date;
  if (typeof due === 'string' && ISO_DATE.test(due)) return due < today ? 'overdue' : 'unpaid';
  return facts.payment;
}

/** Kwota „Do zapłaty”: null = „—”, 0 = „Opłacona”. */
export function resolveOutstanding(
  row: Pick<InvoiceRow, 'payment_status'>,
  facts: InvoiceListRowFacts | undefined,
): number | null {
  if (!facts || facts.payment === null || facts.outstanding === null) return null;
  return row.payment_status === 'paid' ? 0 : facts.outstanding;
}

/** „zł” tylko dla PLN (albo braku waluty); inaczej kod waluty. */
export function currencySymbol(currency: string | null | undefined): string {
  return !currency || currency === 'PLN' ? 'zł' : currency;
}

export const PAYMENT_STATE_LABELS: Record<InvoicePaymentState, string> = {
  paid: 'Opłacona',
  overdue: 'Po terminie',
  unpaid: 'Nieopłacona',
};
