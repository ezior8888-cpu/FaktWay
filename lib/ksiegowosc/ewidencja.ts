/**
 * Ewidencja przychodów ryczałtu (plan księgowości JDG, K3; zasady z sekcji 4
 * planu i z PLAN-FINORA §2.4). Funkcja czysta: dane czyta
 * `lib/ksiegowosc/ewidencja-dane.ts`, plik JPK_EWP(4) buduje `jpk-ewp.ts`.
 *
 * - Przychód tylko z faktur przyjętych w aktywnym środowisku KSeF (filtr przy
 *   odczycie) i z wpisów ręcznych (`ledger_manual_entries`, 00167).
 * - Data przychodu: dzień sprzedaży, nie później niż wystawienie
 *   (`kpirSaleEventDate`, jak w KPiR). Korekta wchodzi różnicą w dniu swojego
 *   wystawienia.
 * - Rozliczenie (ROZ) jest pomniejszone o rozliczone zaliczki, jak w KPiR
 *   (`kpirRevenueNet`), więc zaliczki się nie dublują.
 * - Faktura do paragonu (FP) nie jest przychodem: sprzedaż wchodzi z raportu kasy.
 *   Do czasu reguły, która sprawdzi, że raport kasy obejmuje sprzedaż z FP
 *   (następny PR kroku 1.2, złoty przypadek G30), FP daje brak: miesiąc bez
 *   sum, bo FP nie może po cichu zniknąć ani być drugim przychodem.
 * - Waluta: kurs średni NBP z ostatniego dnia roboczego przed dniem przychodu.
 * - Stawka: z pozycji, a bez niej domyślna z wersji profilu na dzień przychodu
 *   (`stawkaRyczaltuPozycji`). Dzień ze skalą albo liniowym nie należy do
 *   ewidencji (KPiR), dzień bez profilu to brak.
 * - Kwoty w groszach; każdy wiersz jest zaokrąglony do grosza (sekcja 4, pkt 6).
 *
 * Każdy problem to brak z nazwą dokumentu i wyjściem. Miesiąc z brakiem nie
 * ma sum, a okres z brakiem nie ma pliku JPK_EWP (fail-closed).
 */

import { kpirSaleEventDate } from '@/lib/categorization/kpir-revenue';
import { monthLabel } from '@/lib/expenses/month';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlInt } from '@/lib/format/pl';
import { NAZWY_FORM, stawkaRyczaltuPozycji, wersjaNa, type WersjaProfilu } from '@/lib/ksiegowosc/profil';

/** Słownik K_9 JPK_EWP(4) w punktach bazowych: 17, 15, 14, 12,5, 12, 10, 8,5, 5,5 i 3 %. */
export const STAWKI_JPK_EWP_PB = [1700, 1500, 1400, 1250, 1200, 1000, 850, 550, 300] as const;

export type RodzajFaktury = 'zwykla' | 'korekta' | 'zaliczka' | 'rozliczenie';

export interface FakturaEwidencji {
  id: string;
  /** Numer faktury, czyli dowód w K_4. */
  numer: string;
  dataWystawienia: string;
  dataSprzedazy: string | null;
  rodzaj: RodzajFaktury;
  /** Netto z nagłówka w groszach waluty faktury; przy korekcie to różnica (00200). */
  nettoGr: number;
  waluta: string;
  numerKsef: string | null;
  /** Faktura do paragonu (`fa3_data.ksefMarkers.fp`). */
  fp: boolean;
  /**
   * K_6 i K_7: kraj nadania i identyfikator podatkowy kontrahenta (B2C: null);
   * nazwa i adres nabywcy dla KPiR (K7: K_5A, K_5B).
   */
  kontrahent: { kraj: string | null; identyfikator: string | null; nazwa?: string | null; adres?: string | null };
  /** Rozliczenie: netto zaliczek rozliczonych tą fakturą, w groszach waluty faktury. */
  rozliczoneZaliczkiGr: number;
  /** Pozycje, gdy choć jedna ma własną stawkę ryczałtu; null, gdy żadna nie ma. */
  pozycje: Array<{ nettoGr: number; stawkaRyczaltu: number | string | null }> | null;
}

