/**
 * Strażnik JPK_V7M(3) (żelazny filtr F13 część 2, plan B4.10; D-F7: w module
 * księgowości blokada od razu). Ostatnia kontrola spójności gotowego pliku:
 * akcje ekranu VAT (`plikMiesiaca` w `app/actions/ksiegowosc-vat.ts`) wołają
 * go po kontroli XSD, przed wydaniem pliku klientowi i przed wysyłką do
 * bramki MF. Plik z alarmem nie wychodzi: klient dostaje `odmowaJpkV7m`,
 * operator alarm (`alarm.ts`).
 *
 * Funkcja czysta nad tekstem XML (parser `fast-xml-parser`, jak import FA(3)
 * i JPK_FA). Kwoty w groszach jako bezpieczne liczby całkowite; pola nie ma,
 * to 0. Pole powtórzone, puste, z przecinkiem, z więcej niż dwoma miejscami
 * po przecinku albo poza zakresem liczb całkowitych to błąd kontroli, która
 * go potrzebuje. Typy i zakresy pól (np. P_51 nieujemne) sprawdza XSD przed
 * strażnikiem.
 *
 * Wzory pochodzą z oficjalnego schematu MF
 * (`lib/exports/schemas/jpk-v7m3/schemat.xsd`), z opisów pól
 * (`xsd:documentation`) i z komentarzy przy polach deklaracji, nie z kodu
 * generatora. To jedno źródło dla strażnika i testu filtra
 * (`tests/filtr/xsd/jpk-v7m.test.ts`).
 *
 * - FILTR-RT-JPK-01: LiczbaWierszySprzedazy i LiczbaWierszyZakupow to liczba
 *   wierszy SprzedazWiersz i ZakupWiersz (opisy pól). Plik bez ewidencji albo
 *   bez sum kontrolnych też.
 * - FILTR-RT-JPK-02: PodatekNalezny to „suma kwot z K_16, K_18, K_20, K_24,
 *   K_26, K_28, K_30, K_32, K_33 i K_34 pomniejszona o kwotę z K_35, K_36
 *   i K_360, z wyłączeniem faktur oznaczonych FP” (opis pola).
 * - FILTR-RT-JPK-03: PodatekNaliczony to „suma kwot z K_41, K_43, K_44,
 *   K_45, K_46, K_47” (opis pola).
 * - FILTR-RT-JPK-04: deklaracja. Sumy z opisów: P_37 (P_10, P_11, P_13,
 *   P_15, P_17, P_19, P_21, P_22, P_23, P_25, P_27, P_29, P_31), P_38 (P_16,
 *   P_18, P_20, P_24, P_26, P_28, P_30, P_32, P_33, P_34 minus P_35, P_36,
 *   P_360), P_48 (P_39, P_41, P_43, P_44, P_45, P_46, P_47). Wzory
 *   z komentarzy przy polach: P_49 nie wyższe niż P_38 minus P_48, a 0, gdy
 *   ta różnica nie jest dodatnia; P_50 nie wyższe niż P_38 minus P_48 i P_49,
 *   a 0, gdy ta różnica jest ujemna; P_51 = P_38 - P_48 - P_49 - P_50, gdy
 *   P_38 - P_48 > 0, inaczej 0; P_53 = 0, gdy P_51 > 0, inaczej
 *   P_48 - P_38 + P_49 + P_50 + P_52, gdy to więcej niż 0, inaczej 0;
 *   P_62 = P_53 - P_54.
 * - FILTR-RT-JPK-05: deklaracja zgodna z ewidencją w granicy zaokrąglenia
 *   do złotych (NZ-VAT-02, plan B4.10 „zgodność deklaracji z ewidencją”).
 *   Pole deklaracji P_xx i suma pól K_xx z wierszy (z tym samym opisem:
 *   P_10 do P_36 i P_360 ze sprzedaży bez faktur FP, jak PodatekNalezny,
 *   P_40 do P_47 z zakupów) różnią się najwyżej o 50 gr. Granica nie zależy
 *   od tego, w którą stronę zaokrągla się pół złotego przy kwocie ujemnej.
 *
 * Poza strażnikiem, bo wzoru nie da się sprawdzić z samego pliku albo opis
 * go nie podaje: P_39 („Kwota z P_62 wykazana w poprzedniej deklaracji lub
 * wynikająca z decyzji”), P_52 (pozostała ulga na kasy rejestrujące), P_54
 * do P_61 (zwrot: opisy bez wzoru, P_54 wchodzi do P_62), P_68 i P_69
 * (korekta z art. 89a, opisy bez wzoru), kwoty wierszy wobec faktur
 * i kosztów (pilnuje ich test filtra przez `amountsOf`).
 */

