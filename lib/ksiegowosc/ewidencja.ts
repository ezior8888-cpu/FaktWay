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
 *   FP jest poza ewidencją (`pominiete`), gdy raporty kasy z miesiąca paragonu
 *   obejmują kwotę faktur do paragonów z tego miesiąca (`pokrycieFakturDoParagonu`,
 *   krok 1.2, złoty przypadek G30); inaczej brak, bo FP nie może po cichu
 *   zniknąć ani być drugim przychodem.
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
  /** F11-C4: dane z importu KSeF, których FaktWay nie zna pewnie (te same powody co odmowa JPK). */
  niepewnyImport?: NiepewnyImport | null;
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
 * F11-C4: faktura z importu KSeF, której JPK odmawia, bo FaktWay nie zna
 * pewnie jej dnia przychodu albo kwoty (`importedContentFlags` w
 * `lib/exports/data-fetcher.ts`): import sprzed odczytu daty sprzedaży
 * i adnotacji (C5b), różne albo nieczytelne daty sprzedaży, nieznane sumy.
 */
export type NiepewnyImport = 'przed_odczytem' | 'daty_sprzedazy' | 'sumy';

const NIEPEWNY_IMPORT: Readonly<Record<NiepewnyImport, string>> = {
  przed_odczytem: 'jest zaimportowana z KSeF przed odczytem daty sprzedaży z pliku, więc nie wiadomo, w którym dniu powstał przychód',
  daty_sprzedazy: 'ma pozycje z różnymi datami sprzedaży albo nieczytelną datę sprzedaży, a przychód powstaje w dniu sprzedaży',
  sumy: 'została zaimportowana z KSeF bez sum netto i VAT, więc FaktWay nie zna jej kwoty',
};

/** Brak przy fakturze z importu, której dnia przychodu albo kwoty FaktWay nie zna (F11-C4). */
export function brakFakturyZImportu(numer: string, dzien: string, powod: NiepewnyImport, gdzie: 'ewidencji' | 'księgi'): string {
  const wyjscie =
    powod === 'przed_odczytem'
      ? 'FaktWay uzupełnia datę sprzedaży automatycznie z oryginału w KSeF (postęp: Import danych → Historia z KSeF) i wtedy policzy miesiąc. ' +
        'Jeśli ten komunikat zostaje dłużej niż dobę, napisz do nas przez Pomoc.'
      : 'Miesiąc policzymy ręcznie po zgłoszeniu w Pomocy.';
  return (
    `Faktura ${numer} z ${formatIsoDatePl(dzien)} ${NIEPEWNY_IMPORT[powod]}. Tego miesiąca (${monthLabel(dzien.slice(0, 7))}) ` +
    `FaktWay nie liczy, żeby przychód nie wszedł do ${gdzie} z błędną datą albo kwotą. ${wyjscie}`
  );
}

/**
 * Faktura do paragonu (krok 1.2 planu kompletnej aplikacji, RP-FP-01). Zasada 2
 * planu księgowości: FP nie jest drugim przychodem, jeśli sprzedaż weszła już
 * z raportu kasy (art. 14 ust. 1 ustawy o PIT: przychód ze sprzedaży powstaje
 * raz; art. 109 ust. 3d ustawy o VAT: FP nie zwiększa wartości sprzedaży).
 *
 * Reguła pokrycia (miesiąc i kwoty, #509): FP jest poza ewidencją i KPiR, gdy
 * raporty kasy z miesiąca paragonu (dzień przychodu FP) są nie niższe niż
 * faktury do paragonów z tego miesiąca. Raport kasy to wpis ręczny „Raport
 * z kasy rejestrującej” (w KPiR w kolumnie 7); rodzaj ma w formularzu wartość
 * domyślną, więc dochodzi warunek kwot. Bez raportu, przy niższej kwocie albo
 * przy FP w walucie, korekcie, zaliczce i kwocie nie większej niż 0 jest brak
 * z nazwą faktury i wyjściem: FP nie zniknie i nie wejdzie drugi raz.
 * Przyjęte według rekomendacji, do potwierdzenia przez księgową (G30).
 */
export interface RaportKasy {
  /** Dzień przychodu wpisu (RRRR-MM-DD). */
  dzien: string;
  kwotaGr: number;
}

export type PokrycieFp = { pokryta: true; powod: string } | { pokryta: false; komunikat: string };

export type BrakPokryciaFp =
  | { powod: 'brak_raportu' }
  | { powod: 'raport_nizszy'; raportyGr: number; fakturyGr: number }
  | { powod: 'nie_zestawi'; opis: string };

const MIEJSCE: Readonly<Record<'ewidencji' | 'księgi', string>> = { ewidencji: 'W ewidencji', księgi: 'W księdze' };

