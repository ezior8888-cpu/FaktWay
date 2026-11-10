/**
 * Ustawienia, zespół, import i FLO na danych przykładowych. Odpowiedniki
 * `app/(dashboard)/settings/*`, `import-danych` ze strony (bez Flo, plan D13).
 */

export const FIRMA = {
  nazwa: 'Pracownia Przykładowa Jan Kowalski',
  nip: '1234567890',
  ulica: 'ul. Przykładowa 1',
  miasto: '00-001 Warszawa',
  vat: 'Czynny podatnik VAT',
  rozpoczecie: '2024-07-01',
};

export const PODSTAWY_ZWOLNIENIA = [
  { wartosc: '113-1', etykieta: 'Podmiotowe, sprzedaż do 240 000 zł (art. 113 ust. 1)' },
  { wartosc: '113-9', etykieta: 'Działalność rozpoczęta w tym roku (art. 113 ust. 9)' },
  { wartosc: 'inna', etykieta: 'Inna podstawa (np. art. 43)' },
];

export const KSEF = {
  status: 'Skonfigurowano połączenie',
  nip: '1234567890',
  certyfikatDo: '2027-10-14',
  google: true,
};

export const URZADZENIA_PUSH = [
  { id: 'u1', nazwa: 'iPhone Jana', dodane: '2026-10-02' },
  { id: 'u2', nazwa: 'MacBook, Safari', dodane: '2026-09-11' },
];

export const POWIADOMIENIA_PUSH = [
  { klucz: 'zaakceptowana', etykieta: 'Faktura zaakceptowana' },
  { klucz: 'odrzucona', etykieta: 'Faktura odrzucona' },
  { klucz: 'platnosc', etykieta: 'Otrzymana płatność' },
  { klucz: 'certyfikat', etykieta: 'Wygasanie certyfikatu', opis: '30 i 7 dni przed końcem ważności' },
  { klucz: 'zakupowa', etykieta: 'Nowa faktura zakupowa' },
  { klucz: 'ksiegowosc', etykieta: 'Księgowość', opis: 'Terminy podatków i składek' },
];

export const KLUCZE_DOSTEPU = [
  { id: 'p1', nazwa: 'iPhone, Face ID', ostatnio: '2026-11-08' },
  { id: 'p2', nazwa: 'MacBook, Touch ID', ostatnio: '2026-11-05' },
];

export const CZLONKOWIE = [
  { id: 'm1', imie: 'Jan Kowalski', email: 'jan@przyklad.pl', rola: 'właściciel', od: '2024-07-01', ty: true },
  { id: 'm2', imie: 'Ewa Nowak', email: 'ewa@przyklad.pl', rola: 'admin', od: '2025-03-12' },
  { id: 'm3', imie: 'Biuro Rachunkowe Sowa', email: 'sowa@przyklad.pl', rola: 'księgowy', od: '2025-04-01' },
];

export const ZAPROSZENIA = [{ id: 'z1', email: 'adam@przyklad.pl', rola: 'członek', wygasa: '2026-11-14' }];

export const DOSTEPY_KSIEGOWEJ = [
  { id: 'd1', nazwa: 'Biuro Rachunkowe Sowa', email: 'sowa@przyklad.pl', poziom: 'Podgląd + pobieranie XML', status: 'Aktywny', wygasa: '2027-04-01', uzycia: 14 },
];

export const PACZKI_KSIEGOWEJ = [
  { id: 'k1', okres: 'Październik 2026', status: 'Wysłane', data: '2026-11-05' },
  { id: 'k2', okres: 'Wrzesień 2026', status: 'Wysłane', data: '2026-10-05' },
];

export const FORMATY_KSIEGOWEJ = ['JPK_FA(4)', 'KPiR Excel', 'Comarch Optima', 'Insert Subiekt', 'Symfonia', 'Wapro Mag', 'CSV uniwersalny'];

export const DZIENNIK = [
  { id: 'a1', data: '2026-11-08 21:14', akcja: 'Zalogowanie', zasob: 'session', ip: '192.0.2.10' },
  { id: 'a2', data: '2026-11-07 10:02', akcja: 'Wysłano fakturę do KSeF', zasob: 'invoice:f12', ip: '192.0.2.10' },
  { id: 'a3', data: '2026-11-05 09:41', akcja: 'Oznaczono zapłatę', zasob: 'invoice:f10', ip: '192.0.2.24' },
  { id: 'a4', data: '2026-11-03 18:20', akcja: 'Zmieniono dane firmy', zasob: 'tenant', ip: '192.0.2.24' },
  { id: 'a5', data: '2026-11-02 08:15', akcja: 'Zaakceptowano wydatek', zasob: 'expense:k3', ip: '192.0.2.10' },
];

export const IMPORT = {
  historiaSprzedaz: { pobrano: 412, z: 412 },
  historiaZakupy: { pobrano: 238, z: 251 },
  zPlikow: 86,
  nowiKontrahenci: 23,
  ostatniePobranie: 'dziś, 7:45',
  zrodla: ['Fakturownia', 'inFakt', 'wFirma', 'iFirma'],
  historia: [
    { id: 'i1', zrodlo: 'inFakt (CSV)', rozpoczeto: '2026-10-12', wynik: '86 faktur, 23 kontrahentów', status: 'Gotowe' },
    { id: 'i2', zrodlo: 'Historia z KSeF', rozpoczeto: '2026-10-12', wynik: '650 faktur', status: 'W toku' },
  ],
};
