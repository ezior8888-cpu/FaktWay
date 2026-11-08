/**
 * Plik JPK_PKPIR(3): podatkowa księga przychodów i rozchodów (plan
 * księgowości JDG, K7). Struktura według schematu MF
 * `http://jpk.mf.gov.pl/wzor/2024/10/30/10302/` (lib/exports/schemas/
 * jpk-pkpir3/schemat.xsd, pobrany 7.11.2026 z gov.pl) i broszury MF
 * z października 2025. Wiersze daje `kpir.ts`; ten plik tylko je zapisuje.
 * Przed wydaniem człowiekowi plik przechodzi `validateJpkPkpir`.
 *
 * Podmiot to osoba fizyczna (JDG): NIP, imię, nazwisko i data urodzenia
 * podawane przy pobraniu, jak w JPK_EWP (K3). Pola rolnika (Rolnik_PIT,
 * K_9A, K_14A, SumaPrzychodow2) zostają puste: od rozporządzenia
 * z 6.09.2025 (Dz.U. 2025 poz. 1299) nie mają funkcji.
 *
 * PKPIRInfo: spis z natury na początek i koniec roku (P_1, P_2) moduł
 * dziś zapisuje jako zero, więc P_3 to koszty z księgi, a P_4 przychód minus
 * P_3. Firma, która ma towary handlowe (koszty w K_10), dostaje uwagę
 * w pobraniu: spis z natury podaje księgowa.
 */

import { create } from 'xmlbuilder2';

import { kwotaJpk } from '@/lib/ksiegowosc/jpk-ewp';
import { sumyKpir, type WierszKpir } from '@/lib/ksiegowosc/kpir';

export const JPK_PKPIR_NAMESPACE = 'http://jpk.mf.gov.pl/wzor/2024/10/30/10302/';
export const ETD_NAMESPACE = 'http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/01/05/eD/DefinicjeTypy/';

export interface PodatnikJpkPkpir {
  nip: string;
  imie: string;
  nazwisko: string;
  dataUrodzenia: string;
}

export interface DaneJpkPkpir {
  od: string;
  do: string;
  /** 1: pierwsze złożenie (pełny, zamknięty rok), 0: plik na żądanie (część roku). */
  celZlozenia: 0 | 1;
  kodUrzedu: string;
  podatnik: PodatnikJpkPkpir;
  /** Wiersze okresu numerowane od 1 (`wierszeKpirOkresu`). */
  wiersze: readonly WierszKpir[];
  wytworzono?: Date;
}

/** TZnakowyJPK: 1-256 znaków bez zbędnych spacji. */
function znaki(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 256);
}

export function nazwaPlikuJpkPkpir(nip: string, od: string, doDnia: string): string {
  return `JPK_PKPIR_${nip}_${od}_${doDnia}.xml`;
}

export function generujJpkPkpir(dane: DaneJpkPkpir): string {
  // LiczbaWierszy to TNaturalnyJPK (> 0): plik bez wierszy nie przejdzie schematu.
  if (dane.wiersze.length === 0) throw new Error('JPK_PKPIR: brak wierszy w okresie');

  const root = create({ version: '1.0', encoding: 'UTF-8' }).ele('JPK', {
    xmlns: JPK_PKPIR_NAMESPACE,
    'xmlns:etd': ETD_NAMESPACE,
  });

  const naglowek = root.ele('Naglowek');
  naglowek.ele('KodFormularza', { kodSystemowy: 'JPK_PKPIR (3)', wersjaSchemy: '1-0' }).txt('JPK_PKPIR').up();
  naglowek.ele('WariantFormularza').txt('3').up();
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

  const sumy = sumyKpir(dane.wiersze);
  const info = root.ele('PKPIRInfo');
  info.ele('P_1').txt(kwotaJpk(0)).up();
  info.ele('P_2').txt(kwotaJpk(0)).up();
  info.ele('P_3').txt(kwotaJpk(sumy.kosztyGr)).up();
  info.ele('P_4').txt(kwotaJpk(sumy.przychodGr - sumy.kosztyGr)).up();

  for (const w of dane.wiersze) {
    const k = w.kwoty;
    const wiersz = root.ele('PKPIRWiersz');
    wiersz.ele('K_1').txt(String(w.lp)).up();
    wiersz.ele('K_2').txt(w.data).up();
    wiersz.ele('K_3A').txt(znaki(w.dowod)).up();
    if (w.numerKsef) wiersz.ele('K_3B').txt(w.numerKsef.trim()).up();
    if (w.krajKontrahenta && w.idKontrahenta) wiersz.ele('K_4A').txt(w.krajKontrahenta).up();
    if (w.idKontrahenta) wiersz.ele('K_4B').txt(w.idKontrahenta).up();
    wiersz.ele('K_5A').txt(znaki(w.nazwaKontrahenta)).up();
    wiersz.ele('K_5B').txt(znaki(w.adresKontrahenta)).up();
    wiersz.ele('K_6').txt(znaki(w.opis)).up();
    if (k.k7) wiersz.ele('K_7').txt(kwotaJpk(k.k7)).up();
    if (k.k8) wiersz.ele('K_8').txt(kwotaJpk(k.k8)).up();
    if (k.k7 || k.k8) wiersz.ele('K_9').txt(kwotaJpk(k.k7 + k.k8)).up();
    if (k.k10) wiersz.ele('K_10').txt(kwotaJpk(k.k10)).up();
    if (k.k11) wiersz.ele('K_11').txt(kwotaJpk(k.k11)).up();
    if (k.k12) wiersz.ele('K_12').txt(kwotaJpk(k.k12)).up();
    if (k.k13) wiersz.ele('K_13').txt(kwotaJpk(k.k13)).up();
    if (k.k12 || k.k13) wiersz.ele('K_14').txt(kwotaJpk(k.k12 + k.k13)).up();
    if (w.br) {
      wiersz.ele('K_16A').txt(znaki(w.br.opis)).up();
      wiersz.ele('K_16B').txt(kwotaJpk(w.br.kwotaGr)).up();
    }
    if (w.uwagi && znaki(w.uwagi)) wiersz.ele('K_17').txt(znaki(w.uwagi)).up();
  }

  const ctrl = root.ele('PKPIRCtrl');
  ctrl.ele('LiczbaWierszy').txt(String(dane.wiersze.length)).up();
  ctrl.ele('SumaPrzychodow').txt(kwotaJpk(sumy.przychodGr)).up();

  return root.end({ prettyPrint: true });
}
