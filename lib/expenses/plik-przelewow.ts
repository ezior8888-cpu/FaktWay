/**
 * Plik przelewów z listy „Do zapłaty” (plan kompletnej aplikacji, krok 3.4,
 * część 2): które z zaznaczonych kosztów wchodzą do pliku Elixir-0, z jaką
 * datą, kwotą i tytułem, a które zostają poza nim i dlaczego.
 *
 * Zasada: przy wątpliwości koszt zostaje poza plikiem z powodem i tym, co
 * zrobić, zamiast przelewu ze zgadniętą kwotą, rachunkiem albo trybem MPP.
 * Kwota, tytuł i próg białej listy pochodzą z tej samej listy co ekran
 * (`listaDoZaplaty`), więc plik nie liczy niczego inaczej niż „Do zapłaty”.
 *
 * Data wykonania: termin płatności, a gdy termin już minął (albo jest dziś):
 * dziś. Bank nie przyjmie daty z przeszłości (mBank: „musi być większa-równa
 * dacie dzisiejszej”), a zapłata w dniu terminu zostawia pieniądze na
 * rachunku do ostatniego dnia i nie spóźnia płatności.
 *
 * Biała lista (RP-BL-01): koszt ponad 15 000 zł brutto wraca z planu jako
 * kandydat ze znacznikiem `bialaLista`; akcja sprawdza rachunek świeżo
 * (metoda `check` API MF) i dopiero wynik „TAK” z zapisanym dowodem wpuszcza
 * go do pliku. Plik niczego nie oznacza jako zapłacone.
 *
 * Ten moduł to typy, stałe i teksty (biorą je ekran i akcja, bez importów
 * wykonywalnych); plan pliku jest w `plik-przelewow-plan.ts`. Testy:
 * `tests/unit/plik-przelewow-akcja.test.ts`.
 */

import type { KosztDoZaplaty, WierszKosztuDoZaplaty } from '@/lib/expenses/do-zaplaty';
import type { PrzelewElixir } from '@/lib/expenses/elixir0';

/** Najwięcej przelewów w jednym pliku: tyle przyjmuje w paczce część banków (mBank, Bank Pocztowy dla małych firm). */
export const LIMIT_PRZELEWOW_W_PLIKU = 50;

export type KodPominiecia =
  | 'nie_znaleziono'
  | 'zaplacony'
  | 'spoza_listy'
  | 'waluta'
  | 'brak_rachunku'
  | 'rachunek_zagraniczny'
  | 'rachunek_bledny'
  | 'rachunek_faktora'
  | 'mpp_nieczytelne'
  | 'problemy_odczytu'
  | 'kilka_terminow'
  | 'wplaty_czesciowe'
  | 'brak_numeru_ksef'
  | 'nazwa'
  | 'tytul'
  | 'mpp_bank'
  | 'mpp_dane'
  | 'biala_lista_nip'
  | 'biala_lista_poza'
  | 'biala_lista_blad'
  | 'biala_lista_dowod';

export interface PominietyKoszt {
  id: string;
  sprzedawca: string;
  numerFaktury: string;
  kod: KodPominiecia;
  /** Pełne zdania: co jest nie tak i co zrobić. */
  powod: string;
}

export interface PrzelewWPliku {
  id: string;
  sprzedawca: string;
  numerFaktury: string;
  kwota: number;
  dataWykonania: string;
  mpp: boolean;
  /** Dowód świeżego sprawdzenia w wykazie podatników VAT (koszt ponad 15 000 zł). */
  bialaLista: { requestId: string; dzien: string } | null;
}

export interface PodsumowaniePliku {
  nazwaPliku: string | null;
  /** Dzień pobrania w Polsce: na ten dzień jest sprawdzenie białej listy. */
  dzien: string;
  liczba: number;
  suma: number;
  /** Przelewy w MPP w pliku. */
  mpp: number;
  przelewy: PrzelewWPliku[];
  pominiete: PominietyKoszt[];
}

export type PlikPrzelewowResult =
  | { success: true; plik: { nazwa: string; base64: string } | null; podsumowanie: PodsumowaniePliku }
  | { success: false; error: string };

export interface NadawcaPliku {
  nazwa: string;
  adres: Array<string | null | undefined>;
  /** 26 cyfr (`readTenantBankAccount`). */
  rachunek: string;
}

/** Wiersz kosztu do pliku: jak na liście, z adresem sprzedawcy. */
export type WierszKosztuDoPliku = WierszKosztuDoZaplaty & { seller_address?: string | null };

export interface KandydatPrzelewu {
  koszt: KosztDoZaplaty;
  przelew: PrzelewElixir;
  /** Koszt ponad 15 000 zł: przed plikiem świeże sprawdzenie rachunku po NIP. */
  bialaLista: { nip: string } | null;
}

/** RRRR-MM-DD jako DD.MM.RRRR. */
export const dataPl = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export const W_BANKOWOSCI = 'Zapłać go w bankowości.';
const WYSZUKIWARKA = 'wyszukiwarce wykazu podatników VAT na podatki.gov.pl';

