/**
 * Faktura do paragonu (FP), plan kompletnej aplikacji, krok 1.2.
 *
 * Przepisy (ustawa o VAT, tekst jednolity Dz.U. 2026 poz. 1263, odczyt 9.11.2026):
 * - art. 106b ust. 3: na żądanie nabywcy zgłoszone w terminie 3 miesięcy, licząc
 *   od końca miesiąca dostawy, usługi albo zapłaty, podatnik wystawia fakturę;
 * - art. 106b ust. 5 i 6: fakturę dla podatnika do sprzedaży z kasy wystawia się
 *   tylko, gdy paragon ma jego NIP (inaczej 100 % VAT z faktury jako sankcja);
 * - art. 106h ust. 1: w dokumentacji zostaje numer dokumentu i numer unikatowy
 *   kasy z paragonu albo paragon papierowy;
 * - art. 109 ust. 3d: FP ujmuje się w ewidencji w okresie wystawienia i nie
 *   zwiększa sprzedaży ani podatku należnego (FA(3): `Fa/FP` = 1);
 * - art. 145n ust. 1 pkt 2 z art. 106e ust. 5 pkt 3: od 1.02 do 31.12.2026
 *   paragon z NIP do 450 zł brutto jest fakturą uproszczoną, więc drugiej faktury
 *   do tej sprzedaży się nie wystawia (objaśnienia MF „Paragony fiskalne”
 *   z 16.10.2020, s. 5: „sprzedawca musi odmówić”).
 * Numer unikatowy kasy: trzy litery i 10 cyfr (§ 22 ust. 2 rozporządzenia MF,
 * Dz.U. 2013 poz. 1076; § 62 ust. 2 Dz.U. 2018 poz. 1206; § 27 ust. 2 Dz.U.
 * 2020 poz. 957), starsze kasy trzy albo dwie litery i 8 cyfr (§ 32 ust. 3 i 4
 * rozporządzenia z 2013 r.).
 *
 * Moduł czysty: bez bazy i bez generatora. Używa go schemat formularza
 * (klient i serwer), `validateInvoice` (wysyłka, szkic, ponowienie z kopii),
 * generator FA(3), PDF, widok faktury, odczyt księgowości i JPK.
 */

import { formatIsoDatePl } from '@/lib/format/iso-date';
import { isXmlSafe } from '@/lib/xml/fa3-limits';
import type { BuyerParty, ReceiptInvoiceData } from '@/types/invoice';

/** Napis na PDF i w widoku faktury. */
export const RECEIPT_INVOICE_LABEL = 'Faktura do paragonu';

/** Najdłuższy numer paragonu (XSD `TZnakowy` w `DodatkowyOpis` dopuszcza 256). */
export const RECEIPT_NUMBER_MAX_LENGTH = 100;

/** Art. 106e ust. 5 pkt 3: kwota należności ogółem do 450 zł (FaktWay wystawia tylko w złotych). */
export const SIMPLIFIED_INVOICE_LIMIT_GROSS_PLN = 450;

/** Art. 145n ust. 1 pkt 2: paragon z NIP jako faktura uproszczona do 31.12.2026. */
export const SIMPLIFIED_RECEIPT_LAST_DAY = '2026-12-31';

/** Klucze `Fa/DodatkowyOpis` z danymi paragonu (art. 106h ust. 1), w tej kolejności. */
export const RECEIPT_XML_KEYS = {
  receiptNumber: 'Numer paragonu',
  receiptDate: 'Data paragonu',
  cashRegisterNumber: 'Numer unikatowy kasy',
} as const;

const CASH_REGISTER_NUMBER = /^(?:[A-Z]{3}\d{10}|[A-Z]{2,3}\d{8})$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export const RECEIPT_ONLY_REGULAR_MESSAGE =
  'Fakturę do paragonu FaktWay wystawia jako zwykłą fakturę VAT. Zaliczki, korekty ani rozliczenia do paragonu jeszcze nie: napisz do nas przez Pomoc.';
