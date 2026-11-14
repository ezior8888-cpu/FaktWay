/**
 * Podatkowa księga przychodów i rozchodów według wzoru od 2026 r. (plan
 * księgowości JDG, K7; rozporządzenie MFiG z 6.09.2025, Dz.U. 2025 poz. 1299;
 * struktura JPK_PKPIR(3), broszura MF z października 2025). Funkcja czysta:
 * dane czyta `kpir-dane.ts`, plik buduje `jpk-pkpir.ts`.
 *
 * Wiersz to K_1-K_17: numer KSeF (K_3B), identyfikator kontrahenta (K_4A,
 * K_4B), kontrahent i adres (K_5A, K_5B, obowiązkowe; bez danych „BRAK”),
 * przychód (K_7, K_8), koszty (K_10-K_13), B+R (K_16A, K_16B). Pola rolnika
 * (K_9A, K_14A) zostają puste, a K_9 i K_14 to sumy wiersza.
 *
 * Przychód z faktur jak ewidencja ryczałtu (K3, `ewidencja.ts`): dzień
 * sprzedaży nie później niż wystawienie, korekta różnicą w dniu wystawienia,
 * rozliczenie pomniejszone o zaliczki, faktura do paragonu nie jest przychodem
 * (poza księgą, gdy raport kasy z kolumny 7 z miesiąca paragonu ją obejmuje,
 * inaczej brak: `pokrycieFakturDoParagonu`, krok 1.2), waluta po kursie NBP.
 * Koszty z listy kosztów uznanych za koszt, w kwocie jak KPiR w aplikacji (`kpirCostAmount`: netto i VAT bez odliczenia),
 * w kolumnie z kategorii kosztu. Koszt B+R (w aplikacji `col_15`) idzie do
 * K_13 i dodatkowo do K_16 (kolumna 16 to zapis kosztów B+R już ujętych
 * w kosztach). Do księgi należą dni ze skalą albo liniowym; dzień
 * z ryczałtem należy do ewidencji przychodów, dzień bez profilu to brak.
 *
 * Fundusz Pracy i FS z zapłaconych składek ZUS (K7.3, D21) FaktWay dopisuje
 * sam: wiersz kolumny 13 w dniu zapłaty, z przyrostu jak odliczenia
 * (`zaplatyFunduszuPracy`).
 *
 * Każdy problem to brak z nazwą dokumentu i wyjściem; okres z brakiem nie ma
 * sum ani pliku (fail-closed).
 */

import { monthLabel } from '@/lib/expenses/month';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import {
  brakFakturyDoParagonu,
  brakFakturyZImportu,
  dzienPrzychodu,
  kluczKursu,
  kwotaTekst,
  pokrycieFakturDoParagonu,
  przeliczNaPln,
  type BrakEwidencji,
  type FakturaEwidencji,
  type KursPrzychodu,
  type PominietaFaktura,
} from '@/lib/ksiegowosc/ewidencja';
import { wersjaNa, type WersjaProfilu } from '@/lib/ksiegowosc/profil';

export const KOLUMNY_KPIR = ['k7', 'k8', 'k10', 'k11', 'k12', 'k13'] as const;
export type KolumnaKpir = (typeof KOLUMNY_KPIR)[number];

export const NAZWY_KOLUMN: Readonly<Record<KolumnaKpir, string>> = {
  k7: 'Przychód: sprzedaż towarów i usług (7)',
  k8: 'Przychód: pozostałe przychody (8)',
  k10: 'Zakup towarów handlowych i materiałów (10)',
  k11: 'Koszty uboczne zakupu (11)',
  k12: 'Wynagrodzenia (12)',
  k13: 'Pozostałe wydatki (13)',
};

/** Pole obowiązkowe bez danych (K_5A, K_5B), jak „BRAK” w JPK_V7M. */
export const BRAK_DANYCH = 'BRAK';

export interface KontrahentKpir {
  nazwa: string | null;
  adres: string | null;
  kraj: string | null;
  identyfikator: string | null;
}

export interface KosztKpir {
  id: string;
  /** K_2: data dowodu (data wystawienia kosztu). */
  data: string;
  dowod: string;
  numerKsef: string | null;
  kontrahent: KontrahentKpir;
  /** K_6 */
  opis: string;
  /** `expenses.kpir_column`: col_10-col_13, col_15/col_16 (B+R); inna albo brak to brak w księdze. */
  kolumnaAplikacji: string | null;
  /** W groszach (PLN), jak KPiR w aplikacji. */
  kwotaGr: number;
}

