/**
 * Formatowanie kwot i dat po polsku. Te same zasady co `lib/format/pl.ts`
 * strony: kwota „1 234,56 zł” z twardą spacją przed walutą. Kopia, nie import:
 * sposób współdzielenia kodu ze stroną ustala etap M5 planu
 * (docs/koordynacja/PLAN-APLIKACJA-MOBILNA.md).
 */
const KWOTA = new Intl.NumberFormat('pl-PL', {
  style: 'currency',
  currency: 'PLN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const DATA_KROTKA = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'short' });
const DATA_PELNA = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' });

/** Kwota w groszach jako „1 234,56 zł”. Grosze, bo tak liczy generator FA(3). */
export function kwota(grosze: number): string {
  return KWOTA.format(grosze / 100).replace(/\s(?=zł$)/, ' ');
}

/** „12 lis” dla dat w wierszach listy. Data w formacie RRRR-MM-DD. */
export function dataKrotka(iso: string): string {
  return DATA_KROTKA.format(new Date(`${iso}T12:00:00`)).replace(/\.$/, '');
}

/** „12 listopada 2026” dla ekranu szczegółu. */
export function dataPelna(iso: string): string {
  return DATA_PELNA.format(new Date(`${iso}T12:00:00`));
}

/** Liczba dni od `od` do `do` (obie daty RRRR-MM-DD). */
export function dniMiedzy(od: string, doDnia: string): number {
  const ms = new Date(`${doDnia}T12:00:00`).getTime() - new Date(`${od}T12:00:00`).getTime();
  return Math.round(ms / 86_400_000);
}
