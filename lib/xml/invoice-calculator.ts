import type {
  Invoice,
  InvoiceLineItem,
  VatRate,
  BuyerParty,
  SellerParty,
  PaymentInfo,
  InvoiceType,
} from '@/types/invoice';
import { receiptBuyerKind, receiptInvoiceIssues } from '@/lib/invoices/receipt-invoice';
import { isSaleDateWithinLimit, SALE_DATE_TOO_LATE_MESSAGE } from '@/lib/invoices/sale-date';
import { addressCountryForKodUE, isNpIiBuyerVat, parseVatUe } from '@/lib/invoices/vat-ue';

// ═══════════════════════════════════════════════════════════════
// Zaokrąglanie i konwersje liczbowe
// ═══════════════════════════════════════════════════════════════

/**
 * Zaokrąglenie do 2 miejsc (grosze) metodą "half away from zero" z korektą epsilon.
 *
 * Naiwna implementacja `Math.round(x * 100) / 100` ma znany bug z liczbami
 * które w IEEE 754 nie są reprezentowane dokładnie:
 *   Math.round(1.005 * 100) / 100 === 1    // ŹLE, powinno być 1.01
 *   bo 1.005 * 100 === 100.49999999999999
 *
 * Dodanie Number.EPSILON przed mnożeniem rozwiązuje najczęstsze przypadki
 * (typowe kwoty faktur). Dla bardzo dużych liczb (> 10^15) nadal może się
 * zemścić, ale tam i tak wpadamy w inne problemy precyzji.
 */
export function roundToCents(value: number): number {
  const sign = Math.sign(value);
  const abs = Math.abs(value);
  return (sign * Math.round((abs + Number.EPSILON) * 100)) / 100;
}

/**
 * Zaokrąglenie do N miejsc (używane dla cen jednostkowych P_9A - do 8 miejsc).
 */
export function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  const sign = Math.sign(value);
  const abs = Math.abs(value);
  return (sign * Math.round((abs + Number.EPSILON) * factor)) / factor;
}

// ═══════════════════════════════════════════════════════════════
// Kalkulacje faktury
// ═══════════════════════════════════════════════════════════════

/**
 * Mapa stawek VAT na wartości numeryczne do kalkulacji.
 * Stawki niematematyczne (zw, oo, np, np_ii) zawsze dają VAT=0.
 */
export function getVatPercentage(rate: VatRate): number {
  switch (rate) {
    case '23':
      return 23;
    case '8':
      return 8;
    case '5':
      return 5;
    case '0':
    case 'zw':
    case 'oo':
    case 'np':
    case 'np_ii':
      return 0;
  }
}

/**
 * Kalkulacja pojedynczej pozycji na podstawie quantity, unitPriceNet, vatRate.
 * Zwraca WSZYSTKIE pola numeryczne (netAmount, vatAmount, grossAmount).
 */
export function calculateLineItem(
  input: Pick<InvoiceLineItem, 'quantity' | 'unitPriceNet' | 'vatRate'>
): Pick<InvoiceLineItem, 'netAmount' | 'vatAmount' | 'grossAmount'> {
  const netAmount = roundToCents(input.quantity * input.unitPriceNet);
  const vatPercentage = getVatPercentage(input.vatRate);
  const vatAmount = roundToCents((netAmount * vatPercentage) / 100);
  const grossAmount = roundToCents(netAmount + vatAmount);
  return { netAmount, vatAmount, grossAmount };
}

/**
 * Sumy per stawka VAT (wymagane przez FA(3) pola P_13_1, P_14_1 dla 23%;
 * P_13_2, P_14_2 dla 8%; itd.).
 */
export interface VatSummaryPerRate {
  rate: VatRate;
  /** Suma netto w tej stawce */
  netSum: number;
  /** Suma VAT w tej stawce */
  vatSum: number;
}

export function summarizeVatPerRate(lines: InvoiceLineItem[]): VatSummaryPerRate[] {
  const map = new Map<VatRate, { net: number; vat: number }>();

  for (const line of lines) {
    const existing = map.get(line.vatRate) ?? { net: 0, vat: 0 };
    existing.net += line.netAmount;
    existing.vat += line.vatAmount;
    map.set(line.vatRate, existing);
  }

  return Array.from(map.entries()).map(([rate, sums]) => ({
    rate,
    netSum: roundToCents(sums.net),
    vatSum: roundToCents(sums.vat),
  }));
}

/**
 * Totale całej faktury - sumy wszystkich pozycji.
 */
export interface InvoiceTotals {
  netTotal: number;
  vatTotal: number;
  grossTotal: number;
}

