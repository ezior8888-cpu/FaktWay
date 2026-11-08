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

/** Faktura czeka na zapłatę (przyjęta przez KSeF i niezapłacona). */
export function doZaplaty(f: Faktura): boolean {
  return f.statusKsef === 'przyjeta' && !f.zaplacona;
}
