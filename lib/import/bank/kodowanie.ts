import iconv from 'iconv-lite';

/**
 * Odczyt tekstu wyciągu (krok 3.2). Banki podają różne strony kodowe:
 * PKO BP i ING w MT940 CP852, mBank ISO 8859-2, raport Elixir PKO BP
 * Windows-1250, CAMT.053 zwykle UTF-8 z deklaracją w nagłówku XML.
 *
 * Kolejność: UTF-8 (także czysty ASCII), potem kodowanie z deklaracji XML,
 * a gdy jej nie ma, ta z trzech stron kodowych, która daje najwięcej polskich
 * liter i najmniej znaków, których w wyciągu nie ma (ramki, znaki sterujące,
 * litery spoza polskiego). Kodowanie dotyczy tylko nazw i tytułów: kwoty, daty
 * i numery są w ASCII, więc zła strona kodowa nie zmieni zapisanej wpłaty.
 */

const CANDIDATES = ['cp852', 'iso-8859-2', 'win1250'] as const;
const POLISH_LETTERS = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g;
/** Znaki spoza ASCII, które bywają w wyciągu: polskie litery, twarda spacja, znak pustego pola „˙”, cudzysłowy, euro, paragraf. */
const EXPECTED_NON_ASCII = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ\u00A0\u02D9\u00FF„”‘’€§°]/g;
const NON_ASCII = /[^\x00-\x7F]/g;

function score(text: string): number {
  const polish = text.match(POLISH_LETTERS)?.length ?? 0;
  const other = (text.match(NON_ASCII)?.length ?? 0) - (text.match(EXPECTED_NON_ASCII)?.length ?? 0);
  return polish - 2 * other;
}

export function decodeBankText(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // nie UTF-8: szukamy strony kodowej niżej
  }
  const declared = /^\s*<\?xml[^>]*encoding=["']([A-Za-z0-9_.:-]+)["']/.exec(buffer.subarray(0, 200).toString('latin1'))?.[1];
  if (declared && iconv.encodingExists(declared)) return iconv.decode(buffer, declared);

  let best = '';
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const encoding of CANDIDATES) {
    const text = iconv.decode(buffer, encoding);
    const value = score(text);
    if (value > bestScore) {
      best = text;
      bestScore = value;
    }
  }
  return best;
}