export function calculateInvoiceTotals(lines: InvoiceLineItem[]): InvoiceTotals {
  const netTotal = roundToCents(
    lines.reduce((sum, line) => sum + line.netAmount, 0)
  );
  const vatTotal = roundToCents(
    lines.reduce((sum, line) => sum + line.vatAmount, 0)
  );
  const grossTotal = roundToCents(netTotal + vatTotal);
  return { netTotal, vatTotal, grossTotal };
}

// ═══════════════════════════════════════════════════════════════
// finalizeInvoice - wejście userowskie → pełny Invoice
// ═══════════════════════════════════════════════════════════════

/** Pozycja jaką user podaje z formularza (bez wyliczeń). */
export type InvoiceLineItemInput = Pick<
  InvoiceLineItem,
  'ordinal' | 'name' | 'unit' | 'quantity' | 'unitPriceNet' | 'vatRate'
> &
  Partial<Pick<InvoiceLineItem, 'classificationCode'>>;

/** Faktura jaką user podaje z formularza (bez wyliczeń i totali). */
export interface InvoiceInput {
  internalNumber: string;
  type: InvoiceType;
  issueDate: string;
  saleDate?: string;
  seller: SellerParty;
  buyer: BuyerParty;
  lines: InvoiceLineItemInput[];
  payment: Omit<PaymentInfo, 'amountDue'>;
  notes?: string;
  /** Faktura do paragonu (FP): tylko zwykła faktura VAT. */
  receipt?: Invoice['receipt'];
}

/**
 * Buduje pełny Invoice z wejścia userowskiego.
 * Zaokrągla każdą pozycję, liczy totale, ustawia amountDue = grossTotal.
 * Single source of truth = pozycje; pola kwotowe na Invoice to derived state.
 */
export function finalizeInvoice(input: InvoiceInput): Invoice {
  const lines: InvoiceLineItem[] = input.lines.map((raw) => {
    const { netAmount, vatAmount, grossAmount } = calculateLineItem(raw);
    return {
      ordinal: raw.ordinal,
      name: raw.name,
      classificationCode: raw.classificationCode,
      unit: raw.unit,
      quantity: raw.quantity,
      unitPriceNet: raw.unitPriceNet,
      vatRate: raw.vatRate,
      netAmount,
      vatAmount,
      grossAmount,
    };
  });

  const { netTotal, vatTotal, grossTotal } = calculateInvoiceTotals(lines);

  return {
    internalNumber: input.internalNumber,
    type: input.type,
    issueDate: input.issueDate,
    saleDate: input.saleDate,
    seller: input.seller,
    buyer: input.buyer,
    lines,
    netTotal,
    vatTotal,
    grossTotal,
    payment: {
      ...input.payment,
      amountDue: grossTotal,
    },
    notes: input.notes,
    // Klucz tylko przy FP: zwykła faktura ma kształt jak przed krokiem 1.2.
    ...(input.receipt ? { receipt: input.receipt } : {}),
  };
}

// ═══════════════════════════════════════════════════════════════
// Walidacje podstawowe (NIP, IBAN, daty)
// ═══════════════════════════════════════════════════════════════

/**
 * Walidacja polskiego NIP (10 cyfr + suma kontrolna mod 11).
 * Jeśli mod=10, NIP jest z definicji niepoprawny (żadna cyfra nie może być 10).
 */
export function validateNipChecksum(nip: string): boolean {
  if (!/^\d{10}$/.test(nip)) return false;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const digits = nip.split('').map(Number);
  const checksum = digits.slice(0, 9).reduce((sum, d, i) => sum + d * weights[i], 0);
  const mod = checksum % 11;
  return mod < 10 && mod === digits[9];
}

/** PESEL — 11 cyfr + algorytm sumy kontrolnej (jak w GUS/regon). */
export function validatePeselChecksum(pesel: string): boolean {
  if (!/^\d{11}$/.test(pesel)) return false;
  const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(pesel[i], 10) * weights[i];
  }
  const checksum = (10 - (sum % 10)) % 10;
  return checksum === parseInt(pesel[10], 10);
}

/**
 * Numer rachunku w postaci IBAN: bez spacji i myślników, wielkie litery,
 * a polski NRB (26 cyfr — tak go wpisuje większość klientów i tak podpowiada
 * formularz) dostaje „PL”. Do 01.10.2026 walidacja faktury wymagała kodu
 * kraju, więc zwykły numer rachunku przechodził formularz i dopiero wysyłka
 * do KSeF padała na „nieprawidłowy format IBAN”.
 */
