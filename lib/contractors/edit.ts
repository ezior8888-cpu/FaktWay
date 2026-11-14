import { z } from 'zod';

import { sanitizeSearch } from '@/lib/invoices/list-query';
import { FA3_TEXT_LIMITS, isXmlSafe, liczbaZnakow, NO_CONTROL_CHARS_MESSAGE } from '@/lib/xml/fa3-limits';

/**
 * Kontrahenci — edycja, usuwanie i wyszukiwanie (F-011 w raporcie audytu
 * bloku 1). Do 02.10.2026 baza kontrahentów była tylko pamięcią wyszukiwań
 * w GUS: bez edycji, usuwania i wyszukiwania, a dane z GUS nigdy się nie
 * odświeżały i nie dało się ich poprawić.
 */

// Nazwa i adres kontrahenta trafiają do Podmiot2 faktury: granice XSD
// i znaki sterujące z modułu granic (C1), jak w danych firmy.
const text = (min: number, required: string, max: number) =>
  z
    .string()
    .refine(isXmlSafe, NO_CONTROL_CHARS_MESSAGE)
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(min, required).max(max, `Maksymalnie ${liczbaZnakow(max)}`));

export const contractorEditSchema = z.object({
  name: text(1, 'Podaj nazwę kontrahenta', FA3_TEXT_LIMITS.nazwa.max),
  addressLine1: text(0, '', FA3_TEXT_LIMITS.adresL1.max),
  addressLine2: text(0, '', FA3_TEXT_LIMITS.adresL2.max),
  email: z.union([z.literal(''), z.string().trim().email('Nieprawidłowy adres e-mail')]),
});

export type ContractorEditInput = z.input<typeof contractorEditSchema>;
export type ContractorEdit = z.output<typeof contractorEditSchema>;

/**
 * Pola poprawione ręcznie — trafiają do `contractors.manual_fields` (00064),
 * żeby nocne odświeżanie z rejestrów nie cofnęło poprawki klienta.
 */
export function changedContractorFields(
  before: { name: string | null; address: { addressLine1?: string; addressLine2?: string } | null; email: string | null },
  after: ContractorEdit,
): Array<'name' | 'address' | 'email'> {
  const changed: Array<'name' | 'address' | 'email'> = [];
  if ((before.name ?? '') !== after.name) changed.push('name');
  if (
    (before.address?.addressLine1 ?? '') !== after.addressLine1 ||
    (before.address?.addressLine2 ?? '') !== after.addressLine2
  ) {
    changed.push('address');
  }
  if ((before.email ?? '') !== after.email) changed.push('email');
  return changed;
}

/** Warunek `or()` wyszukiwania kontrahentów: nazwa albo NIP. `null` = bez frazy. */
export function contractorSearchFilter(q: string): string | null {
  const term = sanitizeSearch(q);
  if (!term) return null;
  const parts = [`name.ilike.%${term}%`];
  const digits = term.replace(/[\s-]/g, '');
  if (/^\d{2,10}$/.test(digits)) parts.push(`nip.ilike.%${digits}%`);
  return parts.join(',');
}
