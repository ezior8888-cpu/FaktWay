import { addressCountryForKodUE, parseVatUe } from '@/lib/invoices/vat-ue';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { calculateLineItem } from '@/lib/xml/invoice-calculator';
import type { InvoiceLineItem } from '@/types/invoice';

import { euCountryName } from './constants';

export type VatUeHint = { tone: 'muted' | 'warn' | 'ok'; text: string };

/** Podpowiedź pod polem VAT-UE — na bieżąco, zanim schemat pokaże błąd. */
export function buildVatUeHint(buyerVatUeWatch: string): VatUeHint {
  const vatUeParsed = parseVatUe(buyerVatUeWatch);
  return !buyerVatUeWatch.trim()
    ? { tone: 'muted', text: 'Prefiks kraju i numer, np. DE123456789 (Grecja: EL).' }
    : !vatUeParsed
      ? { tone: 'warn', text: 'Niepoprawny format — dwuliterowy prefiks kraju UE i do 12 znaków numeru.' }
      : vatUeParsed.kodUE === 'PL'
        ? { tone: 'warn', text: 'To polski numer — wybierz „Firma z Polski (NIP)”.' }
        : {
            tone: 'ok',
            text: `${euCountryName(addressCountryForKodUE(vatUeParsed.kodUE)) ?? vatUeParsed.kodUE} · ${vatUeParsed.normalized}`,
          };
}

// Wyciągnięte do zmiennej, bo tej samej tablicy potrzebuje `InvoiceTotals`
// do rozbicia VAT-u na stawki. Wcześniej mapowanie żyło wyłącznie w argumencie
// `calculateInvoiceTotals`, więc podsumowanie nie miało jak zobaczyć stawek
// i liczyło VAT jako `brutto − netto`.
export function toLineItems(watchedLines: InvoiceFormValues['lines'] | undefined): InvoiceLineItem[] {
  return (
    (watchedLines ?? []) as InvoiceFormValues['lines']
  ).map<InvoiceLineItem>((line, idx) => {
    const calc = calculateLineItem({
      quantity: Number(line?.quantity) || 0,
      unitPriceNet: Number(line?.unitPriceNet) || 0,
      vatRate: line?.vatRate ?? '23',
    });
    return {
      ordinal: idx + 1,
      name: line?.name ?? '',
      unit: line?.unit ?? 'szt',
      quantity: Number(line?.quantity) || 0,
      unitPriceNet: Number(line?.unitPriceNet) || 0,
      vatRate: line?.vatRate ?? '23',
      ...calc,
    };
  });
}
