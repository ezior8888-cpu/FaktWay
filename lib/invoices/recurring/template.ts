/**
 * Kiedy faktura może być wzorem faktury cyklicznej (plan Finora N1).
 *
 * Tylko zwykła faktura VAT sprzedaży, wystawiona w FaktWay (nie import),
 * przyjęta przez KSeF, w złotych. Korekta, zaliczka i faktura końcowa mają
 * treść zależną od innego dokumentu, import nie ma pewnych pozycji, a szkic
 * mógł nigdy nie przejść walidacji KSeF.
 *
 * Te same warunki stosuje akcja tworzenia (`templateRejection`) i lista
 * kandydatów do wyboru (`TEMPLATE_FILTERS` w `queries.ts`).
 */

/** Filtry 1:1 z warunkami wzoru — do zapytania PostgREST (`.eq(kolumna, wartość)`). */
export const TEMPLATE_FILTERS = {
  direction: 'outgoing',
  origin: 'app',
  invoice_kind: 'regular',
  invoice_type: 'VAT',
  ksef_status: 'accepted',
  currency: 'PLN',
} as const;

export interface TemplateCandidateFields {
  direction: string;
  origin: string;
  invoice_kind: string;
  invoice_type: string | null;
  ksef_status: string | null;
  currency: string | null;
}

/** Polski komunikat, dlaczego faktura nie może być wzorem, albo `null`, gdy może. */
export function templateRejection(invoice: TemplateCandidateFields): string | null {
  if (invoice.direction !== TEMPLATE_FILTERS.direction) {
    return 'Wzorem może być tylko faktura sprzedaży, nie faktura kosztowa.';
  }
  if (invoice.origin !== TEMPLATE_FILTERS.origin) {
    return 'Wzorem może być tylko faktura wystawiona w FaktWay — nie faktura z importu.';
  }
  if (invoice.invoice_kind !== TEMPLATE_FILTERS.invoice_kind || invoice.invoice_type !== TEMPLATE_FILTERS.invoice_type) {
    return 'Wzorem może być tylko zwykła faktura VAT — nie korekta, zaliczka ani faktura końcowa.';
  }
  if (invoice.ksef_status !== TEMPLATE_FILTERS.ksef_status) {
    return 'Wzorem może być tylko faktura przyjęta przez KSeF. Poczekaj na przyjęcie albo wybierz inną fakturę.';
  }
  if (invoice.currency !== TEMPLATE_FILTERS.currency) {
    return 'Wzorem może być tylko faktura w złotych (PLN).';
  }
  return null;
}
