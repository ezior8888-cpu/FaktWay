import { z } from 'zod';
import {
  calculateInvoiceTotals,
  calculateLineItem,
  issueDateRangeErrors,
  validateIban,
  validateNipChecksum,
  validatePeselChecksum,
} from '@/lib/xml/invoice-calculator';
import {
  DB_TEXT_LIMITS,
  FA3_TEXT_LIMITS,
  isXmlSafe,
  liczbaZnakow,
  NO_CONTROL_CHARS_MESSAGE,
  notXsdBlank,
  xsdLength,
} from '@/lib/xml/fa3-limits';

import {
  normalizeCashRegisterNumber,
  receiptInvoiceIssues,
  type ReceiptBuyerKind,
  type ReceiptRuleField,
} from '@/lib/invoices/receipt-invoice';
import { isSaleDateWithinLimit, SALE_DATE_TOO_LATE_MESSAGE } from '@/lib/invoices/sale-date';
import { addressCountryForKodUE, parseVatUe, type KodUE, isNpIiBuyerVat } from '@/lib/invoices/vat-ue';
import { numberingFormFields } from '@/lib/numeracja/pola';
import type { ReceiptInvoiceData } from '@/types/invoice';

/**
 * Kraje adresu nabywcy z UE (AUD-70) — polskie nazwy do formularza.
 *
 * Klucze to prefiksy VAT-UE (`KodUE`) bez Polski, więc typ pilnuje, żeby
 * żadnego państwa z listy XSD nie zabrakło. Kod adresu bierzemy przez
 * `addressCountryForKodUE` — Grecja ma w numerze VAT `EL`, a w adresie `GR`.
 */
const NAZWY_KRAJOW_UE: Record<Exclude<KodUE, 'PL'>, string> = {
  AT: 'Austria',
  BE: 'Belgia',
  BG: 'Bułgaria',
  CY: 'Cypr',
  CZ: 'Czechy',
  DK: 'Dania',
  EE: 'Estonia',
  FI: 'Finlandia',
  FR: 'Francja',
  DE: 'Niemcy',
  EL: 'Grecja',
  HR: 'Chorwacja',
  HU: 'Węgry',
  IE: 'Irlandia',
  IT: 'Włochy',
  LV: 'Łotwa',
  LT: 'Litwa',
  LU: 'Luksemburg',
  MT: 'Malta',
  NL: 'Holandia',
  PT: 'Portugalia',
  RO: 'Rumunia',
  SK: 'Słowacja',
  SI: 'Słowenia',
  ES: 'Hiszpania',
  SE: 'Szwecja',
  XI: 'Irlandia Północna',
};

export const EU_BUYER_COUNTRIES: ReadonlyArray<{ code: string; name: string }> = (
  Object.entries(NAZWY_KRAJOW_UE) as Array<[Exclude<KodUE, 'PL'>, string]>
)
  .map(([kod, name]) => ({ code: addressCountryForKodUE(kod), name }))
  .sort((a, b) => a.name.localeCompare(b.name, 'pl'));

const EU_BUYER_COUNTRY_CODES: ReadonlySet<string> = new Set(EU_BUYER_COUNTRIES.map((k) => k.code));

/** Stawka „np. II” (art. 100 ust. 1 pkt 4) bez nabywcy z innego państwa UE. */
export const NP_II_REQUIRES_EU_BUYER_MESSAGE =
  'Stawka np. II tylko dla usługi dla firmy z innego kraju UE z numerem VAT-UE — wybierz nabywcę „Firma z UE (VAT-UE)”';

/**
 * „np. II” w korekcie, gdy nabywca faktury pierwotnej nie jest firmą z innego
 * kraju UE — nabywcy korekty nie zmienia się, więc bez wskazówki „wybierz nabywcę”.
 */
export const NP_II_CORRECTION_BUYER_MESSAGE =
  'Stawka np. II tylko dla usługi dla firmy z innego kraju UE z numerem VAT-UE — nabywca faktury pierwotnej go nie ma; wybierz inną stawkę';

/** Irlandia Płn. ma numer VAT-UE tylko dla towarów — usługa nie jest np. II. */
export const NP_II_NOT_FOR_XI_MESSAGE =
  'Stawka np. II nie dotyczy firm z Irlandii Północnej (XI) — ich numer VAT-UE obejmuje tylko towary; dla usługi wybierz np. (poza krajem)';

