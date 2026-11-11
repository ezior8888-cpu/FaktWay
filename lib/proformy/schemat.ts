import { z } from 'zod';

import {
  isQuotePaymentMethod,
  isQuoteVatRate,
  QUOTE_CURRENCY,
  QUOTE_KINDS,
  QUOTE_LIMITS,
  quoteItems,
  quoteTotals,
  type QuoteItemInput,
  type QuotePaymentMethod,
  type QuoteVatRate,
  type SalesQuote,
} from '@/lib/proformy/model';
import { lineItemSchema, MAX_INVOICE_AMOUNT } from '@/lib/schemas/invoice-form';
import { normalizeIban, parseIsoDate, validateIban } from '@/lib/xml/invoice-calculator';

/**
 * Szkic proformy albo oferty (krok 2.4): jeden schemat dla formularza i akcji
 * zapisu (AGENTS.md: walidacja klient + serwer). Pozycje sprawdza schemat
 * pozycji faktury (`lineItemSchema`: nazwa, jednostka, ilość i cena do
 * 4 miejsc), więc pozycja, która przejdzie tu, przejdzie formularz faktury
 * po zamianie. Granice jak w CHECK-ach 00198, więc szkic, który przejdzie
 * schemat, przejdzie bazę. Wynik schematu przechodzi schemat drugi raz bez
 * zmian: formularz oddaje akcji wynik walidacji, a akcja sprawdza go znowu.
 */

export const QUOTE_CURRENCY_ERROR = 'Proformę i ofertę można na razie wystawić tylko w złotych (PLN).';

export const QUOTE_NP_II_ERROR =
  'Stawka np. II wymaga nabywcy z innego kraju UE, a proforma i oferta biorą kontrahenta z bazy firmy (firma z NIP). Wybierz inną stawkę.';

const itemSchema = lineItemSchema.superRefine((item, ctx) => {
  if (!item.name.trim()) ctx.addIssue({ code: 'custom', path: ['name'], message: 'Nazwa wymagana' });
  if (!item.unit.trim()) ctx.addIssue({ code: 'custom', path: ['unit'], message: 'Podaj jednostkę' });
  if (!isQuoteVatRate(item.vatRate)) ctx.addIssue({ code: 'custom', path: ['vatRate'], message: QUOTE_NP_II_ERROR });
});

/** Pole opcjonalne: pusty tekst albo brak to null; reszta po sprawdzeniu. */
function optionalText(check: (value: string) => string | null, map: (value: string) => string = (v) => v) {
  return z
    .string()
    .nullish()
    .transform((raw, ctx) => {
      const value = (raw ?? '').trim();
      if (!value) return null;
      const problem = check(value);
      if (problem) {
        ctx.addIssue({ code: 'custom', message: problem });
        return z.NEVER;
      }
      return map(value);
    });
}

/**
 * Pola jednego rodzaju (ważność oferty, płatność proformy) sprawdzamy dopiero
 * w `transform`, gdy wiadomo, jaki to dokument: formularz chowa pola drugiego
 * rodzaju, więc ich błąd blokowałby zapis komunikatem, którego nie widać.
 */
const kindField = z.string().nullish().transform((raw) => (raw ?? '').trim() || null);

