/**
 * Szybka faktura z telefonu (etap M8): pola formularza na treść
 * `POST /api/mobile/v1/faktury`, błąd serwera z powrotem na pole formularza,
 * nabywcy z ostatnich faktur i klucz zapisu.
 *
 * Bez React Native: ten sam plik czytają testy strony
 * (`tests/unit/mobile-faktura-wystawienie.test.ts`), które sprawdzają wynik
 * prawdziwym schematem formularza strony. Importy względne (patrz `mobile/AGENTS.md`).
 *
 * Zasady faktury sprawdza serwer tym samym schematem co strona; telefon robi
 * tylko szybkie sprawdzenie przed wysłaniem (`sprawdz` w formularzu).
 */
import type { Faktura, MetodaPlatnosci } from '../../dane-przykladowe';
import type { FakturaTelefonu, StawkaVatTelefonu } from '../api/kontrakt';

/** Pozycja w polach formularza: tekst z klawiatury („1500,50”, „1,5”). */
export type PozycjaFormularza = { nazwa: string; ilosc: string; jednostka: string; cena: string; stawka: string };

/** Zwykła faktura VAT z formularza telefonu (pola jak w `faktury/nowa/[rodzaj].tsx`). */
export type FormularzZwyklej = {
  numer: string;
  dataWystawienia: string;
  dataSprzedazy: string;
  /** Termin w dniach od daty wystawienia (7, 14, 30). */
  terminDni: number;
  rodzajNabywcy: 'firma' | 'osoba';
  nip: string;
  nazwa: string;
  adres1: string;
  adres2: string;
  email: string;
  metoda: MetodaPlatnosci;
  rachunek: string;
  mpp: boolean;
  pozycje: PozycjaFormularza[];
  uwagi: string;
};

const STAWKI: readonly StawkaVatTelefonu[] = ['23', '8', '5', '0', 'zw', 'oo', 'np'];

const METODY: Partial<Record<MetodaPlatnosci, FakturaTelefonu['paymentMethod']>> = {
  Przelew: 'transfer',
  Gotówka: 'cash',
  Karta: 'card',
};

/** Liczba z pola („1 500,5” → 1500.5) bez zaokrąglania: cena i ilość mogą mieć 4 miejsca po przecinku. */
export function liczbaZPola(tekst: string): number {
  const t = tekst.replace(/\s/g, '').replace(',', '.');
  return t ? Number(t) : NaN;
}

/** RRRR-MM-DD plus dni (kalendarzowo, bez strefy). */
export function dodajDni(iso: string, dni: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dni);
  return d.toISOString().slice(0, 10);
}

/**
 * Treść faktury dla serwera. Wartości jak z formularza strony: data sprzedaży
 * równa wystawieniu to pusty tekst, rachunek tylko przy przelewie (bez spacji),
 * NIP same cyfry, stawka tekstem (`zw`, `np` nie zamieniają się w 0%).
 */
export function doFakturyTelefonu(f: FormularzZwyklej): FakturaTelefonu {
  const osoba = f.rodzajNabywcy === 'osoba';
  const metoda = METODY[f.metoda] ?? 'other';
  return {
    internalNumber: f.numer.trim(),
    issueDate: f.dataWystawienia,
    saleDate: f.dataSprzedazy && f.dataSprzedazy !== f.dataWystawienia ? f.dataSprzedazy : '',
    buyerNip: osoba ? '' : f.nip.replace(/\D/g, ''),
    buyerName: f.nazwa.trim(),
    buyerAddressLine1: f.adres1.trim(),
    buyerAddressLine2: f.adres2.trim(),
    buyerEmail: f.email.trim(),
    buyerIsConsumer: osoba,
    lines: f.pozycje.map((p) => ({
      name: p.nazwa.trim(),
      unit: p.jednostka.trim() || 'szt',
      quantity: liczbaZPola(p.ilosc),
      unitPriceNet: liczbaZPola(p.cena),
      vatRate: STAWKI.find((s) => s === p.stawka) ?? '23',
    })),
    paymentMethod: metoda,
    paymentDueDate: dodajDni(f.dataWystawienia, f.terminDni),
    bankAccount: metoda === 'transfer' ? f.rachunek.replace(/\s/g, '') : '',
    notes: f.uwagi.trim(),
    splitPayment: f.mpp,
  };
}

