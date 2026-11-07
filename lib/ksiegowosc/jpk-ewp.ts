/**
 * Plik JPK_EWP(4): ewidencja przychodów ryczałtu (plan księgowości JDG, K3).
 * Struktura według schematu MF `http://jpk.mf.gov.pl/wzor/2024/10/30/10301/`
 * (lib/exports/schemas/jpk-ewp4/schemat.xsd, pobrany 5.11.2026 z gov.pl)
 * i broszury MF z października 2025. Wiersze daje `ewidencja.ts`; ten plik
 * tylko je zapisuje. Przed wydaniem człowiekowi plik przechodzi
 * `validateJpkEwp`.
 *
 * Podmiot to osoba fizyczna (JDG): NIP, imię, nazwisko i data urodzenia.
 * FaktWay ich nie przechowuje, więc klient podaje je przy pobraniu (jak dane
 * autoryzujące w D9).
 */

import { create } from 'xmlbuilder2';

import type { WierszEwidencji } from '@/lib/ksiegowosc/ewidencja';

export const JPK_EWP_NAMESPACE = 'http://jpk.mf.gov.pl/wzor/2024/10/30/10301/';
export const ETD_NAMESPACE = 'http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/01/05/eD/DefinicjeTypy/';

export interface PodatnikJpkEwp {
  nip: string;
  imie: string;
  nazwisko: string;
  dataUrodzenia: string;
}

export interface DaneJpkEwp {
  od: string;
  do: string;
  /** 1: pierwsze złożenie (pełny, zamknięty rok), 0: plik na żądanie (część roku). */
  celZlozenia: 0 | 1;
  kodUrzedu: string;
  podatnik: PodatnikJpkEwp;
  /** Wiersze okresu numerowane od 1 (`wierszeOkresu`). */
  wiersze: readonly WierszEwidencji[];
  wytworzono?: Date;
}

/** TKwotowy: grosze jako „1234.56”, bez separatorów tysięcy. */
export function kwotaJpk(gr: number): string {
  const znak = gr < 0 ? '-' : '';
  const abs = Math.abs(gr);
  return `${znak}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** K_9 ze słownika: 1250 → „12.5”, 1200 → „12”. */
export function stawkaJpk(pb: number): string {
  return String(pb / 100);
}

/** TZnakowyJPK: 1-256 znaków bez zbędnych spacji. */
function znaki(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 256);
}

/** 1: cały zamknięty rok (DataOd 1.01, DataDo 31.12, rok minął); 0: każdy inny okres. */
export function celZlozenia(od: string, doDnia: string, dzis: string): 0 | 1 {
  const rok = od.slice(0, 4);
  return od === `${rok}-01-01` && doDnia === `${rok}-12-31` && dzis > doDnia ? 1 : 0;
}

export function nazwaPlikuJpkEwp(nip: string, od: string, doDnia: string): string {
  return `JPK_EWP_${nip}_${od}_${doDnia}.xml`;
}

export function generujJpkEwp(dane: DaneJpkEwp): string {
  // LiczbaWierszy to TNaturalnyJPK (> 0): plik bez wpisów nie przejdzie schematu.
  if (dane.wiersze.length === 0) throw new Error('JPK_EWP: brak wierszy w okresie');

  const root = create({ version: '1.0', encoding: 'UTF-8' }).ele('JPK', {
    xmlns: JPK_EWP_NAMESPACE,
    'xmlns:etd': ETD_NAMESPACE,
  });

  const naglowek = root.ele('Naglowek');
  naglowek.ele('KodFormularza', { kodSystemowy: 'JPK_EWP (4)', wersjaSchemy: '1-0' }).txt('JPK_EWP').up();
  naglowek.ele('WariantFormularza').txt('4').up();
  naglowek.ele('CelZlozenia').txt(String(dane.celZlozenia)).up();
  naglowek.ele('DataWytworzeniaJPK').txt(`${(dane.wytworzono ?? new Date()).toISOString().slice(0, 19)}Z`).up();
  naglowek.ele('DataOd').txt(dane.od).up();
  naglowek.ele('DataDo').txt(dane.do).up();
  naglowek.ele('KodUrzedu').txt(dane.kodUrzedu).up();

  const osoba = root.ele('Podmiot1', { rola: 'Podatnik' }).ele('OsobaFizyczna');
  osoba.ele('etd:NIP').txt(dane.podatnik.nip).up();
  osoba.ele('etd:ImiePierwsze').txt(znaki(dane.podatnik.imie)).up();
  osoba.ele('etd:Nazwisko').txt(znaki(dane.podatnik.nazwisko)).up();
  osoba.ele('etd:DataUrodzenia').txt(dane.podatnik.dataUrodzenia).up();

  let suma = 0;
  for (const w of dane.wiersze) {
    const wiersz = root.ele('EWPWiersz');
    wiersz.ele('K_1').txt(String(w.lp)).up();
    wiersz.ele('K_2').txt(w.dataWpisu).up();
    wiersz.ele('K_3').txt(w.dataPrzychodu).up();
    wiersz.ele('K_4').txt(znaki(w.dowod)).up();
    if (w.numerKsef) wiersz.ele('K_5').txt(w.numerKsef.trim()).up();
    if (w.krajKontrahenta && w.idKontrahenta) wiersz.ele('K_6').txt(w.krajKontrahenta).up();
    if (w.idKontrahenta) wiersz.ele('K_7').txt(w.idKontrahenta).up();
    wiersz.ele('K_8').txt(kwotaJpk(w.kwotaGr)).up();
    wiersz.ele('K_9').txt(stawkaJpk(w.stawkaPb)).up();
    if (w.uwagi && znaki(w.uwagi)) wiersz.ele('K_10').txt(znaki(w.uwagi)).up();
    suma += w.kwotaGr;
  }

  const ctrl = root.ele('EWPCtrl');
  ctrl.ele('LiczbaWierszy').txt(String(dane.wiersze.length)).up();
  ctrl.ele('SumaPrzychodow').txt(kwotaJpk(suma)).up();

  return root.end({ prettyPrint: true });
}
