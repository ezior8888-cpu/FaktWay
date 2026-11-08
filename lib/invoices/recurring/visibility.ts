/**
 * Kiedy pokazać przyciski „Duplikuj” i „Ustaw jako cykliczną” (plan Finora
 * N1, P3/P4/P11) — czyste funkcje bez importów serwerowych, więc działają
 * i w komponentach klienckich.
 *
 * „Ustaw jako cykliczną” używa DOKŁADNIE tych warunków co akcja tworzenia
 * (`templateRejection`): przycisk, który prowadzi do odmowy, byłby gorszy
 * niż brak przycisku.
 *
 * „Duplikuj” (`/invoices/new/regular?wzor=<id>`): formularz zwykłej faktury
 * przyjmuje tylko zwykłą fakturę. Korekta ma treść zależną od rodzica,
 * zaliczka i faktura końcowa mają własne formularze i powiązania, a faktura
 * z importu nie ma pewnych pozycji (prefill odmówiłby i strona pokazałaby
 * komunikat „nie znaleziono”). Status KSeF nie ma znaczenia: kopiować można
 * także fakturę odrzuconą albo szkic — nowa faktura dostaje nowy numer i datę.
 */
import { templateRejection } from './template';

export interface RecurringVisibilityRow {
  /** Lista faktur wystawionych jest już zawężona do sprzedaży; brak pola = sprzedaż. */
  direction?: string | null;
  origin?: string | null;
  invoice_kind?: string | null;
  invoice_type?: string | null;
  ksef_status?: string | null;
  currency?: string | null;
}

/** „Duplikuj”: zwykła faktura sprzedaży wystawiona w FaktWay. */
export function canDuplicateInvoice(row: RecurringVisibilityRow): boolean {
  return (row.direction ?? 'outgoing') === 'outgoing' && row.origin === 'app' && row.invoice_kind === 'regular';
}

/** „Ustaw jako cykliczną”: faktura spełnia warunki wzoru N1; brak waluty w wierszu to brak dowodu, że jest w PLN. */
export function canSetAsRecurring(row: RecurringVisibilityRow): boolean {
  return (
    templateRejection({
      direction: row.direction ?? 'outgoing',
      origin: row.origin ?? '',
      invoice_kind: row.invoice_kind ?? '',
      invoice_type: row.invoice_type ?? null,
      ksef_status: row.ksef_status ?? null,
      currency: row.currency ?? null,
    }) === null
  );
}

/** Adres „Duplikuj”. */
export function duplicateInvoiceHref(invoiceId: string): string {
  return `/invoices/new/regular?wzor=${encodeURIComponent(invoiceId)}`;
}

/** Adres „Ustaw jako cykliczną” / „Zrób fakturę cykliczną” — otwiera arkusz z wybranym wzorem. */
export function setAsRecurringHref(invoiceId: string): string {
  return `/invoices/recurring?wzor=${encodeURIComponent(invoiceId)}`;
}
