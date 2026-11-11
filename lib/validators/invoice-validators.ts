// lib/validators/invoice-validators.ts
// Walidatory Zod dla wszystkich typów faktur

import { z } from 'zod';
import { validateNipChecksum, validatePeselChecksum } from '@/lib/xml/invoice-calculator';
import { resolveAmountChangeVatRate } from '@/lib/invoices/correction-amount-change';
import { isForeignEuVat, isNpIiBuyerVat, parseVatUe } from '@/lib/invoices/vat-ue';
import {
  NP_II_CORRECTION_BUYER_MESSAGE,
  NP_II_NOT_FOR_XI_MESSAGE,
  SALES_QUOTE_LINK_MESSAGE,
} from '@/lib/schemas/invoice-form';

// ============================================================================
// Helpers walidacyjne
// ============================================================================

/** NIP po polsku - 10 cyfr + checksum mod11 */
const nipSchema = z
  .string()
  .regex(/^\d{10}$/, 'NIP musi mieć 10 cyfr')
  .refine(validateNipChecksum, 'Niepoprawny NIP - błędna suma kontrolna');

/** PESEL - 11 cyfr + checksum */
const peselSchema = z
  .string()
  .regex(/^\d{11}$/, 'PESEL musi mieć 11 cyfr')
  .refine(validatePeselChecksum, 'Niepoprawny PESEL');

export { validatePeselChecksum } from '@/lib/xml/invoice-calculator';

/** Numer faktury - dozwolone znaki alfanumeryczne + / - . */
const invoiceNumberSchema = z
  .string()
  .min(1, 'Numer faktury jest wymagany')
  .max(50, 'Numer max 50 znaków')
  .regex(/^[A-Za-z0-9/.-]+$/, 'Dozwolone tylko: litery, cyfry, /, -, .');

/** Data ISO YYYY-MM-DD */
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format daty: YYYY-MM-DD')
  .refine((d) => !Number.isNaN(Date.parse(d)), 'Niepoprawna data');

// ============================================================================
// Pozycja faktury
// ============================================================================

export const invoiceLineSchema = z.object({
  name: z.string().min(1, 'Nazwa wymagana').max(512, 'Max 512 znaków'),
  unit: z.string().min(1, 'Jednostka wymagana').max(20),
  quantity: z.number().positive('Ilość musi być dodatnia'),
  unitPriceNet: z.number().min(0, 'Cena nieujemna'),
  /** Bez `zw` — brak pól P_19 (podstawa zwolnienia) w generatorze. */
  vatRate: z.enum(['23', '8', '5', '0', 'oo', 'np']),
  pkwiuCode: z.string().optional(),
  gtuCode: z.string().optional(),
});

export type InvoiceLineSchema = z.infer<typeof invoiceLineSchema>;

// ============================================================================
// Sprzedawca
// ============================================================================

export const sellerSchema = z.object({
  nip: nipSchema,
  name: z.string().min(1).max(512),
  address: z.object({
    addressLine1: z.string().min(1),
    addressLine2: z.string().min(1),
    countryCode: z.string().length(2).default('PL'),
  }),
  email: z.string().email('Niepoprawny email').optional(),
});

// ============================================================================
// Nabywca - B2B
// ============================================================================

export const buyerB2BSchema = z.object({
  type: z.literal('b2b'),
  idType: z.literal('nip'),
  nip: nipSchema,
  name: z.string().min(1).max(512),
  address: z.object({
    addressLine1: z.string().min(1),
    addressLine2: z.string().min(1),
    countryCode: z.string().length(2),
  }),
  email: z.string().email().optional(),
});

// ============================================================================
// Nabywca - B2C
// ============================================================================

export const buyerB2CSchema = z
  .object({
    type: z.literal('b2c'),
    idType: z.enum(['pesel', 'id_card', 'passport', 'no_id']),
    pesel: peselSchema.optional(),
    idNumber: z.string().min(3).max(20).optional(),
    name: z.string().min(1).max(512),
    address: z.object({
      addressLine1: z.string().min(1),
      addressLine2: z.string().min(1),
      countryCode: z.string().length(2),
    }),
    email: z.string().email().optional(),
  })
  .refine(
    (data) => {
      if (data.idType === 'pesel') return !!data.pesel;
      if (data.idType === 'id_card' || data.idType === 'passport') {
        return !!data.idNumber;
      }
      return true;
    },
    {
      message: 'Wymagany identyfikator dla wybranego typu',
      path: ['pesel'],
    }
  );

