/**
 * Rekord przelewu krajowego w formacie Elixir-0 („PLI”, Multicash PLI): plik
 * do importu przelewów w bankowości firmowej (plan kompletnej aplikacji,
 * krok 3.4, część 2). Kodowanie Windows-1250 jest osobno
 * (`elixir0-kodowanie.ts`), żeby ten moduł nie ciągnął `iconv-lite` do
 * przeglądarki.
 *
 * Specyfikacja (publiczne opisy importu banków, odczyt 10.11.2026):
 *  - ING Bank Śląski, „Opis formatów plików importu i eksportu wykorzystywanych
 *    w ING Business”, wersja 1.51C od 8.07.2026, rozdział II, tabele 1 i 2
 *    (https://www.ing.pl/_fileserver/item/1122382);
 *  - mBank, „Import do koszyka”
 *    (https://www.mbank.pl/pdf/koszyk_przelewow_-_instrukcja_importu_przelewow.pdf).
 *
 * Rekord: pola po przecinku, teksty w cudzysłowie, bez nagłówka, CR LF po
 * każdym rekordzie. Kolejno: 110 (polecenie przelewu), data wykonania
 * RRRRMMDD, kwota w groszach bez przecinka, numer rozliczeniowy banku
 * zleceniodawcy (8 cyfr), 0, rachunek zleceniodawcy, rachunek kontrahenta,
 * nazwa i adres zleceniodawcy (4 x 35, linie po „|”), nazwa i adres
 * kontrahenta (4 x 35), 0, numer rozliczeniowy banku kontrahenta, tytuł
 * (4 x 35), "", "", klasyfikacja "51" (przelew w MPP: "53").
 *
 * Tytuł dzielimy co 35 znaków, bez przestawiania słów: tak każą dzielić MPP
 * oba banki (mBank: „|” dokładnie co 35 znaków, także wewnątrz słów
 * kodowych; przykład ING z tabeli 3 tak samo), więc linie złożone z powrotem
 * dają dokładnie ten sam tytuł, który klient widzi przy koszcie.
 *
 * MPP: tytuł `/VAT/kwota VAT z przecinkiem/IDC/NIP/INV/numer faktury/TXT/tekst`
 * (VAT 10n,2n; IDC do 14 znaków; INV do 35; TXT do 33, opcjonalny). Numer
 * faktury to numer KSeF (RP-PLAT-01). Format nie jest wspólny dla banków
 * (Bank Pocztowy: kod "51" i kwota VAT w groszach), więc przelew MPP trafia
 * do pliku tylko przy rachunku zleceniodawcy w banku, którego specyfikacja
 * opisuje go jak wyżej (`BANKI_MPP_W_ELIXIR`).
 *
 * Testy: `tests/unit/plik-przelewow-elixir.test.ts`.
 */

import { poprawnyNumerKsef } from '@/lib/invoices/tytul-przelewu';
import { normalizeIban, roundToCents, validateIban } from '@/lib/xml/invoice-calculator';

/** Długość linii pól wielowierszowych i ich liczba (4 x 35). */
export const DLUGOSC_LINII = 35;
export const LICZBA_LINII = 4;

/**
 * Banki (cyfry 3-6 numeru rachunku), których opis importu Elixir-0 podaje
 * przelew MPP z kodem "53" i komunikatem `/VAT/…/IDC/…/INV/…/TXT/…`.
 */
export const BANKI_MPP_W_ELIXIR: Readonly<Record<string, string>> = {
  '1050': 'ING Bank Śląski (ING Business, opis formatów, wersja 1.51C)',
  '1140': 'mBank (import do koszyka)',
};

const POLSKIE = 'ąćęłńóśźżĄĆĘŁŃÓŚŹŻ';
/** Litery, których nie rozkłada NFD. */
const ZAMIANY: Readonly<Record<string, string>> = { ß: 'ss', æ: 'ae', Æ: 'AE', ø: 'o', Ø: 'O', đ: 'd', Đ: 'D', ð: 'd', þ: 'th', Þ: 'Th' };
/**
 * Poza literami (z polskimi), cyframi i spacją: znaki specjalne dozwolone
 * w imporcie PLI według ING (rozdział II): \ - @ $ < > , . ( ) [ ] { } / = _ % ~ & ^ '
 * Reszta (także „"” i „|”, które w pliku coś znaczą) zamienia się wcześniej
 * albo na spację.
 */
