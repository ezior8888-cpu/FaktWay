/**
 * Plik Elixir-0 w Windows-1250 (krok 3.4, część 2): rekordy z CR LF po
 * każdym, także po ostatnim, bez nagłówka (ING Business, rozdział II).
 * Tylko po stronie serwera (`iconv-lite`).
 *
 * `iconv-lite` zamienia znak spoza strony kodowej na „?” bez błędu, więc
 * przed kodowaniem sprawdzamy każdy znak: tekst idzie przez `tekstElixir`,
 * a gdyby coś się prześlizgnęło, plik nie powstaje (zamiast cichej zmiany
 * nazwy albo tytułu).
 */

import iconv from 'iconv-lite';

const ZNAK_1250 = /^[\x20-\x7e]$/;

export function zakodujPlikElixir(rekordy: readonly string[]): Uint8Array {
  const tekst = rekordy.map((r) => `${r}\r\n`).join('');
  for (const znak of tekst) {
    if (znak === '\r' || znak === '\n' || ZNAK_1250.test(znak)) continue;
    const bajty = iconv.encode(znak, 'win1250');
    if (bajty.length !== 1 || iconv.decode(bajty, 'win1250') !== znak) {
      throw new Error(`Znak spoza Windows-1250 w pliku przelewów: U+${znak.codePointAt(0)!.toString(16).toUpperCase()}`);
    }
  }
  return new Uint8Array(iconv.encode(tekst, 'win1250'));
}
