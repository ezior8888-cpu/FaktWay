/**
 * Faktura zakupu z KSeF bez wydatku jako koszt kart (PLAN-PRAWDZIWE-DANE E10,
 * decyzja Bartosza D-K) — znaczniki i link dokumentu. Moduł bez importów
 * runtime, więc czyste agregaty (`cash-movements`, `analytics-finance`)
 * biorą go bez odczytów bazy; loader to `getCostsWithKsefPurchases`
 * (`lib/dashboard/costs.ts`, tam też re-eksport).
 */

/** `CostEntry.source` faktury zakupu z KSeF, do której nie ma wydatku. */
export const KSEF_INVOICE_COST_SOURCE = 'ksef_invoice';

/**
 * Kategoria takiej faktury. Kategorię nadaje dopiero wydatek (Skrzynka,
 * kategoryzacja), a archiwum z historii KSeF wydatków nie tworzy.
 */
export const KSEF_INVOICE_CATEGORY = 'Faktury z KSeF';

/** Czy koszt to faktura zakupu z KSeF bez wydatku (a nie wydatek). */
export function isKsefInvoiceCost(entry: { source: string }): boolean {
  return entry.source === KSEF_INVOICE_COST_SOURCE;
}

/** Dokument kosztu do otwarcia: faktura zakupu z KSeF albo wydatek. */
export function costHref(entry: { id: string; source: string }): string {
  return isKsefInvoiceCost(entry) ? `/invoices/${entry.id}` : `/expenses/${entry.id}`;
}