export function normalizeIban(raw: string): string {
  const clean = raw.replace(/[\s-]/g, '').toUpperCase();
  return /^\d{26}$/.test(clean) ? `PL${clean}` : clean;
}

/**
 * Walidacja IBAN (dowolny kraj, ale zoptymalizowane pod PL).
 * Format: 2 litery kraju + 2 cyfry kontrolne + BBAN (max 30 znaków).
 * Algorytm mod-97: przesuwamy 4 pierwsze znaki na koniec, zamieniamy litery
 * na liczby (A=10, B=11, ...), cała wartość mod 97 musi dać 1.
 */
export function validateIban(iban: string): boolean {
  const clean = normalizeIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(clean)) return false;

  const rearranged = clean.slice(4) + clean.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) =>
    (ch.charCodeAt(0) - 55).toString()
  );

  // Mod 97 na dużym stringu cyfr (bez BigInt) - kawałkami po 9 cyfr.
  let remainder = '';
  for (const digit of numeric) {
    remainder += digit;
    if (remainder.length >= 9) {
      remainder = (parseInt(remainder, 10) % 97).toString();
    }
  }
  return parseInt(remainder, 10) % 97 === 1;
}

/**
 * Walidacja daty w formacie ISO RRRR-MM-DD (bez czasu).
 * Zwraca Date lub null jeśli format zły.
 */
export function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(date.getTime())) return null;
  // Sprawdź że nie było "normalizacji" (np. 2026-02-31 → 2026-03-03)
  const [y, m, d] = value.split('-').map(Number);
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() + 1 !== m ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

// ═══════════════════════════════════════════════════════════════
// validateInvoice - pełna walidacja biznesowa faktury
// ═══════════════════════════════════════════════════════════════

/** Minimalna data wystawienia faktury FA(3) wg XSD (DataWytworzeniaFa). */
const FA3_MIN_ISSUE_DATE = new Date('2025-09-01T00:00:00Z');

/** Maksymalne wyprzedzenie daty wystawienia względem today (30 dni). */
const MAX_ISSUE_DATE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Zakres daty wystawienia — wspólny dla `validateInvoice` (wysyłka do KSeF)
 * i formularza. Reguła sprawdzana tylko przy wysyłce przepuszczała fakturę
 * przez zapis, a job oznaczał ją jako nieudaną bez możliwości poprawki.
 */
export function issueDateRangeErrors(issueDateIso: string, now: Date = new Date()): string[] {
  const issueDate = parseIsoDate(issueDateIso);
  if (!issueDate) {
    return [`Data wystawienia "${issueDateIso}" ma nieprawidłowy format (oczekiwane RRRR-MM-DD).`];
  }
  const errors: string[] = [];
  if (issueDate < FA3_MIN_ISSUE_DATE) {
    errors.push(`Data wystawienia ${issueDateIso} jest wcześniejsza niż minimalna data FA(3) (2025-09-01).`);
  }
  if (issueDate.getTime() - now.getTime() > MAX_ISSUE_DATE_AHEAD_MS) {
    errors.push(`Data wystawienia ${issueDateIso} jest więcej niż 30 dni w przyszłości.`);
  }
  return errors;
}

