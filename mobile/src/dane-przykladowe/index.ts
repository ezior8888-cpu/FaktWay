/**
 * Dane przykładowe do etapów M2 i M3 (bez logowania i API). Firmy są
 * zmyślone, NIP to testowy `1234567890` (AGENTS.md, „KSeF-specific”).
 * Kwoty w groszach. Prawdziwe dane podłącza etap M6.
 */

/** „Dziś” dla danych przykładowych, żeby terminy i zaległości się nie rozjeżdżały. */
export const DZIS = '2026-11-09';

export type StatusKsef = 'przyjeta' | 'wysylanie' | 'odrzucona' | 'robocza';

export type Pozycja = {
  nazwa: string;
  ilosc: number;
  jednostka: string;
  cenaNetto: number;
  stawkaVat: number;
};

export type Faktura = {
  id: string;
  numer: string;
  kontrahent: string;
  nipKontrahenta: string;
  dataWystawienia: string;
  terminPlatnosci: string;
  brutto: number;
  netto: number;
  statusKsef: StatusKsef;
  numerKsef?: string;
  zaplacona: boolean;
  pozycje: Pozycja[];
};

const NIP = '1234567890';

function faktura(
  id: string,
  numer: string,
  kontrahent: string,
  dataWystawienia: string,
  terminPlatnosci: string,
  pozycje: Pozycja[],
  statusKsef: StatusKsef,
  zaplacona: boolean,
): Faktura {
  const netto = pozycje.reduce((s, p) => s + Math.round(p.ilosc * p.cenaNetto), 0);
  const vat = pozycje.reduce((s, p) => s + Math.round((p.ilosc * p.cenaNetto * p.stawkaVat) / 100), 0);
  return {
    id,
    numer,
    kontrahent,
    nipKontrahenta: NIP,
    dataWystawienia,
    terminPlatnosci,
    netto,
    brutto: netto + vat,
    statusKsef,
    numerKsef:
      statusKsef === 'przyjeta'
        ? `${NIP}-${dataWystawienia.replaceAll('-', '')}-${id.toUpperCase().padStart(6, '0')}-A1`
        : undefined,
    zaplacona,
    pozycje,
  };
}

const uslugaGraficzna = (cena: number): Pozycja => ({
  nazwa: 'Projekt graficzny',
  ilosc: 1,
  jednostka: 'usł.',
  cenaNetto: cena,
  stawkaVat: 23,
});

export const FAKTURY: Faktura[] = [
  faktura('f12', 'FV/11/2026/7', 'Pracownia Lipowa sp. z o.o.', '2026-11-07', '2026-11-21',
    [uslugaGraficzna(450000), { nazwa: 'Poprawki', ilosc: 3, jednostka: 'godz.', cenaNetto: 15000, stawkaVat: 23 }],
    'wysylanie', false),
  faktura('f11', 'FV/11/2026/6', 'Zielony Ogród Anna Nowak', '2026-11-05', '2026-11-19',
    [{ nazwa: 'Sesja zdjęciowa produktów', ilosc: 1, jednostka: 'usł.', cenaNetto: 180000, stawkaVat: 23 }],
    'przyjeta', false),
  faktura('f10', 'FV/11/2026/5', 'Biuro Rachunkowe Sowa', '2026-11-04', '2026-11-18',
    [{ nazwa: 'Strona internetowa, etap 2', ilosc: 1, jednostka: 'usł.', cenaNetto: 620000, stawkaVat: 23 }],
    'przyjeta', true),
  faktura('f9', 'FV/11/2026/4', 'Drukarnia Pod Mostem', '2026-11-03', '2026-11-17',
    [{ nazwa: 'Skład katalogu', ilosc: 24, jednostka: 'str.', cenaNetto: 9000, stawkaVat: 23 }],
    'odrzucona', false),
  faktura('f8', 'FV/11/2026/3', 'Atelier Wiśniewski', '2026-11-02', '2026-11-16',
    [uslugaGraficzna(210000)], 'przyjeta', true),
  faktura('f7', 'FV/11/2026/2', 'Kowalczyk Studio', '2026-11-02', '2026-11-09',
    [{ nazwa: 'Identyfikacja wizualna', ilosc: 1, jednostka: 'usł.', cenaNetto: 980000, stawkaVat: 23 }],
    'przyjeta', false),
  faktura('f6', 'FV/11/2026/1', 'Pracownia Lipowa sp. z o.o.', '2026-11-01', '2026-11-15',
    [uslugaGraficzna(300000)], 'przyjeta', true),
  faktura('f5', 'FV/10/2026/9', 'Hotel Nad Zatoką', '2026-10-28', '2026-11-04',
    [{ nazwa: 'Projekt menu', ilosc: 1, jednostka: 'usł.', cenaNetto: 150000, stawkaVat: 23 }],
    'przyjeta', false),
  faktura('f4', 'FV/10/2026/8', 'Zielony Ogród Anna Nowak', '2026-10-21', '2026-10-28',
    [{ nazwa: 'Ulotki A5, projekt', ilosc: 2, jednostka: 'usł.', cenaNetto: 60000, stawkaVat: 23 }],
    'przyjeta', false),
  faktura('f3', 'FV/10/2026/7', 'Kowalczyk Studio', '2026-10-15', '2026-10-29',
    [uslugaGraficzna(520000)], 'przyjeta', true),
  faktura('f2', 'FV/10/2026/6', 'Biuro Rachunkowe Sowa', '2026-10-08', '2026-10-22',
    [{ nazwa: 'Opieka nad stroną, październik', ilosc: 1, jednostka: 'mies.', cenaNetto: 90000, stawkaVat: 23 }],
    'przyjeta', true),
  faktura('f1', 'FV/10/2026/5', 'Drukarnia Pod Mostem', '2026-10-02', '2026-10-16',
    [{ nazwa: 'Projekt okładki', ilosc: 1, jednostka: 'usł.', cenaNetto: 110000, stawkaVat: 23 }],
    'przyjeta', true),
];