export const buyerSchema = z.discriminatedUnion('type', [buyerB2BSchema, buyerB2CSchema]);

// ============================================================================
// Nabywca z UE (VAT-UE) — tylko korekta zwykłej faktury (AUD-70)
// ============================================================================

export const buyerEUSchema = z.object({
  type: z.literal('eu'),
  vatUeNumber: z
    .string()
    .refine((v) => isForeignEuVat(v), 'Numer VAT-UE firmy z innego kraju UE, np. DE123456789 (Grecja: EL)'),
  name: z.string().min(1).max(512),
  address: z.object({
    addressLine1: z.string().min(1),
    addressLine2: z.string().optional(),
    countryCode: z
      .string()
      .length(2)
      .refine((c) => c !== 'PL', 'Kraj adresu firmy z UE nie może być Polską'),
  }),
  email: z.string().email().optional(),
});

/** Nabywca korekty: jak na fakturze pierwotnej — z NIP, osoba prywatna albo firma z UE. */
export const correctionBuyerSchema = z.discriminatedUnion('type', [
  buyerB2BSchema,
  buyerB2CSchema,
  buyerEUSchema,
]);

/** Pozycja korekty — jak `invoiceLineSchema`, plus `np_ii` (korekta faktury dla firmy z UE). */
export const correctionLineSchema = invoiceLineSchema.extend({
  vatRate: z.enum(['23', '8', '5', '0', 'oo', 'np', 'np_ii']),
});
export type CorrectionLineSchema = z.infer<typeof correctionLineSchema>;

/** Dane korekty, od których zależy „np. II” — pasuje też `CorrectionInvoiceData` (generator KOR). */
export interface CorrectionNpIiInput {
  buyer: { type: string; vatUeNumber?: string };
  /** Bez typu stawka `amountChange` liczy się zawsze; z typem — tylko w korekcie kwotowej. */
  correctionType?: string;
  linesBefore?: ReadonlyArray<{ vatRate: string }>;
  linesAfter?: ReadonlyArray<{ vatRate: string }>;
  amountChange?: { vatRate?: string };
}

/**
 * Reguła „np. II” w korekcie (AUD-70): stawka z art. 100 ust. 1 pkt 4 tylko dla
 * nabywcy — podatnika z INNEGO państwa UE (`isNpIiBuyerVat`: bez PL i bez XI).
 * Obejmuje pozycje przed i po korekcie oraz stawkę korekty kwotowej. Komunikat
 * albo `null` — wspólne dla schematu (formularz, akcja) i generatora KOR.
 */
export function correctionNpIiBuyerError(data: CorrectionNpIiInput): string | null {
  const hasNpIi =
    [...(data.linesBefore ?? []), ...(data.linesAfter ?? [])].some((l) => l.vatRate === 'np_ii') ||
    ((data.correctionType === undefined || data.correctionType === 'amount_change') &&
      data.amountChange?.vatRate === 'np_ii');
  if (!hasNpIi) return null;
  const vatUe = data.buyer.type === 'eu' ? data.buyer.vatUeNumber : undefined;
  if (isNpIiBuyerVat(vatUe)) return null;
  return parseVatUe(vatUe)?.kodUE === 'XI' ? NP_II_NOT_FOR_XI_MESSAGE : NP_II_CORRECTION_BUYER_MESSAGE;
}

// ============================================================================
// Faktura ZWYKŁA
// ============================================================================

export const regularInvoiceSchema = z
  .object({
    invoiceType: z.literal('regular'),
    internalNumber: invoiceNumberSchema,
    issueDate: dateSchema,
    paymentMethod: z.enum(['transfer', 'card', 'cash', 'compensation', 'other']),
    paymentDueDate: dateSchema,
    bankAccount: z.string().regex(/^\d{26}$/, 'Numer konta = 26 cyfr').optional(),
    notes: z.string().max(2000).optional(),

    seller: sellerSchema,
    buyer: buyerSchema,
    lines: z.array(invoiceLineSchema).min(1, 'Min. 1 pozycja').max(100, 'Max 100 pozycji'),
  })
  .refine((data) => new Date(data.paymentDueDate) >= new Date(data.issueDate), {
    message: 'Termin płatności nie może być przed datą wystawienia',
    path: ['paymentDueDate'],
  });

