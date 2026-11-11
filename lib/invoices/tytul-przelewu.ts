/**
 * Tytuł przelewu z numerem KSeF (plan kompletnej aplikacji, krok 1.4;
 * rejestr przepisów RP-PLAT-01 i RP-PLAT-03).
 *
 * Od 1.01.2027 płacący za fakturę wystawioną w KSeF podaje w tytule przelewu
 * jej numer KSeF, także w MPP; przy kilku fakturach identyfikator zbiorczy
 * (strona MF „Numer KSeF i zbiorczy identyfikator”, zmiana 06.02.2026).
 * Obowiązek ma płacący, a FaktWay tylko podsuwa gotowy tytuł, więc podpowiedź
 * nie zależy od daty: przed 2027 r. nikomu nie szkodzi. Identyfikator
 * zbiorczy to osobny krok.
 *
 * Zasady tytułu:
 *  - numer KSeF jest pierwszy, w całości i dokładnie raz;
 *  - numer faktury dochodzi po spacji, jeśli całość mieści się w 140 znakach
 *    (4 wiersze po 35 znaków w przelewie Elixir); inaczej sam numer KSeF;
 *  - numer faktury, w którym już jest numer KSeF (np. numer zastępczy z KSeF),
 *    nie dochodzi, żeby w tytule był jeden numer KSeF;
 *  - faktura z MPP: sam numer KSeF, bo w komunikacie MPP numer faktury idzie
 *    do pola na 35 znaków, a numer KSeF ma 35 znaków;
 *  - bez numeru KSeF albo z numerem spoza wzorca: sam numer faktury, jak przed
 *    tą zmianą.
 *
 * Moduł bez importów: działa na serwerze (PDF, maile) i w przeglądarce (ekran
 * faktury). Testy: `tests/unit/tytul-przelewu.test.ts`.
 */

/**
 * Wzorzec `TNumerKSeF` ze schematu FA(3) (`lib/xml/schemas/fa3/schemat.xsd`;
 * ten sam jest w JPK_V7M(3), JPK_EWP(4) i JPK_PKPIR(3)). Jedyna różnica:
 * `\d` ze schematu zapisane jako `[0-9]`. W XSD `\d` obejmuje cyfry wszystkich
 * pism, a numer w tytule przelewu ma mieć zwykłe cyfry, więc tu jest ostrzej
 * niż w schemacie. Zgodność ze schematem sprawdza test.
 */
export const WZORZEC_NUMERU_KSEF =
  '([1-9](([0-9][1-9])|([1-9][0-9]))[0-9]{7}|M[0-9]{9}|[A-Z]{3}[0-9]{7})' +
  '-(20[2-9][0-9]|2[1-9][0-9]{2}|[3-9][0-9]{3})(0[1-9]|1[0-2])(0[1-9]|[1-2][0-9]|3[0-1])' +
  '-([0-9A-F]{6})-?([0-9A-F]{6})-([0-9A-F]{2})';

/** Wzorzec XSD obejmuje cały napis. */
const NUMER_KSEF = new RegExp(`^(?:${WZORZEC_NUMERU_KSEF})$`);
/** Ten sam wzorzec w dowolnym miejscu napisu: numer KSeF wewnątrz numeru faktury. */
const NUMER_KSEF_W_TEKSCIE = new RegExp(WZORZEC_NUMERU_KSEF);
/** Białe znaki, które `xsd:token` zdejmuje z brzegów: spacja, tabulator, CR, LF. */
const BRZEGI_XSD = /^[ \t\r\n]+|[ \t\r\n]+$/g;

/** Elixir: tytuł przelewu to 4 wiersze po 35 znaków. */
export const MAKS_DLUGOSC_TYTULU_PRZELEWU = 140;

/**
 * Numer KSeF zgodny z `TNumerKSeF`, bez białych znaków z brzegów, albo `null`
 * (brak numeru, inny typ, numer spoza wzorca).
 */
export function poprawnyNumerKsef(wartosc: unknown): string | null {
  if (typeof wartosc !== 'string') return null;
  const numer = wartosc.replace(BRZEGI_XSD, '');
  return NUMER_KSEF.test(numer) ? numer : null;
}

export interface OpcjeTytulu {
  /** Faktura z mechanizmem podzielonej płatności (P_18A = 1). */
  mpp?: boolean;
}

/**
 * Tytuł przelewu dla faktury. Z poprawnym numerem KSeF: numer KSeF, spacja
 * i numer faktury (albo sam numer KSeF, gdy całość przekroczyłaby 140 znaków
 * albo faktura ma MPP). Bez poprawnego numeru KSeF: `numerFaktury` bez zmian,
 * jak przed krokiem 1.4.
 */
export function tytulPrzelewu(
  numerFaktury: string,
  numerKsef: string | null | undefined,
  opcje: OpcjeTytulu = {},
): string {
  const ksef = poprawnyNumerKsef(numerKsef);
  if (!ksef) return numerFaktury;
  if (opcje.mpp) return ksef;
  const numer = numerFaktury.trim();
  if (!numer || NUMER_KSEF_W_TEKSCIE.test(numer)) return ksef;
  const tytul = `${ksef} ${numer}`;
  return tytul.length <= MAKS_DLUGOSC_TYTULU_PRZELEWU ? tytul : ksef;
}

/** Dane płatności z dokumentu, od których zależy wiersz „Tytuł przelewu”. */
export interface PlatnoscDokumentu extends OpcjeTytulu {
  /** Sposób zapłaty z `payment_data.method`; przelew to `transfer`. */
  metoda: string | null | undefined;
  /** Kwota „Do zapłaty” z tego samego dokumentu. */
  doZaplaty: number;
}

/**
 * Tytuł przelewu dla dokumentów, które przed krokiem 1.4 nie miały takiego
 * wiersza: PDF faktury, mail z fakturą, ekran faktury. `null` znaczy „bez
 * wiersza, dokument jak dotąd”: brak poprawnego numeru KSeF (szkic, wysyłka
 * w toku, odrzucona, poza KSeF), zapłata inna niż przelew albo nic do zapłaty
 * (np. korekta na minus, faktura rozliczeniowa pokryta zaliczkami).
 */
export function tytulPrzelewuNaDokumencie(
  numerFaktury: string,
  numerKsef: string | null | undefined,
  platnosc: PlatnoscDokumentu,
): string | null {
  if (!poprawnyNumerKsef(numerKsef)) return null;
  if (platnosc.metoda !== 'transfer') return null;
  if (!Number.isFinite(platnosc.doZaplaty) || platnosc.doZaplaty <= 0) return null;
  return tytulPrzelewu(numerFaktury, numerKsef, { mpp: platnosc.mpp });
}