export interface WpisKpir {
  id: string;
  data: string;
  dokument: string;
  kolumna: KolumnaKpir;
  kwotaGr: number;
  opis: string | null;
  /**
   * Rodzaj dowodu z `ledger_manual_entries` (`czytajWpisyKpir`). Tylko wpis
   * „raport_kasy” w kolumnie 7 obejmuje fakturę do paragonu (krok 1.2); wpis
   * bez rodzaju nie jest raportem kasy.
   */
  rodzaj?: 'raport_kasy' | 'inny';
}

/** Fundusz Pracy i FS z zapłaty składek społecznych (K7.3, D21): koszt w dniu zapłaty. */
export interface ZaplataFp {
  id: string;
  /** RRRR-MM: okres składek. */
  zaMiesiac: string;
  /** RRRR-MM-DD: dzień zapłaty (K_2). */
  data: string;
  fpGr: number;
}

/** Zapłacona wersja rozliczenia składek społecznych (`tax_settlements`). */
export interface ZaplaconeSkladki {
  id: string;
  /** RRRR-MM */
  okres: string;
  wersja: number;
  kwotaGr: number;
  spoleczneBezFpGr: number;
  /** RRRR-MM-DD */
  zaplaconeO: string;
}

/**
 * Fundusz Pracy i FS z zapłaconych wersji składek społecznych (K7.3, D21).
 * Jak odliczenia (`przyrostyZaplat`): przy dopłacie liczy się tylko przyrost
 * ponad najwyższą wcześniej zapłaconą wersję okresu, a FP to przyrost kwoty
 * minus przyrost części bez FP.
 */
export function zaplatyFunduszuPracy(zaplaty: readonly ZaplaconeSkladki[]): ZaplataFp[] {
  const grupy = new Map<string, ZaplaconeSkladki[]>();
  for (const z of zaplaty) grupy.set(z.okres, [...(grupy.get(z.okres) ?? []), z]);
  const wynik: ZaplataFp[] = [];
  for (const lista of grupy.values()) {
    let kwota = 0;
    let bezFp = 0;
    for (const z of [...lista].sort((a, b) => a.wersja - b.wersja)) {
      const fp = Math.max(0, z.kwotaGr - kwota) - Math.max(0, z.spoleczneBezFpGr - bezFp);
      if (fp > 0) wynik.push({ id: z.id, zaMiesiac: z.okres, data: z.zaplaconeO, fpGr: fp });
      kwota = Math.max(kwota, z.kwotaGr);
      bezFp = Math.max(bezFp, z.spoleczneBezFpGr);
    }
  }
  return wynik.sort((a, b) => a.data.localeCompare(b.data) || a.id.localeCompare(b.id));
}

export interface WejscieKpir {
  rok: number;
  /** Faktury sprzedaży; `kontrahent.nazwa` i `adres` z danych nabywcy. */
  faktury: readonly FakturaEwidencji[];
  koszty: readonly KosztKpir[];
  wpisy: readonly WpisKpir[];
  /** Fundusz Pracy i FS z zapłaconych składek (K7.3); bez pola: brak takich zapłat. */
  zaplatyFp?: readonly ZaplataFp[];
  wersje: readonly WersjaProfilu[];
  kursy: ReadonlyMap<string, KursPrzychodu>;
}

export interface WierszKpir {
  /** K_1 */
  lp: number;
  /** K_2 */
  data: string;
  /** K_3A */
  dowod: string;
  /** K_3B */
  numerKsef: string | null;
  /** K_4A */
  krajKontrahenta: string | null;
  /** K_4B */
  idKontrahenta: string | null;
  /** K_5A */
  nazwaKontrahenta: string;
  /** K_5B */
  adresKontrahenta: string;
  /** K_6 */
  opis: string;
  /** K_7, K_8, K_10-K_13 w groszach (zero: pole puste). */
  kwoty: Readonly<Record<KolumnaKpir, number>>;
  /** K_16A i K_16B: koszt B+R ujęty już w K_13. */
  br: { opis: string; kwotaGr: number } | null;
  /** K_17 */
  uwagi: string | null;
  zrodlo: { typ: 'faktura' | 'koszt' | 'wpis' | 'zaplata'; id: string };
}

