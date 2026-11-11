/**
 * Księgowość JDG na danych przykładowych: profil podatkowy, rozliczenie
 * miesiąca, KPiR, VAT, eksporty. Odpowiedniki `app/(dashboard)/reports/*`
 * i `lib/ksiegowosc/*`. Kwoty w groszach.
 */

export type FormaOpodatkowania = 'ryczalt' | 'skala' | 'liniowy';
export type RodzajZus = 'ulga' | 'preferencyjne' | 'pelne' | 'etat';

export const NAZWA_FORMY: Record<FormaOpodatkowania, string> = {
  ryczalt: 'Ryczałt od przychodów ewidencjonowanych',
  skala: 'Skala podatkowa',
  liniowy: 'Podatek liniowy 19 %',
};

export const OPIS_ZUS: Record<RodzajZus, { nazwa: string; opis: string }> = {
  ulga: { nazwa: 'Ulga na start', opis: 'Pierwsze 6 miesięcy działalności: tylko składka zdrowotna.' },
  preferencyjne: { nazwa: 'Składki preferencyjne', opis: 'Kolejne 24 miesiące: niższa podstawa składek społecznych.' },
  pelne: { nazwa: 'Pełne składki', opis: 'Standardowa podstawa składek społecznych.' },
  etat: { nazwa: 'Etat obok działalności', opis: 'Przy umowie o pracę z co najmniej minimalną pensją: bez składek społecznych.' },
};

export const STAWKI_RYCZALTU = ['17', '15', '14', '12', '10', '8,5', '5,5', '3'];

export const PROFIL = {
  forma: 'liniowy' as FormaOpodatkowania,
  od: '2026-01-01',
  zus: 'pelne' as RodzajZus,
  zusOd: '2026-01-01',
  chorobowe: true,
  rachunekZus: '',
  vat: 'Czynny podatnik VAT',
  historia: [
    'od 01.01.2026: podatek liniowy, pełne składki od 01.01.2026, z chorobowym',
    'od 01.07.2024: podatek liniowy, składki preferencyjne od 01.07.2024',
  ],
};

export type PozycjaDoZaplaty = {
  id: string;
  nazwa: string;
  kwota: number;
  termin: string;
  przelew: string;
};

export const ROZLICZENIE = {
  miesiac: 'październik 2026',
  przychod: 4_012_000,
  koszty: 1_431_000,
  pozycje: [
    { id: 'pit', nazwa: 'Zaliczka na podatek dochodowy', kwota: 254_300, termin: '2026-11-20', przelew: 'Mikrorachunek podatkowy, symbol PIT-36L, okres 26M10, identyfikator NIP 1234567890' },
    { id: 'spoleczne', nazwa: 'Składki społeczne', kwota: 181_234, termin: '2026-11-20', przelew: 'Rachunek składkowy ZUS 00 0000 0000 0000 0000 0000 0000' },
    { id: 'zdrowotna', nazwa: 'Składka zdrowotna', kwota: 49_878, termin: '2026-11-20', przelew: 'Rachunek składkowy ZUS 00 0000 0000 0000 0000 0000 0000' },
    { id: 'vat', nazwa: 'Podatek VAT', kwota: 312_700, termin: '2026-11-25', przelew: 'Mikrorachunek podatkowy, symbol VAT-7, okres 26M10, identyfikator NIP 1234567890' },
  ] satisfies PozycjaDoZaplaty[],
  historia: [
    { rozliczenie: 'wrzesień 2026', wersja: 1, kwota: 801_200, zatwierdzone: '2026-10-03', zaplata: '2026-10-18' },
    { rozliczenie: 'sierpień 2026', wersja: 2, kwota: 744_900, zatwierdzone: '2026-09-04', zaplata: '2026-09-19' },
  ],
};

export type WpisKpir = {
  lp: number;
  data: string;
  dowod: string;
  kontrahent: string;
  opis: string;
  kolumna: '7' | '8' | '10' | '11' | '12' | '13' | '15';
  kwota: number;
  doSprawdzenia?: boolean;
};

export const KPIR: WpisKpir[] = [
  { lp: 1, data: '2026-11-01', dowod: 'FV/11/2026/1', kontrahent: 'Pracownia Lipowa sp. z o.o.', opis: 'Projekt graficzny', kolumna: '7', kwota: 300_000 },
  { lp: 2, data: '2026-11-02', dowod: 'FV/11/2026/2', kontrahent: 'Kowalczyk Studio', opis: 'Identyfikacja wizualna', kolumna: '7', kwota: 980_000 },
  { lp: 3, data: '2026-11-02', dowod: 'HPO/2026/7781', kontrahent: 'Hurtownia Papiernicza Ołówek', opis: 'Materiały biurowe', kolumna: '13', kwota: 12_700 },
  { lp: 4, data: '2026-11-02', dowod: 'FV/11/2026/3', kontrahent: 'Atelier Wiśniewski', opis: 'Projekt graficzny', kolumna: '7', kwota: 210_000 },
  { lp: 5, data: '2026-11-03', dowod: 'KW/11/2026/88', kontrahent: 'Biuro Coworking Kwadrat', opis: 'Biurko, listopad', kolumna: '13', kwota: 60_000, doSprawdzenia: true },
  { lp: 6, data: '2026-11-04', dowod: 'FV/11/2026/5', kontrahent: 'Biuro Rachunkowe Sowa', opis: 'Strona internetowa, etap 2', kolumna: '7', kwota: 620_000 },
  { lp: 7, data: '2026-11-05', dowod: '0042/2026', kontrahent: 'Stacja Paliw Rondo', opis: 'Paliwo', kolumna: '13', kwota: 23_130 },
  { lp: 8, data: '2026-11-05', dowod: 'FV/11/2026/6', kontrahent: 'Zielony Ogród Anna Nowak', opis: 'Sesja zdjęciowa produktów', kolumna: '7', kwota: 180_000 },
  { lp: 9, data: '2026-11-06', dowod: 'TW/2026/11/4411', kontrahent: 'Telekom Wschód sp. z o.o.', opis: 'Abonament, listopad', kolumna: '13', kwota: 8_000, doSprawdzenia: true },
];

export const VAT_MIESIACA = {
  miesiac: 'październik 2026',
  nalezny: 922_800,
  naliczony: 610_100,
  termin: '2026-11-25',
  mikrorachunek: 'PL 00 0000 0000 0000 0000 0000 0000',
  wysylki: [
    { wyslano: '2026-10-21', stan: 'Przyjęty, UPO gotowe', numer: 'a1b2c3d4e5f6', doWplaty: 281_400 },
  ],
};

export type FormatEksportu = 'kpir' | 'csv' | 'jpk';

export const FORMATY: { klucz: FormatEksportu; nazwa: string; opis: string }[] = [
  { klucz: 'kpir', nazwa: 'KPiR Excel', opis: 'Księga dla księgowej' },
  { klucz: 'csv', nazwa: 'CSV uniwersalny', opis: 'Optima, Subiekt i inne programy' },
  { klucz: 'jpk', nazwa: 'JPK_FA(4)', opis: 'Urząd, Symfonia, Wapro' },
];

export const EKSPORTY = [
  { id: 'e1', plik: 'KPiR Excel', okres: 'Październik 2026', utworzono: '2026-11-02', status: 'Gotowe' },
  { id: 'e2', plik: 'JPK_FA(4)', okres: 'III kw. 2026', utworzono: '2026-10-05', status: 'Gotowe' },
  { id: 'e3', plik: 'CSV uniwersalny', okres: 'Wrzesień 2026', utworzono: '2026-10-01', status: 'Wygasłe' },
];