export const POWODY: Readonly<Record<Exclude<KodPominiecia, 'zaplacony' | 'waluta' | 'kilka_terminow' | 'problemy_odczytu' | 'biala_lista_poza' | 'biala_lista_blad' | 'biala_lista_dowod'>, string>> = {
  nie_znaleziono: 'Nie ma tego kosztu w aktywnej firmie. Odśwież listę „Do zapłaty” albo przełącz firmę.',
  spoza_listy:
    'Kosztu nie ma na liście „Do zapłaty”: nie pochodzi z faktury KSeF z terminem płatności albo to korekta na minus.',
  brak_rachunku: `Faktura nie podaje rachunku sprzedawcy albo numeru nie dało się odczytać. Rachunek sprawdź w fakturze. ${W_BANKOWOSCI}`,
  rachunek_zagraniczny: `Rachunek z faktury nie jest polskim numerem (NRB), a plik Elixir-0 to przelewy krajowe. ${W_BANKOWOSCI}`,
  rachunek_bledny:
    'Numer rachunku z faktury nie przechodzi kontroli cyfr kontrolnych (możliwa literówka). Sprawdź go ze sprzedawcą przed zapłatą.',
  rachunek_faktora: `Faktura podaje też rachunek faktora, więc nie wiadomo, na który rachunek zapłacić. Sprawdź to w fakturze. ${W_BANKOWOSCI}`,
  mpp_nieczytelne: `Nie udało się odczytać z faktury, czy obowiązuje podzielona płatność (MPP). Sprawdź to w fakturze. ${W_BANKOWOSCI}`,
  wplaty_czesciowe: `Faktura podaje wpłaty częściowe, które nie pasują do jej kwoty, więc kwota do zapłaty jest niepewna. Sprawdź ją w fakturze. ${W_BANKOWOSCI}`,
  brak_numeru_ksef: `Faktura nie ma poprawnego numeru KSeF, a tytuł przelewu w pliku go wymaga. Sprawdź fakturę w KSeF. ${W_BANKOWOSCI}`,
  nazwa: `Nazwy sprzedawcy nie da się zapisać znakami, które przyjmuje plik banku. ${W_BANKOWOSCI}`,
  tytul: `Tytułu przelewu nie da się zapisać w 4 liniach po 35 znaków. ${W_BANKOWOSCI}`,
  mpp_bank:
    'Faktura z podzieloną płatnością (MPP), a opis importu Elixir-0 banku Twojego rachunku nie potwierdza przelewu MPP, ' +
    'więc zapłać w bankowości jako przelew MPP (kwota VAT, NIP i numer KSeF są przy koszcie).',
  mpp_dane:
    'Faktura z podzieloną płatnością (MPP), a do komunikatu MPP brakuje pewnej kwoty VAT, NIP sprzedawcy albo numeru KSeF, ' +
    'więc zapłać w bankowości jako przelew MPP według faktury.',
  biala_lista_nip:
    `Kwota ponad 15 000 zł, a koszt nie ma polskiego NIP sprzedawcy, więc rachunku nie da się sprawdzić w wykazie podatników VAT. Plik go nie zawiera: sprawdź rachunek w ${WYSZUKIWARKA}.`,
};

/** Rachunek spoza wykazu (metoda check: „NIE”). Skutki jak w RP-BL-01 i ostrzeżeniu z części 1. */
export function powodPozaWykazem(dzien: string, requestId: string): string {
  return (
    `Tego rachunku nie ma w wykazie podatników VAT przy NIP sprzedawcy (stan na ${dataPl(dzien)}, numer zapytania ${requestId}). ` +
    'Zapłata ponad 15 000 zł na rachunek spoza wykazu oznacza, że tej kwoty nie zaliczysz do kosztów w PIT i odpowiadasz ' +
    'solidarnie za VAT niezapłacony przez sprzedawcę, chyba że w ciągu 7 dni od zlecenia przelewu zawiadomisz naczelnika ' +
    'właściwego urzędu skarbowego (formularz ZAW-NR). Plik go nie zawiera: wyjaśnij rachunek ze sprzedawcą.'
  );
}

export function powodBleduWykazu(opis: string): string {
  return (
    `Nie udało się sprawdzić rachunku w wykazie podatników VAT (${opis}). To nie znaczy, że rachunek jest w porządku, ` +
    `więc plik go nie zawiera. Pobierz plik ponownie za chwilę albo sprawdź rachunek w ${WYSZUKIWARKA}.`
  );
}

export function powodBrakuDowodu(requestId: string): string {
  return (
    `Rachunek jest w wykazie podatników VAT (numer zapytania ${requestId}), ale nie udało się zapisać dowodu sprawdzenia ` +
    'w historii zmian, więc plik go nie zawiera. Pobierz plik ponownie.'
  );
}

/** Data wykonania: termin, a gdy już minął albo jest dziś: dziś (RRRR-MM-DD). */
export function dataWykonania(termin: string, dzis: string): string {
  return termin > dzis ? termin : dzis;
}

export function nazwaPlikuPrzelewow(dzis: string): string {
  return `przelewy-${dzis}.pli`;
}
