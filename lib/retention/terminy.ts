import { addDaysToIsoDate, todayInWarsaw, warsawMidnightIso } from '@/lib/format/warsaw-date';

/**
 * Terminy retencji faktur (żelazny filtr NZ-RET-01, obszar `retencja`, R1).
 *
 * FaktWay przechowuje dane fakturowe co najmniej 10 lat od dnia wystawienia
 * (AGENTS.md, „Compliance”). Ustawowe minimum jest krótsze: dokumenty trzyma
 * się do przedawnienia zobowiązania podatkowego (art. 112 ustawy o VAT,
 * art. 86 § 1 Ordynacji podatkowej), które mija 5 lat od końca roku,
 * w którym upłynął termin płatności podatku (art. 70 § 1 Ordynacji).
 *
 * Usuwanie ma dwa kroki:
 * 1. `cron.archive-old-invoices` (3:00) bierze faktury wystawione przed
 *    `granicaArchiwizacji` i zapisuje im `scheduled_deletion_at`
 *    z `terminUsunieciaPoArchiwizacji`;
 * 2. `cron.retention-delete` (4:00) usuwa faktury, których
 *    `scheduled_deletion_at` minął.
 * Faktura archiwizowana dziś ma datę wystawienia sprzed granicy (dziś minus
 * 2 lata), a termin to koniec dnia „dziś plus 8 lat”, więc usunięcie wypada
 * zawsze po końcu dnia „wystawienie plus 10 lat” w Polsce. Sprawdza to
 * `tests/filtr/niezmienniki/retencja.test.ts` dla każdego dnia 2026-2060.
 */

/** Lata przechowywania danych fakturowych, licząc od dnia wystawienia. */
export const LATA_PRZECHOWYWANIA_FAKTUR = 10;

/** Po tylu latach od dnia wystawienia XML faktury trafia do archiwum (Glacier). */
export const LATA_DO_ARCHIWUM = 2;

const DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Ten sam dzień `lata` lat później (ujemne: wcześniej). 29 lutego w roku bez
 * tego dnia daje 28 lutego, jak koniec terminu liczonego w latach (art. 112
 * Kodeksu cywilnego).
 */
export function przesunOLata(dzien: string, lata: number): string {
  const m = DATA.exec(dzien);
  if (!m || addDaysToIsoDate(dzien, 0) === null) throw new Error(`Retencja: nieprawidłowa data "${dzien}"`);
  const rok = Number(m[1]) + lata;
  const ostatniDzienMiesiaca = new Date(Date.UTC(rok, Number(m[2]), 0)).getUTCDate();
  const d = Math.min(Number(m[3]), ostatniDzienMiesiaca);
  return `${String(rok).padStart(4, '0')}-${m[2]}-${String(d).padStart(2, '0')}`;
}

/** Faktury wystawione PRZED tym dniem trafiają dziś do archiwum: dziś w Polsce minus 2 lata. */
export function granicaArchiwizacji(teraz: Date = new Date()): string {
  return przesunOLata(todayInWarsaw(teraz), -LATA_DO_ARCHIWUM);
}

/**
 * `scheduled_deletion_at` faktury archiwizowanej w chwili `teraz` (znacznik
 * ISO): północ w Polsce po dniu „dziś plus 8 lat”, czyli 10 lat
 * przechowywania minus 2 lata do archiwum.
 */
export function terminUsunieciaPoArchiwizacji(teraz: Date = new Date()): string {
  const ostatniDzien = przesunOLata(todayInWarsaw(teraz), LATA_PRZECHOWYWANIA_FAKTUR - LATA_DO_ARCHIWUM);
  const nastepnyDzien = addDaysToIsoDate(ostatniDzien, 1);
  if (nastepnyDzien === null) throw new Error(`Retencja: nieprawidłowa data "${ostatniDzien}"`);
  return warsawMidnightIso(nastepnyDzien);
}
