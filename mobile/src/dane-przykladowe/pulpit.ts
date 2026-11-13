/**
 * Liczby do Pulpitu, Przepływów i Analiz (dane przykładowe). Odpowiedniki kart
 * strony: `components/dashboard/finora/sloty.tsx`, `components/przeplywy/`,
 * `components/analizy/`. Kwoty w groszach, serie wykresów w złotych.
 */

export const MIESIACE_7 = ['maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis'];

/** Finanse: zysk (przychód netto minus koszty) w ostatnich 7 miesiącach, zł. */
export const FINANSE_ZYSK = [14_200, 16_900, 12_400, 9_800, 18_300, 21_700, 23_280];
export const FINANSE_PRZYCHOD = [26_400, 29_100, 25_800, 22_300, 31_200, 33_900, 34_560];

export const RAPORT_MIESIACA = {
  przychodNetto: 3_456_000,
  koszty: 1_128_000,
  srednioZysk: 1_665_000,
  fakturyWKsef: 12,
  fakturyZmiana: 20,
  sredniaFaktura: 288_000,
  sredniaZmiana: -6,
  przychodZmiana: 2,
};

/**
 * Zysk listopada narastająco na koniec dni 1 do 9 (dziś = 9.11), w groszach;
 * ostatni punkt równa się zyskowi z `RAPORT_MIESIACA` (34 560 zł minus 11 280 zł).
 * Wykres karty wyniku na Pulpicie (D14, wzór Copilota).
 */
export const ZYSK_NARASTAJACO = [240_000, 1_310_000, 1_370_000, 1_980_000, 2_160_000, 2_130_000, 2_290_000, 2_340_000, 2_328_000];

/** VAT należny w ostatnich 12 miesiącach, zł. */
export const VAT_NALEZNY = [
  { x: 'gru', y: 5_800 }, { x: 'sty', y: 4_900 }, { x: 'lut', y: 5_200 }, { x: 'mar', y: 6_100 },
  { x: 'kwi', y: 5_600 }, { x: 'maj', y: 6_070 }, { x: 'cze', y: 6_690 }, { x: 'lip', y: 5_930 },
  { x: 'sie', y: 5_130 }, { x: 'wrz', y: 7_180 }, { x: 'paź', y: 7_800 }, { x: 'lis', y: 7_950 },
];

export const NALEZNOSCI = {
  razem: 2_367_750,
  zaleglePct: 14,
  wTerminie: 2_035_650,
  do30: 332_100,
  powyzej30: 0,
};

export const NAJLEPIEJ_SPRZEDAJACE = [
  { nazwa: 'Identyfikacja wizualna', jm: 'usł.', kwota: 2_940_000 },
  { nazwa: 'Projekt graficzny', jm: 'usł.', kwota: 2_310_000 },
  { nazwa: 'Strona internetowa', jm: 'usł.', kwota: 1_860_000 },
  { nazwa: 'Sesja zdjęciowa produktów', jm: 'usł.', kwota: 720_000 },
  { nazwa: 'Skład katalogu', jm: 'str.', kwota: 432_000 },
];

export const NAJWIEKSI_KLIENCI = [
  { nazwa: 'Kowalczyk Studio', nip: '1234567890', kwota: 3_102_600, udzial: 28 },
  { nazwa: 'Pracownia Lipowa sp. z o.o.', nip: '1234567890', kwota: 2_568_000, udzial: 23 },
  { nazwa: 'Biuro Rachunkowe Sowa', nip: '1234567890', kwota: 1_987_500, udzial: 18 },
  { nazwa: 'Zielony Ogród Anna Nowak', nip: '1234567890', kwota: 1_219_000, udzial: 11 },
  { nazwa: 'Nabywcy bez NIP (B2C)', nip: '', kwota: 664_000, udzial: 6 },
];

export type Okres = 'tygodniowo' | 'miesiecznie' | 'rocznie';

