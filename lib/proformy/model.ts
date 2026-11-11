/**
 * Proforma i oferta (wycena) (plan kompletnej aplikacji, krok 2.4): typy
 * i reguły wspólne dla bazy (00198), akcji, PDF, maila, ekranów i zamiany
 * w fakturę. Moduł bez importów serwerowych, więc nadaje się i do klienta.
 *
 * Dokument nie jest fakturą: nie trafia do KSeF („Do KSeF nie przesyła się
 * faktur proforma”, ksef.podatki.gov.pl, „Zakres obowiązkowego KSeF”), do
 * KPiR, ewidencji, JPK, raportów ani przypomnień o płatności. Pozycje i kwoty
 * są jak na fakturze: liczą je te same funkcje (`calculateLineItem`,
 * `calculateInvoiceTotals`), a grosze zaokrągla tylko `roundToCents`.
 */
import { vatSummaryByRate, type VatSummaryRow } from '@/lib/invoices/vat-summary';
import type { NoteContractorOption, NoteParty } from '@/lib/noty/model';
import { calculateInvoiceTotals, calculateLineItem } from '@/lib/xml/invoice-calculator';

export const QUOTE_KINDS = ['proforma', 'offer'] as const;
export type QuoteKind = (typeof QUOTE_KINDS)[number];

export const QUOTE_KIND_LABELS: Record<QuoteKind, string> = {
  proforma: 'Proforma',
  offer: 'Oferta',
};

/** Dopełniacz do zdań: „z proformy”, „z oferty”. */
export const QUOTE_KIND_GENITIVE: Record<QuoteKind, string> = {
  proforma: 'proformy',
  offer: 'oferty',
};

/** Biernik do zdań: „wystaw proformę”, „wystaw ofertę”. */
export const QUOTE_KIND_ACCUSATIVE: Record<QuoteKind, string> = {
  proforma: 'proformę',
  offer: 'ofertę',
};

/** Przedrostek serii, ten sam co w CHECK `sales_quotes_issued_check` (00198). */
export const QUOTE_NUMBER_PREFIXES: Record<QuoteKind, string> = {
  proforma: 'PRO',
  offer: 'OF',
};

export type QuoteStatus = 'draft' | 'issued';

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Szkic',
  issued: 'Wystawiona',
};

/** W tej części tylko złote (CHECK `sales_quotes_currency_check`). */
export const QUOTE_CURRENCY = 'PLN';

/** Granice z CHECK-ów 00198; formularz i schemat używają tych samych liczb. */
export const QUOTE_LIMITS = {
  items: 200,
  notes: 2000,
} as const;

/**
 * Stawki jak w formularzu faktury bez „np. II”: kontrahent z bazy
 * kontrahentów to firma z NIP, a „np. II” wymaga firmy z innego kraju UE.
 * Ten sam zestaw sprawdza `sales_quote_items_valid` (00198).
 */
export const QUOTE_VAT_RATES = ['23', '8', '5', '0', 'zw', 'oo', 'np'] as const;
export type QuoteVatRate = (typeof QUOTE_VAT_RATES)[number];

/** Etykiety stawek jak na PDF faktury (`lib/pdf/invoice-renderer.ts`). */
export const QUOTE_VAT_RATE_LABELS: Record<QuoteVatRate, string> = {
  '23': '23%',
  '8': '8%',
  '5': '5%',
  '0': '0%',
  zw: 'zw.',
  oo: 'o.o.',
  np: 'np.',
};

export const QUOTE_PAYMENT_METHODS = ['transfer', 'cash', 'card', 'other'] as const;
export type QuotePaymentMethod = (typeof QUOTE_PAYMENT_METHODS)[number];

export const QUOTE_PAYMENT_METHOD_LABELS: Record<QuotePaymentMethod, string> = {
  transfer: 'Przelew',
  cash: 'Gotówka',
  card: 'Karta',
  other: 'Inna',
};

/**
 * Proformę i ofertę zapisuje, wystawia i wysyła każdy aktywny członek firmy,
 * tak jak fakturę i notę (RLS `invoices` z 00002 i 00037, 00193; pomoc „Role
 * i uprawnienia”: księgowy ma uprawnienia członka). Te same role sprawdzają
 * polityki i funkcje 00198.
 */
export const QUOTE_WRITER_ROLES = ['owner', 'admin', 'member', 'accountant'] as const;

export function canWriteQuotes(role: string | null | undefined): boolean {
  return typeof role === 'string' && (QUOTE_WRITER_ROLES as readonly string[]).includes(role);
}

/** Migawka strony dokumentu: wystawca (z `tenants`) albo kontrahent (z `contractors`), jak przy nocie. */
export type QuoteParty = NoteParty;

