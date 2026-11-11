import { hasKsefCurrencyRate } from '@/lib/expenses/ksef-currency-review';
import type { Json } from '@/types/database';

/**
 * W jakiej walucie są kwoty zapisane przy koszcie. Ta sama reguła co
 * jednostka kwoty w karcie kosztu (`components/expenses/expense-edit-form.tsx`,
 * `grossUnit`): koszt spoza skrzynki KSeF jest w złotych; koszt ze skrzynki
 * bierze walutę z powiązanej faktury KSeF, a przy walucie obcej bez
 * potwierdzonego kursu NBP kwoty zostały w walucie faktury.
 *
 * `null` = waluty nie da się potwierdzić (brak waluty faktury). Wtedy nie
 * twierdzimy, że to złote.
 */
export function expenseAmountsCurrency(
  expense: { source: string | null; issue_date: string; ocr_extracted_data: Json | null },
  ksefInvoiceCurrency: string | null | undefined,
): string | null {
  if (expense.source !== 'ksef_inbox') return 'PLN';
  const currency = ksefInvoiceCurrency?.trim().toUpperCase();
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return null;
  if (currency === 'PLN') return 'PLN';
  return hasKsefCurrencyRate(expense.ocr_extracted_data, currency, expense.issue_date) ? 'PLN' : currency;
}