export interface Kpir {
  rok: number;
  wiersze: WierszKpir[];
  braki: BrakEwidencji[];
  pominiete: PominietaFaktura[];
}

export interface SumyKpir {
  /** K_9: K_7 + K_8. */
  przychodGr: number;
  /** K_10 + K_11 + K_14 (K_12 + K_13): koszty bez spisu z natury. */
  kosztyGr: number;
  kolumny: Record<KolumnaKpir, number>;
  brGr: number;
  liczbaWierszy: number;
}

const PROFIL_TEKST = 'Ustawienia są w Księgowości, w zakładce „Ustawienia podatkowe”.';
const KOSZT_TEKST = 'Kolumnę KPiR ustawia się w Kosztach, w kategorii kosztu.';

const ZERO: Readonly<Record<KolumnaKpir, number>> = { k7: 0, k8: 0, k10: 0, k11: 0, k12: 0, k13: 0 };

const wRoku = (dzien: string, rok: number) => dzien.slice(0, 4) === String(rok);
const znaki = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 256);
const lubBrak = (s: string | null | undefined) => znaki(s) || BRAK_DANYCH;

/** Kolumna kosztu z kategorii aplikacji; B+R to K_13 z zapisem w K_16. */
function kolumnaKosztu(kolumna: string | null): { kolumna: KolumnaKpir; br: boolean } | null {
  switch (kolumna) {
    case 'col_10':
      return { kolumna: 'k10', br: false };
    case 'col_11':
      return { kolumna: 'k11', br: false };
    case 'col_12':
      return { kolumna: 'k12', br: false };
    case 'col_13':
      return { kolumna: 'k13', br: false };
    case 'col_15':
    case 'col_16':
      return { kolumna: 'k13', br: true };
    default:
      return null;
  }
}

type DzienKsiegi = { tak: true } | { tak: false; brak: string | null };

/** Czy dzień należy do KPiR: skala albo liniowy tak; ryczałt nie (bez braku); bez profilu brak. */
function dzienKsiegi(wersje: readonly WersjaProfilu[], dzien: string, nazwa: string): DzienKsiegi {
  const wersja = wersjaNa(wersje, dzien);
  if (!wersja) {
    return {
      tak: false,
      brak: `${nazwa} z ${formatIsoDatePl(dzien)}: bez ustawień podatkowych na ten dzień nie wiadomo, czy dokument należy do KPiR. ${PROFIL_TEKST}`,
    };
  }
  return wersja.forma === 'ryczalt' ? { tak: false, brak: null } : { tak: true };
}