/** Kontrahent z bazy firmy do wyboru w formularzu. */
export type QuoteContractorOption = NoteContractorOption;

/** Pozycja z formularza, jak pozycja faktury (`lineItemSchema`). */
export interface QuoteItemInput {
  name: string;
  unit: string;
  quantity: number;
  unitPriceNet: number;
  vatRate: QuoteVatRate;
}

/** Pozycja z kwotami policzonymi funkcją faktury. */
export interface QuoteItem extends QuoteItemInput {
  netAmount: number;
  vatAmount: number;
  grossAmount: number;
}

export interface QuoteTotals {
  netTotal: number;
  vatTotal: number;
  grossTotal: number;
}

export interface SalesQuote extends QuoteTotals {
  id: string;
  tenantId: string;
  kind: QuoteKind;
  status: QuoteStatus;
  /** Numer z bazy po wystawieniu; w szkicu `null`. */
  number: string | null;
  issueDate: string;
  /** Tylko oferta. */
  validUntil: string | null;
  items: QuoteItem[];
  currency: typeof QUOTE_CURRENCY;
  contractorId: string | null;
  counterparty: QuoteParty;
  /** Dane firmy z chwili wystawienia; w szkicu `null` (podgląd bierze dane z profilu firmy). */
  issuer: QuoteParty | null;
  /** Tylko proforma. */
  paymentMethod: QuotePaymentMethod | null;
  paymentDueDate: string | null;
  bankAccount: string | null;
  notes: string | null;
  issuedAt: string | null;
  createdAt: string;
}

/** Wiersz listy dokumentów. */
export interface QuoteListItem {
  id: string;
  kind: QuoteKind;
  status: QuoteStatus;
  number: string | null;
  issueDate: string;
  validUntil: string | null;
  counterpartyName: string;
  grossTotal: number;
}

export interface QuoteEmailRecord {
  id: string;
  recipient: string;
  sentAt: string;
}

/** Faktura utworzona z dokumentu (`invoices.sales_quote_id`, 00198). */
export interface QuoteInvoiceLink {
  invoiceId: string;
  internalNumber: string | null;
  /** `regular` albo `advance` (wyzwalacz `d_guard_invoice_sales_quote_insert`). */
  invoiceKind: string;
  ksefStatus: string | null;
  /** Numer kolejnej zamiany (1 = pierwsza faktura z dokumentu). */
  seq: number;
}

/** Kwoty pozycji tą samą funkcją co na fakturze (`calculateLineItem`, grosze przez `roundToCents`). */
export function quoteItems(inputs: readonly QuoteItemInput[]): QuoteItem[] {
  return inputs.map((input) => ({
    name: input.name,
    unit: input.unit,
    quantity: input.quantity,
    unitPriceNet: input.unitPriceNet,
    vatRate: input.vatRate,
    ...calculateLineItem(input),
  }));
}

/** Sumy dokumentu tą samą funkcją co na fakturze (`calculateInvoiceTotals`). */
export function quoteTotals(items: readonly QuoteItem[]): QuoteTotals {
  return calculateInvoiceTotals(items.map((item, index) => ({ ordinal: index + 1, ...item })));
}

/** Podsumowanie według stawek, jak w podglądzie i PDF faktury (`vatSummaryByRate`). */
export function quoteVatSummary(items: readonly QuoteItem[]): VatSummaryRow[] {
  return (
    vatSummaryByRate(
      items.map((item) => ({
        vat_rate: item.vatRate,
        net_amount: item.netAmount,
        vat_amount: item.vatAmount,
        gross_amount: item.grossAmount,
      })),
    ) ?? []
  );
}

/** Numer w kształcie z bazy (00198): `PRO/1/2026`, `OF/12/2027`. */
export function formatQuoteNumber(kind: QuoteKind, seq: number, year: number): string {
  return `${QUOTE_NUMBER_PREFIXES[kind]}/${seq}/${year}`;
}

export function isQuoteKind(value: unknown): value is QuoteKind {
  return typeof value === 'string' && (QUOTE_KINDS as readonly string[]).includes(value);
}

export function isQuoteVatRate(value: unknown): value is QuoteVatRate {
  return typeof value === 'string' && (QUOTE_VAT_RATES as readonly string[]).includes(value);
}

export function isQuotePaymentMethod(value: unknown): value is QuotePaymentMethod {
  return typeof value === 'string' && (QUOTE_PAYMENT_METHODS as readonly string[]).includes(value);
}

/** Etykieta stawki; nieznany kod drukujemy surowo zamiast pustej komórki. */
export function quoteVatRateLabel(rate: string): string {
  return isQuoteVatRate(rate) ? QUOTE_VAT_RATE_LABELS[rate] : rate;
}
