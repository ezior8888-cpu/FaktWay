import { hasKsefCurrencyRate } from '@/lib/expenses/ksef-currency-review';
import type { Json } from '@/types/database';

/**
 * Koszt ze zdjęcia (OCR) w walucie obcej, dla której nie było kursu NBP
 * (`lib/jobs/runners/process-ocr.ts`, `cost.kind === 'missing_rate'`):
 * kwoty w wierszu są w walucie dokumentu, koszt jest poza KPiR, a ślad
 * waluty to `ocr_extracted_data.currency` bez `fx` (E17b).
 *
 * Do KPiR wchodzi dopiero wtedy, gdy klient wpisze kwoty w złotych i to
 * potwierdzi (`reviewExpenseAction`, pole `confirmPlnAmounts`). Potwierdzenie
 * zostaje w śladzie jako `pln_confirmation` (kto i kiedy) obok oryginalnego
 * odczytu dokumentu, który się nie zmienia. Od tej chwili kwoty są w złotych:
 * formularz i listy podpisują je „zł”, a kolejne zmiany nie wymagają
 * ponownego potwierdzenia.
 *
 * Moduł bez zależności serwerowych: używa go akcja, formularz i listy.
 */

export const PLN_CONFIRMATION_KEY = 'pln_confirmation';

const HOME_CURRENCY = 'PLN';

type TraceObject = { [key: string]: Json | undefined };

function asObject(raw: Json | null | undefined): TraceObject | null {
  return raw !== null && raw !== undefined && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

function foreignCode(value: Json | undefined): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) && code !== HOME_CURRENCY ? code : null;
}

/**
 * Waluta obca dokumentu z OCR (z kursem albo bez). `null` dla złotych, braku
 * śladu i śladu KSeF (koszty KSeF mają własną ścieżkę:
 * `lib/expenses/ksef-currency-review.ts`).
 */
export function ocrForeignCurrency(raw: Json | null | undefined): string | null {
  const trace = asObject(raw);
  if (!trace || trace.source === 'ksef_inbox') return null;
  return foreignCode(trace.currency);
}

/**
 * Kod waluty, w której są kwoty kosztu OCR, dopóki nie ma ich w złotych:
 * dokument w walucie obcej bez kursu NBP (`fx`) i bez potwierdzenia klienta.
 * `null` = kwoty w złotych.
 */
export function ocrAmountsAwaitingPln(raw: Json | null | undefined): string | null {
  const currency = ocrForeignCurrency(raw);
  if (!currency) return null;
  const trace = asObject(raw)!;
  if (asObject(trace.fx) || asObject(trace[PLN_CONFIRMATION_KEY])) return null;
  return currency;
}

/** Kwota brutto z dokumentu (w jego walucie), jeśli ślad ją ma. */
export function ocrDocumentGross(raw: Json | null | undefined): number | null {
  const gross = asObject(raw)?.gross_amount;
  return typeof gross === 'number' && Number.isFinite(gross) ? gross : null;
}

/** Ślad z potwierdzeniem, że kwoty są w złotych; oryginalny odczyt bez zmian. */
export function withPlnConfirmation(
  raw: Json | null | undefined,
  confirmedBy: string,
  confirmedAt: string,
): Json {
  return {
    ...(asObject(raw) ?? {}),
    [PLN_CONFIRMATION_KEY]: { confirmed_by: confirmedBy, confirmed_at: confirmedAt },
  };
}

export interface ExpenseAmountsSource {
  source: string | null;
  ksef_invoice_id: string | null;
  issue_date: string;
  ocr_extracted_data: Json | null;
}

/**
 * Waluta kwot wiersza `expenses` dla list: `'PLN'` albo kod waluty, gdy kwoty
 * nie są przeliczone. OCR: bez kursu i bez potwierdzenia klienta. KSeF: ślad
 * waluty bez potwierdzonego kursu (jak `hasKsefCurrencyRate`). Koszt KSeF bez
 * śladu (sprzed obsługi walut) lista traktuje jak złote, bo nie zna waluty
 * faktury; formularz bierze ją z faktury.
 */
export function expenseAmountsCurrency(expense: ExpenseAmountsSource): string {
  if (expense.source === 'ksef_inbox' || expense.ksef_invoice_id !== null) {
    const trace = asObject(expense.ocr_extracted_data);
    const currency = trace?.source === 'ksef_inbox' ? foreignCode(trace.currency) : null;
    if (!currency) return HOME_CURRENCY;
    return hasKsefCurrencyRate(expense.ocr_extracted_data, currency, expense.issue_date)
      ? HOME_CURRENCY
      : currency;
  }
  return ocrAmountsAwaitingPln(expense.ocr_extracted_data) ?? HOME_CURRENCY;
}

/** Jednostka przy kwocie: „zł” dla złotych, inaczej kod waluty. */
export function amountUnit(currency: string): string {
  return currency === HOME_CURRENCY ? 'zł' : currency;
}
