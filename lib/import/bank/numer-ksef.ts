/**
 * Numer KSeF w tytule przelewu (krok 3.2, przepis L2 z kroku 1.4).
 *
 * Wąska funkcja według wzorca `TNumerKSeF` ze schematu FA(3)
 * (`lib/xml/schemas/fa3/schemat.xsd`): identyfikator (NIP bez zera na drugiej
 * albo trzeciej pozycji, `M` + 9 cyfr albo 3 litery + 7 cyfr), data RRRRMMDD,
 * dwie grupy po 6 znaków szesnastkowych (myślnik między nimi opcjonalny)
 * i 2 znaki kontrolne. Do zastąpienia `poprawnyNumerKsef` z
 * `lib/invoices/tytul-przelewu.ts` po scaleniu #498 (tam też cyfry kontrolne).
 */

const ID = '(?:[1-9](?:\\d[1-9]|[1-9]\\d)\\d{7}|M\\d{9}|[A-Z]{3}\\d{7})';
const DAY = '(?:20[2-9]\\d|2[1-9]\\d{2}|[3-9]\\d{3})(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])';
const PATTERN = `(${ID})-(${DAY})-([0-9A-F]{6})-?([0-9A-F]{6})-([0-9A-F]{2})`;
const EXACT = new RegExp(`^${PATTERN}$`);
/** W tekście: numer oddzielony od liter i cyfr. */
const IN_TEXT = new RegExp(`(?<![0-9A-Z])${PATTERN}(?![0-9A-Z])`, 'g');
/** W tekście bez spacji (numer rozcięty przez bank na dwie linie): bez cyfry tuż przed. */
const IN_COMPACT = new RegExp(`(?<!\\d)${PATTERN}`, 'g');

const canonical = (m: RegExpMatchArray | RegExpExecArray) => `${m[1]}-${m[2]}-${m[3]}${m[4]}-${m[5]}`;

/** Zapis kanoniczny (wielkie litery, bez opcjonalnego myślnika); napis spoza wzorca to `null`. */
export function canonicalKsefNumber(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const m = EXACT.exec(value.trim().toUpperCase());
  return m ? canonical(m) : null;
}

/** Wszystkie numery KSeF z tytułu, w zapisie kanonicznym, bez powtórzeń. */
export function ksefNumbersInText(text: string | null | undefined): string[] {
  if (!text) return [];
  const upper = text.toUpperCase();
  const found = new Set<string>();
  for (const m of upper.matchAll(IN_TEXT)) found.add(canonical(m));
  for (const m of upper.replace(/\s+/g, '').matchAll(IN_COMPACT)) found.add(canonical(m));
  return [...found];
}