export const quoteDraftSchema = z
  .object({
    kind: z.enum(QUOTE_KINDS, { message: 'Wybierz rodzaj dokumentu: proforma albo oferta.' }),
    contractorId: z
      .string({ message: 'Wybierz kontrahenta z bazy kontrahentów.' })
      .uuid('Wybierz kontrahenta z bazy kontrahentów.'),
    issueDate: z
      .string({ message: 'Podaj poprawną datę wystawienia.' })
      .refine((value) => parseIsoDate(value) !== null, { message: 'Podaj poprawną datę wystawienia.' }),
    validUntil: kindField,
    items: z
      .array(itemSchema, { message: 'Dodaj co najmniej jedną pozycję.' })
      .min(1, 'Dodaj co najmniej jedną pozycję.')
      .max(QUOTE_LIMITS.items, `Dokument może mieć najwyżej ${QUOTE_LIMITS.items} pozycji.`),
    currency: z.string({ message: QUOTE_CURRENCY_ERROR }).transform((value, ctx) => {
      if (value.trim().toUpperCase() !== QUOTE_CURRENCY) {
        ctx.addIssue({ code: 'custom', message: QUOTE_CURRENCY_ERROR });
        return z.NEVER;
      }
      return QUOTE_CURRENCY;
    }),
    paymentMethod: z.string().nullish(),
    paymentDueDate: kindField,
    bankAccount: kindField,
    notes: optionalText((value) =>
      value.length > QUOTE_LIMITS.notes ? `Uwagi mogą mieć najwyżej ${QUOTE_LIMITS.notes} znaków.` : null,
    ),
  })
  .transform((data, ctx) => {
    const fail = (path: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [path], message });
      return z.NEVER;
    };
    const offer = data.kind === 'offer';
    let validUntil: string | null = null;
    let paymentMethod: QuotePaymentMethod | null = null;
    let paymentDueDate: string | null = null;
    let bankAccount: string | null = null;
    if (offer) {
      validUntil = data.validUntil;
      if (!validUntil) return fail('validUntil', 'Podaj, do kiedy oferta jest ważna.');
      if (!parseIsoDate(validUntil)) return fail('validUntil', 'Podaj poprawną datę ważności oferty.');
      if (validUntil < data.issueDate) {
        return fail('validUntil', 'Data ważności oferty nie może być wcześniejsza niż data wystawienia.');
      }
    } else {
      if (!isQuotePaymentMethod(data.paymentMethod)) return fail('paymentMethod', 'Wybierz sposób zapłaty.');
      paymentMethod = data.paymentMethod;
      paymentDueDate = data.paymentDueDate;
      if (paymentDueDate && !parseIsoDate(paymentDueDate)) return fail('paymentDueDate', 'Podaj poprawny termin zapłaty.');
      if (paymentDueDate && paymentDueDate < data.issueDate) {
        return fail('paymentDueDate', 'Termin zapłaty nie może być wcześniejszy niż data wystawienia.');
      }
      bankAccount = data.bankAccount ? normalizeIban(data.bankAccount) : null;
      if (bankAccount && !validateIban(bankAccount)) {
        return fail('bankAccount', 'Numer rachunku jest niepoprawny. Wpisz 26 cyfr rachunku albo pełny numer IBAN.');
      }
      // Ta sama reguła co CHECK `sales_quotes_transfer_account_check` (i formularz faktury).
      if (paymentMethod === 'transfer' && !bankAccount) {
        return fail('bankAccount', 'Przy przelewie podaj numer rachunku do wpłaty.');
      }
    }

    const items: QuoteItemInput[] = data.items.map((item) => ({
      name: item.name.trim(),
      unit: item.unit.trim(),
      quantity: item.quantity,
      unitPriceNet: item.unitPriceNet,
      vatRate: item.vatRate as QuoteVatRate,
    }));
    // Granica kwot faktury (NUMERIC(12,2) w `invoices` i w 00198): dokument, którego
    // faktura nie zmieściłaby się w bazie, nie powstaje.
    if (quoteTotals(quoteItems(items)).grossTotal > MAX_INVOICE_AMOUNT) {
      return fail('items', 'Kwota dokumentu przekracza 10 mld zł. Podziel ją na kilka dokumentów.');
    }

    return {
      kind: data.kind,
      contractorId: data.contractorId,
      issueDate: data.issueDate,
      validUntil,
      items,
      currency: data.currency,
      paymentMethod,
      paymentDueDate,
      bankAccount,
      notes: data.notes,
    };
  });

/** Wartości formularza. */
export type QuoteDraftInput = z.input<typeof quoteDraftSchema>;
/** Szkic po walidacji (puste pola jako null, pola płatności tylko przy proformie). */
export type QuoteDraft = z.output<typeof quoteDraftSchema>;

/** Szkic z bazy jako wartości formularza. */
export function quoteToDraftInput(quote: SalesQuote): QuoteDraftInput {
  return {
    kind: quote.kind,
    contractorId: quote.contractorId ?? '',
    issueDate: quote.issueDate,
    validUntil: quote.validUntil ?? '',
    items: quote.items.map((item) => ({
      name: item.name,
      unit: item.unit,
      quantity: item.quantity,
      unitPriceNet: item.unitPriceNet,
      vatRate: item.vatRate,
    })),
    currency: quote.currency,
    paymentMethod: quote.paymentMethod ?? 'transfer',
    paymentDueDate: quote.paymentDueDate ?? '',
    bankAccount: quote.bankAccount ?? '',
    notes: quote.notes ?? '',
  };
}

/** Data wystawienia z przyszłości: odmowa (ten sam warunek sprawdza RPC wystawienia). */
export function quoteIssueDateError(issueDate: string, today: string): string | null {
  return issueDate > today ? 'Data wystawienia nie może być z przyszłości.' : null;
}