/** Klucze błędów formularza telefonu (`bledy` w `faktury/nowa/[rodzaj].tsx`). */
export type PoleBledu = 'numer' | 'nazwa' | 'nip' | 'adres' | 'pozycje' | 'rachunek' | 'termin' | 'ogolny';

/** Pole formularza strony z odpowiedzi `invoice_invalid` (`buyerName`, `lines.0.name`) na pole telefonu. */
export function poleFormularza(pole: string | undefined): PoleBledu {
  const glowa = pole?.split('.')[0] ?? '';
  switch (glowa) {
    case 'internalNumber':
    case 'issueDate':
    case 'saleDate':
      return 'numer';
    case 'buyerName':
      return 'nazwa';
    case 'buyerNip':
    case 'buyerIsConsumer':
    case 'buyerConsumerIdType':
      return 'nip';
    case 'buyerAddressLine1':
    case 'buyerAddressLine2':
      return 'adres';
    case 'lines':
      return 'pozycje';
    case 'bankAccount':
    case 'splitPayment':
      return 'rachunek';
    case 'paymentDueDate':
      return 'termin';
    default:
      return 'ogolny';
  }
}

export type NabywcaZFaktury = {
  nazwa: string;
  nip: string;
  osoba: boolean;
  adres1: string;
  adres2: string;
  email: string;
  /** Dni do zapłaty z ostatniej faktury dla tego nabywcy (7, 14 albo 30). */
  terminDni: number;
};

/** Najbliższa opcja terminu (7, 14, 30 dni) dla zapisanej faktury. */
export function najblizszyTermin(dni: number): number {
  return [7, 14, 30].reduce((a, b) => (Math.abs(b - dni) < Math.abs(a - dni) ? b : a));
}

function dniMiedzy(od: string, doDnia: string): number {
  return Math.round((Date.parse(`${doDnia}T12:00:00Z`) - Date.parse(`${od}T12:00:00Z`)) / 86_400_000);
}

/**
 * Nabywcy z ostatnich faktur sprzedaży (najnowsze pierwsze, bez powtórzeń):
 * „wystaw dla ostatniego kontrahenta” (plan 3). Tylko faktury z adresem w dwóch
 * wierszach, bo bez adresu faktury nie da się wystawić.
 */
export function nabywcyZFaktur(faktury: readonly Faktura[], najwyzej = 20): NabywcaZFaktury[] {
  const widziani = new Set<string>();
  const wynik: NabywcaZFaktury[] = [];
  for (const f of faktury) {
    const linie = f.adresKontrahentaLinie;
    if (!linie?.linia1 || !linie.linia2 || !f.kontrahent || f.rodzaj !== 'vat') continue;
    const nip = f.nipKontrahenta.replace(/\D/g, '');
    const klucz = nip || `osoba:${f.kontrahent.toLowerCase()}`;
    if (widziani.has(klucz)) continue;
    widziani.add(klucz);
    wynik.push({
      nazwa: f.kontrahent,
      nip,
      osoba: nip.length !== 10,
      adres1: linie.linia1,
      adres2: linie.linia2,
      email: f.emailKontrahenta ?? '',
      terminDni: najblizszyTermin(dniMiedzy(f.dataWystawienia, f.terminPlatnosci)),
    });
    if (wynik.length >= najwyzej) break;
  }
  return wynik;
}

/**
 * Klucz zapisu (`Idempotency-Key`): UUID v4, jeden na otwarcie formularza.
 * `crypto.getRandomValues`, gdy jest; inaczej `Math.random` (klucz jest
 * unikalny w obrębie konta i firmy, nie jest sekretem).
 */
export function kluczZapisu(losuj?: (bajty: Uint8Array) => void): string {
  const b = new Uint8Array(16);
  const zrodlo = losuj ?? (globalThis as { crypto?: { getRandomValues?: (t: Uint8Array) => void } }).crypto?.getRandomValues?.bind(
    (globalThis as { crypto?: object }).crypto,
  );
  if (zrodlo) zrodlo(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