/** Przepływy: wpływy i koszty brutto w okresach, zł. */
export const PRZEPLYWY: Record<Okres, { x: string; wplywy: number; koszty: number }[]> = {
  tygodniowo: [
    { x: '22.09', wplywy: 6_200, koszty: 2_100 }, { x: '29.09', wplywy: 9_100, koszty: 3_400 },
    { x: '06.10', wplywy: 4_800, koszty: 1_900 }, { x: '13.10', wplywy: 11_300, koszty: 2_800 },
    { x: '20.10', wplywy: 7_600, koszty: 4_200 }, { x: '27.10', wplywy: 5_900, koszty: 2_300 },
    { x: '03.11', wplywy: 12_400, koszty: 3_100 },
  ],
  miesiecznie: [
    { x: 'maj', wplywy: 30_100, koszty: 12_400 }, { x: 'cze', wplywy: 34_800, koszty: 14_900 },
    { x: 'lip', wplywy: 29_300, koszty: 16_100 }, { x: 'sie', wplywy: 25_900, koszty: 15_200 },
    { x: 'wrz', wplywy: 36_700, koszty: 15_400 }, { x: 'paź', wplywy: 40_100, koszty: 14_300 },
    { x: 'lis', wplywy: 28_600, koszty: 13_900 },
  ],
  rocznie: [
    { x: '2022', wplywy: 182_000, koszty: 71_000 }, { x: '2023', wplywy: 251_000, koszty: 98_000 },
    { x: '2024', wplywy: 304_000, koszty: 121_000 }, { x: '2025', wplywy: 362_000, koszty: 149_000 },
    { x: '2026', wplywy: 371_000, koszty: 152_000 },
  ],
};

export const ODLOZ_NA_PODATEK = { procent: 19, kwota: 4_215_300 };

export const WPLYNELO_MIESIAC = { kwota: 2_860_000, zmiana: -29 };
export const KOSZTY_MIESIAC = { kwota: 1_390_000, zmiana: -3 };

export const ZRODLA_PRZEPLYWOW = [
  { nazwa: 'Kowalczyk Studio', opis: 'Klient · 6 wpłat', kwota: 3_102_600, udzial: 28 },
  { nazwa: 'Pracownia Lipowa sp. z o.o.', opis: 'Klient · 8 wpłat', kwota: 2_568_000, udzial: 23 },
  { nazwa: 'Biuro Coworking Kwadrat', opis: 'Dostawca · 12 dokumentów', kwota: -885_600, udzial: 8 },
  { nazwa: 'Biuro Rachunkowe Sowa', opis: 'Klient · 11 wpłat', kwota: 1_987_500, udzial: 18 },
  { nazwa: 'Stacja Paliw Rondo', opis: 'Dostawca · 9 dokumentów', kwota: -341_400, udzial: 3 },
];

export type Operacja = {
  id: string;
  kontrahent: string;
  opis: string;
  kategoria: 'Sprzedaż' | 'Usługi' | 'Biuro' | 'Paliwo' | 'Telefon';
  kwota: number;
  data: string;
  status: 'Opłacona' | 'Korekta' | 'Zatwierdzony' | 'Do akceptacji' | 'Z KSeF';
};

