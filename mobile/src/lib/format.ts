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
const DZIEN_TYGODNIA = new Intl.DateTimeFormat('pl-PL', { weekday: 'short', day: 'numeric', month: 'long' });
const GODZINA = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });
const DZIEN_I_GODZINA = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });
const DZIEN_WARSZAWA = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' });

const KWOTY_WALUT = new Map<string, Intl.NumberFormat>();

/**
 * Kwota w groszach jako „1 234,56 zł”. Grosze, bo tak liczy generator FA(3).
 * Faktura w innej walucie (z bazy, od M7) dostaje swój symbol: „1 234,56 €”.
 */
export function kwota(grosze: number, waluta = 'PLN'): string {
  if (waluta === 'PLN') return KWOTA.format(grosze / 100).replace(/\s(?=zł$)/, '\u00a0');
  let f = KWOTY_WALUT.get(waluta);
  if (!f) {
    try {
      f = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: waluta, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } catch {
      // Kod spoza ISO 4217: liczba i kod obok.
      return `${(grosze / 100).toFixed(2).replace('.', ',')}\u00a0${waluta}`;
    }
    KWOTY_WALUT.set(waluta, f);
  }
  return f.format(grosze / 100).replace(/\s(?=\S+$)/, '\u00a0');
}

const CENY = new Map<string, Intl.NumberFormat>();

/**
 * Cena jednostkowa netto z miejscami jak w bazie (`unit_price_net`, do 4):
 * „33,3333 zł”, „100,00 zł”. Kwoty faktury zostają w groszach (`kwota`).
 */
export function cena(wartosc: number, waluta = 'PLN'): string {
  let f = CENY.get(waluta);
  if (!f) {
    try {
      f = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: waluta, minimumFractionDigits: 2, maximumFractionDigits: 4 });
    } catch {
      return `${wartosc.toFixed(4).replace(/0{1,2}$/, '').replace('.', ',')}\u00a0${waluta}`;
    }
    CENY.set(waluta, f);
  }
  return f.format(wartosc).replace(/\s(?=\S+$)/, '\u00a0');
}

/** „12 lis” dla dat w wierszach listy. Data w formacie RRRR-MM-DD. */
export function dataKrotka(iso: string): string {
  return DATA_KROTKA.format(new Date(`${iso}T12:00:00`)).replace(/\.$/, '');
}

/** „12 listopada 2026” dla ekranu szczegółu. */
export function dataPelna(iso: string): string {
  return DATA_PELNA.format(new Date(`${iso}T12:00:00`));
}

/** „pt., 6 listopada” dla nagłówka dnia na liście kosztów (wzór Copilota, D14). */
export function dzienTygodnia(iso: string): string {
  return DZIEN_TYGODNIA.format(new Date(`${iso}T12:00:00`));
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

/** Kwota z pola i do pola: liczenie w `lib/kwota-z-pola.ts` (obszar R1 filtra), tu tylko dla dawnych importów. */
export { doPola, groszeZPola } from './kwota-z-pola';

/** Kiedy pobrano dane z serwera: „przed chwilą”, „dziś o 12:40”, „12 lis, 12:40”. */
export function kiedyPobrano(iso: string, teraz = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (teraz.getTime() - d.getTime() < 60_000) return 'przed chwilą';
  if (DZIEN_WARSZAWA.format(d) === DZIEN_WARSZAWA.format(teraz)) return `dziś o ${GODZINA.format(d)}`;
  return DZIEN_I_GODZINA.format(d).replace(/\.(?=,)/, '');
}

/** Numer rachunku do czytania: 26 cyfr NRB jak „61 1090 1014 …”; inny zapis bez zmian. */
export function rachunek(numer: string): string {
  const cyfry = numer.replace(/\s+/g, '');
  if (!/^\d{26}$/.test(cyfry)) return numer;
  return `${cyfry.slice(0, 2)} ${cyfry.slice(2).replace(/(\d{4})(?=\d)/g, '$1 ')}`;
}