export interface WpisReczny {
  id: string;
  rodzaj: 'raport_kasy' | 'inny';
  dataPrzychodu: string;
  dataWpisu: string;
  dokument: string;
  kwotaGr: number;
  stawkaPb: number;
  opis: string | null;
}

export type KursPrzychodu =
  | { znaleziony: true; mid: number; tabela: string; dataTabeli: string }
  | { znaleziony: false };

export interface WejscieEwidencji {
  rok: number;
  faktury: readonly FakturaEwidencji[];
  wpisy: readonly WpisReczny[];
  wersje: readonly WersjaProfilu[];
  /** Kursy NBP po kluczu `kluczKursu(waluta, dzień przychodu)`. */
  kursy: ReadonlyMap<string, KursPrzychodu>;
  /**
   * Próg najmu z parametrów roku (00168, K4): przychód ze stawką najmu z dni,
   * w których profil ma `najem`, ponad próg w roku idzie ze stawką wyższą.
   * Brak (np. sekcja niepotwierdzona przez księgową, D7) daje brak przy
   * wierszach najmu.
   */
  najem?: ProgNajmu;
}

export type ProgNajmu = { progGr: number; stawkaNajmuPb: number; stawkaPonadProgPb: number } | { brak: string };

export interface WierszEwidencji {
  /** K_1, numer kolejny w roku. */
  lp: number;
  /** K_2 */
  dataWpisu: string;
  /** K_3 */
  dataPrzychodu: string;
  /** K_4 */
  dowod: string;
  /** K_5 */
  numerKsef: string | null;
  /** K_6 */
  krajKontrahenta: string | null;
  /** K_7 */
  idKontrahenta: string | null;
  /** K_8, w groszach (PLN). */
  kwotaGr: number;
  /** K_9, w punktach bazowych. */
  stawkaPb: number;
  /** K_10 */
  uwagi: string | null;
  zrodlo: { typ: 'faktura' | 'wpis'; id: string };
}

export interface BrakEwidencji {
  dzien: string;
  dokument: string;
  komunikat: string;
}

export interface PominietaFaktura {
  numer: string;
  dzien: string;
  powod: string;
}

export interface Ewidencja {
  rok: number;
  wiersze: WierszEwidencji[];
  braki: BrakEwidencji[];
  pominiete: PominietaFaktura[];
  /** Czy w roku jest choć jeden dzień z profilem ryczałtowym. */
  ryczaltWRoku: boolean;
}

export interface SumyOkresu {
  /** Suma K_8 według stawki (pb), w groszach. */
  stawki: Map<number, number>;
  razemGr: number;
  liczbaWierszy: number;
}

export const kluczKursu = (waluta: string, dzien: string) => `${waluta.toUpperCase()}|${dzien}`;

/** Dzień przychodu faktury: korekta w dniu wystawienia, reszta jak KPiR. */
export function dzienPrzychodu(f: Pick<FakturaEwidencji, 'rodzaj' | 'dataWystawienia' | 'dataSprzedazy'>): string {
  if (f.rodzaj === 'korekta') return f.dataWystawienia;
  return kpirSaleEventDate({ saleDate: f.dataSprzedazy, issueDate: f.dataWystawienia });
}

/**
 * Kwota w groszach waluty po kursie NBP, zaokrąglona do grosza (połówka od
 * zera). Kurs skalowany przez 10^6 i iloczyn w BigInt, bez błędu float.
 */
export function przeliczNaPln(kwotaGr: number, mid: number): number {
  const skala = BigInt(1_000_000);
  const kurs = BigInt(Math.round(mid * 1_000_000));
  const iloczyn = BigInt(Math.abs(kwotaGr)) * kurs;
  const grosze = Number((iloczyn + skala / BigInt(2)) / skala);
  return kwotaGr < 0 ? -grosze : grosze;
}

/** „12,5 %” z punktów bazowych. */
export function etykietaStawki(pb: number): string {
  return `${String(pb / 100).replace('.', ',')} %`;
}