export function zbudujKpir(wejscie: WejscieKpir): Kpir {
  const { rok, wersje } = wejscie;
  const braki: BrakEwidencji[] = [];
  const pominiete: PominietaFaktura[] = [];
  const wiersze: Omit<WierszKpir, 'lp'>[] = [];
  // Krok 1.2: jak ewidencja, FP poza przychodem, gdy raport kasy (kolumna 7) z miesiąca paragonu ją obejmuje.
  const pokrycieFp = pokrycieFakturDoParagonu(
    wejscie.faktury,
    wejscie.wpisy.filter((w) => w.rodzaj === 'raport_kasy' && w.kolumna === 'k7').map((w) => ({ dzien: w.data, kwotaGr: w.kwotaGr })),
    'księgi',
  );

  for (const f of wejscie.faktury) {
    const dzien = dzienPrzychodu(f);
    if (!wRoku(dzien, rok)) continue;
    const nalezy = dzienKsiegi(wersje, dzien, `Faktura ${f.numer}`);
    if (!nalezy.tak) {
      if (nalezy.brak) braki.push({ dzien, dokument: f.numer, komunikat: nalezy.brak });
      continue;
    }
    if (f.niepewnyImport) {
      // F11-C4: jak ewidencja, import z niepewnym dniem przychodu albo kwotą daje brak.
      braki.push({ dzien, dokument: f.numer, komunikat: brakFakturyZImportu(f.numer, dzien, f.niepewnyImport, 'księgi') });
      continue;
    }
    if (f.fp) {
      const p = pokrycieFp.get(f.id) ?? { pokryta: false, komunikat: brakFakturyDoParagonu(f.numer, dzien, 'księgi', { powod: 'brak_raportu' }) };
      if (p.pokryta) pominiete.push({ numer: f.numer, dzien, powod: p.powod });
      else braki.push({ dzien, dokument: f.numer, komunikat: p.komunikat });
      continue;
    }
    let kwotaGr = f.rodzaj === 'rozliczenie' ? f.nettoGr - f.rozliczoneZaliczkiGr : f.nettoGr;
    if (kwotaGr === 0) continue;

    const uwagi: string[] = [];
    if (f.rodzaj === 'korekta') uwagi.push('Korekta (różnica)');
    if (f.rodzaj === 'zaliczka') uwagi.push('Zaliczka');
    if (f.rodzaj === 'rozliczenie' && f.rozliczoneZaliczkiGr !== 0) uwagi.push(`Rozliczenie, pomniejszone o zaliczki ${kwotaTekst(f.rozliczoneZaliczkiGr)} ${f.waluta}`);
    if (f.waluta.toUpperCase() !== 'PLN') {
      const kurs = wejscie.kursy.get(kluczKursu(f.waluta, dzien));
      if (!kurs || !kurs.znaleziony) {
        braki.push({
          dzien,
          dokument: f.numer,
          komunikat:
            `Faktura ${f.numer} w ${f.waluta.toUpperCase()}: brak kursu średniego NBP sprzed ${formatIsoDatePl(dzien)}, ` +
            'więc nie przeliczamy jej na złote. Kurs pobieramy przy każdym otwarciu księgi.',
        });
        continue;
      }
      uwagi.push(`${kwotaTekst(kwotaGr)} ${f.waluta.toUpperCase()} po kursie ${String(kurs.mid).replace('.', ',')} (tabela ${kurs.tabela} z ${kurs.dataTabeli})`);
      kwotaGr = przeliczNaPln(kwotaGr, kurs.mid);
    }
    wiersze.push({
      data: dzien,
      dowod: f.numer,
      numerKsef: f.numerKsef,
      krajKontrahenta: f.kontrahent.kraj,
      idKontrahenta: f.kontrahent.identyfikator,
      nazwaKontrahenta: lubBrak(f.kontrahent.nazwa),
      adresKontrahenta: lubBrak(f.kontrahent.adres),
      opis: f.rodzaj === 'korekta' ? 'Korekta sprzedaży' : 'Sprzedaż towarów i usług',
      kwoty: { ...ZERO, k7: kwotaGr },
      br: null,
      uwagi: uwagi.length > 0 ? uwagi.join('; ').slice(0, 256) : null,
      zrodlo: { typ: 'faktura', id: f.id },
    });
  }

  for (const k of wejscie.koszty) {
    if (!wRoku(k.data, rok)) continue;
    const nalezy = dzienKsiegi(wersje, k.data, `Koszt ${k.dowod}`);
    if (!nalezy.tak) {
      if (nalezy.brak) braki.push({ dzien: k.data, dokument: k.dowod, komunikat: nalezy.brak });
      continue;
    }
    const kolumna = kolumnaKosztu(k.kolumnaAplikacji);
    if (!kolumna) {
      braki.push({
        dzien: k.data,
        dokument: k.dowod,
        komunikat:
          k.kolumnaAplikacji === null
            ? `Koszt ${k.dowod} z ${formatIsoDatePl(k.data)} nie ma kolumny KPiR, więc nie wiadomo, gdzie go wpisać. ${KOSZT_TEKST}`
            : `Koszt ${k.dowod} z ${formatIsoDatePl(k.data)} ma kolumnę przychodu, a jest kosztem. ${KOSZT_TEKST}`,
      });
      continue;
    }
    if (k.kwotaGr === 0) continue;
    const opis = znaki(k.opis) || 'Wydatek';
    wiersze.push({
      data: k.data,
      dowod: znaki(k.dowod) || BRAK_DANYCH,
      numerKsef: k.numerKsef,
      krajKontrahenta: k.kontrahent.kraj,
      idKontrahenta: k.kontrahent.identyfikator,
      nazwaKontrahenta: lubBrak(k.kontrahent.nazwa),
      adresKontrahenta: lubBrak(k.kontrahent.adres),
      opis,
      kwoty: { ...ZERO, [kolumna.kolumna]: k.kwotaGr },
      br: kolumna.br ? { opis, kwotaGr: k.kwotaGr } : null,
      uwagi: null,
      zrodlo: { typ: 'koszt', id: k.id },
    });
  }

  for (const w of wejscie.wpisy) {
    if (!wRoku(w.data, rok)) continue;
    const nalezy = dzienKsiegi(wersje, w.data, `Wpis ${w.dokument}`);
    if (!nalezy.tak) {
      braki.push({
        dzien: w.data,
        dokument: w.dokument,
        komunikat:
          nalezy.brak ??
          `Wpis ${w.dokument} z ${formatIsoDatePl(w.data)}: w tym dniu forma to ryczałt, więc wpis nie należy do KPiR. Wpis usuwa się na liście wpisów ręcznych.`,
      });
      continue;
    }
    wiersze.push({
      data: w.data,
      dowod: znaki(w.dokument) || BRAK_DANYCH,
      numerKsef: null,
      krajKontrahenta: null,
      idKontrahenta: null,
      nazwaKontrahenta: BRAK_DANYCH,
      adresKontrahenta: BRAK_DANYCH,
      opis: znaki(w.opis) || (w.kolumna === 'k7' || w.kolumna === 'k8' ? 'Przychód' : 'Wydatek'),
      kwoty: { ...ZERO, [w.kolumna]: w.kwotaGr },
      br: null,
      uwagi: null,
      zrodlo: { typ: 'wpis', id: w.id },
    });
  }

  for (const z of wejscie.zaplatyFp ?? []) {
    if (!wRoku(z.data, rok)) continue;
    const dowod = `Składki ZUS za ${z.zaMiesiac.slice(5, 7)}/${z.zaMiesiac.slice(0, 4)}`;
    const nalezy = dzienKsiegi(wersje, z.data, dowod);
    if (!nalezy.tak) {
      if (nalezy.brak) braki.push({ dzien: z.data, dokument: dowod, komunikat: nalezy.brak });
      continue;
    }
    wiersze.push({
      data: z.data,
      dowod,
      numerKsef: null,
      krajKontrahenta: null,
      idKontrahenta: null,
      nazwaKontrahenta: 'Zakład Ubezpieczeń Społecznych',
      adresKontrahenta: BRAK_DANYCH,
      opis: `Fundusz Pracy i Fundusz Solidarnościowy za ${monthLabel(z.zaMiesiac)}`,
      kwoty: { ...ZERO, k13: z.fpGr },
      br: null,
      uwagi: null,
      zrodlo: { typ: 'zaplata', id: z.id },
    });
  }

  // Przychody przed kosztami w tym samym dniu, jak KPiR w aplikacji.
  const kolejnosc = { faktura: 0, wpis: 1, koszt: 2, zaplata: 3 } as const;
  wiersze.sort(
    (a, b) =>
      a.data.localeCompare(b.data) ||
      kolejnosc[a.zrodlo.typ] - kolejnosc[b.zrodlo.typ] ||
      a.dowod.localeCompare(b.dowod, 'pl') ||
      a.zrodlo.id.localeCompare(b.zrodlo.id),
  );
  braki.sort((a, b) => a.dzien.localeCompare(b.dzien) || a.dokument.localeCompare(b.dokument, 'pl'));
  return { rok, wiersze: wiersze.map((w, i) => ({ ...w, lp: i + 1 })), braki, pominiete };
}