export const OPERACJE: Operacja[] = [
  { id: 'o1', kontrahent: 'Biuro Rachunkowe Sowa', opis: 'NIP 1234567890', kategoria: 'Sprzedaż', kwota: 762_600, data: '2026-11-06', status: 'Opłacona' },
  { id: 'o2', kontrahent: 'Telekom Wschód sp. z o.o.', opis: 'Abonament', kategoria: 'Telefon', kwota: -9_840, data: '2026-11-06', status: 'Z KSeF' },
  { id: 'o3', kontrahent: 'Stacja Paliw Rondo', opis: 'Paragon', kategoria: 'Paliwo', kwota: -28_450, data: '2026-11-05', status: 'Zatwierdzony' },
  { id: 'o4', kontrahent: 'Atelier Wiśniewski', opis: 'NIP 1234567890', kategoria: 'Sprzedaż', kwota: 258_300, data: '2026-11-04', status: 'Opłacona' },
  { id: 'o5', kontrahent: 'Biuro Coworking Kwadrat', opis: 'Biurko, listopad', kategoria: 'Biuro', kwota: -73_800, data: '2026-11-03', status: 'Do akceptacji' },
  { id: 'o6', kontrahent: 'Pracownia Lipowa sp. z o.o.', opis: 'NIP 1234567890', kategoria: 'Sprzedaż', kwota: 369_000, data: '2026-11-02', status: 'Opłacona' },
  { id: 'o7', kontrahent: 'Drukarnia Pod Mostem', opis: 'Korekta FV/10/2026/5', kategoria: 'Usługi', kwota: -24_600, data: '2026-11-01', status: 'Korekta' },
];

/** Analizy: dane miesiąca (sprzedaż i koszty). */
export const ANALIZA_SPRZEDAZ = {
  sprzedanoNetto: 3_456_000,
  srednioDziennie: 384_000,
  zmiana: 2,
  najlepszyKlient: 'Kowalczyk Studio',
  trend: [{ x: 'cze', y: 29_100 }, { x: 'lip', y: 25_800 }, { x: 'sie', y: 22_300 }, { x: 'wrz', y: 31_200 }, { x: 'paź', y: 33_900 }, { x: 'lis', y: 34_560 }],
  produkty: [
    { x: 'Identyfikacja', y: 9_800 }, { x: 'Projekty', y: 9_600 }, { x: 'Strony', y: 6_200 },
    { x: 'Zdjęcia', y: 1_800 }, { x: 'Skład', y: 2_160 },
  ],
  doZaplaty: 2_367_750,
  poTerminie: 332_100,
  najstarszaZaleglosc: 12,
  przychody: 3_456_000,
  koszty: 1_128_000,
  staliKlienci: [
    { nazwa: 'Biuro Rachunkowe Sowa', dzien: 8, srednio: 110_700 },
    { nazwa: 'Pracownia Lipowa sp. z o.o.', dzien: 1, srednio: 369_000 },
    { nazwa: 'Kowalczyk Studio', dzien: 15, srednio: 520_000 },
  ],
};

export const ANALIZA_KOSZTY = {
  dokumentyBrutto: 1_390_000,
  srednioDziennie: 154_400,
  zmiana: -3,
  najwiekszaKategoria: 'Biuro',
  trend: [{ x: 'cze', y: 14_900 }, { x: 'lip', y: 16_100 }, { x: 'sie', y: 15_200 }, { x: 'wrz', y: 15_400 }, { x: 'paź', y: 14_300 }, { x: 'lis', y: 13_900 }],
  kategorie: [
    { x: 'Biuro', y: 7_380 }, { x: 'Paliwo', y: 2_845 }, { x: 'Telefon', y: 984 }, { x: 'Materiały', y: 1_562 }, { x: 'Inne', y: 1_129 },
  ],
  vatNaliczony: 259_900,
  vatDoOdliczenia: 241_300,
  doOpisania: 2,
  staleKoszty: [
    { nazwa: 'Biuro Coworking Kwadrat', dzien: 3, srednio: 73_800 },
    { nazwa: 'Telekom Wschód sp. z o.o.', dzien: 6, srednio: 9_840 },
  ],
};

/** Kalendarz sprzedaży i wydatków: intensywność od 0 do 4 dla 180 dni (stała, przewidywalna). */
export function kalendarz(ziarno: number): number[] {
  return Array.from({ length: 182 }, (_, i) => {
    const dzienTyg = i % 7;
    if (dzienTyg >= 5) return (i * ziarno) % 9 === 0 ? 1 : 0;
    return (i * 7 + ziarno * 3) % 5;
  });
}
