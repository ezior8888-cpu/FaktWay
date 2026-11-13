/**
 * Dane przykładowe ekranów (bez logowania i API) i typy, w których ekrany
 * widzą też dane z bazy (od M7: faktury i skrzynka KSeF, mapowanie w
 * `lib/dane/mapowanie.ts`). Firmy są zmyślone, NIP to testowy `1234567890`
 * (AGENTS.md, „KSeF-specific”). Kwoty w groszach.
 */

/** „Dziś” dla danych przykładowych, żeby terminy i zaległości się nie rozjeżdżały. */
export const DZIS = '2026-11-09';

/**
 * `blad`: wysyłka nie wyszła (na stronie `failed`: ponawiamy, wstrzymana, brak
 * certyfikatu). Tylko w danych z bazy; KSeF faktury nie odrzucił.
 */
export type StatusKsef = 'przyjeta' | 'wysylanie' | 'odrzucona' | 'robocza' | 'blad';

export type Pozycja = {
  nazwa: string;
  ilosc: number;
  jednostka: string;
  cenaNetto: number;
  /** Stawka do obliczeń; zw, np i oo liczą się jako 0. */
  stawkaVat: number;
  /** Stawka do pokazania, gdy nie jest liczbą procent („zw”, „np”, „oo”). */
  stawkaOpis?: string;
  /** Kwoty pozycji zapisane na fakturze (dane z bazy); bez nich liczymy z ilości i ceny. */
  netto?: number;
  vat?: number;
  brutto?: number;
};

/** Strona faktury z bazy (sprzedawca); dane przykładowe biorą `SPRZEDAWCA`. */
export type Strona = { nazwa: string; nip?: string; adres?: string };

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
  /** Rodzaj z wyboru „Nowa faktura” na stronie (`invoice-type-selector.tsx`). */
  rodzaj: RodzajFaktury;
  metodaPlatnosci: MetodaPlatnosci;
  rachunek?: string;
  mpp?: boolean;
  uwagi?: string;
  /** Powód odrzucenia przez KSeF (komunikat, pole, podpowiedź). */
  blad?: { komunikat: string; pole: string; podpowiedz: string };
  /** Przypomnienie o zapłacie (strona „Po terminie”). */
  przypomnienie?: { etap: number; wyslane: number; status: 'Zaplanowane' | 'Wysłane' | 'Wstrzymane' | 'Bez przypomnień'; data?: string };
  /** Pola tylko z bazy (M7); dane przykładowe ich nie mają. Waluta: brak to PLN. */
  waluta?: string;
  sprzedawca?: Strona;
  adresKontrahenta?: string;
  /** Adres nabywcy w dwóch wierszach jak na fakturze (dane z bazy): do nowej faktury dla tego kontrahenta (M8). */
  adresKontrahentaLinie?: { linia1: string; linia2: string };
  emailKontrahenta?: string;
  dataSprzedazy?: string;
  bank?: string;
  /** Wpłacono częściowo (grosze); „Do zapłaty” to brutto minus ta kwota. */
  zaplacono?: number;
};

export type MetodaPlatnosci = 'Przelew' | 'Gotówka' | 'Karta' | 'Płatność mobilna' | 'Kompensata' | 'Inna';

export type RodzajFaktury = 'vat' | 'zaliczkowa' | 'korygujaca' | 'rozliczajaca';

export const NAZWA_RODZAJU: Record<RodzajFaktury, string> = {
  vat: 'Faktura VAT',
  zaliczkowa: 'Faktura zaliczkowa',
  korygujaca: 'Faktura korygująca',
  rozliczajaca: 'Faktura rozliczeniowa',
};

/** Dane sprzedawcy (firma z przykładowego konta). */
export const SPRZEDAWCA = {
  nazwa: 'Pracownia Przykładowa Jan Kowalski',
  adres: 'ul. Przykładowa 1, 00-001 Warszawa',
  nip: '1234567890',
  rachunek: '12 3456 7890 1234 5678 9012 3456',
  bank: 'Bank Przykładowy',
};

const NIP = '1234567890';

