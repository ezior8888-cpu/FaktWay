/**
 * Identyfikator zbiorczy KSeF (plan kompletnej aplikacji, krok 1.4, część 2;
 * rejestr przepisów RP-PLAT-02).
 *
 * Od płatności z 1.01.2027 płacący za kilka faktur jednego sprzedawcy jednym
 * przelewem podaje w tytule identyfikator zbiorczy nadany przez KSeF zamiast
 * numerów KSeF tych faktur (art. 108g ustawy o VAT w brzmieniu z Dz.U. 2025
 * poz. 1203; strona MF „Numer KSeF i zbiorczy identyfikator”). Identyfikator
 * nadaje KSeF (`POST /collective-identifiers`, `lib/ksef/identyfikator-zbiorczy.ts`);
 * ten moduł tylko sprawdza, czy napis jest spójny.
 *
 * Format ze specyfikacji KSeF 2.0 (OpenAPI, pole
 * `GenerateCollectiveIdentifierResponse.collectiveIdentifierNumber`):
 * 35 znaków `9999999999-IZRRRRMM-FFFFFFFFFFFF-FF`:
 *  - 10 cyfr NIP sprzedawcy,
 *  - stałe `IZ`, rok i miesiąc utworzenia,
 *  - 12 znaków HEX (wielkie litery),
 *  - suma kontrolna CRC-8 (wielomian 0x07, start 0x00, bez odbicia i bez XOR
 *    na końcu) jako 2 znaki HEX.
 * Specyfikacja nie mówi, z których znaków liczyć sumę. Wektor z dokumentacji
 * (`1111111111-IZ202607-65ED02180000-E7`) pasuje tylko do sumy po pierwszych
 * 32 znakach razem z myślnikami (bez myślników wychodzi D7). Test:
 * `tests/unit/identyfikator-zbiorczy.test.ts`.
 *
 * Walidator sprawdza spójność, nie istnienie w KSeF: istnienie potwierdza
 * tylko odpowiedź KSeF.
 *
 * Moduł bez importów: działa na serwerze (odpowiedź KSeF, odczyt z bazy)
 * i w przeglądarce (lista „Do zapłaty”).
 */

/** Długość identyfikatora (`minLength` i `maxLength` w specyfikacji). */
export const DLUGOSC_IDENTYFIKATORA_ZBIORCZEGO = 35;
/** Identyfikator obejmuje co najmniej dwie faktury (`invoices` min. 2). */
export const MIN_FAKTUR_W_IDENTYFIKATORZE = 2;
/** Domyślny limit faktur w jednym identyfikatorze (limity kontekstu KSeF). */
export const MAKS_FAKTUR_W_IDENTYFIKATORZE = 500;
/** Jedna faktura może być w najwyżej tylu identyfikatorach w kontekście (błąd 71002). */
export const MAKS_IDENTYFIKATOROW_FAKTURY = 132;

/**
 * Wzorzec ze specyfikacji, z `[0-9]` zamiast `\d` jak w `WZORZEC_NUMERU_KSEF`
 * (`lib/invoices/tytul-przelewu.ts`): zwykłe cyfry, bez cyfr innych pism.
 * Rok od 2000, miesiąc 01-12.
 */
export const WZORZEC_IDENTYFIKATORA_ZBIORCZEGO = '[1-9][0-9]{9}-IZ20[0-9]{2}(0[1-9]|1[0-2])-[0-9A-F]{12}-[0-9A-F]{2}';

const IDENTYFIKATOR = new RegExp(`^(?:${WZORZEC_IDENTYFIKATORA_ZBIORCZEGO})$`);
/** Białe znaki, które `xsd:token` zdejmuje z brzegów: spacja, tabulator, CR, LF. */
const BRZEGI_XSD = /^[ \t\r\n]+|[ \t\r\n]+$/g;
/** Liczba znaków, z których liczona jest suma (NIP, IZ z datą i część HEX, z myślnikami). */
const ZNAKI_SUMY = 32;

/**
 * CRC-8 (wielomian 0x07, start 0x00) po kodach znaków ASCII, jako 2 znaki HEX
 * wielkimi literami. Liczone bit po bicie: identyfikator ma 32 znaki, tablica
 * niczego nie przyspieszy.
 */
export function sumaKontrolnaIdentyfikatora(poczatek: string): string {
  let crc = 0;
  for (let i = 0; i < poczatek.length; i++) {
    crc ^= poczatek.charCodeAt(i) & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Identyfikator zbiorczy zgodny z formatem i sumą kontrolną, bez białych
 * znaków z brzegów, albo `null` (brak, inny typ, zły format, zła suma).
 */
export function poprawnyIdentyfikatorZbiorczy(wartosc: unknown): string | null {
  if (typeof wartosc !== 'string') return null;
  const identyfikator = wartosc.replace(BRZEGI_XSD, '');
  if (identyfikator.length !== DLUGOSC_IDENTYFIKATORA_ZBIORCZEGO || !IDENTYFIKATOR.test(identyfikator)) return null;
  const suma = sumaKontrolnaIdentyfikatora(identyfikator.slice(0, ZNAKI_SUMY));
  return identyfikator.slice(ZNAKI_SUMY + 1) === suma ? identyfikator : null;
}

/** NIP sprzedawcy z poprawnego identyfikatora (pierwsze 10 cyfr). */
export function nipZIdentyfikatora(identyfikator: string): string {
  return identyfikator.slice(0, 10);
}
