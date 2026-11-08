import type { FieldErrors } from 'react-hook-form';

import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

/** Pierwszy komunikat z drzewa błędów walidacji — do toastu przy zapisie i wysyłce. */
export function firstValidationMessage(errors: FieldErrors<InvoiceFormValues>): string {
  const walk = (node: unknown): string | null => {
    if (!node || typeof node !== 'object') return null;
    const o = node as Record<string, unknown>;
    if (typeof o.message === 'string' && o.message.length) return o.message;
    if (Array.isArray(o)) {
      for (const item of o) {
        const m = walk(item);
        if (m) return m;
      }
      return null;
    }
    for (const v of Object.values(o)) {
      const m = walk(v);
      if (m) return m;
    }
    return null;
  };
  return walk(errors) ?? 'Sprawdź pola formularza (czerwone podpowiedzi).';
}
