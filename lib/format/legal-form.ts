/**
 * Skracanie form prawnych w nazwach kontrahentów (PLAN-FINORA §7.2): KSeF daje
 * pełne formy („spółka z ograniczoną odpowiedzialnością”), które w tabeli
 * zabierają pół kolumny. Moduł bez importów — serwer i przeglądarka.
 */

/** Kolejność ma znaczenie: dłuższe formy przed krótszymi. */
const LEGAL_FORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sp[óo]łka z ograniczon[aą] odpowiedzialno[śs]ci[aą]/giu, 'sp. z o.o.'],
  [/sp[óo]łka akcyjna/giu, 'S.A.'],
];

/** Pełna forma prawna → powszechny skrót; reszta nazwy bez zmian. */
export function shortenLegalForm(name: string): string {
  let out = name;
  for (const [pattern, short] of LEGAL_FORMS) out = out.replace(pattern, short);
  return out.replace(/\s+/g, ' ').trim();
}

/** Skróty form prawnych, które nie niosą inicjału nazwy. */
const LEGAL_FORM_TOKENS: ReadonlySet<string> = new Set([
  'sp.', 'z', 'o.o.', 's.a.', 'k.', 'j.', 'p.s.a.', 'sp.k.', 'sp.j.', 'sp.p.', 'ska', 's.k.a.',
]);

/** Do dwóch wielkich liter z pierwszych znaczących słów nazwy; „?” bez nazwy. */
export function companyInitials(name: string | null | undefined): string {
  if (!name) return '?';
  const words = shortenLegalForm(name)
    .split(' ')
    .filter((word) => word !== '' && !LEGAL_FORM_TOKENS.has(word.toLowerCase()));
  const letters = words
    .map((word) => Array.from(word).find((ch) => /\p{L}|\p{N}/u.test(ch)))
    .filter((ch): ch is string => ch !== undefined)
    .slice(0, 2);
  return letters.length > 0 ? letters.join('').toLocaleUpperCase('pl-PL') : '?';
}