import { XMLParser } from 'fast-xml-parser';

import type { AlarmFiltra } from '@/lib/bezpieczniki/alarm';

export const KODY_JPK_V7M = {
  wiersze: 'FILTR-RT-JPK-01',
  nalezny: 'FILTR-RT-JPK-02',
  naliczony: 'FILTR-RT-JPK-03',
  deklaracja: 'FILTR-RT-JPK-04',
  zEwidencja: 'FILTR-RT-JPK-05',
} as const;

export type KodJpkV7m = (typeof KODY_JPK_V7M)[keyof typeof KODY_JPK_V7M];

export interface AlarmJpkV7m extends AlarmFiltra {
  kod: KodJpkV7m;
  rodzaj: 'vat';
}

/** Suma pól `plus` pomniejszona o sumę pól `minus`. */
export interface Wzor {
  plus: readonly string[];
  minus: readonly string[];
}

/** Wzory sum z opisów pól schematu MF (cytaty w nagłówku pliku). */
export const WZORY_JPK_V7M = {
  podatekNalezny: {
    plus: ['K_16', 'K_18', 'K_20', 'K_24', 'K_26', 'K_28', 'K_30', 'K_32', 'K_33', 'K_34'],
    minus: ['K_35', 'K_36', 'K_360'],
  },
  podatekNaliczony: { plus: ['K_41', 'K_43', 'K_44', 'K_45', 'K_46', 'K_47'], minus: [] },
  P_37: { plus: ['P_10', 'P_11', 'P_13', 'P_15', 'P_17', 'P_19', 'P_21', 'P_22', 'P_23', 'P_25', 'P_27', 'P_29', 'P_31'], minus: [] },
  P_38: { plus: ['P_16', 'P_18', 'P_20', 'P_24', 'P_26', 'P_28', 'P_30', 'P_32', 'P_33', 'P_34'], minus: ['P_35', 'P_36', 'P_360'] },
  P_48: { plus: ['P_39', 'P_41', 'P_43', 'P_44', 'P_45', 'P_46', 'P_47'], minus: [] },
} as const satisfies Record<string, Wzor>;

/** Numery par P_xx i K_xx o tym samym opisie (FILTR-RT-JPK-05). */
export const DEKLARACJA_Z_EWIDENCJI = {
  sprzedaz: [
    '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29',
    '30', '31', '32', '33', '34', '35', '36', '360',
  ],
  zakupy: ['40', '41', '42', '43', '44', '45', '46', '47'],
} as const;

/** Granica zaokrąglenia do pełnych złotych w groszach (FILTR-RT-JPK-05). */
const ZAOKRAGLENIE_GR = 50;

/** Pola deklaracji, z których korzystają kontrole JPK-04 i JPK-05. */
const POLA_DEKLARACJI = [
  ...new Set<string>([
    ...[WZORY_JPK_V7M.P_37, WZORY_JPK_V7M.P_38, WZORY_JPK_V7M.P_48].flatMap((w) => [...w.plus, ...w.minus]),
    'P_37', 'P_38', 'P_48', 'P_49', 'P_50', 'P_51', 'P_52', 'P_53', 'P_54', 'P_62',
    ...[...DEKLARACJA_Z_EWIDENCJI.sprzedaz, ...DEKLARACJA_Z_EWIDENCJI.zakupy].map((nr) => `P_${nr}`),
  ]),
];