export const RECEIPT_NUMBER_MESSAGE =
  `Podaj numer paragonu (numer dokumentu z paragonu), najwyżej ${RECEIPT_NUMBER_MAX_LENGTH} znaków.`;
export const RECEIPT_DATE_MESSAGE = 'Podaj datę z paragonu (RRRR-MM-DD).';
export const RECEIPT_DATE_AFTER_ISSUE_MESSAGE =
  'Data paragonu nie może być późniejsza niż data wystawienia faktury.';
export const CASH_REGISTER_NUMBER_MESSAGE =
  'Numer unikatowy kasy z paragonu to 3 albo 2 litery i 10 albo 8 cyfr, np. ABC1234567890 (na paragonie obok logo fiskalnego).';
export const REQUEST_DATE_MESSAGE =
  'Data żądania faktury musi być między datą paragonu a datą wystawienia faktury.';
export const EU_BUYER_MESSAGE =
  'Fakturę do paragonu FaktWay wystawia dla firmy z Polski z NIP z paragonu albo dla osoby prywatnej. Dla firmy z UE jeszcze nie: napisz do nas przez Pomoc.';
export const BUYER_NIP_ON_RECEIPT_MESSAGE =
  'Fakturę do paragonu dla firmy wystawia się tylko wtedy, gdy paragon ma NIP nabywcy (art. 106b ust. 5 ustawy o VAT). Sprawdź paragon i zaznacz „Paragon ma NIP nabywcy”.';
export const SIMPLIFIED_RECEIPT_MESSAGE =
  'Paragon z 2026 r. na kwotę do 450 zł brutto z NIP nabywcy jest fakturą uproszczoną (art. 106e ust. 5 pkt 3 i art. 145n ust. 1 pkt 2 ustawy o VAT), więc do tej sprzedaży nie wystawia się drugiej faktury.';

/**
 * Korekta FP (krok 1.2): generator korekty nie pisze `FP`, a korekty są na
 * produkcji wstrzymane, więc odmowa przed zapisem. Wyjście: Pomoc.
 */
export function receiptCorrectionRefusal(internalNumber: string | null): string {
  return (
    `Faktura ${internalNumber ?? '(bez numeru)'} to faktura do paragonu. Korekty faktury do paragonu FaktWay jeszcze ` +
    'nie wystawia: napisz do nas przez Pomoc, ustalimy, jak ją poprawić.'
  );
}

export function saleDateMustMatchReceiptMessage(receiptDate: string): string {
  return `Na fakturze do paragonu data sprzedaży to data z paragonu (${formatIsoDatePl(receiptDate)}). Popraw datę sprzedaży albo datę paragonu.`;
}

export function requestDeadlinePassedMessage(receiptDate: string, deadline: string): string {
  return (
    'Fakturę do paragonu wystawia się na żądanie zgłoszone w ciągu 3 miesięcy od końca miesiąca sprzedaży ' +
    `(art. 106b ust. 3 ustawy o VAT). Dla paragonu z ${formatIsoDatePl(receiptDate)} ten termin minął ` +
    `${formatIsoDatePl(deadline)}. Jeśli nabywca poprosił o fakturę w terminie, wpisz dzień jego prośby w polu „Data żądania faktury”.`
  );
}

/** Prawdziwy dzień RRRR-MM-DD (bez „2026-02-31”). */
export function isIsoDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DAY.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Numer kasy tak, jak go zapisujemy: bez spacji i myślników, wielkimi literami. */
export function normalizeCashRegisterNumber(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase();
}

export function isCashRegisterNumber(value: string): boolean {
  return CASH_REGISTER_NUMBER.test(value);
}

/**
 * Ostatni dzień na żądanie faktury (art. 106b ust. 3): koniec trzeciego
 * miesiąca po miesiącu sprzedaży. Paragon z 15.08 → 30.11, z 30.11.2026 →
 * 28.02.2027, z listopada 2027 → 29.02.2028.
 */
