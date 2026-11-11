/**
 * Nagłówek Content-Disposition dla pobieranych plików (RFC 6266 / RFC 5987).
 *
 * Wartość nagłówka musi być ByteString (Latin-1), więc nazwa z „Ł” czy „ś” wywracała
 * konstruktor odpowiedzi (F12-E7). Wysyłamy zapas ASCII w `filename="..."` oraz pełną
 * nazwę w `filename*=UTF-8''...`.
 */

/** Zapas ASCII: NFD bez znaków łączących, ł→l, Ł→L, reszta spoza 0x20-0x7E, `"` i `\` → `_`. */
function asciiFallback(filename: string): string {
  return filename
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .replace(/[^\x20-\x7e]|["\\]/g, '_');
}

/** Kodowanie procentowe z RFC 5987 (`encodeURIComponent` zostawia `'()*`). */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function attachmentDisposition(filename: string): string {
  return `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

/** Nazwa pliku z nagłówka: najpierw `filename*=UTF-8''`, potem `filename="..."`, na końcu `fallback`. */
export function filenameFromDisposition(header: string | null | undefined, fallback: string): string {
  const cd = header ?? '';
  const star = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (star) {
    try {
      const decoded = decodeURIComponent(star.trim());
      if (decoded) return decoded;
    } catch {
      // zły ciąg procentowy: spróbuj zwykłej postaci
    }
  }
  const plain = cd.match(/filename="(.+?)"/)?.[1];
  return plain || fallback;
}
