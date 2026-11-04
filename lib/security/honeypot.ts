/**
 * Pole-pułapka w formularzach auth (`components/auth/honeypot-field.tsx`).
 * Nazwa kusi boty, a nie pasuje do niczego, co przeglądarka sama wypełnia.
 */
export const HONEYPOT_FIELD = 'website';

/** Coś w polu-pułapce (także plik zamiast tekstu) = wysłał bot. */
export function isHoneypotTripped(formData: FormData): boolean {
  const value = formData.get(HONEYPOT_FIELD);
  if (value === null) return false;
  return typeof value !== 'string' || value.trim() !== '';
}
