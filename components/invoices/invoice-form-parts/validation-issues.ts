import type { FieldErrors } from 'react-hook-form';

import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

/** Jeden błąd walidacji do listy w bloku nad akcjami (audyt dostępności, A-05). */
export interface ValidationIssue {
  /** Ścieżka pola, np. `buyerNip` albo `lines.0.name`. */
  path: string;
  /** Nazwa pola dla czytelnika, np. „NIP nabywcy”; pusta, gdy nie znamy pola. */
  label: string;
  message: string;
  /** `id` elementu w formularzu, do odnośnika i przeniesienia fokusu; brak, gdy pole nie ma `id`. */
  targetId: string | null;
}

const POLA: Record<string, { label: string; id: string }> = {
  internalNumber: { label: 'Numer faktury', id: 'internalNumber' },
  issueDate: { label: 'Data wystawienia', id: 'issue-date' },
  saleDate: { label: 'Data sprzedaży', id: 'sale-date' },
  paymentDueDate: { label: 'Termin płatności', id: 'payment-due-date' },
  buyerNip: { label: 'NIP nabywcy', id: 'buyer-nip' },
  buyerVatUe: { label: 'Numer VAT-UE nabywcy', id: 'buyer-vat-ue' },
  buyerCountryCode: { label: 'Kraj nabywcy', id: 'buyer-country' },
  buyerConsumerIdType: { label: 'Typ identyfikatora', id: 'buyer-id-type' },
  buyerPesel: { label: 'PESEL', id: 'buyer-pesel' },
  buyerIdDocument: { label: 'Numer dokumentu', id: 'buyer-id-document' },
  buyerName: { label: 'Nazwa nabywcy', id: 'buyer-name' },
  buyerAddressLine1: { label: 'Adres nabywcy (linia 1)', id: 'buyer-address-1' },
  buyerAddressLine2: { label: 'Adres nabywcy (linia 2)', id: 'buyer-address-2' },
  buyerEmail: { label: 'Email nabywcy', id: 'buyer-email' },
  paymentMethod: { label: 'Metoda płatności', id: 'payment-method' },
  bankAccount: { label: 'Numer rachunku', id: 'bank-account' },
  receiptInvoice: { label: 'Faktura do paragonu', id: 'receipt-invoice' },
  receiptNumber: { label: 'Numer paragonu', id: 'receipt-number' },
  receiptDate: { label: 'Data paragonu', id: 'receipt-date' },
  cashRegisterNumber: { label: 'Numer unikatowy kasy', id: 'cash-register-number' },
  receiptRequestDate: { label: 'Data żądania faktury', id: 'receipt-request-date' },
  buyerNipOnReceipt: { label: 'Paragon ma NIP nabywcy', id: 'buyer-nip-on-receipt' },
  notes: { label: 'Uwagi', id: 'invoice-notes' },
};

const POLA_POZYCJI: Record<string, { label: string; suffix: string }> = {
  name: { label: 'nazwa', suffix: 'name' },
  unit: { label: 'jednostka', suffix: 'unit' },
  quantity: { label: 'ilość', suffix: 'quantity' },
  unitPriceNet: { label: 'cena netto', suffix: 'unit-price' },
  vatRate: { label: 'stawka VAT', suffix: 'vat-rate' },
};

function opisPola(path: string): { label: string; targetId: string | null } {
  const poz = /^lines\.(\d+)\.(\w+)/.exec(path);
  if (poz) {
    const numer = Number(poz[1]) + 1;
    const pole = POLA_POZYCJI[poz[2]!];
    return pole
      ? { label: `Pozycja ${numer}, ${pole.label}`, targetId: `line-${poz[1]}-${pole.suffix}` }
      : { label: `Pozycja ${numer}`, targetId: null };
  }
  if (path === 'lines' || path.startsWith('lines.')) return { label: 'Pozycje', targetId: null };
  const znane = POLA[path.split('.')[0]!];
  return znane ? { label: znane.label, targetId: znane.id } : { label: '', targetId: null };
}

/** Wszystkie błędy z drzewa walidacji, w kolejności drzewa, bez powtórzeń tego samego komunikatu przy tym samym polu. */
export function collectValidationIssues(errors: FieldErrors<InvoiceFormValues>): ValidationIssue[] {
  const wynik: ValidationIssue[] = [];
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (typeof o.message === 'string' && o.message.length) {
      const { label, targetId } = opisPola(path);
      if (!wynik.some((w) => w.path === path && w.message === o.message)) {
        wynik.push({ path, label, message: o.message, targetId });
      }
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === 'ref' || k === 'message' || k === 'type' || k === 'types') continue;
      walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(errors, '');
  return wynik;
}