export function brakFakturyDoParagonu(numer: string, dzien: string, gdzie: 'ewidencji' | 'księgi', brak: BrakPokryciaFp): string {
  const miesiac = monthLabel(dzien.slice(0, 7));
  const wstep =
    `Faktura ${numer} z ${formatIsoDatePl(dzien)} to faktura do paragonu: sprzedaż z paragonu wchodzi do ${gdzie} ` +
    'z raportu kasy, a sama faktura nie jest przychodem.';
  switch (brak.powod) {
    case 'brak_raportu':
      return (
        `${wstep} ${MIEJSCE[gdzie]} za ${miesiac} nie ma raportu kasy (wpis ręczny „Raport z kasy rejestrującej”` +
        `${gdzie === 'księgi' ? ', kolumna 7' : ''}), więc FaktWay nie liczy tego miesiąca, żeby sprzedaż z paragonu nie zniknęła. ` +
        'Raport kasy za ten miesiąc dodaje się we wpisach ręcznych. Jeśli tej sprzedaży nie zapisano na kasie, miesiąc policzymy ręcznie po zgłoszeniu w Pomocy.'
      );
    case 'raport_nizszy':
      return (
        `${wstep} Raporty kasy za ${miesiac} (${kwotaTekst(brak.raportyGr)} zł) są niższe niż faktury do paragonów ` +
        `z tego miesiąca (${kwotaTekst(brak.fakturyGr)} zł), więc nie obejmują całej tej sprzedaży i FaktWay nie liczy ` +
        'tego miesiąca. Kwoty raportów kasy są we wpisach ręcznych; jeśli się zgadzają, miesiąc policzymy ręcznie po zgłoszeniu w Pomocy.'
      );
    case 'nie_zestawi':
      return (
        `${wstep} Tej faktury (${brak.opis}) FaktWay nie zestawi z raportem kasy, więc nie liczy tego miesiąca. ` +
        'Miesiąc policzymy ręcznie po zgłoszeniu w Pomocy.'
      );
  }
}

/** Co FP z importu może mieć poza zwykłą fakturą w złotych (FaktWay wystawia FP tylko tak). */
function opisNiezestawialnej(f: FakturaEwidencji): string | null {
  if (f.rodzaj !== 'zwykla') return NAZWY_RODZAJU[f.rodzaj];
  if (f.waluta.toUpperCase() !== 'PLN') return `w ${f.waluta.toUpperCase()}`;
  if (f.nettoGr <= 0) return `z kwotą netto ${kwotaTekst(f.nettoGr)} zł`;
  return null;
}

/**
 * Pokrycie każdej FP raportami kasy z miesiąca jej dnia przychodu (zasada
 * w komentarzu nad `RaportKasy`). Wynik po `id` faktury, dla każdej FP z listy.
 */
export function pokrycieFakturDoParagonu(
  faktury: readonly FakturaEwidencji[],
  raporty: readonly RaportKasy[],
  gdzie: 'ewidencji' | 'księgi',
): Map<string, PokrycieFp> {
  const miesiac = (dzien: string) => dzien.slice(0, 7);
  const fpWMiesiacu = new Map<string, number>();
  for (const f of faktury) {
    if (!f.fp || opisNiezestawialnej(f) !== null) continue;
    const m = miesiac(dzienPrzychodu(f));
    fpWMiesiacu.set(m, (fpWMiesiacu.get(m) ?? 0) + f.nettoGr);
  }
  const raportyWMiesiacu = new Map<string, number>();
  for (const r of raporty) raportyWMiesiacu.set(miesiac(r.dzien), (raportyWMiesiacu.get(miesiac(r.dzien)) ?? 0) + r.kwotaGr);

  const wynik = new Map<string, PokrycieFp>();
  for (const f of faktury) {
    if (!f.fp) continue;
    const dzien = dzienPrzychodu(f);
    const brak = (b: BrakPokryciaFp) => wynik.set(f.id, { pokryta: false, komunikat: brakFakturyDoParagonu(f.numer, dzien, gdzie, b) });
    const opis = opisNiezestawialnej(f);
    if (opis !== null) {
      brak({ powod: 'nie_zestawi', opis });
      continue;
    }
    const raportyGr = raportyWMiesiacu.get(miesiac(dzien));
    const fakturyGr = fpWMiesiacu.get(miesiac(dzien)) ?? 0;
    if (raportyGr === undefined) brak({ powod: 'brak_raportu' });
    else if (raportyGr < fakturyGr) brak({ powod: 'raport_nizszy', raportyGr, fakturyGr });
    else {
      wynik.set(f.id, {
        pokryta: true,
        powod:
          `Faktura do paragonu nie jest drugim przychodem: sprzedaż z paragonu weszła do ${gdzie} z raportu kasy ` +
          `za ${monthLabel(miesiac(dzien))}.`,
      });
    }
  }
  return wynik;
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
  // Krok 1.2: FP poza przychodem, gdy raport kasy z miesiąca paragonu ją obejmuje (RP-FP-01).
  const pokrycieFp = pokrycieFakturDoParagonu(
    wejscie.faktury,
    wejscie.wpisy.filter((w) => w.rodzaj === 'raport_kasy').map((w) => ({ dzien: w.dataPrzychodu, kwotaGr: w.kwotaGr })),
    'ewidencji',
  );

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

    if (f.niepewnyImport) {
      braki.push({ dzien, dokument: f.numer, komunikat: brakFakturyZImportu(f.numer, dzien, f.niepewnyImport, 'ewidencji') });
      continue;
    }
    if (f.fp) {
      const p = pokrycieFp.get(f.id) ?? { pokryta: false, komunikat: brakFakturyDoParagonu(f.numer, dzien, 'ewidencji', { powod: 'brak_raportu' }) };
      if (p.pokryta) pominiete.push({ numer: f.numer, dzien, powod: p.powod });
      else braki.push({ dzien, dokument: f.numer, komunikat: p.komunikat });
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
