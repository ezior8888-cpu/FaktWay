/**
 * Tekst z HTML-a z `renderToStaticMarkup` bez znaczników — tak, jak go czyta
 * użytkownik (i Playwright w nazwie przycisku). Skan znak po znaku zamiast
 * `replace(/<[^>]+>/g, '')`: CodeQL (js/incomplete-multi-character-sanitization)
 * odrzuca jednorazowe zdzieranie znaczników wyrażeniem regularnym.
 */
export function tekstBezZnacznikow(html: string): string {
  let out = '';
  let inTag = false;
  for (const ch of html) {
    if (ch === '<') inTag = true;
    else if (ch === '>' && inTag) inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}
