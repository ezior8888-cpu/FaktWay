/**
 * Nazwa kontrahenta do list w małych kartach (plan Finora §7.2): forma
 * prawna skrócona, bo KSeF podaje pełne („spółka z ograniczoną
 * odpowiedzialnością” → „sp. z o.o.”). Moduł bez importów — działa na
 * serwerze i w przeglądarce. Wielkość liter reszty nazwy bez zmian.
 */

const LEGAL_FORMS: ReadonlyArray<[RegExp, string]> = [
  [/spółka\s+z\s+ograniczoną\s+odpowiedzialnością\s+spółka\s+komandytowa/giu, 'sp. z o.o. sp.k.'],
  [/spółka\s+z\s+ograniczoną\s+odpowiedzialnością/giu, 'sp. z o.o.'],
  [/prosta\s+spółka\s+akcyjna/giu, 'P.S.A.'],
  [/spółka\s+komandytowo[-\s]akcyjna/giu, 'S.K.A.'],
  [/spółka\s+akcyjna/giu, 'S.A.'],
  [/spółka\s+komandytowa/giu, 'sp.k.'],
  [/spółka\s+jawna/giu, 'sp.j.'],
  [/spółka\s+partnerska/giu, 'sp.p.'],
  [/spółka\s+cywilna/giu, 's.c.'],
];

export function shortCompanyName(name: string): string {
  let out = name.replace(/\s+/g, ' ').trim();
  for (const [pattern, short] of LEGAL_FORMS) out = out.replace(pattern, short);
  return out;
}
