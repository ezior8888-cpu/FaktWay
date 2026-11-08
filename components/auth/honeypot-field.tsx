import { HONEYPOT_FIELD } from '@/lib/security/honeypot';

export { HONEYPOT_FIELD };

/**
 * Pole-pułapka na proste boty. Człowiek go nie widzi, czytnik ekranu go
 * pomija, Tab do niego nie wchodzi, a menedżery haseł mają je ignorować.
 * Bot, który wypełnia wszystkie pola, wpisze tu coś i akcja odmówi
 * (`isHoneypotTripped`). Test: `tests/unit/pole-pulapka.test.tsx`.
 */
export function HoneypotField() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
      <label htmlFor={HONEYPOT_FIELD}>Strona internetowa</label>
      <input
        type="text"
        id={HONEYPOT_FIELD}
        name={HONEYPOT_FIELD}
        tabIndex={-1}
        autoComplete="off"
        defaultValue=""
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        data-form-type="other"
      />
    </div>
  );
}
