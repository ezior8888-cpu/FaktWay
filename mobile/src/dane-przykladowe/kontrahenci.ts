/** Kontrahenci i faktury cykliczne na dane przykładowe (zmyślone firmy, NIP testowy). */

export type Kontrahent = {
  id: string;
  nazwa: string;
  nip: string;
  adres: string;
  email?: string;
  telefon?: string;
  terminDni: number;
  przypomnienia: boolean;
};

const NIP = '1234567890';

export const KONTRAHENCI: Kontrahent[] = [
  { id: 'k-lipowa', nazwa: 'Pracownia Lipowa sp. z o.o.', nip: NIP, adres: 'ul. Lipowa 12, 00-001 Warszawa', email: 'biuro@przyklad.pl', terminDni: 14, przypomnienia: true },
  { id: 'k-ogrod', nazwa: 'Zielony Ogród Anna Nowak', nip: NIP, adres: 'ul. Ogrodowa 3, 30-001 Kraków', email: 'anna@przyklad.pl', telefon: '+48 600 000 000', terminDni: 14, przypomnienia: true },
  { id: 'k-sowa', nazwa: 'Biuro Rachunkowe Sowa', nip: NIP, adres: 'ul. Sowia 8, 80-001 Gdańsk', email: 'sowa@przyklad.pl', terminDni: 14, przypomnienia: false },
  { id: 'k-drukarnia', nazwa: 'Drukarnia Pod Mostem', nip: NIP, adres: 'ul. Mostowa 1, 50-001 Wrocław', terminDni: 14, przypomnienia: true },
  { id: 'k-atelier', nazwa: 'Atelier Wiśniewski', nip: NIP, adres: 'ul. Wiśniowa 22, 60-001 Poznań', email: 'atelier@przyklad.pl', terminDni: 14, przypomnienia: false },
  { id: 'k-kowalczyk', nazwa: 'Kowalczyk Studio', nip: NIP, adres: 'ul. Studyjna 5, 90-001 Łódź', email: 'studio@przyklad.pl', terminDni: 7, przypomnienia: true },
  { id: 'k-hotel', nazwa: 'Hotel Nad Zatoką', nip: NIP, adres: 'ul. Nadmorska 40, 81-001 Gdynia', telefon: '+48 500 000 000', terminDni: 7, przypomnienia: true },
];

export type FakturaCykliczna = {
  id: string;
  kontrahent: string;
  opis: string;
  brutto: number;
  co: 'miesiąc' | 'kwartał' | 'rok';
  nastepna: string;
  wstrzymana: boolean;
  wyslijDoKsef: boolean;
};

export const CYKLICZNE: FakturaCykliczna[] = [
  { id: 'c1', kontrahent: 'Biuro Rachunkowe Sowa', opis: 'Opieka nad stroną', brutto: 110_700, co: 'miesiąc', nastepna: '2026-12-01', wstrzymana: false, wyslijDoKsef: true },
  { id: 'c2', kontrahent: 'Pracownia Lipowa sp. z o.o.', opis: 'Abonament graficzny', brutto: 369_000, co: 'miesiąc', nastepna: '2026-12-01', wstrzymana: false, wyslijDoKsef: true },
  { id: 'c3', kontrahent: 'Hotel Nad Zatoką', opis: 'Aktualizacja menu', brutto: 61_500, co: 'kwartał', nastepna: '2027-01-02', wstrzymana: true, wyslijDoKsef: false },
];
