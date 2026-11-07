/**
 * Kody bramki MF (specyfikacja interfejsów usług JPK 5.6.0): odmowy
 * `InitUploadSigned` (400, rozdział 2.2.1) i statusy metody `Status`
 * (rozdział 2.2.4), z treścią dla klienta (bez trybu rozkazującego, D8).
 *
 * Odmowa techniczna (zły plik, szyfrowanie, schemat) to błąd po stronie
 * FaktWay: klient dostaje informację, że plik nie został złożony, a operator
 * kod i opis MF w Sentry.
 */

export type StanWysylki = 'w_toku' | 'przyjeta' | 'odrzucona';

export interface OcenaStatusu {
  stan: StanWysylki;
  /** Treść dla klienta. */
  tresc: string;
  /** Błąd po stronie FaktWay: do zgłoszenia operatorowi. */
  techniczny: boolean;
}

const TECHNICZNY = 'Plik nie został złożony z powodu błędu technicznego po stronie FaktWay. Zgłoszenie trafiło do zespołu FaktWay.';

/** Statusy zależne od klienta albo od podatnika; pozostałe 4xx są techniczne. */
const ODMOWY_KLIENTA: Readonly<Record<number, string>> = {
  419: 'Dane autoryzujące nie zgadzają się z danymi urzędu skarbowego: imię, nazwisko, data urodzenia albo kwota przychodu z zeznania sprzed dwóch lat.',
  420: 'Urząd nie ma aktualnego pełnomocnictwa ani upoważnienia dla osoby podpisującej plik.',
  422: 'Danymi autoryzującymi plik składa tylko podatnik będący osobą fizyczną. Inny podatnik składa go z podpisem kwalifikowanym albo zaufanym.',
  424: 'Tego pliku nie można złożyć z danymi autoryzującymi. Pozostaje podpis kwalifikowany albo zaufany.',
  425: 'Dane autoryzujące nie pasują do danych podatnika w pliku.',
};

export function ocenStatus(kod: number): OcenaStatusu {
  if (kod === 200) return { stan: 'przyjeta', tresc: 'Plik przyjęty. Urzędowe poświadczenie odbioru (UPO) jest gotowe.', techniczny: false };
  // 1xx: sesja trwa albo MF sprawdza plik (120). 3xx poza 300: faza przetwarzania.
  if ((kod >= 100 && kod < 200) || (kod > 300 && kod < 400)) {
    return {
      stan: 'w_toku',
      tresc: 'MF sprawdza plik. Urzędowe poświadczenie odbioru (UPO) przychodzi zwykle w ciągu kilku minut.',
      techniczny: false,
    };
  }
  // Duplikat: deklaracja jest złożona wcześniejszą wysyłką, więc to nie „nie złożono”.
  if (kod === 407 || kod === 411) {
    return {
      stan: 'odrzucona',
      tresc: 'MF ma już identyczny plik z wcześniejszej wysyłki i ta wysyłka niczego nie zmienia. Deklaracja jest złożona tamtą wysyłką.',
      techniczny: false,
    };
  }
  const klienta = ODMOWY_KLIENTA[kod];
  if (klienta) return { stan: 'odrzucona', tresc: `${klienta} Plik nie został złożony.`, techniczny: false };
  // 300 (MF nie zna numeru referencyjnego), pozostałe 4xx i kody spoza listy.
  return { stan: 'odrzucona', tresc: TECHNICZNY, techniczny: true };
}

/** Odmowy `InitUploadSigned`, które nie są błędem FaktWay. Pozostałe kody są techniczne. */
const ODMOWY_INIT: Readonly<Record<number, string>> = {
  133: 'MF nie przyjmuje już tego rodzaju dokumentu.',
  158: 'MF chwilowo nie przyjmuje kolejnych plików. Wysyłka będzie możliwa za kilka minut.',
};

export function ocenOdmoweInit(kod: number | null): OcenaStatusu {
  const tresc = kod === null ? undefined : ODMOWY_INIT[kod];
  return tresc
    ? { stan: 'odrzucona', tresc: `${tresc} Plik nie został złożony.`, techniczny: false }
    : { stan: 'odrzucona', tresc: TECHNICZNY, techniczny: true };
}

/** Numer referencyjny oryginału z opisu duplikatu (kod 170 przy `InitUploadSigned`, 407 w `Status`). */
export function numerOryginalu(opis: string): string | null {
  return /oryginału(?:\s+to|:)?\s*([0-9a-z]{16,64})/i.exec(opis)?.[1] ?? null;
}