/**
 * Netto i VAT pozycji zaokrąglane osobno; brutto faktury to ich suma, więc
 * wiersze sumują się do nagłówka. Pozycja z bazy ma kwoty z faktury i te
 * pokazujemy, zamiast liczyć od nowa.
 */
export function nettoPozycji(p: Pozycja): number {
  return p.netto ?? Math.round(p.ilosc * p.cenaNetto);
}

export function vatPozycji(p: Pozycja): number {
  return p.vat ?? Math.round((nettoPozycji(p) * p.stawkaVat) / 100);
}

export function bruttoPozycji(p: Pozycja): number {
  return p.brutto ?? nettoPozycji(p) + vatPozycji(p);
}

/** „23%” albo „zw”, „np”, „oo”. */
export function stawkaTekst(p: Pozycja): string {
  return p.stawkaOpis ?? `${p.stawkaVat}%`;
}

function faktura(
  id: string,
  numer: string,
  kontrahent: string,
  dataWystawienia: string,
  terminPlatnosci: string,
  pozycje: Pozycja[],
  statusKsef: StatusKsef,
  zaplacona: boolean,
  dodatki: Partial<Faktura> = {},
): Faktura {
  const netto = pozycje.reduce((s, p) => s + nettoPozycji(p), 0);
  const vat = pozycje.reduce((s, p) => s + vatPozycji(p), 0);
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
    rodzaj: 'vat',
    metodaPlatnosci: 'Przelew',
    rachunek: '12 3456 7890 1234 5678 9012 3456',
    ...dodatki,
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
  faktura('f14', 'FV/11/2026/8', 'Hotel Nad Zatoką', '2026-11-09', '2026-11-23',
    [{ nazwa: 'Projekt karty win', ilosc: 1, jednostka: 'usł.', cenaNetto: 85000, stawkaVat: 23 }],
    'robocza', false, { uwagi: 'Szkic do sprawdzenia przed wysyłką.' }),
  faktura('f13', 'FZ/11/2026/1', 'Kowalczyk Studio', '2026-11-08', '2026-11-22',
    [{ nazwa: 'Zaliczka na kampanię wiosenną', ilosc: 1, jednostka: 'usł.', cenaNetto: 400000, stawkaVat: 23 }],
    'przyjeta', false, { rodzaj: 'zaliczkowa', mpp: false }),
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
    'odrzucona', false, {
      blad: {
        komunikat: 'KSeF odrzucił fakturę: niepoprawny NIP nabywcy.',
        pole: 'NIP nabywcy',
        podpowiedz: 'Sprawdź NIP w danych kontrahenta i wyślij fakturę ponownie.',
      },
    }),
  faktura('f8', 'FV/11/2026/3', 'Atelier Wiśniewski', '2026-11-02', '2026-11-16',
    [uslugaGraficzna(210000)], 'przyjeta', true),
  faktura('f7', 'FV/11/2026/2', 'Kowalczyk Studio', '2026-11-02', '2026-11-09',
    [{ nazwa: 'Identyfikacja wizualna', ilosc: 1, jednostka: 'usł.', cenaNetto: 980000, stawkaVat: 23 }],
    'przyjeta', false),
  faktura('f6', 'FV/11/2026/1', 'Pracownia Lipowa sp. z o.o.', '2026-11-01', '2026-11-15',
    [uslugaGraficzna(300000)], 'przyjeta', true),
  faktura('f5', 'FV/10/2026/9', 'Hotel Nad Zatoką', '2026-10-28', '2026-11-04',
    [{ nazwa: 'Projekt menu', ilosc: 1, jednostka: 'usł.', cenaNetto: 150000, stawkaVat: 23 }],
    'przyjeta', false, { przypomnienie: { etap: 1, wyslane: 1, status: 'Wysłane', data: '2026-11-07' } }),
  faktura('f4', 'FV/10/2026/8', 'Zielony Ogród Anna Nowak', '2026-10-21', '2026-10-28',
    [{ nazwa: 'Ulotki A5, projekt', ilosc: 2, jednostka: 'usł.', cenaNetto: 60000, stawkaVat: 23 }],
    'przyjeta', false, { przypomnienie: { etap: 2, wyslane: 2, status: 'Zaplanowane', data: '2026-11-11' } }),
  faktura('f3', 'FV/10/2026/7', 'Kowalczyk Studio', '2026-10-15', '2026-10-29',
    [uslugaGraficzna(520000)], 'przyjeta', true),
  faktura('f2', 'FV/10/2026/6', 'Biuro Rachunkowe Sowa', '2026-10-08', '2026-10-22',
    [{ nazwa: 'Opieka nad stroną, październik', ilosc: 1, jednostka: 'mies.', cenaNetto: 90000, stawkaVat: 23 }],
    'przyjeta', true),
  faktura('f1', 'FV/10/2026/5', 'Drukarnia Pod Mostem', '2026-10-02', '2026-10-16',
    [{ nazwa: 'Projekt okładki', ilosc: 1, jednostka: 'usł.', cenaNetto: 110000, stawkaVat: 23 }],
    'przyjeta', true),
  faktura('f0', 'KOR/11/2026/1', 'Drukarnia Pod Mostem', '2026-11-01', '2026-11-15',
    [{ nazwa: 'Rabat do FV/10/2026/5', ilosc: 1, jednostka: 'usł.', cenaNetto: -20000, stawkaVat: 23 }],
    'przyjeta', true, { rodzaj: 'korygujaca', uwagi: 'Przyczyna korekty: rabat za opóźnienie.' }),
];

