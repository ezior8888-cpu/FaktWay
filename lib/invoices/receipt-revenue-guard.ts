import { OutgoingInvoiceCurrencyNotSupportedError } from '@/lib/exports/currency-guard';
import { isReceiptInvoiceColumns, isReceiptInvoiceFa3 } from '@/lib/invoices/receipt-invoice';

/**
 * Faktura do paragonu (FP) w raportach przychodu, krok 1.2 planu kompletnej
 * aplikacji (ustalenie 1 z #509).
 *
 * Sprzedaż z paragonu weszła już raportem z kasy. FP liczona jak zwykła
 * sprzedaż podwoiłaby przychód (art. 109 ust. 3d ustawy o VAT: FP nie zwiększa
 * sprzedaży). Raporty spoza modułu księgowości (KPiR w Raportach, plik Excel
 * KPiR, szacunek podatku, przepływy) nie znają raportów kasy, więc w okresie
 * z FP nie podają sumy: odmowa z numerem dokumentu i wyjściem (protokół napraw,
 * pkt 4). Jak moduł księgowości i JPK. FP rozpoznaje wyłącznie
 * `lib/invoices/receipt-invoice.ts`.
 *
 * Błąd dziedziczy po `OutgoingInvoiceCurrencyNotSupportedError`: te same
 * obsługi „raport wstrzymany” (route eksportu, job, karty Pulpitu i Przepływów)
 * pokazują jego komunikat w całości.
 */

/** Aliasy kolumn `invoices` dla odczytów bez całego `fa3_data` (jak `isReceiptInvoiceColumns`). */
export const RECEIPT_REVENUE_COLUMNS =
  'receipt:fa3_data->receipt, ksef_fp:fa3_data->ksefMarkers->>fp';

/** Początek komunikatu: job eksportu rozpoznaje po nim tekst do pokazania klientowi. */
export const RECEIPT_REVENUE_REFUSAL_PREFIX = 'Raport wstrzymany: faktura do paragonu';

export class ReceiptInvoiceRevenueError extends OutgoingInvoiceCurrencyNotSupportedError {
  constructor(numbers: readonly string[]) {
    super();
    this.name = 'ReceiptInvoiceRevenueError';
    const [first = 'bez numeru'] = numbers;
    const rest = numbers.length > 1 ? ` (i ${numbers.length - 1} kolejne)` : '';
    this.message =
      `${RECEIPT_REVENUE_REFUSAL_PREFIX} ${first}${rest}. ` +
      'Sprzedaż z paragonu weszła już raportem z kasy, więc FaktWay nie liczy sumy przychodu, ' +
      'żeby nie policzyć jej dwa razy. Przychód za ten okres ustal z raportów kasy ' +
      'albo napisz do nas przez Pomoc.';
  }
}

export interface ReceiptRevenueRow {
  /** Numer dokumentu do komunikatu. */
  number: string | null | undefined;
  isReceipt: boolean;
}

/** Wiersz `invoices` z aliasami `RECEIPT_REVENUE_COLUMNS`. */
export function receiptRevenueRow(row: {
  internal_number?: string | null;
  receipt?: unknown;
  ksef_fp?: unknown;
}): ReceiptRevenueRow {
  return { number: row.internal_number, isReceipt: isReceiptInvoiceColumns(row.receipt, row.ksef_fp) };
}

/** Wiersz z eksportu: znaczniki z `fa3_data` (`importedContentFlags` oznacza też FP z FaktWay). */
export function receiptRevenueRowFromMarkers(invoice: {
  invoiceNumber?: string | null;
  ksefMarkers?: unknown;
}): ReceiptRevenueRow {
  return { number: invoice.invoiceNumber, isReceipt: isReceiptInvoiceFa3({ ksefMarkers: invoice.ksefMarkers }) };
}

/** Numery FP z listy (kolejność wejścia). */
export function receiptInvoiceNumbers(rows: readonly ReceiptRevenueRow[]): string[] {
  return rows.filter((r) => r.isReceipt).map((r) => r.number?.trim() || 'bez numeru');
}

/** Rzuca `ReceiptInvoiceRevenueError`, gdy wśród faktur sprzedaży jest FP. */
export function assertNoReceiptInvoicesInRevenue(rows: readonly ReceiptRevenueRow[]): void {
  const numbers = receiptInvoiceNumbers(rows);
  if (numbers.length > 0) throw new ReceiptInvoiceRevenueError(numbers);
}
