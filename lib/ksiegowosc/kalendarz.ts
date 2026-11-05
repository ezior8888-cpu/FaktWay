/**
 * Kalendarz dni wolnych i terminy płatności (plan księgowości JDG, krok K1).
 *
 * Przeniesione z `lib/flo/tax-params.ts`; FLO importuje stąd (D14). Daty to
 * północ UTC polskiego dnia, jak w FLO. Algorytmy są czystą arytmetyką
 * kalendarza, a dni miesiąca terminów biorą się z `parametry/terminy.ts`.
 *
 * Zmiana względem FLO: Wigilia (24 grudnia) jest dniem wolnym od pracy od
 * 2025 r. Kalendarz FLO jej nie znał (jego test twierdził odwrotnie), a ten
 * sam wyjątek ma już `lib/ksef/idempotency.ts`.
 */

import { terminyNa } from '@/lib/ksiegowosc/parametry';

const DOBA_MS = 86_400_000;

/** Od tego roku Wigilia jest dniem ustawowo wolnym od pracy. */
export const WIGILIA_WOLNA_OD = 2025;

/**
 * Niedziela Wielkanocna: algorytm Meeusa/Jonesa/Butchera dla kalendarza
 * gregoriańskiego. Od niej liczą się trzy pozostałe święta ruchome.
 */
export function wielkanoc(rok: number): Date {
  const a = rok % 19;
  const b = Math.floor(rok / 100);
  const c = rok % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const miesiac = Math.floor((h + l - 7 * m + 114) / 31);
  const dzien = ((h + l - 7 * m + 114) % 31) + 1;

  return new Date(Date.UTC(rok, miesiac - 1, dzien));
}

/** Święta o stałej dacie: [miesiąc, dzień]. Wigilia osobno, od 2025 r. */
const SWIETA_STALE: readonly [number, number][] = [
  [1, 1], // Nowy Rok
  [1, 6], // Trzech Króli
  [5, 1], // Święto Pracy
  [5, 3], // Święto Konstytucji
  [8, 15], // Wniebowzięcie / Wojska Polskiego
  [11, 1], // Wszystkich Świętych
  [11, 11], // Niepodległości
  [12, 25], // Boże Narodzenie
  [12, 26], // drugi dzień świąt
];

/** Dni ustawowo wolne w danym roku, jako RRRR-MM-DD. */
export function dniWolne(rok: number): Set<string> {
  const dni = new Set<string>();

  for (const [miesiac, dzien] of SWIETA_STALE) {
    dni.add(iso(new Date(Date.UTC(rok, miesiac - 1, dzien))));
  }
  if (rok >= WIGILIA_WOLNA_OD) dni.add(iso(new Date(Date.UTC(rok, 11, 24))));

  const niedzielaWielkanocna = wielkanoc(rok);
  // Wielkanoc, poniedziałek wielkanocny, Zielone Świątki, Boże Ciało.
  for (const przesuniecie of [0, 1, 49, 60]) {
    dni.add(iso(new Date(niedzielaWielkanocna.getTime() + przesuniecie * DOBA_MS)));
  }

  return dni;
}

export function czySwieto(data: Date): boolean {
  return dniWolne(data.getUTCFullYear()).has(iso(data));
}

export function czyDzienRoboczy(data: Date): boolean {
  const dzienTygodnia = data.getUTCDay();
  if (dzienTygodnia === 0 || dzienTygodnia === 6) return false;
  return !czySwieto(data);
}

/**
 * Najbliższy dzień roboczy, zawsze DO PRZODU: termin w sobotę upływa
 * w poniedziałek. Przesunięcie w tył kazałoby płacić wcześniej, niż trzeba.
 */
export function najblizszyDzienRoboczy(data: Date): Date {
  let kursor = data;
  // Najdłuższy realny ciąg dni wolnych to kilka dni; limit chroni tylko
  // przed pętlą nieskończoną.
  for (let straznik = 0; straznik < 14; straznik++) {
    if (czyDzienRoboczy(kursor)) return kursor;
    kursor = new Date(kursor.getTime() + DOBA_MS);
  }
  return kursor;
}

export type RodzajTerminu = 'ryczalt' | 'zaliczkaPit' | 'zus' | 'vatJpk';

export interface Termin {
  rodzaj: RodzajTerminu;
  /** Termin ustawowy przed przesunięciem, RRRR-MM-DD. */
  nominalny: string;
  /** Termin faktyczny, po przesunięciu na dzień roboczy. */
  faktyczny: string;
  /** Czy przesunięcie nastąpiło (do treści komunikatu). */
  przesuniety: boolean;
}

/**
 * Termin za okres rozliczeniowy, zawsze w miesiącu NASTĘPUJĄCYM po nim
 * (za grudzień w styczniu). `null`, gdy dla tego dnia nie znamy terminów:
 * termin „na oko” klient zapłaciłby za późno.
 */
export function terminDla(okres: { rodzaj: RodzajTerminu; rok: number; miesiac: number }): Termin | null {
  // Miesiąc po okresie; przejście przez grudzień załatwia Date.UTC.
  const kotwica = new Date(Date.UTC(okres.rok, okres.miesiac, 1));
  const terminy = terminyNa(iso(kotwica));
  const dzien = terminy?.liczby[okres.rodzaj].wartosc ?? null;
  if (dzien === null) return null;

  const nominalny = new Date(Date.UTC(kotwica.getUTCFullYear(), kotwica.getUTCMonth(), dzien));
  const faktyczny = najblizszyDzienRoboczy(nominalny);

  return {
    rodzaj: okres.rodzaj,
    nominalny: iso(nominalny),
    faktyczny: iso(faktyczny),
    przesuniety: iso(faktyczny) !== iso(nominalny),
  };
}

/** Ostatni miesiąc kwartału, w którym leży miesiąc. */
export function ostatniMiesiacKwartalu(miesiac: number): number {
  return Math.ceil(miesiac / 3) * 3;
}

function iso(data: Date): string {
  return data.toISOString().slice(0, 10);
}
