import { hasKsefCurrencyRate } from '@/lib/expenses/ksef-currency-review';
import { documentCurrency, HOME_CURRENCY } from '@/lib/ocr/currency';
import type { Json } from '@/types/database';

/**
 * W jakiej walucie są kwoty zapisane przy koszcie (`net_amount`, `vat_amount`,
 * `gross_amount`): `'PLN'`, kod waluty obcej albo `null`, gdy nie wiadomo.
 * Kwot w walucie obcej nie wolno podpisać „zł” (portal księgowej, krok 6.2).
 *
 * Koszt z KSeF: waluta faktury zakupu. W walucie obcej runner skrzynki
 * zapisuje złote tylko ze śladem kursu NBP (`hasKsefCurrencyRate`), bez niego
 * kwoty zostają w walucie faktury: ta sama reguła co jednostka kwot na
 * ekranie wydatku (`components/expenses/expense-edit-form.tsx`). Brak albo zły
 * kod waluty faktury to `null`.
 *
 * Koszt ze zdjęcia: bez kursu NBP odczyt zapisuje kwoty w walucie dokumentu
 * i wyłącza koszt z KPiR (`process-ocr`, `costInPln`). Złote są więc przy
 * walucie PLN, przy śladzie kursu (`fx`) albo gdy koszt liczy się do KPiR
 * (włączyć go mógł tylko człowiek po poprawie kwot).
 */
export interface ExpenseAmountsFields {
  source: string;
  ksef_invoice_id: string | null;
  issue_date: string;
  is_deductible: boolean | null | undefined;
  ocr_extracted_data: Json | null | undefined;
}

function objectOf(value: Json | null | undefined): Record<string, Json | undefined> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function expenseAmountsCurrency(
  expense: ExpenseAmountsFields,
  ksefInvoiceCurrency: string | null | undefined,
): string | null {
  if (expense.source === 'ksef_inbox' || expense.ksef_invoice_id) {
    if (!expense.ksef_invoice_id) return null;
    const currency = ksefInvoiceCurrency?.trim().toUpperCase() ?? '';
    if (!/^[A-Z]{3}$/.test(currency)) return null;
    if (currency === HOME_CURRENCY) return HOME_CURRENCY;
    return hasKsefCurrencyRate(expense.ocr_extracted_data ?? null, currency, expense.issue_date)
      ? HOME_CURRENCY
      : currency;
  }

  const trail = objectOf(expense.ocr_extracted_data);
  const rawCurrency = trail?.currency;
  const currency = documentCurrency({ currency: typeof rawCurrency === 'string' ? rawCurrency : null });
  if (currency === HOME_CURRENCY || trail?.fx || expense.is_deductible === true) return HOME_CURRENCY;
  return currency;
}