/** Grosze jako „1234,56”: do komunikatów i uwag, bez zależności od locale. */
export function kwotaTekst(gr: number): string {
  const znak = gr < 0 ? '-' : '';
  const abs = Math.abs(gr);
  return `${znak}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

const NAZWY_RODZAJU: Record<Exclude<RodzajFaktury, 'zwykla'>, string> = {
  korekta: 'korekta',
  zaliczka: 'zaliczka',
  rozliczenie: 'rozliczenie zaliczek',
};

const PROFIL_TEKST = 'Ustawienia są w Księgowości, w zakładce „Ustawienia podatkowe”.';
const POMOC_TEKST = 'Taki dokument rozdzielimy ręcznie po zgłoszeniu w Pomocy.';

/**
 * Brak przy fakturze do paragonu (krok 1.2 planu kompletnej aplikacji). Art.
 * 109 ust. 3d ustawy o VAT i zasada 2 planu księgowości: sprzedaż z paragonu
 * wchodzi z raportu kasy, a sama FP nie jest przychodem. FaktWay nie sprawdza
 * jeszcze, czy raport kasy obejmuje tę sprzedaż (wpis ręczny może być innym
 * dowodem), więc miesiąc nie ma sum: FP nie zniknie ani nie wejdzie drugi raz.
 * Wyjście jak przy innych dokumentach, których ewidencja nie rozdzieli: Pomoc.
 */
export function brakFakturyDoParagonu(numer: string, dzien: string, gdzie: 'ewidencji' | 'księgi'): string {
  return (
    `Faktura ${numer} z ${formatIsoDatePl(dzien)} to faktura do paragonu: sprzedaż z paragonu wchodzi do ${gdzie} ` +
    `z raportu kasy, a sama faktura nie jest przychodem. FaktWay nie sprawdza jeszcze, czy raport kasy za ` +
    `${monthLabel(dzien.slice(0, 7))} obejmuje tę sprzedaż, więc tego miesiąca nie liczy, żeby sprzedaż nie zniknęła ` +
    'ani nie weszła dwa razy. Miesiąc policzymy ręcznie po zgłoszeniu w Pomocy.'
  );
}

interface Czesc {
  stawkaPb: number;
  kwotaGr: number;
}

type WynikStawek = { czesci: Czesc[] } | { brak: string };

function stawkiFaktury(f: FakturaEwidencji, wersja: WersjaProfilu, kwotaGr: number): WynikStawek {
  const nazwa = `Faktura ${f.numer}`;
  if (f.pozycje === null) {
    if (wersja.stawkaDomyslna === null) {
      return { brak: `${nazwa}: profil na ten dzień nie ma stawki ryczałtu. ${PROFIL_TEKST}` };
    }
    return { czesci: [{ stawkaPb: wersja.stawkaDomyslna, kwotaGr }] };
  }

  const grupy = new Map<number, number>();
  for (const p of f.pozycje) {
    const pb = stawkaRyczaltuPozycji(p.stawkaRyczaltu, wersja);
    if (pb === null) {
      return { brak: `${nazwa}: profil na ten dzień nie ma stawki ryczałtu. ${PROFIL_TEKST}` };
    }
    grupy.set(pb, (grupy.get(pb) ?? 0) + p.nettoGr);
  }
  if (grupy.size === 1) return { czesci: [{ stawkaPb: [...grupy.keys()][0], kwotaGr }] };

  if (f.rodzaj !== 'zwykla') {
    return { brak: `${nazwa} (${NAZWY_RODZAJU[f.rodzaj]}) ma pozycje z różnymi stawkami ryczałtu. ${POMOC_TEKST}` };
  }
  const suma = [...grupy.values()].reduce((a, b) => a + b, 0);
  if (suma !== kwotaGr) {
    return {
      brak:
        `${nazwa}: suma pozycji (${kwotaTekst(suma)}) nie zgadza się z kwotą netto (${kwotaTekst(kwotaGr)}), ` +
        `więc nie rozdzielimy jej na stawki. ${POMOC_TEKST}`,
    };
  }
  return { czesci: [...grupy].map(([stawkaPb, gr]) => ({ stawkaPb, kwotaGr: gr })).filter((c) => c.kwotaGr !== 0) };
}

function uwagiFaktury(f: FakturaEwidencji): string[] {
  if (f.rodzaj === 'korekta') return ['Korekta (różnica)'];
  if (f.rodzaj === 'zaliczka') return ['Zaliczka'];
  if (f.rodzaj === 'rozliczenie' && f.rozliczoneZaliczkiGr !== 0) {
    return [`Rozliczenie, pomniejszone o zaliczki ${kwotaTekst(f.rozliczoneZaliczkiGr)} ${f.waluta}`];
  }
  return [];
}

const wRoku = (dzien: string, rok: number) => dzien.slice(0, 4) === String(rok);

function czyRyczaltWRoku(wersje: readonly WersjaProfilu[], rok: number): boolean {
  const naPoczatek = wersjaNa(wersje, `${rok}-01-01`);
  const wTrakcie = wersje.filter((w) => wRoku(w.validFrom, rok));
  return [naPoczatek, ...wTrakcie].some((w) => w?.forma === 'ryczalt');
}

type WierszBezLp = Omit<WierszEwidencji, 'lp'>;

/** Stawka najmu, gdy parametrów brak: tylko do rozpoznania wierszy, którym dajemy brak. */
const STAWKA_NAJMU_BEZ_PARAMETROW = 850;

/**
 * Próg najmu (K4): przychód ze stawką najmu z dni, w których profil ma `najem`,
 * liczy się narastająco od 1 stycznia po dniu przychodu; wiersz, który
 * przekracza próg, dzieli się na część do progu i nadwyżkę ze stawką wyższą.
 * Korekta in minus po przekroczeniu progu najpierw zmniejsza nadwyżkę (roczny
 * ryczałt to stawka najmu do progu i wyższa ponad nim; sekcja 5, pewność
 * średnia). Wcześniejszy brak w roku zmienia sumę narastająco, więc kolejne
 * wiersze najmu też są brakiem, dopóki go nie wyjaśnić.
 */
function progNajmu(wiersze: WierszBezLp[], wejscie: WejscieEwidencji, braki: BrakEwidencji[]): WierszBezLp[] {
  if (!wejscie.wersje.some((v) => v.najem)) return wiersze;
  const n = wejscie.najem ?? { brak: `Brak progu najmu w parametrach na ${wejscie.rok} r., więc stawki nie ustalimy.` };
  const stawkaNajmu = 'brak' in n ? STAWKA_NAJMU_BEZ_PARAMETROW : n.stawkaNajmuPb;
  const posortowane = [...wiersze].sort(
    (a, b) => a.dataPrzychodu.localeCompare(b.dataPrzychodu) || a.dataWpisu.localeCompare(b.dataWpisu) || a.dowod.localeCompare(b.dowod, 'pl'),
  );
  let pierwszyBrak = braki.reduce<string | null>((min, b) => (min === null || b.dzien < min ? b.dzien : min), null);
  const dodajBrak = (w: WierszBezLp, komunikat: string) => {
    braki.push({ dzien: w.dataPrzychodu, dokument: w.dowod, komunikat });
    if (pierwszyBrak === null || w.dataPrzychodu < pierwszyBrak) pierwszyBrak = w.dataPrzychodu;
  };
  const wynik: WierszBezLp[] = [];
  let narastajaco = 0;
  for (const w of posortowane) {
    const najem = w.stawkaPb === stawkaNajmu && wersjaNa(wejscie.wersje, w.dataPrzychodu)?.najem === true;
    if (!najem) {
      wynik.push(w);
      continue;
    }
    if ('brak' in n) {
      dodajBrak(w, `${w.dowod}: ${n.brak} ${POMOC_TEKST}`);
      continue;
    }
    if (pierwszyBrak !== null && pierwszyBrak <= w.dataPrzychodu) {
      dodajBrak(
        w,
        `${w.dowod}: stawka przychodu z najmu zależy od przychodu od początku roku, a ewidencja ma wcześniej brak ` +
          `(${formatIsoDatePl(pierwszyBrak)}). Po jego wyjaśnieniu ewidencja ustali stawkę.`,
      );
      continue;
    }
    const uwagi = (u: string | null) =>
      [u, `Najem ponad ${formatPlInt(n.progGr / 100)} zł w roku: ${etykietaStawki(n.stawkaPonadProgPb)}`].filter(Boolean).join('; ').slice(0, 256);
    const nadwyzka = Math.max(0, narastajaco - n.progGr);
    narastajaco += w.kwotaGr;
    if (w.kwotaGr < 0) {
      const zNadwyzki = Math.max(w.kwotaGr, -nadwyzka);
      if (zNadwyzki < 0) wynik.push({ ...w, kwotaGr: zNadwyzki, stawkaPb: n.stawkaPonadProgPb, uwagi: uwagi(w.uwagi) });
      if (w.kwotaGr - zNadwyzki < 0) wynik.push({ ...w, kwotaGr: w.kwotaGr - zNadwyzki });
      continue;
    }
    const doProgu = Math.max(0, n.progGr - (narastajaco - w.kwotaGr));
    if (w.kwotaGr <= doProgu) {
      wynik.push(w);
      continue;
    }
    if (doProgu > 0) wynik.push({ ...w, kwotaGr: doProgu });
    wynik.push({ ...w, kwotaGr: w.kwotaGr - doProgu, stawkaPb: n.stawkaPonadProgPb, uwagi: uwagi(w.uwagi) });
  }
  return wynik;
}

export function zbudujEwidencje(wejscie: WejscieEwidencji): Ewidencja {
  const { rok, wersje } = wejscie;
  const braki: BrakEwidencji[] = [];
  const pominiete: PominietaFaktura[] = [];
  const wiersze: Omit<WierszEwidencji, 'lp'>[] = [];

  for (const f of wejscie.faktury) {
    const dzien = dzienPrzychodu(f);
    if (!wRoku(dzien, rok)) continue;

    const wersja = wersjaNa(wersje, dzien);
    if (!wersja) {
      braki.push({
        dzien,
        dokument: f.numer,
        komunikat:
          `Faktura ${f.numer} z ${formatIsoDatePl(dzien)}: bez ustawień podatkowych na ten dzień ` +
          `nie wiadomo, czy i z jaką stawką wchodzi do ewidencji. ${PROFIL_TEKST}`,
      });
      continue;
    }
    if (wersja.forma !== 'ryczalt') continue;

    if (f.fp) {
      braki.push({ dzien, dokument: f.numer, komunikat: brakFakturyDoParagonu(f.numer, dzien, 'ewidencji') });
      continue;
    }

    const kwotaGr = f.rodzaj === 'rozliczenie' ? f.nettoGr - f.rozliczoneZaliczkiGr : f.nettoGr;
    if (kwotaGr === 0) continue;

    const stawki = stawkiFaktury(f, wersja, kwotaGr);
    if ('brak' in stawki) {
      braki.push({ dzien, dokument: f.numer, komunikat: stawki.brak });
      continue;
    }
    const zla = stawki.czesci.find((c) => !(STAWKI_JPK_EWP_PB as readonly number[]).includes(c.stawkaPb));
    if (zla) {
      braki.push({
        dzien,
        dokument: f.numer,
        komunikat:
          `Faktura ${f.numer} ma stawkę ${etykietaStawki(zla.stawkaPb)}, której nie ma w ewidencji ryczałtu ` +
          `(17, 15, 14, 12,5, 12, 10, 8,5, 5,5 i 3 %). ${POMOC_TEKST}`,
      });
      continue;
    }

    const uwagi = uwagiFaktury(f);
    let czesci = stawki.czesci;
    if (f.waluta.toUpperCase() !== 'PLN') {
      const kurs = wejscie.kursy.get(kluczKursu(f.waluta, dzien));
      if (!kurs || !kurs.znaleziony) {
        braki.push({
          dzien,
          dokument: f.numer,
          komunikat:
            `Faktura ${f.numer} w ${f.waluta.toUpperCase()}: brak kursu średniego NBP sprzed ${formatIsoDatePl(dzien)}, ` +
            'więc nie przeliczamy jej na złote. Kurs pobieramy przy każdym otwarciu ewidencji.',
        });
        continue;
      }
      uwagi.push(
        `${kwotaTekst(kwotaGr)} ${f.waluta.toUpperCase()} po kursie ${String(kurs.mid).replace('.', ',')} ` +
          `(tabela ${kurs.tabela} z ${kurs.dataTabeli})`,
      );
      czesci = czesci.map((c) => ({ ...c, kwotaGr: przeliczNaPln(c.kwotaGr, kurs.mid) }));
    }

    for (const c of czesci) {
      wiersze.push({
        dataWpisu: f.dataWystawienia,
        dataPrzychodu: dzien,
        dowod: f.numer,
        numerKsef: f.numerKsef,
        krajKontrahenta: f.kontrahent.kraj,
        idKontrahenta: f.kontrahent.identyfikator,
        kwotaGr: c.kwotaGr,
        stawkaPb: c.stawkaPb,
        uwagi: uwagi.length > 0 ? uwagi.join('; ').slice(0, 256) : null,
        zrodlo: { typ: 'faktura', id: f.id },
      });
    }
  }

  for (const w of wejscie.wpisy) {
    if (!wRoku(w.dataPrzychodu, rok)) continue;
    const wersja = wersjaNa(wersje, w.dataPrzychodu);
    const kiedy = formatIsoDatePl(w.dataPrzychodu);
    if (!wersja) {
      braki.push({
        dzien: w.dataPrzychodu,
        dokument: w.dokument,
        komunikat: `Wpis ${w.dokument} z ${kiedy}: bez ustawień podatkowych na ten dzień wpis nie należy do ewidencji. ${PROFIL_TEKST}`,
      });
      continue;
    }
    if (wersja.forma !== 'ryczalt') {
      braki.push({
        dzien: w.dataPrzychodu,
        dokument: w.dokument,
        komunikat:
          `Wpis ${w.dokument} z ${kiedy}: w tym dniu forma opodatkowania to ${NAZWY_FORM[wersja.forma].toLowerCase()}, ` +
          'więc wpis nie należy do ewidencji przychodów. Wpis usuwa się na liście wpisów ręcznych.',
      });
      continue;
    }
    wiersze.push({
      dataWpisu: w.dataWpisu,
      dataPrzychodu: w.dataPrzychodu,
      dowod: w.dokument,
      numerKsef: null,
      krajKontrahenta: null,
      idKontrahenta: null,
      kwotaGr: w.kwotaGr,
      stawkaPb: w.stawkaPb,
      uwagi: w.opis,
      zrodlo: { typ: 'wpis', id: w.id },
    });
  }

  const poProgu = progNajmu(wiersze, wejscie, braki);
  poProgu.sort(
    (a, b) =>
      a.dataPrzychodu.localeCompare(b.dataPrzychodu) ||
      a.dataWpisu.localeCompare(b.dataWpisu) ||
      a.dowod.localeCompare(b.dowod, 'pl') ||
      a.zrodlo.id.localeCompare(b.zrodlo.id) ||
      a.stawkaPb - b.stawkaPb,
  );
  braki.sort((a, b) => a.dzien.localeCompare(b.dzien) || a.dokument.localeCompare(b.dokument, 'pl'));

  return {
    rok,
    wiersze: poProgu.map((w, i) => ({ ...w, lp: i + 1 })),
    braki,
    pominiete,
    ryczaltWRoku: czyRyczaltWRoku(wersje, rok),
  };
}

const wOkresie = (dzien: string, od: string, doDnia: string) => dzien >= od && dzien <= doDnia;

/** Wiersze z dniem przychodu w okresie [od, do], numerowane od 1 (K_1 pliku za ten okres). */
export function wierszeOkresu(e: Ewidencja, od: string, doDnia: string): WierszEwidencji[] {
  return e.wiersze.filter((w) => wOkresie(w.dataPrzychodu, od, doDnia)).map((w, i) => ({ ...w, lp: i + 1 }));
}

export function brakiOkresu(e: Ewidencja, od: string, doDnia: string): BrakEwidencji[] {
  return e.braki.filter((b) => wOkresie(b.dzien, od, doDnia));
}

export function sumyOkresu(wiersze: readonly WierszEwidencji[]): SumyOkresu {
  const stawki = new Map<number, number>();
  for (const w of wiersze) stawki.set(w.stawkaPb, (stawki.get(w.stawkaPb) ?? 0) + w.kwotaGr);
  return {
    stawki: new Map([...stawki].sort((a, b) => b[0] - a[0])),
    razemGr: wiersze.reduce((s, w) => s + w.kwotaGr, 0),
    liczbaWierszy: wiersze.length,
  };
}