export function validateInvoice(invoice: Invoice, now: Date = new Date()): string[] {
  const errors: string[] = [];

  // ── Sprzedawca ─────────────────────────────────────────────
  if (!validateNipChecksum(invoice.seller.nip)) {
    errors.push(`NIP sprzedawcy "${invoice.seller.nip}" ma nieprawidłową sumę kontrolną.`);
  }

  // ── Nabywca: dokładnie jeden identyfikator ─────────────────
  const buyerIdCount =
    (invoice.buyer.nip ? 1 : 0) +
    (invoice.buyer.vatUeNumber ? 1 : 0) +
    (invoice.buyer.noIdMarker ? 1 : 0) +
    (invoice.buyer.pesel?.trim() ? 1 : 0) +
    (invoice.buyer.nrInny?.trim() ? 1 : 0);
  if (buyerIdCount === 0) {
    errors.push(
      'Nabywca musi mieć ustawiony dokładnie jeden identyfikator (NIP, VAT UE, PESEL, nr inny dokumentu lub „brak ID”).'
    );
  } else if (buyerIdCount > 1) {
    errors.push(
      'Nabywca może mieć tylko jeden identyfikator (NIP, VAT UE, PESEL, dokument lub marker braku ID).'
    );
  }
  if (invoice.buyer.nip && !validateNipChecksum(invoice.buyer.nip)) {
    errors.push(`NIP nabywcy "${invoice.buyer.nip}" ma nieprawidłową sumę kontrolną.`);
  }
  if (invoice.buyer.pesel && !validatePeselChecksum(invoice.buyer.pesel)) {
    errors.push(`PESEL nabywcy ma nieprawidłową sumę kontrolną.`);
  }
  errors.push(...buyerVatUeErrors(invoice));

  // ── Daty ───────────────────────────────────────────────────
  const issueDate = parseIsoDate(invoice.issueDate);
  errors.push(...issueDateRangeErrors(invoice.issueDate, now));

  if (invoice.saleDate !== undefined) {
    const saleDate = parseIsoDate(invoice.saleDate);
    if (!saleDate) {
      errors.push(`Data sprzedaży "${invoice.saleDate}" ma nieprawidłowy format.`);
    } else if (issueDate && !isSaleDateWithinLimit(invoice.issueDate, invoice.saleDate)) {
      errors.push(SALE_DATE_TOO_LATE_MESSAGE);
    }
  }

  const dueDate = parseIsoDate(invoice.payment.dueDate);
  if (!dueDate) {
    errors.push(`Termin płatności "${invoice.payment.dueDate}" ma nieprawidłowy format.`);
  } else if (issueDate && dueDate < issueDate) {
    errors.push('Termin płatności nie może być wcześniejszy niż data wystawienia.');
  }

  // ── Pozycje ────────────────────────────────────────────────
  if (invoice.lines.length === 0) {
    errors.push('Faktura musi mieć co najmniej jedną pozycję.');
  }

  for (const line of invoice.lines) {
    if (line.name.length === 0 || line.name.length > 512) {
      errors.push(`Pozycja ${line.ordinal}: nazwa musi mieć 1-512 znaków (obecnie ${line.name.length}).`);
    }
    if (line.quantity <= 0) {
      errors.push(`Pozycja ${line.ordinal}: ilość musi być > 0.`);
    }
    if (line.unitPriceNet < 0) {
      errors.push(`Pozycja ${line.ordinal}: cena netto nie może być ujemna.`);
    }

    const calculated = calculateLineItem(line);
    if (Math.abs(calculated.netAmount - line.netAmount) > 0.01) {
      errors.push(
        `Pozycja ${line.ordinal}: netAmount (${line.netAmount}) nie zgadza się z ` +
          `quantity * unitPriceNet (${calculated.netAmount}).`
      );
    }
    if (Math.abs(calculated.vatAmount - line.vatAmount) > 0.01) {
      errors.push(
        `Pozycja ${line.ordinal}: vatAmount (${line.vatAmount}) nie zgadza się z ` +
          `netAmount * ${line.vatRate}% (${calculated.vatAmount}).`
      );
    }
    if (Math.abs(calculated.grossAmount - line.grossAmount) > 0.01) {
      errors.push(
        `Pozycja ${line.ordinal}: grossAmount nie zgadza się z netAmount + vatAmount.`
      );
    }
  }

  // ── Totale całej faktury ───────────────────────────────────
  const totals = calculateInvoiceTotals(invoice.lines);
  if (Math.abs(totals.netTotal - invoice.netTotal) > 0.01) {
    errors.push(
      `Suma netto faktury (${invoice.netTotal}) nie zgadza się z sumą pozycji (${totals.netTotal}).`
    );
  }
  if (Math.abs(totals.vatTotal - invoice.vatTotal) > 0.01) {
    errors.push(
      `Suma VAT faktury (${invoice.vatTotal}) nie zgadza się z sumą pozycji (${totals.vatTotal}).`
    );
  }
  if (Math.abs(totals.grossTotal - invoice.grossTotal) > 0.01) {
    errors.push(
      `Suma brutto faktury (${invoice.grossTotal}) nie zgadza się z sumą pozycji (${totals.grossTotal}).`
    );
  }

  // ── Sumy per stawka muszą zgadzać się z totalem netto ──────
  const perRate = summarizeVatPerRate(invoice.lines);
  const netPerRateSum = roundToCents(perRate.reduce((s, r) => s + r.netSum, 0));
  if (Math.abs(netPerRateSum - invoice.netTotal) > 0.01) {
    errors.push(
      `Suma netto per stawka VAT (${netPerRateSum}) nie zgadza się z sumą netto faktury (${invoice.netTotal}).`
    );
  }

  // ── Płatność ───────────────────────────────────────────────
  if (Math.abs(invoice.payment.amountDue - invoice.grossTotal) > 0.01) {
    errors.push(
      `Kwota do zapłaty (${invoice.payment.amountDue}) nie zgadza się z kwotą brutto (${invoice.grossTotal}).`
    );
  }

  if (invoice.payment.method === 'transfer') {
    if (!invoice.payment.bankAccount) {
      errors.push('Dla płatności przelewem wymagany jest numer rachunku bankowego.');
    } else if (!validateIban(invoice.payment.bankAccount)) {
      errors.push(`Numer rachunku "${invoice.payment.bankAccount}" ma nieprawidłowy format IBAN.`);
    }
  }

  // ── Zwolnienie z VAT ───────────────────────────────────────
  // FA(3): stawka 'zw' wymaga P_19 + podstawy prawnej (P_19A).
  if (invoice.lines.some((l) => l.vatRate === 'zw') && !invoice.annotations?.vatExemptionBasis?.trim()) {
    errors.push(ZW_WITHOUT_BASIS_MESSAGE);
  }

  // ── Faktura do paragonu (FP, krok 1.2) ─────────────────────
  // Te same reguły co formularz (`lib/invoices/receipt-invoice.ts`): szkic,
  // job wysyłki i ponowienie z kopii nie wyślą FP, której formularz by nie przyjął.
  if (invoice.receipt !== undefined) {
    for (const issue of receiptInvoiceIssues({
      receipt: invoice.receipt,
      invoiceType: invoice.type,
      issueDate: invoice.issueDate,
      saleDate: invoice.saleDate,
      buyerKind: receiptBuyerKind(invoice.buyer),
      grossTotal: invoice.grossTotal,
    })) {
      errors.push(issue.message);
    }
  }

  return errors;
}

