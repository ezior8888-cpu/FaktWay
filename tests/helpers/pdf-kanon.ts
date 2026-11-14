import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

/**
 * Postać PDF z pdfkit niezależna od kompresji (krok 2.2 planu kompletnej
 * aplikacji: „bez logo wydruk taki sam jak dziś”).
 *
 * Bajty strumieni zależą od wersji zlib (Node 22 w CI i na produkcji, Node 24
 * na Macu), więc porównanie całych plików byłoby fałszywym alarmem. Kanon to
 * każdy obiekt po kolei: słownik bez `/Length` i skrót SHA-256 strumienia PO
 * rozpakowaniu (FlateDecode). Rozpakowana treść strony to operatory rysowania
 * (tekst, położenie, linie, obrazy), więc ten sam kanon znaczy ten sam wydruk.
 * Tabela xref i stopka pliku (przesunięcia w bajtach) są pominięte.
 *
 * Format pdfkit: `N 0 obj\n<<…>>\nstream\n<bajty>\nendstream\nendobj\n`, długość
 * bajtów w `/Length` słownika.
 */
export function kanonPdf(pdf: Buffer): string {
  const text = pdf.toString('latin1');
  const obiekty: string[] = [];
  const naglowek = /(\d+) 0 obj\n/g;
  let trafienie: RegExpExecArray | null;
  while ((trafienie = naglowek.exec(text))) {
    const start = trafienie.index + trafienie[0].length;
    const koniecObiektu = text.indexOf('\nendobj', start);
    if (koniecObiektu < 0) throw new Error(`PDF: obiekt ${trafienie[1]} bez endobj`);
    const tresc = text.slice(start, koniecObiektu);
    const strumien = tresc.indexOf('\nstream\n');
    if (strumien < 0) {
      obiekty.push(`${trafienie[1]} ${tresc}`);
      naglowek.lastIndex = koniecObiektu;
      continue;
    }
    const slownik = tresc.slice(0, strumien);
    const dlugosc = /\/Length (\d+)/.exec(slownik);
    if (!dlugosc) throw new Error(`PDF: strumień obiektu ${trafienie[1]} bez /Length`);
    const od = start + strumien + '\nstream\n'.length;
    const bajty = pdf.subarray(od, od + Number(dlugosc[1]));
    const surowe = /\/Filter \/FlateDecode/.test(slownik) ? inflateSync(bajty) : bajty;
    obiekty.push(`${trafienie[1]} ${slownik.replace(/\/Length \d+\s*/g, '')} strumień ${createHash('sha256').update(surowe).digest('hex')}`);
    naglowek.lastIndex = od + Number(dlugosc[1]);
  }
  if (obiekty.length === 0) throw new Error('PDF: brak obiektów');
  return obiekty.join('\n');
}

/** Skrót kanonu: jedna linia do porównania z wynikiem sprzed zmiany. */
export function skrotKanonuPdf(pdf: Buffer): string {
  return createHash('sha256').update(kanonPdf(pdf)).digest('hex');
}