// ============================================================================
// Faktura KORYGUJĄCA
// ============================================================================

export const correctionInvoiceSchema = z
  .object({
    invoiceType: z.literal('correction'),
    internalNumber: invoiceNumberSchema,
    issueDate: dateSchema,
    paymentMethod: z.enum(['transfer', 'card', 'cash', 'compensation', 'other']),
    paymentDueDate: dateSchema,
    bankAccount: z
      .union([z.literal(''), z.string().regex(/^[0-9]{26}$/)])
      .optional(),
    notes: z.string().max(2000).optional(),

    parentInvoiceId: z.string().uuid('Wybierz fakturę pierwotną'),
    parentInvoiceNumber: z.string().min(1),
    parentInvoiceIssueDate: dateSchema,
    parentKsefNumber: z.string().optional(),

    correctionType: z.enum(['before_after', 'amount_change', 'cancellation']),
    correctionReason: z.string().min(5, 'Wymagane uzasadnienie min. 5 znaków').max(500),

    /** MF `TTypKorekty`: 1 skutek okres pierwotny / 2 skutek data korekty / 3 inna. */
    typKorekty: z.enum(['1', '2', '3']).default('2'),

    seller: sellerSchema,
    buyer: correctionBuyerSchema,

    linesBefore: z.array(correctionLineSchema).optional(),
    linesAfter: z.array(correctionLineSchema).optional(),

    amountChange: z
      .object({
        netDelta: z.number(),
        vatDelta: z.number(),
        grossDelta: z.number(),
        description: z.string().min(1).max(500),
        /** Stawka bez VAT z faktury pierwotnej (np I / np II / oo) — nie wynika z kwot. */
        vatRate: z.enum(['np', 'np_ii', 'oo']).optional(),
      })
      .optional(),
  })
  .refine(
    (data) => {
      if (data.correctionType === 'before_after') {
        return !!(data.linesBefore?.length && data.linesAfter?.length);
      }
      if (data.correctionType === 'amount_change') {
        return !!data.amountChange;
      }
      return true;
    },
    {
      message: 'Wypełnij dane korekty zgodnie z wybranym typem',
    }
  )
  .refine((data) => {
    if (data.correctionType !== 'amount_change' || !data.amountChange) return true;
    try {
      resolveAmountChangeVatRate(data.amountChange);
      return true;
    } catch {
      return false;
    }
  }, {
    message: 'Kwoty korekty muszą mieć jedną obsługiwaną stawkę VAT i brutto równe netto plus VAT',
    path: ['amountChange'],
  })
  // AUD-70: np. II tylko dla firmy z innego kraju UE (bez XI) — błąd przy polu
  // ze stawką np. II, żeby formularz pokazał go przy właściwej sekcji.
  .superRefine((data, ctx) => {
    const message = correctionNpIiBuyerError(data);
    if (!message) return;
    const fields: Array<'linesBefore' | 'linesAfter' | 'amountChange'> = [];
    if (data.linesBefore?.some((l) => l.vatRate === 'np_ii')) fields.push('linesBefore');
    if (data.linesAfter?.some((l) => l.vatRate === 'np_ii')) fields.push('linesAfter');
    if (data.correctionType === 'amount_change' && data.amountChange?.vatRate === 'np_ii') fields.push('amountChange');
    for (const field of fields) ctx.addIssue({ code: 'custom', message, path: [field] });
  })
  .refine((data) => new Date(data.paymentDueDate) >= new Date(data.issueDate), {
    message: 'Termin płatności nie może być przed datą wystawienia',
    path: ['paymentDueDate'],
  });

// ============================================================================
// Faktura ZALICZKOWA
// ============================================================================