export function znajdzFakture(id: string): Faktura | undefined {
  return FAKTURY.find((f) => f.id === id);
}

/**
 * Faktura kosztowa ze skrzynki KSeF (na stronie `(koszty)/inbox`). Status
 * mówi, czy wydatek z tej faktury jest już opisany; `undefined`, gdy wydatek
 * jeszcze nie powstał albo to archiwum z historii KSeF (`zHistorii`).
 */
export type FakturaKosztowa = {
  id: string;
  numer: string;
  numerKsef?: string;
  sprzedawca: string;
  nipSprzedawcy: string;
  dataWystawienia: string;
  /** Dzień przyjęcia w KSeF (Warszawa). */
  otrzymano?: string;
  brutto: number;
  netto?: number;
  waluta: string;
  status?: 'nowa' | 'opisana';
  zHistorii: boolean;
  /** Wydatek z tej faktury (`/koszty/[id]`), gdy już jest. */
  wydatekId?: string;
  pozycje: Pozycja[];
};

export type ZrodloKosztu = 'ksef' | 'zdjecie' | 'reczny' | 'import';
export type KolumnaKpir = '10' | '11' | '12' | '13' | '15';

export const NAZWA_KOLUMNY: Record<KolumnaKpir, string> = {
  '10': 'Kol. 10: Towary handlowe i materiały',
  '11': 'Kol. 11: Koszty uboczne zakupu',
  '12': 'Kol. 12: Wynagrodzenia',
  '13': 'Kol. 13: Pozostałe wydatki',
  '15': 'Kol. 15: Koszty B+R',
};

export const NAZWA_ZRODLA: Record<ZrodloKosztu, string> = { ksef: 'KSeF', zdjecie: 'Zdjęcie', reczny: 'Ręcznie', import: 'Import' };

export const KATEGORIE_KOSZTOW = [
  'Paliwo', 'Telekomunikacja', 'Oprogramowanie', 'Marketing', 'Materiały biurowe', 'Reprezentacja',
  'Podróże służbowe', 'Usługi obce', 'Energia', 'Czynsz', 'Pozostałe wydatki',
] as const;

export type Koszt = {
  id: string;
  dostawca: string;
  nip?: string;
  opis: string;
  data: string;
  netto: number;
  brutto: number;
  zrodlo: ZrodloKosztu;
  doOpisania: boolean;
  kategoria: string;
  kolumna: KolumnaKpir;
  dokument: 'Faktura' | 'Faktura uproszczona' | 'Paragon' | 'Inny dokument';
  numer: string;
  numerKsef?: string;
  /** Data przyjęcia w KSeF (skrzynka). */
  otrzymano?: string;
  wKpir: boolean;
};

/** Id trasy `/koszty/[id]` dla wydatku wpisywanego ręcznie, jeszcze niezapisanego. */
export const NOWY_WYDATEK = 'nowy';

