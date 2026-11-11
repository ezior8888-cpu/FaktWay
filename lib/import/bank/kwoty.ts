/**
 * Kwoty z wyciągów bankowych w groszach, na liczbach całkowitych (krok 3.2).
 *
 * Każdy format ma własny, ścisły zapis i własną funkcję. Napis spoza zapisu
 * to `null`, a nie zgadywanie: parser przerywa wtedy cały plik. Więcej niż dwa
 * miejsca po przecinku to też `null`, bo kolumna wpłat ma grosze, a cicho
 * zaokrąglona kwota trafiłaby do zapisu zapłaty.
 *
 * `lib/import/csv-parsers/` (import faktur z innych programów) poprawia równolegle
 * sesja S-10; po jej scaleniu warto ujednolicić zapis polski w jednym miejscu.
 */

/** Najwięcej groszy, które liczymy dokładnie (15 cyfr, jak NUMERIC(15,2) w bazie). */
const MAX_DIGITS = 15;

function grosze(whole: string, fraction: string): number | null {
  const digits = `${whole.replace(/^0+(?=\d)/, '')}${fraction.padEnd(2, '0')}`;
  if (digits.length > MAX_DIGITS) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

/** Spacja, twarda spacja i wąska twarda spacja jako separator tysięcy. */
const THOUSANDS = '[ \\u00A0\\u202F]';
const POLISH = new RegExp(`^([+\\-\\u2212]?)(\\d{1,3}(?:${THOUSANDS}\\d{3})+|\\d+)(?:,(\\d{1,2}))?$`);

/**
 * Zapis polski: „-1 234,56”, „1234,5”, „1 234”, „−5,00” (minus typograficzny).
 * Separator tysięcy tylko co trzy cyfry, przecinek dziesiętny, najwyżej dwa
 * miejsca. Kropka (ani jako tysiące, ani jako przecinek) to `null`.
 */
export function groszeZKwotyPolskiej(text: string): number | null {
  const m = POLISH.exec(text.trim());
  if (!m) return null;
  const value = grosze(m[2]!.replace(new RegExp(THOUSANDS, 'g'), ''), m[3] ?? '');
  if (value === null) return null;
  // „-0,00” to zero, a nie -0.
  return (m[1] === '-' || m[1] === '\u2212') && value !== 0 ? -value : value;
}

/** SWIFT MT940 (pole :61:, :60F:): „449,77”, „10000,” (przecinek zawsze, bez znaku). */
export function groszeZKwotySwift(text: string): number | null {
  const m = /^(\d{1,15}),(\d{0,2})$/.exec(text);
  return m ? grosze(m[1]!, m[2]!) : null;
}

/** ISO 20022 (CAMT.053, `Amt`): „490879.24”, „20”, bez znaku i bez wykładnika. */
export function groszeZKwotyXml(text: string): number | null {
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(text);
  return m ? grosze(m[1]!, m[2] ?? '') : null;
}

/** Liczba groszy bez znaku (raport Elixir PKO BP, pole 3). */
export function groszeZLiczbyGroszy(text: string): number | null {
  if (!/^\d{1,15}$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** Grosze jako napis kwoty z kropką („12345.67”, „-0.30”) dla RPC: bez liczb zmiennoprzecinkowych. */
export function kwotaZGroszy(value: number): string {
  if (!Number.isSafeInteger(value)) throw new RangeError('Kwota spoza zakresu');
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