export function receiptRequestDeadline(receiptDate: string): string {
  const m = ISO_DAY.exec(receiptDate);
  if (!m) throw new Error(`receiptRequestDeadline: niepoprawna data "${receiptDate}"`);
  // Dzień 0 miesiąca m+4 (0-indeksowo) to ostatni dzień miesiąca m+3.
  // filtr-wyjatek: data-warszawa rachunek miesięcy w UTC na polach RRRR-MM-DD, nie dzisiejsza data
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + 4, 0)).toISOString().slice(0, 10);
}

export type ReceiptBuyerKind = 'company' | 'eu' | 'consumer';

/** Firma z NIP, firma z UE (VAT-UE) albo osoba prywatna: jak identyfikator w `Podmiot2`. */
export function receiptBuyerKind(buyer: Pick<BuyerParty, 'nip' | 'vatUeNumber'>): ReceiptBuyerKind {
  if (buyer.nip?.trim()) return 'company';
  if (buyer.vatUeNumber?.trim()) return 'eu';
  return 'consumer';
}

export type ReceiptRuleField =
  | 'type'
  | 'receiptNumber'
  | 'receiptDate'
  | 'cashRegisterNumber'
  | 'requestDate'
  | 'saleDate'
  | 'buyer'
  | 'buyerNipOnReceipt'
  | 'amount';

export interface ReceiptRuleIssue {
  field: ReceiptRuleField;
  message: string;
}

export interface ReceiptRuleInput {
  receipt: ReceiptInvoiceData;
  /** `Invoice.type` (`VAT`, `KOR`, ...). */
  invoiceType: string;
  issueDate: string;
  /** Data sprzedaży na fakturze; brak = data wystawienia (P_6 pominięte). */
  saleDate?: string;
  buyerKind: ReceiptBuyerKind;
  /** Kwota należności ogółem (brutto) w złotych. */
  grossTotal: number;
}

/**
 * Wszystkie reguły FP naraz, każda z polem i komunikatem. Wynik zależy tylko od
 * danych dokumentu (bez zegara), więc ponowienie wysyłki daje ten sam wynik.
 */
