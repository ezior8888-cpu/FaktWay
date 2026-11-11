/**
 * Tekst z wyciągów (krok 3.2): czyszczenie pól, sklejanie kawałków stałej
 * długości i zapis do porównań. Bez zależności serwerowych, więc bierze go też
 * ekran (przez `dopasowanie.ts`); odczyt stron kodowych jest w `kodowanie.ts`.
 */

/** Znaki pustego pola i twarda spacja zamieniane na spację, białe znaki zwinięte; pusty napis to `null`. */
export function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u00A0\u02D9\u00FF]/g, ' ').replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/**
 * Pola dzielone przez bank na kawałki stałej długości (MT940: 27 znaków,
 * Elixir: 35): gdy poprzedni kawałek ma pełną długość, następny jest dalszym
 * ciągiem tego samego słowa i dochodzi bez spacji (PKO BP: „jeżeli pole nie
 * jest puste, poprzednie ma długość 27 znaków”). Krótszy kawałek kończy
 * linię, więc następny dochodzi po spacji. Puste kawałki pomijamy.
 */
export function joinPieces(pieces: readonly string[], width: number): string | null {
  let out = '';
  let previousFull = false;
  for (const piece of pieces) {
    if (cleanText(piece) === null) continue;
    out += out === '' || previousFull ? piece : ` ${piece}`;
    previousFull = piece.length >= width;
  }
  return cleanText(out);
}

/** Wielkie litery bez polskich znaków: do porównań numerów i nazw, nie do wyświetlania. */
export function foldText(value: string): string {
  return value
    .toUpperCase()
    .replace(/Ł/g, 'L')
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '');
}