const POZA_ZESTAWEM = /[^A-Za-z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ \\\-@$<>,.()[\]{}/=_%~&^']/g;

/** Tekst w znakach, które przyjmuje plik banku. Cudzysłowy na apostrof, myślniki na dywiz, obce litery bez znaków diakrytycznych. */
export function tekstElixir(raw: string | null | undefined): string {
  if (!raw) return '';
  const s = raw
    .normalize('NFC')
    .replace(/["„”“«»‟″]/g, "'")
    .replace(/[‘’‚‛`´]/g, "'")
    .replace(/[‐‑‒–—―]/g, '-');
  const litery = Array.from(s)
    .map((ch) => (POLSKIE.includes(ch) ? ch : (ZAMIANY[ch] ?? ch.normalize('NFD').replace(/\p{M}/gu, ''))))
    .join('');
  return litery.replace(POZA_ZESTAWEM, ' ').replace(/\s+/g, ' ').trim();
}

function zawijaj(tekst: string): string[] {
  const linie: string[] = [];
  let biezaca = '';
  for (const slowo of tekst.split(' ').filter(Boolean)) {
    if (slowo.length > DLUGOSC_LINII) {
      if (biezaca) linie.push(biezaca);
      biezaca = '';
      for (let i = 0; i < slowo.length; i += DLUGOSC_LINII) {
        const kawalek = slowo.slice(i, i + DLUGOSC_LINII);
        if (kawalek.length === DLUGOSC_LINII) linie.push(kawalek);
        else biezaca = kawalek;
      }
      continue;
    }
    const razem = biezaca ? `${biezaca} ${slowo}` : slowo;
    if (razem.length <= DLUGOSC_LINII) biezaca = razem;
    else {
      linie.push(biezaca);
      biezaca = slowo;
    }
  }
  if (biezaca) linie.push(biezaca);
  return linie;
}

/**
 * Pole „nazwa i adres”: nazwa (pierwszy element) zawinięta po słowach, potem
 * adres w pozostałych liniach, razem najwyżej 4 x 35. `null`, gdy z nazwy nie
 * zostaje ani jeden znak, który przyjmuje plik.
 */
export function poleNazwyElixir(czesci: ReadonlyArray<string | null | undefined>): string | null {
  const nazwa = zawijaj(tekstElixir(czesci[0]));
  if (nazwa.length === 0) return null;
  const linie = nazwa.slice(0, LICZBA_LINII);
  for (const adres of czesci.slice(1)) {
    for (const linia of zawijaj(tekstElixir(adres))) {
      if (linie.length < LICZBA_LINII) linie.push(linia);
    }
  }
  return linie.join('|');
}

/** Tytuł podzielony co 35 znaków („|” na 36., 72. i 108. znaku). `null` przy pustym i dłuższym niż 140 znaków. */
export function liniePo35(tekst: string): string | null {
  const znaki = Array.from(tekst);
  if (znaki.length === 0 || znaki.length > DLUGOSC_LINII * LICZBA_LINII) return null;
  const linie: string[] = [];
  for (let i = 0; i < znaki.length; i += DLUGOSC_LINII) linie.push(znaki.slice(i, i + DLUGOSC_LINII).join(''));
  return linie.join('|');
}

/** Polski numer rachunku (NRB): 26 cyfr z poprawną liczbą kontrolną, bez „PL”, spacji i kresek. Inaczej `null`. */
export function nrb(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const iban = normalizeIban(raw);
  if (!/^PL\d{26}$/.test(iban) || !validateIban(iban)) return null;
  return iban.slice(2);
}

/** Numer rozliczeniowy banku (8 cyfr po liczbie kontrolnej). */
export function numerRozliczeniowy(rachunek: string): string {
  return rachunek.slice(2, 10);
}

/** Czy specyfikacja Elixir-0 banku zleceniodawcy opisuje przelew MPP (kod "53"). */
export function bankObslugujeMppWElixir(rachunekNadawcy: string): boolean {
  return Object.hasOwn(BANKI_MPP_W_ELIXIR, rachunekNadawcy.slice(2, 6));
}

/** Kwota w groszach (grosze jak na fakturze, `roundToCents`); `null` dla zera, ujemnej i ponad 15 cyfr. */
export function kwotaWGroszach(zl: number): number | null {
  if (!Number.isFinite(zl)) return null;
  const grosze = Math.round(roundToCents(zl) * 100);
  return grosze > 0 && grosze <= 999_999_999_999_999 ? grosze : null;
}

const SLOWA_KODOWE = /\/(VAT|IDC|INV|TXT)\//i;

/**
 * Komunikat przelewu MPP (bez podziału na linie). `null`, gdy brakuje
 * danych: kwoty VAT większej od zera (do 10 cyfr złotych), NIP sprzedawcy
 * (10 cyfr) albo poprawnego numeru KSeF. Tekst wolny dochodzi tylko w całości
 * (najwyżej 33 znaki, bez słów kodowych); inaczej go nie ma.
 */
export function komunikatMpp(p: { vat: number; nip: string; numerKsef: string; tekst?: string | null }): string | null {
  const grosze = kwotaWGroszach(p.vat);
  const numerKsef = poprawnyNumerKsef(p.numerKsef);
  if (grosze === null || grosze > 999_999_999_999 || !/^\d{10}$/.test(p.nip) || !numerKsef) return null;
  const vat = `${Math.floor(grosze / 100)},${String(grosze % 100).padStart(2, '0')}`;
  const komunikat = `/VAT/${vat}/IDC/${p.nip}/INV/${numerKsef}`;
  const tekst = tekstElixir(p.tekst);
  return tekst && tekst.length <= 33 && !SLOWA_KODOWE.test(tekst) ? `${komunikat}/TXT/${tekst}` : komunikat;
}

export interface PrzelewElixir {
  /** RRRR-MM-DD. */
  dataWykonania: string;
  kwotaGrosze: number;
  /** 26 cyfr (`nrb`). */
  rachunekNadawcy: string;
  rachunekOdbiorcy: string;
  /** Pola wielowierszowe gotowe do pliku (`poleNazwyElixir`, `liniePo35`). */
  nadawca: string;
  odbiorca: string;
  tytul: string;
  mpp: boolean;
}

const wCudzyslowie = (tekst: string) => `"${tekst}"`;

/** Jeden rekord (bez CR LF). */
export function rekordElixir(p: PrzelewElixir): string {
  return [
    '110',
    p.dataWykonania.replace(/-/g, ''),
    String(p.kwotaGrosze),
    numerRozliczeniowy(p.rachunekNadawcy),
    '0',
    wCudzyslowie(p.rachunekNadawcy),
    wCudzyslowie(p.rachunekOdbiorcy),
    wCudzyslowie(p.nadawca),
    wCudzyslowie(p.odbiorca),
    '0',
    numerRozliczeniowy(p.rachunekOdbiorcy),
    wCudzyslowie(p.tytul),
    '""',
    '""',
    wCudzyslowie(p.mpp ? '53' : '51'),
  ].join(',');
}