// UWAGA: typ VatRate w types/invoice.ts nie zawiera '3' (stawka ryczałtu
// rolnika ryczałtowego). Trzymamy się tego samego zestawu, żeby
// calculateLineItem/getVatPercentage nie traciły type-safety. '3' da się
// dodać jednym punktem w types/invoice.ts + mapping w invoice-calculator.
/**
 * `zw` — sprzedaż zwolniona. FA(3) wymaga wtedy P_19A (podstawy prawnej),
 * którą faktura bierze z ustawień firmy (`tenants.vat_exemption_basis`).
 */
export const vatRateEnum = z.enum(['23', '8', '5', '0', 'zw', 'oo', 'np', 'np_ii']);

export const buyerConsumerIdTypeEnum = z.enum([
  'pesel',
  'id_card',
  'passport',
  'no_id',
]);

const consumerIdChoices = buyerConsumerIdTypeEnum.enum;

// UWAGA: quantity/unitPriceNet to `z.number()` (nie `z.coerce.number()`).
// RHF zadba o konwersję string→number przez `{ valueAsNumber: true }`.
// Puste pole number → `NaN`; `z.number()` w Zod odrzuca NaN — wtedy
// walidacja się nie udaje — MUSIMY pokazać toast w `handleSubmit` onInvalid

/**
 * Granice, których nie przyjmie XSD FA(3) albo baza (F-041). Bez nich
 * faktura przechodziła formularz, a padała dopiero po zapisie — w XSD
 * przy wysyłce albo surowym błędem Postgresa. Liczby i znaki niedozwolone
 * w XML 1.0 (np. pionowy tabulator wklejony z Worda) bierzemy z modułu
 * granic (C1), tego samego, którego pilnują walidatory i generatory.
 */
const xmlSafe = isXmlSafe;
/** „Maksymalnie 512 znaków”. */
const maxMessage = (max: number) => `Maksymalnie ${liczbaZnakow(max)}`;
// Ten sam komunikat dla pustego pola i samych spacji (XSD liczy je jak puste).
const ADDRESS_LINE_1_REQUIRED = 'Adres — linia 1 wymagana';
const ADDRESS_LINE_2_REQUIRED = 'Adres — linia 2 wymagana';
/** `quantity`, `unit_price_net` to NUMERIC(14,4): najwyżej 4 miejsca po przecinku. */
const hasAtMostDecimals = (v: number, d: number) => {
  const scaled = v * 10 ** d;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
};
/** Kwoty faktury i pozycji to NUMERIC(12,2) — poniżej 10 mld zł. */
/** Format okresu faktury cyklicznej — ten sam co CHECK `invoices_recurring_period_format_check` (00154). */
const RECURRING_PERIOD_FORMAT = /^[0-9]{4}(-(0[1-9]|1[0-2])|-Q[1-4])?$/;
export const RECURRING_PERIOD_MISSING_MESSAGE =
  'Brakuje okresu faktury cyklicznej — otwórz „Wystaw teraz” ponownie.';

/** Powiązanie z proformą albo ofertą (krok 2.4) niekompletne albo uszkodzone w formularzu. */
export const SALES_QUOTE_LINK_MESSAGE =
  'Brakuje danych proformy albo oferty, z której otwarto formularz. Otwórz dokument i wybierz zamianę w fakturę jeszcze raz.';

export const MAX_INVOICE_AMOUNT = 9_999_999_999.99;
const VAT_FACTOR: Record<string, number> = { '23': 1.23, '8': 1.08, '5': 1.05 };

/** Pole formularza, przy którym pokazujemy błąd reguły faktury do paragonu. */
const RECEIPT_FIELD_PATH: Record<ReceiptRuleField, string> = {
  type: 'receiptInvoice',
  receiptNumber: 'receiptNumber',
  receiptDate: 'receiptDate',
  cashRegisterNumber: 'cashRegisterNumber',
  requestDate: 'receiptRequestDate',
  saleDate: 'saleDate',
  buyer: 'receiptInvoice',
  buyerNipOnReceipt: 'buyerNipOnReceipt',
  amount: 'receiptInvoice',
};

/** Pola formularza, z których powstaje paragon (bez odwołania do typu schematu niżej). */
interface ReceiptFormFields {
  issueDate: string;
  receiptNumber?: string;
  receiptDate?: string;
  cashRegisterNumber?: string;
  receiptRequestDate?: string;
  buyerNipOnReceipt?: boolean;
}