export const PUSTY_WYDATEK: Koszt = {
  id: '',
  dostawca: '',
  opis: '',
  data: DZIS,
  netto: 0,
  brutto: 0,
  zrodlo: 'reczny',
  doOpisania: true,
  kategoria: 'Pozostałe wydatki',
  kolumna: '13',
  dokument: 'Faktura',
  numer: '',
  wKpir: true,
};

const koszt = (k: Omit<Koszt, 'netto'> & { stawka?: number }): Koszt => ({
  ...k,
  netto: Math.round(k.brutto / (1 + (k.stawka ?? 23) / 100)),
});

export const KOSZTY: Koszt[] = [
  koszt({ id: 'k1', dostawca: 'Telekom Wschód sp. z o.o.', nip: NIP, opis: 'Abonament, listopad', data: '2026-11-06', brutto: 9840, zrodlo: 'ksef', doOpisania: true, kategoria: 'Telekomunikacja', kolumna: '13', dokument: 'Faktura', numer: 'TW/2026/11/4411', numerKsef: `${NIP}-20261106-0K1-A1`, otrzymano: '2026-11-06', wKpir: true }),
  koszt({ id: 'k2', dostawca: 'Biuro Coworking Kwadrat', nip: NIP, opis: 'Biurko, listopad', data: '2026-11-03', brutto: 73800, zrodlo: 'ksef', doOpisania: true, kategoria: 'Czynsz', kolumna: '13', dokument: 'Faktura', numer: 'KW/11/2026/88', numerKsef: `${NIP}-20261103-0K2-A1`, otrzymano: '2026-11-03', wKpir: true }),
  koszt({ id: 'k3', dostawca: 'Hurtownia Papiernicza Ołówek', nip: NIP, opis: 'Materiały biurowe', data: '2026-11-02', brutto: 15621, zrodlo: 'ksef', doOpisania: false, kategoria: 'Materiały biurowe', kolumna: '13', dokument: 'Faktura', numer: 'HPO/2026/7781', numerKsef: `${NIP}-20261102-0K3-A1`, otrzymano: '2026-11-02', wKpir: true }),
  koszt({ id: 'k4', dostawca: 'Stacja Paliw Rondo', nip: NIP, opis: 'Paliwo', data: '2026-11-05', brutto: 28450, zrodlo: 'zdjecie', doOpisania: false, kategoria: 'Paliwo', kolumna: '13', dokument: 'Paragon', numer: '0042/2026', wKpir: true }),
  koszt({ id: 'k5', dostawca: 'Kawiarnia Ziarno', opis: 'Spotkanie z klientem', data: '2026-11-04', brutto: 4200, zrodlo: 'zdjecie', doOpisania: false, kategoria: 'Reprezentacja', kolumna: '13', dokument: 'Paragon', numer: '118/11', wKpir: false, stawka: 8 }),
  koszt({ id: 'k6', dostawca: 'Sklep Komputerowy Bajt', nip: NIP, opis: 'Klawiatura i mysz', data: '2026-10-29', brutto: 61500, zrodlo: 'reczny', doOpisania: false, kategoria: 'Pozostałe wydatki', kolumna: '13', dokument: 'Faktura', numer: 'FS/1029/2026', wKpir: true }),
];

/** Skrzynka KSeF na danych przykładowych: faktury kosztowe z KSeF i ich wydatki. */
export function skrzynkaPrzykladowa(koszty: Koszt[]): FakturaKosztowa[] {
  return koszty
    .filter((k) => k.zrodlo === 'ksef')
    .map((k) => ({
      id: `ksef-${k.id}`,
      numer: k.numer,
      numerKsef: k.numerKsef,
      sprzedawca: k.dostawca,
      nipSprzedawcy: k.nip ?? '',
      dataWystawienia: k.data,
      otrzymano: k.otrzymano,
      brutto: k.brutto,
      netto: k.netto,
      waluta: 'PLN',
      status: k.doOpisania ? 'nowa' : 'opisana',
      zHistorii: false,
      wydatekId: k.id,
      pozycje: [{ nazwa: k.opis, ilosc: 1, jednostka: 'usł.', cenaNetto: k.netto, stawkaVat: 23, netto: k.netto, vat: k.brutto - k.netto, brutto: k.brutto }],
    }));
}

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
