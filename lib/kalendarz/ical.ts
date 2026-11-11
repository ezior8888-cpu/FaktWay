/**
 * Generator iCalendar (RFC 5545) dla adresu kalendarza klienta (krok 7.3
 * planu kompletnej aplikacji). Funkcje czyste: ten sam zestaw zdarzeń daje te
 * same UID-y, a czas generowania wchodzi wyłącznie do DTSTAMP.
 *
 * - Linie kończą się CRLF; dłuższe niż 75 oktetów są zawijane (CRLF + spacja)
 *   na granicy znaku UTF-8, nigdy w środku znaku wielobajtowego.
 * - Wartości tekstowe są uciekane (`\\`, `\;`, `\,`, nowy wiersz jako `\n`),
 *   więc tekst z faktury nie wstrzyknie własnej właściwości.
 * - Zdarzenia całodniowe (`DTSTART;VALUE=DATE`), bez godzin: termin płatności
 *   i podatku to dzień, nie godzina.
 */

export interface ZdarzenieIcal {
  /** Stabilny między pobraniami; klient kalendarza po nim rozpoznaje wpis. */
  uid: string;
  /** RRRR-MM-DD. */
  data: string;
  tytul: string;
  opis: string;
}

const LIMIT_OKTETOW = 75;
const CRLF = '\r\n';

/** Ucieczka wartości TEXT (RFC 5545, 3.3.11); każdy rodzaj nowego wiersza to `\n`. */
export function ucieknijTekst(tekst: string): string {
  return tekst
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Zawija linię do 75 oktetów. Kontynuacja zaczyna się spacją, która też liczy
 * się do limitu, więc zawartość kontynuacji ma najwyżej 74 oktety.
 */
export function zawinLinie(linia: string): string {
  if (Buffer.byteLength(linia, 'utf8') <= LIMIT_OKTETOW) return linia;
  const fizyczne: string[] = [];
  let biezaca = '';
  let oktety = 0;
  let limit = LIMIT_OKTETOW;
  for (const znak of linia) {
    const rozmiar = Buffer.byteLength(znak, 'utf8');
    if (oktety + rozmiar > limit) {
      fizyczne.push(biezaca);
      biezaca = ' ';
      oktety = 1;
      limit = LIMIT_OKTETOW;
    }
    biezaca += znak;
    oktety += rozmiar;
  }
  fizyczne.push(biezaca);
  return fizyczne.join(CRLF);
}

function dataBezMyslnikow(iso: string): string {
  return iso.replace(/-/g, '');
}

function znacznikCzasu(teraz: Date): string {
  return teraz.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** UID wchodzi do pliku bez ucieczki, więc nie wpuszczamy do niego znaków sterujących ani spacji. */
function bezpiecznyUid(uid: string): string {
  return uid.replace(/[^A-Za-z0-9@._-]/g, '-');
}

export function zbudujKalendarz(wejscie: {
  nazwa: string;
  zdarzenia: readonly ZdarzenieIcal[];
  teraz: Date;
}): string {
  const stempel = znacznikCzasu(wejscie.teraz);
  const posortowane = [...wejscie.zdarzenia].sort(
    (a, b) => a.data.localeCompare(b.data) || a.uid.localeCompare(b.uid),
  );

  const linie: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FaktWay//Terminy firmy//PL',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${ucieknijTekst(wejscie.nazwa)}`,
    // Podpowiedź dla klientów kalendarza: odświeżaj co godzinę (RFC 7986).
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const z of posortowane) {
    linie.push(
      'BEGIN:VEVENT',
      `UID:${bezpiecznyUid(z.uid)}`,
      `DTSTAMP:${stempel}`,
      `DTSTART;VALUE=DATE:${dataBezMyslnikow(z.data)}`,
      `SUMMARY:${ucieknijTekst(z.tytul)}`,
      `DESCRIPTION:${ucieknijTekst(z.opis)}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  linie.push('END:VCALENDAR');

  return linie.map(zawinLinie).join(CRLF) + CRLF;
}
