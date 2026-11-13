import { z } from 'zod';

import type { FakturaTelefonu } from '@/lib/api/mobile/kontrakt';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

/**
 * Schematy Zod treści żądań API aplikacji na telefon (plan aplikacji 4.1,
 * rozstrzygnięcie M8). Osobny plik obok kontraktu, bo kontrakt czyta też
 * aplikacja i nie może mieć importów.
 *
 * Tu tylko kształt (pola, typy, nic ponad kontrakt): treść spoza kontraktu to
 * błąd programu w telefonie (400 `invalid_request`). Zasady faktury sprawdza
 * potem ten sam schemat formularza co strona (`invoiceFormSchema` przez
 * `parseRegularInvoiceForm`), z błędem dla klienta i polem (422
 * `invoice_invalid`). Typy wyjścia są równe typom kontraktu (test
 * `tests/unit/mobile-api-faktury.test.ts`).
 */

/** Najwięcej pozycji na fakturze z telefonu (jak publiczne API, `MAX_INVOICE_ITEMS`). */
export const MAX_POZYCJI_TELEFONU = 1000;

export const STAWKI_VAT_TELEFONU = ['23', '8', '5', '0', 'zw', 'oo', 'np'] as const;

export const pozycjaTelefonuSchema = z.strictObject({
  name: z.string(),
  unit: z.string(),
  quantity: z.number(),
  unitPriceNet: z.number(),
  vatRate: z.enum(STAWKI_VAT_TELEFONU),
});

export const fakturaTelefonuSchema = z.strictObject({
  internalNumber: z.string(),
  issueDate: z.string(),
  saleDate: z.string(),
  buyerNip: z.string(),
  buyerName: z.string(),
  buyerAddressLine1: z.string(),
  buyerAddressLine2: z.string(),
  buyerEmail: z.string(),
  buyerIsConsumer: z.boolean(),
  lines: z.array(pozycjaTelefonuSchema).max(MAX_POZYCJI_TELEFONU),
  paymentMethod: z.enum(['transfer', 'cash', 'card', 'other']),
  paymentDueDate: z.string(),
  bankAccount: z.string(),
  notes: z.string(),
  splitPayment: z.boolean(),
});

export const wystawienieSchema = z.strictObject({
  wyslij: z.boolean(),
  faktura: fakturaTelefonuSchema,
});

/**
 * Wartości formularza strony z faktury telefonu. Osoba prywatna bez numeru
 * identyfikacyjnego jak w publicznym API (`toFormValues` w
 * `lib/api/v1/invoice-create.ts`): telefon nie zbiera PESEL ani dokumentu.
 */
export function doWartosciFormularza(f: FakturaTelefonu): InvoiceFormValues {
  return {
    internalNumber: f.internalNumber,
    issueDate: f.issueDate,
    saleDate: f.saleDate,
    buyerNip: f.buyerIsConsumer ? '' : f.buyerNip,
    buyerName: f.buyerName,
    buyerAddressLine1: f.buyerAddressLine1,
    buyerAddressLine2: f.buyerAddressLine2,
    buyerEmail: f.buyerEmail,
    buyerIsConsumer: f.buyerIsConsumer,
    buyerConsumerIdType: f.buyerIsConsumer ? 'no_id' : undefined,
    buyerPesel: '',
    buyerIdDocument: '',
    buyerIsEu: false,
    lines: f.lines.map((l) => ({ name: l.name, unit: l.unit, quantity: l.quantity, unitPriceNet: l.unitPriceNet, vatRate: l.vatRate })),
    paymentMethod: f.paymentMethod,
    paymentDueDate: f.paymentDueDate,
    bankAccount: f.bankAccount,
    notes: f.notes,
    splitPayment: f.splitPayment,
  };
}

/** Ścieżka pola z błędu schematu formularza: `buyerName`, `lines.0.name`. */
export function sciezkaPola(path: ReadonlyArray<PropertyKey>): string | undefined {
  return path.length > 0 ? path.map(String).join('.') : undefined;
}