export function znajdzFakture(id: string): Faktura | undefined {
  return FAKTURY.find((f) => f.id === id);
}

export type Koszt = {
  id: string;
  dostawca: string;
  opis: string;
  data: string;
  brutto: number;
  zrodlo: 'ksef' | 'zdjecie';
  doOpisania: boolean;
};

export const KOSZTY: Koszt[] = [
  { id: 'k1', dostawca: 'Telekom Wschód sp. z o.o.', opis: 'Abonament, listopad', data: '2026-11-06', brutto: 9840, zrodlo: 'ksef', doOpisania: true },
  { id: 'k2', dostawca: 'Biuro Coworking Kwadrat', opis: 'Biurko, listopad', data: '2026-11-03', brutto: 73800, zrodlo: 'ksef', doOpisania: true },
  { id: 'k3', dostawca: 'Hurtownia Papiernicza Ołówek', opis: 'Materiały biurowe', data: '2026-11-02', brutto: 15621, zrodlo: 'ksef', doOpisania: false },
  { id: 'k4', dostawca: 'Stacja Paliw Rondo', opis: 'Paliwo', data: '2026-11-05', brutto: 28450, zrodlo: 'zdjecie', doOpisania: false },
  { id: 'k5', dostawca: 'Kawiarnia Ziarno', opis: 'Spotkanie z klientem', data: '2026-11-04', brutto: 4200, zrodlo: 'zdjecie', doOpisania: false },
];

export type Platnosc = {
  id: string;
  nazwa: string;
  opis: string;
  termin: string;
  kwota: number;
  zaplacona: boolean;
};

/** Zobowiązania za październik płatne w listopadzie (kwoty przykładowe). */
export const MIESIAC = {
  nazwa: 'Listopad 2026',
  przychod: 3_456_000,
  koszty: 1_128_000,
  platnosci: [
    { id: 'm1', nazwa: 'ZUS', opis: 'Składki za październik', termin: '2026-11-20', kwota: 181_234, zaplacona: false },
    { id: 'm2', nazwa: 'Składka zdrowotna', opis: 'Za październik', termin: '2026-11-20', kwota: 49_878, zaplacona: false },
    { id: 'm3', nazwa: 'PIT', opis: 'Zaliczka za październik, liniowy', termin: '2026-11-20', kwota: 254_300, zaplacona: false },
    { id: 'm4', nazwa: 'VAT', opis: 'JPK_V7M za październik', termin: '2026-11-25', kwota: 312_700, zaplacona: false },
  ] satisfies Platnosc[],
};