/** Paragon z pól formularza, w kształcie zapisywanym w `fa3_data.receipt` (akcja serwera bierze ten sam). */
export function receiptFromFormValues(d: ReceiptFormFields, buyerKind: ReceiptBuyerKind): ReceiptInvoiceData {
  const requestDate = d.receiptRequestDate?.trim();
  return {
    receiptNumber: (d.receiptNumber ?? '').trim(),
    receiptDate: (d.receiptDate ?? '').trim(),
    cashRegisterNumber: normalizeCashRegisterNumber(d.cashRegisterNumber ?? ''),
    // Dzień żądania równy dniowi wystawienia to wartość domyślna, nie zapisujemy go.
    ...(requestDate && requestDate !== d.issueDate ? { requestDate } : {}),
    ...(buyerKind === 'company' && d.buyerNipOnReceipt === true ? { buyerNipOnReceipt: true as const } : {}),
  };
}

/** Rodzaj nabywcy z flag formularza, jak w `buildInvoiceFromForm` (firma z UE, osoba prywatna, firma z NIP). */
export function receiptBuyerKindOfForm(d: { buyerIsEu?: boolean; buyerIsConsumer: boolean }): ReceiptBuyerKind {
  if (d.buyerIsEu) return 'eu';
  if (d.buyerIsConsumer) return 'consumer';
  return 'company';
}

export const lineItemSchema = z.object({
  name: z
    .string()
    .min(1, 'Nazwa wymagana')
    .max(FA3_TEXT_LIMITS.p7.max, maxMessage(FA3_TEXT_LIMITS.p7.max))
    .refine(notXsdBlank, 'Nazwa wymagana')
    .refine(xmlSafe, NO_CONTROL_CHARS_MESSAGE),
  unit: z
    .string()
    .min(1, 'Podaj jednostkę')
    .max(DB_TEXT_LIMITS.lineUnit, `Jednostka — maksymalnie ${liczbaZnakow(DB_TEXT_LIMITS.lineUnit)}`)
    .refine(notXsdBlank, 'Podaj jednostkę')
    .refine(xmlSafe, NO_CONTROL_CHARS_MESSAGE),
  quantity: z
    .number()
    .positive('Ilość musi być > 0')
    .max(MAX_INVOICE_AMOUNT, 'Ilość za duża')
    .refine((v) => hasAtMostDecimals(v, 4), 'Ilość — najwyżej 4 miejsca po przecinku'),
  unitPriceNet: z
    .number()
    .nonnegative('Cena nie może być ujemna')
    .max(MAX_INVOICE_AMOUNT, 'Cena za duża')
    .refine((v) => hasAtMostDecimals(v, 4), 'Cena — najwyżej 4 miejsca po przecinku'),
  vatRate: vatRateEnum,
});