export const advanceInvoiceSchema = z
  .object({
    invoiceType: z.literal('advance'),
    internalNumber: invoiceNumberSchema,
    issueDate: dateSchema,
    paymentMethod: z.enum(['transfer', 'card', 'cash', 'compensation', 'other']),
    paymentDueDate: dateSchema,
    bankAccount: z
      .union([z.literal(''), z.string().regex(/^\d{26}$/, 'Numer konta = 26 cyfr')])
      .optional(),
    /** The user must answer explicitly; no default to "MPP does not apply". */
    splitPayment: z.boolean({ message: 'Wybierz, czy do zaliczki stosuje się MPP' }),
    notes: z.string().max(2000).optional(),

    seller: sellerSchema,
    buyer: buyerSchema,

    advanceAmount: z.number().positive('Zaliczka > 0'),
    totalContractAmount: z.number().positive('Wartość umowy > 0'),
    expectedDeliveryDate: dateSchema.optional(),
    vatRate: z.enum(['23', '8', '5', '0']),
    description: z.string().min(5).max(1000),
    /**
     * Proforma albo oferta (krok 2.4, 00198), z której otwarto formularz
     * (`?proforma=<id>`): ukryte pola, oba razem albo żadne. Brak = zwykła zaliczka.
     */
    salesQuoteId: z.string().uuid(SALES_QUOTE_LINK_MESSAGE).optional(),
    salesQuoteSeq: z.string().regex(/^[1-9]\d{0,3}$/, SALES_QUOTE_LINK_MESSAGE).optional(),
  })
  .refine((data) => !data.salesQuoteId === !data.salesQuoteSeq, {
    message: SALES_QUOTE_LINK_MESSAGE,
    path: ['salesQuoteId'],
  })
  .refine((data) => data.advanceAmount <= data.totalContractAmount, {
    message: 'Zaliczka nie może być większa niż wartość umowy',
    path: ['advanceAmount'],
  })
  .refine((data) => !data.splitPayment ||
    (data.paymentMethod === 'transfer' && !!data.bankAccount?.trim()), {
    message: 'MPP wymaga przelewu i numeru rachunku',
    path: ['splitPayment'],
  })
  .refine((data) => new Date(data.paymentDueDate) >= new Date(data.issueDate), {
    message: 'Termin płatności nie może być przed datą wystawienia',
    path: ['paymentDueDate'],
  });

// ============================================================================
// Faktura FINALNA
// ============================================================================

export const finalInvoiceSchema = z
  .object({
    invoiceType: z.literal('final'),
    internalNumber: invoiceNumberSchema,
    issueDate: dateSchema,
    paymentMethod: z.enum(['transfer', 'card', 'cash', 'compensation', 'other']),
    paymentDueDate: dateSchema,
    bankAccount: z
      .union([z.literal(''), z.string().regex(/^\d{26}$/, 'Numer konta = 26 cyfr')])
      .optional(),
    /** The user must answer explicitly; no default to "MPP does not apply". */
    splitPayment: z.boolean({ message: 'Wybierz, czy do faktury stosuje się MPP' }),
    notes: z.string().max(2000).optional(),

    seller: sellerSchema,
    buyer: buyerSchema,

    advanceInvoiceIds: z.array(z.string().uuid()).min(1, 'Wybierz min. 1 zaliczkę'),
    totalAdvances: z.number().nonnegative(),
    lines: z.array(invoiceLineSchema).min(1).max(100),
  })
  .refine((data) => !data.splitPayment ||
    (data.paymentMethod === 'transfer' && !!data.bankAccount?.trim()), {
    message: 'MPP wymaga przelewu i numeru rachunku',
    path: ['splitPayment'],
  })
  .refine((data) => new Date(data.paymentDueDate) >= new Date(data.issueDate), {
    message: 'Termin płatności nie może być przed datą wystawienia',
    path: ['paymentDueDate'],
  });

// ============================================================================
// DISCRIMINATED UNION - cały formularz
// ============================================================================

export const invoiceFormSchema = z.discriminatedUnion('invoiceType', [
  regularInvoiceSchema,
  correctionInvoiceSchema,
  advanceInvoiceSchema,
  finalInvoiceSchema,
]);

export type InvoiceFormSchemaType = z.infer<typeof invoiceFormSchema>;

export type CorrectionInvoiceSchemaIn = z.infer<typeof correctionInvoiceSchema>;
export type AdvanceInvoiceSchemaIn = z.infer<typeof advanceInvoiceSchema>;
export type FinalInvoiceSchemaIn = z.infer<typeof finalInvoiceSchema>;