/** Początek odmowy: po nim Centrum eksportu pokazuje ją klientowi (F13 część 2b). */
export const ODMOWA_JPK_V7M_PREFIX = 'Plik JPK_V7M wstrzymany:';

/** Dla klienta zamiast pliku, który nie przeszedł kontroli; kod pierwszego alarmu. */
export function odmowaJpkV7m(kod: KodJpkV7m): string {
  return (
    `${ODMOWA_JPK_V7M_PREFIX} kontrola spójności wykryła błąd po naszej stronie (${kod}). Zgłosiliśmy go. ` +
    'Termin złożenia się nie przesuwa, więc w razie potrzeby złóż plik z księgową.'
  );
}

/** Odmowa strażnika w jobie eksportu: bez ponawiania (ten sam plik dałby ten sam alarm). */
export class OdmowaJpkV7mError extends Error {
  constructor(kod: KodJpkV7m) {
    super(odmowaJpkV7m(kod));
    this.name = 'OdmowaJpkV7mError';
  }
}

type Wezel = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  // Wartości jako tekst: kwoty czyta `grosze`, nie parser (jak w `lib/import/fa3-parser.ts`).
  parseTagValue: false,
  trimValues: true,
  isArray: (nazwa) => nazwa === 'SprzedazWiersz' || nazwa === 'ZakupWiersz',
});

/** Sprawdza gotowy plik; pusta lista to plik w porządku. `miesiac` (RRRR-MM) trafia do alarmów. */
export function sprawdzJpkV7m(xml: string, miesiac: string): AlarmJpkV7m[] {
  const alarmy: AlarmJpkV7m[] = [];
  const zglos = (kod: KodJpkV7m, opis: string) => alarmy.push({ kod, rodzaj: 'vat', miesiac, opis });

  const jpk = wezel(odczytaj(xml)?.JPK);
  const ewidencja = wezel(jpk?.Ewidencja);
  const pozycje = wezel(wezel(jpk?.Deklaracja)?.PozycjeSzczegolowe);

  // Sprzedaż do sum podatku: bez faktur oznaczonych FP (opis PodatekNalezny).
  const sprzedaz = wiersze(ewidencja?.SprzedazWiersz);
  const sprzedazBezFp = sprzedaz.filter((w) => w.TypDokumentu !== 'FP');
  const zakupy = wiersze(ewidencja?.ZakupWiersz);

  if (!ewidencja) {
    zglos(KODY_JPK_V7M.wiersze, 'plik nie ma ewidencji (Ewidencja)');
  } else {
    const sprzedazCtrl = wezel(ewidencja.SprzedazCtrl);
    const zakupCtrl = wezel(ewidencja.ZakupCtrl);
    sprawdzLiczbe(zglos, sprzedazCtrl, 'SprzedazCtrl', 'LiczbaWierszySprzedazy', sprzedaz.length);
    sprawdzLiczbe(zglos, zakupCtrl, 'ZakupCtrl', 'LiczbaWierszyZakupow', zakupy.length);
    sprawdzSume(zglos, KODY_JPK_V7M.nalezny, sprzedazCtrl, 'PodatekNalezny', sprzedazBezFp, WZORY_JPK_V7M.podatekNalezny, 'sprzedaży bez FP');
    sprawdzSume(zglos, KODY_JPK_V7M.naliczony, zakupCtrl, 'PodatekNaliczony', zakupy, WZORY_JPK_V7M.podatekNaliczony, 'zakupów');
  }

  if (!pozycje) {
    zglos(KODY_JPK_V7M.deklaracja, 'plik nie ma deklaracji (Deklaracja, PozycjeSzczegolowe)');
    return alarmy;
  }
  const deklaracja = new Map<string, number>();
  for (const pole of POLA_DEKLARACJI) {
    const gr = kwota(pozycje, pole);
    if (gr === null) zglos(KODY_JPK_V7M.deklaracja, `pole ${pole} deklaracji nie jest kwotą albo występuje więcej niż raz`);
    else deklaracja.set(pole, gr);
  }
  if (deklaracja.size === POLA_DEKLARACJI.length) sprawdzDeklaracje(zglos, (pole) => deklaracja.get(pole) ?? 0);

  if (!ewidencja) return alarmy;
  const pary = [
    ...DEKLARACJA_Z_EWIDENCJI.sprzedaz.map((nr) => ({ nr, wiersze: sprzedazBezFp, nazwa: 'sprzedaży bez FP' })),
    ...DEKLARACJA_Z_EWIDENCJI.zakupy.map((nr) => ({ nr, wiersze: zakupy, nazwa: 'zakupów' })),
  ];
  for (const { nr, wiersze: zWierszy, nazwa } of pary) {
    const p = deklaracja.get(`P_${nr}`);
    if (p === undefined) continue; // pole nie jest kwotą: alarm JPK-04 wyżej
    const k = sumaWzoru(zWierszy, { plus: [`K_${nr}`], minus: [] });
    if (k === null) zglos(KODY_JPK_V7M.zEwidencja, `pole K_${nr} w wierszach ${nazwa} nie jest kwotą albo suma wychodzi poza zakres`);
    else if (Math.abs(p - k) > ZAOKRAGLENIE_GR) {
      zglos(KODY_JPK_V7M.zEwidencja, `P_${nr} różni się od sumy K_${nr} z wierszy ${nazwa} o więcej niż zaokrąglenie do pełnych złotych`);
    }
  }
  return alarmy;
}