export const invoiceFormSchema = z
  .object({
    internalNumber: z
      .string()
      .min(1, 'Numer faktury wymagany')
      .max(50)
      .refine((v) => v.trim().length > 0, 'Numer faktury wymagany')
      .refine(xmlSafe, NO_CONTROL_CHARS_MESSAGE),
    issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format: RRRR-MM-DD'),
    saleDate: z.union([
      z.literal(''),
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data sprzedaży: RRRR-MM-DD'),
    ]),
    /** Dla firm z Polski — 10 cyfr + checksum (gdy nabywca nie jest osobą prywatną ani firmą z UE). */
    buyerNip: z.string(),
    buyerName: z
      .string()
      .min(1, 'Nazwa wymagana')
      .max(FA3_TEXT_LIMITS.nazwa.max, maxMessage(FA3_TEXT_LIMITS.nazwa.max))
      .refine(notXsdBlank, 'Nazwa wymagana')
      .refine(xmlSafe, NO_CONTROL_CHARS_MESSAGE),
    buyerAddressLine1: z
      .string()
      .min(1, ADDRESS_LINE_1_REQUIRED)
      .max(FA3_TEXT_LIMITS.adresL1.max, maxMessage(FA3_TEXT_LIMITS.adresL1.max))
      .refine(notXsdBlank, ADDRESS_LINE_1_REQUIRED)
      .refine(xmlSafe, NO_CONTROL_CHARS_MESSAGE),
    buyerAddressLine2: z
      .string()
      .min(1, ADDRESS_LINE_2_REQUIRED)
      .max(FA3_TEXT_LIMITS.adresL2.max, maxMessage(FA3_TEXT_LIMITS.adresL2.max))
      .refine(notXsdBlank, ADDRESS_LINE_2_REQUIRED)
      .refine(xmlSafe, NO_CONTROL_CHARS_MESSAGE),
    buyerEmail: z.union([
      z.literal(''),
      z.string().email('Nieprawidłowy adres e-mail'),
    ]),
    buyerIsConsumer: z.boolean(),
    buyerConsumerIdType: buyerConsumerIdTypeEnum.optional(),
    buyerPesel: z.string(),
    buyerIdDocument: z.string(),
    /**
     * AUD-70: firma z innego państwa UE, identyfikowana numerem VAT-UE
     * (`KodUE` + `NrVatUE` w FA(3)). Wyklucza `buyerIsConsumer`. Pola UE są
     * opcjonalne, żeby stare wywołania (bez nich) znaczyły „firma z Polski”.
     */
    buyerIsEu: z.boolean().optional(),
    /** Numer VAT-UE z prefiksem kraju, np. `DE123456789` (Grecja: `EL`). */
    buyerVatUe: z.string().optional(),
    /** Kraj adresu nabywcy z UE (`TKodKraju`, Grecja `GR`) — z `EU_BUYER_COUNTRIES`. */
    buyerCountryCode: z.string().optional(),
    lines: z.array(lineItemSchema).min(1, 'Dodaj co najmniej jedną pozycję'),
    paymentMethod: z.enum(['transfer', 'cash', 'card', 'other']),
    paymentDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    bankAccount: z.string().optional(),
    notes: z.string().max(FA3_TEXT_LIMITS.stopkaFaktury.max).refine(xmlSafe, NO_CONTROL_CHARS_MESSAGE).optional(),
    /** P_18A — mechanizm podzielonej płatności (art. 106e ust. 1 pkt 18a). */
    splitPayment: z.boolean().optional(),
    /**
     * Pozycja cykliczna (plan Finora N1), z której wystawiamy fakturę —
     * ukryte pole formularza otwartego z `?cykliczna=<id>`. Brak = zwykła faktura.
     */
    recurringInvoiceId: z.string().uuid('Nieprawidłowa faktura cykliczna').optional(),
    /**
     * Okres, który strona `?cykliczna=` pokazała w banerze (format jak CHECK
     * `invoices_recurring_period_format_check` w 00154). Wymagany razem
     * z `recurringInvoiceId`: zapis odmawia, gdy pozycja ma już inny okres (C3).
     */
    recurringPeriod: z
      .string()
      .regex(RECURRING_PERIOD_FORMAT, 'Nieprawidłowy okres faktury cyklicznej — otwórz „Wystaw teraz” ponownie.')
      .optional(),
    /**
     * Faktura do paragonu (FP, krok 1.2). Pola opcjonalne, żeby stare
     * wywołania (bez nich) znaczyły „faktura bez paragonu”. Reguły
     * w `receiptInvoiceIssues`, ten sam kod sprawdza wysyłkę (`validateInvoice`).
     */
    receiptInvoice: z.boolean().optional(),
    /** Numer dokumentu z paragonu (art. 106h ust. 1 pkt 1). */
    receiptNumber: z.string().optional(),
    /** Data z paragonu, RRRR-MM-DD; zarazem data sprzedaży. */
    receiptDate: z.string().optional(),
    /** Numer unikatowy kasy z paragonu; spacje i myślniki usuwa zapis. */
    cashRegisterNumber: z.string().optional(),
    /** Dzień żądania faktury, gdy wcześniejszy niż wystawienie (art. 106b ust. 3); pusty = dzień wystawienia. */
    receiptRequestDate: z.string().optional(),
    /** Firma: paragon ma NIP nabywcy (art. 106b ust. 5). */
    buyerNipOnReceipt: z.boolean().optional(),
    /**
     * Proforma albo oferta (krok 2.4, 00198), z której otwarto formularz:
     * ukryte pola formularza z `?proforma=<id>`. Brak = zwykła faktura. Numer
     * kolejnej zamiany jest wymagany razem z dokumentem: zapis odmawia, gdy
     * zajęła go już inna faktura (druga faktura tylko po potwierdzeniu).
     */
    salesQuoteId: z.string().uuid(SALES_QUOTE_LINK_MESSAGE).optional(),
    salesQuoteSeq: z.string().regex(/^[1-9]\d{0,3}$/, SALES_QUOTE_LINK_MESSAGE).optional(),
    /** Seria numeracji, podpowiedź z licznika i klucz zapisu (krok 2.5). */
    ...numberingFormFields,
  })
  .refine((d) => !d.recurringInvoiceId || !!d.recurringPeriod, {
    message: RECURRING_PERIOD_MISSING_MESSAGE,
    path: ['recurringPeriod'],
  })
  .refine((d) => !d.salesQuoteId === !d.salesQuoteSeq, {
    message: SALES_QUOTE_LINK_MESSAGE,
    path: ['salesQuoteId'],
  })
  .refine(
    (d) =>
      d.lines.reduce((sum, l) => sum + l.quantity * l.unitPriceNet * (VAT_FACTOR[l.vatRate] ?? 1), 0) <=
      MAX_INVOICE_AMOUNT,
    { message: 'Kwota faktury przekracza 10 mld zł — podziel ją na kilka faktur', path: ['lines'] },
  )
  .refine((d) => !d.splitPayment || (d.paymentMethod === 'transfer' && !!d.bankAccount?.trim()), {
    message: 'Mechanizm podzielonej płatności wymaga przelewu — podaj numer rachunku',
    path: ['splitPayment'],
  })
  .refine(
    (d) =>
      !!d.buyerIsConsumer ||
      !!d.buyerIsEu ||
      (/^\d{10}$/.test(d.buyerNip) &&
        validateNipChecksum(d.buyerNip)),
    { message: 'NIP firmy — 10 cyfr i suma kontrolna', path: ['buyerNip'] },
  )
  // AUD-70: nabywca z UE i stawka np. II (art. 100 ust. 1 pkt 4).
  .superRefine((d, ctx) => {
    if (d.buyerIsEu && d.buyerIsConsumer) {
      ctx.addIssue({
        code: 'custom',
        message: 'Nabywca to albo osoba prywatna, albo firma z UE — wybierz jedno',
        path: ['buyerIsEu'],
      });
    }
    if (d.buyerIsEu) {
      const vat = parseVatUe(d.buyerVatUe);
      if (!vat) {
        ctx.addIssue({
          code: 'custom',
          message: 'Numer VAT-UE — prefiks kraju UE i numer, np. DE123456789 (Grecja: EL)',
          path: ['buyerVatUe'],
        });
      } else if (vat.kodUE === 'PL') {
        ctx.addIssue({
          code: 'custom',
          message: 'To polski numer — dla firmy z Polski wybierz „Firma z Polski (NIP)” i podaj NIP',
          path: ['buyerVatUe'],
        });
      }
      if (!EU_BUYER_COUNTRY_CODES.has(d.buyerCountryCode ?? '')) {
        ctx.addIssue({
          code: 'custom',
          message: 'Wybierz kraj nabywcy z UE (poza Polską)',
          path: ['buyerCountryCode'],
        });
      }
    }
    // Ważność numeru VAT-UE pilnuje warunek wyżej. np. II dodatkowo wyklucza
    // Irlandię Płn. (XI): jej numer VAT-UE dotyczy tylko towarów (`isNpIiBuyerVat`).
    const nabywcaZUe = d.buyerIsEu === true && !d.buyerIsConsumer;
    const nabywcaDlaNpII = nabywcaZUe && isNpIiBuyerVat(d.buyerVatUe);
    if (!nabywcaDlaNpII) {
      const message = nabywcaZUe && parseVatUe(d.buyerVatUe)?.kodUE === 'XI'
        ? NP_II_NOT_FOR_XI_MESSAGE
        : NP_II_REQUIRES_EU_BUYER_MESSAGE;
      d.lines.forEach((l, i) => {
        if (l.vatRate === 'np_ii') {
          ctx.addIssue({ code: 'custom', message, path: ['lines', i, 'vatRate'] });
        }
      });
    }
  })
  .refine((d) => !d.buyerIsConsumer || !!d.buyerConsumerIdType, {
    message: 'Wybierz typ identyfikatora osoby fizycznej',
    path: ['buyerConsumerIdType'],
  })
  .refine(
    (d) => {
      if (!d.buyerIsConsumer || d.buyerConsumerIdType !== consumerIdChoices.pesel) {
        return true;
      }
      const peselDigits = d.buyerPesel.replace(/\D/g, '');
      return validatePeselChecksum(peselDigits);
    },
    { message: 'Nieprawidłowy PESEL (11 cyfr, suma kontrolna)', path: ['buyerPesel'] },
  )
  .refine(
    (d) => {
      if (!d.buyerIsConsumer) return true;
      const t = d.buyerConsumerIdType;
      if (t !== consumerIdChoices.id_card && t !== consumerIdChoices.passport) return true;
      return (d.buyerIdDocument?.trim().length ?? 0) >= 3;
    },
    {
      message: 'Podaj numer dokumentu (min. 3 znaki)',
      path: ['buyerIdDocument'],
    },
  )
  // C1: numer dokumentu trafia do NrID (XSD: najwyżej 50 znaków, bez znaków
  // sterujących). Tylko gdy faktura go użyje: ukryte pole z wcześniejszego
  // wyboru rodzaju nabywcy nie może blokować zapisu.
  .superRefine((d, ctx) => {
    if (!d.buyerIsConsumer) return;
    const t = d.buyerConsumerIdType;
    if (t !== consumerIdChoices.id_card && t !== consumerIdChoices.passport) return;
    const doc = d.buyerIdDocument.trim();
    if (!xmlSafe(doc)) {
      ctx.addIssue({ code: 'custom', message: NO_CONTROL_CHARS_MESSAGE, path: ['buyerIdDocument'] });
    } else if (xsdLength(doc, 'replace') > FA3_TEXT_LIMITS.nrId.max) {
      ctx.addIssue({ code: 'custom', message: maxMessage(FA3_TEXT_LIMITS.nrId.max), path: ['buyerIdDocument'] });
    }
  })
  .refine((d) => new Date(d.paymentDueDate) >= new Date(d.issueDate), {
    message: 'Termin płatności nie może być przed datą wystawienia',
    path: ['paymentDueDate'],
  })
  .refine(
    (d) =>
      !d.saleDate ||
      d.saleDate === '' ||
      isSaleDateWithinLimit(d.issueDate, d.saleDate),
    {
      message: SALE_DATE_TOO_LATE_MESSAGE,
      path: ['saleDate'],
    },
  )
  // Te same reguły co `validateInvoice` przy wysyłce do KSeF. Sprawdzane tylko
  // tam przepuszczały fakturę przez zapis, a job oznaczał ją jako nieudaną —
  // bez możliwości poprawki (ponowna wysyłka jest wstrzymana).
  .superRefine((d, ctx) => {
    for (const message of issueDateRangeErrors(d.issueDate)) {
      ctx.addIssue({ code: 'custom', message, path: ['issueDate'] });
    }
    const account = d.bankAccount?.trim() ?? '';
    if (d.paymentMethod === 'transfer' && !account) {
      ctx.addIssue({ code: 'custom', message: 'Przy przelewie podaj numer rachunku', path: ['bankAccount'] });
    } else if (account && !validateIban(account)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Nieprawidłowy numer rachunku — 26 cyfr (albo IBAN z kodem kraju); sprawdź, czy nie ma literówki',
        path: ['bankAccount'],
      });
    }
  })
  // Faktura do paragonu (krok 1.2): te same reguły co `validateInvoice` przy
  // wysyłce, z błędem przy właściwym polu. Bez zaznaczenia pola paragonu nie
  // są sprawdzane (zostają w stanie formularza, ale zapis ich nie bierze).
  .superRefine((d, ctx) => {
    if (d.receiptInvoice !== true) return;
    const buyerKind = receiptBuyerKindOfForm(d);
    const lines = d.lines.map((l, i) => ({ ...l, ordinal: i + 1, ...calculateLineItem(l) }));
    const reported = new Set<string>();
    for (const issue of receiptInvoiceIssues({
      receipt: receiptFromFormValues(d, buyerKind),
      invoiceType: 'VAT',
      issueDate: d.issueDate,
      saleDate: d.saleDate,
      buyerKind,
      grossTotal: calculateInvoiceTotals(lines).grossTotal,
    })) {
      const path = RECEIPT_FIELD_PATH[issue.field];
      // Jeden komunikat na pole: drugi przy tym samym polu przykryłby pierwszy w formularzu.
      if (reported.has(path)) continue;
      reported.add(path);
      ctx.addIssue({ code: 'custom', message: issue.message, path: [path] });
    }
  });

export type InvoiceFormValues = z.infer<typeof invoiceFormSchema>;