export function receiptInvoiceIssues(input: ReceiptRuleInput): ReceiptRuleIssue[] {
  const { receipt, issueDate } = input;
  const issues: ReceiptRuleIssue[] = [];
  const add = (field: ReceiptRuleField, message: string) => issues.push({ field, message });

  if (input.invoiceType !== 'VAT') add('type', RECEIPT_ONLY_REGULAR_MESSAGE);

  const number = typeof receipt.receiptNumber === 'string' ? receipt.receiptNumber.trim() : '';
  if (!number || number.length > RECEIPT_NUMBER_MAX_LENGTH || !isXmlSafe(number)) {
    add('receiptNumber', RECEIPT_NUMBER_MESSAGE);
  }

  const cashRegister = typeof receipt.cashRegisterNumber === 'string' ? receipt.cashRegisterNumber : '';
  if (!isCashRegisterNumber(cashRegister)) add('cashRegisterNumber', CASH_REGISTER_NUMBER_MESSAGE);

  if (input.buyerKind === 'eu') add('buyer', EU_BUYER_MESSAGE);
  if (input.buyerKind === 'company' && receipt.buyerNipOnReceipt !== true) {
    add('buyerNipOnReceipt', BUYER_NIP_ON_RECEIPT_MESSAGE);
  }

  const receiptDate = receipt.receiptDate;
  if (!isIsoDay(receiptDate)) {
    add('receiptDate', RECEIPT_DATE_MESSAGE);
    return issues;
  }
  if (isIsoDay(issueDate) && receiptDate > issueDate) add('receiptDate', RECEIPT_DATE_AFTER_ISSUE_MESSAGE);

  const saleDate = input.saleDate?.trim() ? input.saleDate : issueDate;
  if (saleDate !== receiptDate) add('saleDate', saleDateMustMatchReceiptMessage(receiptDate));

  const requestDate = receipt.requestDate;
  if (requestDate !== undefined && (!isIsoDay(requestDate) || requestDate < receiptDate || (isIsoDay(issueDate) && requestDate > issueDate))) {
    add('requestDate', REQUEST_DATE_MESSAGE);
  } else if (isIsoDay(issueDate)) {
    const deadline = receiptRequestDeadline(receiptDate);
    const requestedOn = requestDate ?? issueDate;
    if (requestedOn > deadline) {
      add(requestDate ? 'requestDate' : 'receiptDate', requestDeadlinePassedMessage(receiptDate, deadline));
    }
  }

  if (
    input.buyerKind === 'company' &&
    receiptDate <= SIMPLIFIED_RECEIPT_LAST_DAY &&
    // filtr-wyjatek: kwoty-bez-float złote z dwoma miejscami na całe grosze do porównania z limitem
    Math.round(input.grossTotal * 100) <= SIMPLIFIED_INVOICE_LIMIT_GROSS_PLN * 100
  ) {
    add('amount', SIMPLIFIED_RECEIPT_MESSAGE);
  }

  return issues;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Paragon z `fa3_data.receipt` tylko w pełnym kształcie (PDF, widok faktury).
 * Niepełny zapis to `null`: nie drukujemy pustych danych (oznaczenie zostaje,
 * patrz `isReceiptInvoiceFa3`).
 */
export function receiptFromJson(raw: unknown): ReceiptInvoiceData | null {
  if (!isRecord(raw)) return null;
  const { receiptNumber, receiptDate, cashRegisterNumber, requestDate, buyerNipOnReceipt } = raw;
  if (typeof receiptNumber !== 'string' || !receiptNumber.trim()) return null;
  if (!isIsoDay(receiptDate) || typeof cashRegisterNumber !== 'string' || !cashRegisterNumber.trim()) return null;
  return {
    receiptNumber,
    receiptDate,
    cashRegisterNumber,
    ...(isIsoDay(requestDate) ? { requestDate } : {}),
    ...(buyerNipOnReceipt === true ? { buyerNipOnReceipt: true as const } : {}),
  };
}

/**
 * Czy faktura to FP: wystawiona w FaktWay (`fa3_data.receipt`) albo z importu
 * KSeF z `Fa/FP` = 1 (`fa3_data.ksefMarkers.fp`, C5b). Każdy zapis paragonu,
 * także niepełny, liczy się jako FP (fail-closed w księgowości i JPK).
 */
export function isReceiptInvoiceFa3(fa3: unknown): boolean {
  if (!isRecord(fa3)) return false;
  if (fa3.receipt !== undefined && fa3.receipt !== null) return true;
  return isRecord(fa3.ksefMarkers) && fa3.ksefMarkers.fp === true;
}

/**
 * To samo co `isReceiptInvoiceFa3`, z kolumn wybranych aliasami
 * (`fa3_data->receipt` i `fa3_data->ksefMarkers->>fp`, który PostgREST zwraca
 * jako tekst „true”). Jedna definicja FP dla odczytów bez całego `fa3_data`.
 */
export function isReceiptInvoiceColumns(receipt: unknown, ksefFp: unknown): boolean {
  return isReceiptInvoiceFa3({ receipt, ksefMarkers: { fp: ksefFp === true || ksefFp === 'true' } });
}

/** Wiersz danych paragonu na PDF i w widoku faktury. */
export function receiptDetailsLine(receipt: ReceiptInvoiceData, formatDate: (iso: string) => string = (iso) => iso): string {
  return `Paragon nr ${receipt.receiptNumber} z dnia ${formatDate(receipt.receiptDate)}, numer unikatowy kasy ${receipt.cashRegisterNumber}`;
}

/** Widok faktury: oznaczenie FP i dane paragonu (bez reszty `fa3_data` w komponencie klienckim). */
export interface ReceiptInvoiceView {
  label: string;
  /** `null`: FP z importu KSeF albo niepełny zapis, samo oznaczenie. */
  details: string | null;
}

export function receiptInvoiceView(fa3: unknown): ReceiptInvoiceView | null {
  if (!isReceiptInvoiceFa3(fa3)) return null;
  const receipt = receiptFromJson((fa3 as Record<string, unknown>).receipt);
  return { label: RECEIPT_INVOICE_LABEL, details: receipt ? receiptDetailsLine(receipt, formatIsoDatePl) : null };
}