type Zglos = (kod: KodJpkV7m, opis: string) => void;

function sprawdzLiczbe(zglos: Zglos, ctrl: Wezel | null, nazwaCtrl: string, pole: string, ile: number): void {
  if (!ctrl) return zglos(KODY_JPK_V7M.wiersze, `plik nie ma sum kontrolnych ${nazwaCtrl}`);
  const wartosc = ctrl[pole];
  const liczba = typeof wartosc === 'string' && /^\+?\d+$/.test(wartosc) ? Number(wartosc) : null;
  if (liczba === null || !Number.isSafeInteger(liczba)) zglos(KODY_JPK_V7M.wiersze, `${pole} brak albo nie jest liczbą wierszy`);
  else if (liczba !== ile) zglos(KODY_JPK_V7M.wiersze, `${pole} różni się od liczby wierszy ewidencji`);
}

function sprawdzSume(zglos: Zglos, kod: KodJpkV7m, ctrl: Wezel | null, pole: string, wierszeEwidencji: readonly Wezel[], wzor: Wzor, nazwa: string): void {
  const wartosc = ctrl && Object.prototype.hasOwnProperty.call(ctrl, pole) ? kwota(ctrl, pole) : null;
  const suma = sumaWzoru(wierszeEwidencji, wzor);
  if (wartosc === null) zglos(kod, `${pole} brak albo nie jest kwotą`);
  else if (suma === null) zglos(kod, `pole z opisu ${pole} w wierszach ${nazwa} nie jest kwotą albo suma wychodzi poza zakres`);
  else if (wartosc !== suma) zglos(kod, `${pole} różni się od sumy pól z opisu ${pole} w wierszach ${nazwa}`);
}

