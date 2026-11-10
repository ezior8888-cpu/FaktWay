/**
 * Formatowanie kwot i dat po polsku. Te same zasady co `lib/format/pl.ts`
 * strony: kwota „1 234,56 zł” z twardą spacją przed walutą. Kopia, nie import:
 * sposób współdzielenia kodu ze stroną ustala etap M6 planu
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

const KWOTA_KROTKA = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1 });

/** Liczba w skrócie: „34,6 tys.”, „1,2 mln”, poniżej progu bez skrótu (osie wykresów, kafle). */
export function liczbaKrotka(n: number, progTysiecy = 1000): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${KWOTA_KROTKA.format(n / 1_000_000)}\u00a0mln`;
  if (abs >= progTysiecy) return `${KWOTA_KROTKA.format(n / 1_000)}\u00a0tys.`;
  return KWOTA_KROTKA.format(n);
}

/** Kwota w kaflu: „34,6 tys. zł”, „1,2 mln zł”, poniżej 10 tys. pełna. */
export function kwotaKrotka(grosze: number): string {
  const zl = grosze / 100;
  if (Math.abs(zl) >= 10_000) return `${liczbaKrotka(zl, 10_000)}\u00a0zł`;
  return kwota(grosze);
}

/** Zmiana procentowa ze znakiem: „+2%”, „−6%”, „0%”. */
export function zmiana(pct: number): string {
  if (pct > 0) return `+${pct}%`;
  if (pct < 0) return `\u2212${Math.abs(pct)}%`;
  return '0%';
}

/** Kwota wpisana w polu („1500”, „1 500,50”) w groszach; puste albo błędne to NaN. */
export function groszeZPola(tekst: string): number {
  const t = tekst.replace(/\s/g, '').replace(',', '.');
  if (!t) return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/** Grosze do pola formularza: 1500,50 (bez waluty i spacji). */
export function doPola(grosze: number): string {
  return (grosze / 100).toFixed(2).replace('.', ',');
}
