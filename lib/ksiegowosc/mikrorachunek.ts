/**
 * Mikrorachunek podatkowy z NIP (plan księgowości JDG, krok K1).
 *
 * Budowa według podatki.gov.pl („Mikrorachunek podatkowy: jak sprawdzić
 * numer i wpłacić podatek”, aktualizacja 30.09.2026, odczyt 5.11.2026):
 * 26 cyfr `LK 10100071 222 Y identyfikator zera`, gdzie LK to liczba
 * kontrolna, 10100071 numer rozliczeniowy NBP, 222 numer uzupełniający NBP,
 * Y = 1 dla PESEL i 2 dla NIP, a zera dopełniają numer do 26 cyfr.
 * (Plan w sekcji 5 podawał „22”; strona MF mówi „222”.)
 *
 * JDG płaci PIT, ryczałt i VAT z NIP, więc moduł buduje tylko wariant Y = 2.
 * Liczba kontrolna jak w każdym NRB: reszta z dzielenia przez 97 numeru
 * IBAN po przeniesieniu „PL” i cyfr kontrolnych na koniec musi wynosić 1.
 */

import { validateNipChecksum } from '@/lib/xml/invoice-calculator';

/** Stała część od pozycji 3: numer rozliczeniowy i uzupełniający NBP. */
export const STALA_NBP = '10100071222';

const TYP_NIP = '2';
const DLUGOSC = 26;
/** „PL” w zapisie liczbowym IBAN (P = 25, L = 21). */
const KRAJ_PL = '2521';

function reszta97(cyfry: string): number {
  let reszta = 0;
  for (const cyfra of cyfry) reszta = (reszta * 10 + Number(cyfra)) % 97;
  return reszta;
}

function liczbaKontrolna(bban: string): string {
  const lk = 98 - reszta97(`${bban}${KRAJ_PL}00`);
  return String(lk).padStart(2, '0');
}

/** Sam NIP bez spacji, kresek i prefiksu „PL”; `null`, gdy to nie jest poprawny NIP. */
export function normalizujNip(wpis: string): string | null {
  const nip = wpis.replace(/^\s*PL/i, '').replace(/[\s-]/g, '');
  return validateNipChecksum(nip) ? nip : null;
}

/**
 * Mikrorachunek dla NIP, 26 cyfr bez spacji. `null` przy niepoprawnym NIP:
 * numer z literówką w NIP trafiłby na cudzy rachunek, więc nie zgadujemy.
 */
export function mikrorachunekZNip(wpis: string): string | null {
  const nip = normalizujNip(wpis);
  if (!nip) return null;

  const bez = `${STALA_NBP}${TYP_NIP}${nip}`;
  const bban = bez.padEnd(DLUGOSC - 2, '0');
  return `${liczbaKontrolna(bban)}${bban}`;
}

/** Czy numer (ze spacjami albo bez) wygląda jak poprawny mikrorachunek z NIP. */
export function czyMikrorachunekZNip(numer: string): boolean {
  const cyfry = numer.replace(/\s/g, '');
  if (!/^\d{26}$/.test(cyfry)) return false;
  if (cyfry.slice(2, 13) !== STALA_NBP || cyfry[13] !== TYP_NIP) return false;
  if (!validateNipChecksum(cyfry.slice(14, 24)) || cyfry.slice(24) !== '00') return false;
  return reszta97(`${cyfry.slice(2)}${KRAJ_PL}${cyfry.slice(0, 2)}`) === 1;
}

/**
 * Czy 26 cyfr (ze spacjami albo bez) to poprawny polski numer rachunku (NRB):
 * reszta z 97 numeru IBAN z „PL” musi wynosić 1. Do rachunku składkowego ZUS
 * (NRS) w profilu podatkowym.
 */
export function czyRachunekNrb(numer: string): boolean {
  const cyfry = numer.replace(/\s/g, '');
  if (!/^\d{26}$/.test(cyfry)) return false;
  return reszta97(`${cyfry.slice(2)}${KRAJ_PL}${cyfry.slice(0, 2)}`) === 1;
}

/** Zapis do wyświetlenia: „LK NNNN NNNN NNNN NNNN NNNN NNNN”. */
export function formatujRachunek(numer: string): string {
  const cyfry = numer.replace(/\s/g, '');
  return [cyfry.slice(0, 2), ...(cyfry.slice(2).match(/.{1,4}/g) ?? [])].join(' ');
}
