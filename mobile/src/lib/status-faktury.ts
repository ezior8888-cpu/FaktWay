/**
 * Jeden tekst statusu faktury dla listy i szczegółu. Status zawsze ma tekst,
 * kolor tylko go wzmacnia (docs/mobile/ZASADY-DESIGNU.md, sekcja 4).
 */
import type { Faktura } from '@/dane-przykladowe';
import { dataKrotka, dniMiedzy } from '@/lib/format';
import type { Kolory } from '@/wyglad/kolory';

export type Status = { tekst: string; kolor: keyof Kolory; zalegla: boolean };

/** „1 dzień”, „2 dni”, „5 dni”. */
export function dni(n: number): string {
  return n === 1 ? '1 dzień' : `${n} dni`;
}

export function statusFaktury(f: Faktura, dzis: string): Status {
  if (f.statusKsef === 'robocza') return { tekst: 'Szkic', kolor: 'etykietaDrugorzedna', zalegla: false };
  if (f.statusKsef === 'wysylanie') return { tekst: 'Wysyłanie do KSeF', kolor: 'etykietaDrugorzedna', zalegla: false };
  if (f.statusKsef === 'odrzucona') return { tekst: 'Odrzucona przez KSeF', kolor: 'blad', zalegla: false };
  if (f.zaplacona) return { tekst: 'Zapłacona', kolor: 'sukces', zalegla: false };

  const poTerminie = dniMiedzy(f.terminPlatnosci, dzis);
  if (poTerminie > 7) return { tekst: `${dni(poTerminie)} po terminie`, kolor: 'blad', zalegla: true };
  if (poTerminie > 0) return { tekst: `${dni(poTerminie)} po terminie`, kolor: 'ostrzezenie', zalegla: true };
  if (poTerminie === 0) return { tekst: 'Termin dziś', kolor: 'ostrzezenie', zalegla: false };
  return { tekst: `Termin ${dataKrotka(f.terminPlatnosci)}`, kolor: 'etykietaDrugorzedna', zalegla: false };
}

/**
 * Faktura czeka na zapłatę: wysłana (przyjęta albo jeszcze w drodze do KSeF)
 * i niezapłacona. Klient bywa winien pieniądze, zanim KSeF potwierdzi przyjęcie.
 */
export function doZaplaty(f: Faktura): boolean {
  return (f.statusKsef === 'przyjeta' || f.statusKsef === 'wysylanie') && !f.zaplacona;
}

/** „1 faktura”, „2 faktury”, „5 faktur”, „22 faktury” (polska liczba mnoga). */
export function ileFaktur(n: number): string {
  if (n === 1) return '1 faktura';
  const j = n % 10;
  const d = n % 100;
  return j >= 2 && j <= 4 && (d < 12 || d > 14) ? `${n} faktury` : `${n} faktur`;
}

/** Termin względem dziś: „dziś”, „jutro”, „za 3 dni”, „2 dni po terminie”. */
export function kiedyTermin(dzis: string, termin: string): string {
  const za = dniMiedzy(dzis, termin);
  if (za === 0) return 'dziś';
  if (za === 1) return 'jutro';
  return za > 0 ? `za ${dni(za)}` : `${dni(-za)} po terminie`;
}