/**
 * Numer VAT-UE nabywcy i stawka „np II” (AUD-70).
 *
 * - numer musi dać się zapisać w XSD: prefiks z `TKodyKrajowUE` (Grecja „EL”)
 *   i numer zgodny z `TNrVatUE` — inaczej KSeF odrzuca XML,
 * - „np II” (usługi z art. 100 ust. 1 pkt 4 — art. 28b, VAT rozlicza nabywca)
 *   wymaga nabywcy-podatnika z INNEGO państwa UE, czyli numeru VAT-UE
 *   z prefiksem innym niż „PL” i „XI” (`isNpIiBuyerVat`),
 * - nabywca z zagranicznym VAT-UE ma adres za granicą (`Adres/KodKraju` to
 *   kod ISO — dla Grecji „GR”, nie „EL”).
 */
function buyerVatUeErrors(invoice: Invoice): string[] {
  const errors: string[] = [];
  const raw = invoice.buyer.vatUeNumber;
  const parsed = raw ? parseVatUe(raw) : null;

  if (raw && !parsed) {
    errors.push(
      `Numer VAT-UE nabywcy "${raw}" jest nieprawidłowy: oczekiwano prefiksu kraju UE ` +
        '(Grecja to „EL”, nie „GR”) i do 12 znaków (cyfry, wielkie litery, „+”, „*”), np. „DE123456789”.'
    );
  }

  const npIiOrdinals = invoice.lines.filter((l) => l.vatRate === 'np_ii').map((l) => l.ordinal);
  if (npIiOrdinals.length > 0 && !isNpIiBuyerVat(raw)) {
    const label = npIiOrdinals.length === 1 ? 'Pozycja' : 'Pozycje';
    errors.push(
      `${label} ${npIiOrdinals.join(', ')}: stawka „np II” (usługi z art. 100 ust. 1 pkt 4 ustawy o VAT) ` +
        'wymaga nabywcy — podatnika z innego państwa UE — z numerem VAT-UE (np. „DE123456789”). ' +
        'Dla nabywcy z NIP, z polskim VAT-UE, z Irlandii Płn. (XI — numer tylko dla towarów) ' +
        'albo bez numeru wybierz inną stawkę.'
    );
  }

  if (parsed && parsed.kodUE !== 'PL') {
    const country = (invoice.buyer.address?.countryCode ?? '').trim().toUpperCase();
    if (!country || country === 'PL') {
      errors.push(
        `Nabywca z numerem VAT-UE ${parsed.kodUE} musi mieć kraj w adresie inny niż Polska ` +
          `(np. „${addressCountryForKodUE(parsed.kodUE)}”).`
      );
    }
  }

  return errors;
}

/** Wspólny komunikat walidacji i generatora — człowiek wie, gdzie to ustawić. */
export const ZW_WITHOUT_BASIS_MESSAGE =
  'Pozycja ze stawką „zw” wymaga podstawy prawnej zwolnienia z VAT. Ustaw ją w Ustawieniach → Podatek VAT (np. „art. 113 ust. 1 ustawy o VAT”).';