/** JPK-04: wzory deklaracji z opisów i komentarzy pól (nagłówek pliku). `P` daje kwotę pola w groszach, 0 bez pola. */
function sprawdzDeklaracje(zglos: Zglos, P: (pole: string) => number): void {
  const blad = (opis: string) => zglos(KODY_JPK_V7M.deklaracja, opis);
  const wartosc = (wzor: Wzor) => suma([...wzor.plus.map(P), ...wzor.minus.map((pole) => -P(pole))]);

  for (const pole of ['P_37', 'P_38', 'P_48'] as const) {
    const s = wartosc(WZORY_JPK_V7M[pole]);
    if (s === null) blad(`suma pól z opisu ${pole} wychodzi poza zakres`);
    else if (P(pole) !== s) blad(`${pole} różni się od sumy pól z opisu ${pole}`);
  }

  const roznica = suma([P('P_38'), -P('P_48')]);
  const poP49 = roznica === null ? null : suma([roznica, -P('P_49')]);
  const p51 = roznica === null || poP49 === null ? null : roznica > 0 ? suma([poP49, -P('P_50')]) : 0;
  const nadwyzka = suma([P('P_48'), P('P_49'), P('P_50'), P('P_52'), -P('P_38')]);
  const p62 = suma([P('P_53'), -P('P_54')]);
  if (roznica === null || poP49 === null || p51 === null || nadwyzka === null || p62 === null) {
    return blad('kwoty od P_38 do P_62 wychodzą poza zakres liczb całkowitych');
  }

  if (P('P_49') > Math.max(0, roznica)) blad('P_49 wyższe niż P_38 minus P_48 (albo nie 0, gdy ta różnica nie jest dodatnia)');
  if (P('P_50') > Math.max(0, poP49)) blad('P_50 wyższe niż P_38 minus P_48 i P_49 (albo nie 0, gdy ta różnica jest ujemna)');
  if (P('P_51') !== p51) blad('P_51 różni się od P_38 minus P_48, P_49 i P_50 (0, gdy P_38 nie jest wyższe od P_48)');
  if (P('P_53') !== (P('P_51') > 0 ? 0 : Math.max(0, nadwyzka))) {
    blad('P_53 różni się od nadwyżki P_48, P_49, P_50 i P_52 nad P_38 (0, gdy P_51 jest większe od 0)');
  }
  if (P('P_62') !== p62) blad('P_62 różni się od P_53 minus P_54');
}

function odczytaj(xml: string): Wezel | null {
  try {
    return wezel(parser.parse(xml, true));
  } catch {
    return null;
  }
}

function wezel(v: unknown): Wezel | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Wezel) : null;
}

/** Wiersze ewidencji; wiersz bez pól (pusty element) liczy się do liczby wierszy, kwot nie ma. */
function wiersze(v: unknown): Wezel[] {
  return Array.isArray(v) ? v.map((w) => wezel(w) ?? {}) : [];
}

/** Suma wzoru po wierszach w groszach; null, gdy któreś pole nie jest kwotą albo suma wychodzi poza zakres. */
function sumaWzoru(wierszeEwidencji: readonly Wezel[], wzor: Wzor): number | null {
  const skladniki: number[] = [];
  for (const w of wierszeEwidencji) {
    for (const [pola, znak] of [[wzor.plus, 1], [wzor.minus, -1]] as const) {
      for (const pole of pola) {
        const gr = kwota(w, pole);
        if (gr === null) return null;
        skladniki.push(znak * gr);
      }
    }
  }
  return suma(skladniki);
}

/** Suma z kontrolą zakresu po każdym kroku: null, gdy wyjdzie poza bezpieczne liczby całkowite. */
function suma(skladniki: readonly number[]): number | null {
  let s = 0;
  for (const x of skladniki) {
    s += x;
    if (!Number.isSafeInteger(s)) return null;
  }
  return s;
}

/** Kwota pola w groszach; 0, gdy pola nie ma; null, gdy pole jest, ale nie jest jedną kwotą. */
function kwota(w: Wezel, pole: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(w, pole)) return 0;
  const v = w[pole];
  return typeof v === 'string' ? grosze(v) : null;
}

const KWOTA = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/** Tekst xsd:decimal (TKwotowy, TKwotaC) w groszach; null, gdy to nie kwota z najwyżej dwoma miejscami po przecinku. */
function grosze(tekst: string): number | null {
  const m = KWOTA.exec(tekst);
  if (!m) return null;
  const [, znak, calosc, ulamek = ''] = m;
  if (calosc === '' && ulamek === '') return null;
  if (/[1-9]/.test(ulamek.slice(2))) return null;
  const gr = Number(calosc || '0') * 100 + Number(ulamek.slice(0, 2).padEnd(2, '0'));
  if (!Number.isSafeInteger(gr)) return null;
  return znak === '-' ? 0 - gr : gr;
}