const wOkresie = (dzien: string, od: string, doDnia: string) => dzien >= od && dzien <= doDnia;

/** Wiersze z dniem w okresie [od, do], numerowane od 1 (K_1 pliku za ten okres). */
export function wierszeKpirOkresu(k: Kpir, od: string, doDnia: string): WierszKpir[] {
  return k.wiersze.filter((w) => wOkresie(w.data, od, doDnia)).map((w, i) => ({ ...w, lp: i + 1 }));
}

export function brakiKpirOkresu(k: Kpir, od: string, doDnia: string): BrakEwidencji[] {
  return k.braki.filter((b) => wOkresie(b.dzien, od, doDnia));
}

export function sumyKpir(wiersze: readonly WierszKpir[]): SumyKpir {
  const kolumny = { ...ZERO };
  let brGr = 0;
  for (const w of wiersze) {
    for (const k of KOLUMNY_KPIR) kolumny[k] += w.kwoty[k];
    brGr += w.br?.kwotaGr ?? 0;
  }
  return {
    przychodGr: kolumny.k7 + kolumny.k8,
    kosztyGr: kolumny.k10 + kolumny.k11 + kolumny.k12 + kolumny.k13,
    kolumny,
    brGr,
    liczbaWierszy: wiersze.length,
  };
}
