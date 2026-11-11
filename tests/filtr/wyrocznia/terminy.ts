// Terminy płatności JDG i dni wolne od pracy (SPEC-terminy.md). Bez zależności.
export type Rodzaj = 'ryczalt' | 'zaliczkaPit' | 'zus' | 'vatJpk';

const DZIEN_MS = 86400000;

function dwie(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** Numer dnia od epoki (UTC) dla roku, miesiąca 1-12, dnia. */
function numerDnia(r: number, m: number, d: number): number {
  return Math.round(Date.UTC(r, m - 1, d) / DZIEN_MS);
}

/** Numer dnia -> 'RRRR-MM-DD'. */
function naNapis(n: number): string {
  const t = new Date(n * DZIEN_MS);
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${dwie(t.getUTCMonth() + 1)}-${dwie(t.getUTCDate())}`;
}

/** Parsuje 'RRRR-MM-DD' (punkt 4 SPEC); zły format lub nieistniejąca data = błąd. */
function parsuj(data: string): { r: number; m: number; d: number; n: number } {
  const w = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data);
  if (typeof data !== 'string' || !w) throw new Error(`Nieprawidłowa data: ${String(data)}`);
  const r = Number(w[1]);
  const m = Number(w[2]);
  const d = Number(w[3]);
  const n = numerDnia(r, m, d);
  if (naNapis(n) !== data) throw new Error(`Nieprawidłowa data: ${data}`);
  return { r, m, d, n };
}

/** Dzień tygodnia: 0 = niedziela ... 6 = sobota (1970-01-01 to czwartek). */
function dzienTygodnia(n: number): number {
  return (((n + 4) % 7) + 7) % 7;
}

function sprawdzRok(rok: number): void {
  if (!Number.isInteger(rok) || rok < 1583 || rok > 9999) throw new Error(`Nieprawidłowy rok: ${rok}`);
}

/** Niedziela wielkanocna, algorytm Meeusa/Jonesa/Butchera (punkt 1 SPEC). */
export function wielkanoc(rok: number): string {
  sprawdzRok(rok);
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
  return `${String(rok).padStart(4, '0')}-${dwie(miesiac)}-${dwie(dzien)}`;
}

/** Święta z punktu 1 SPEC, rosnąco; 24.12 dopiero od 2025. */
export function swietaUstawowe(rok: number): string[] {
  sprawdzRok(rok);
  const w = parsuj(wielkanoc(rok)).n;
  const lista: number[] = [
    numerDnia(rok, 1, 1),
    numerDnia(rok, 1, 6),
    w,
    w + 1,
    numerDnia(rok, 5, 1),
    numerDnia(rok, 5, 3),
    w + 49,
    w + 60,
    numerDnia(rok, 8, 15),
    numerDnia(rok, 11, 1),
    numerDnia(rok, 11, 11),
    ...(rok >= 2025 ? [numerDnia(rok, 12, 24)] : []),
    numerDnia(rok, 12, 25),
    numerDnia(rok, 12, 26),
  ];
  return lista.sort((x, y) => x - y).map(naNapis);
}

/** Niedziela albo dzień z punktu 1 SPEC. */
export function czyDzienWolnyOdPracy(data: string): boolean {
  const { r, n } = parsuj(data);
  if (dzienTygodnia(n) === 0) return true;
  return swietaUstawowe(r).includes(data);
}

/** Dzień, w którym może upłynąć termin: nie sobota i nie dzień wolny (punkt 3 SPEC). */
export function czyDzienTerminu(data: string): boolean {
  const { n } = parsuj(data);
  return dzienTygodnia(n) !== 6 && !czyDzienWolnyOdPracy(data);
}

/** Pierwszy dzień >= data, w którym może upłynąć termin (punkt 3 SPEC). */
export function przesunTermin(data: string): string {
  let { n } = parsuj(data);
  let s = naNapis(n);
  while (!czyDzienTerminu(s)) {
    n += 1;
    s = naNapis(n);
  }
  return s;
}

/** Termin za okres (punkt 2 i 3 SPEC). Dzień nominalny: 20, a dla VAT/JPK 25. */
export function termin(rodzaj: Rodzaj, rok: number, miesiac: number): { nominalny: string; faktyczny: string } {
  sprawdzRok(rok);
  if (!Number.isInteger(miesiac) || miesiac < 1 || miesiac > 12) throw new Error(`Nieprawidłowy miesiąc: ${miesiac}`);
  let dzien: number;
  switch (rodzaj) {
    case 'ryczalt':
    case 'zaliczkaPit':
    case 'zus':
      dzien = 20;
      break;
    case 'vatJpk':
      dzien = 25;
      break;
    default:
      throw new Error(`Nieznany rodzaj: ${String(rodzaj)}`);
  }
  // Miesiąc następujący po okresie; grudzień przechodzi na styczeń R+1.
  const r = miesiac === 12 ? rok + 1 : rok;
  const m = miesiac === 12 ? 1 : miesiac + 1;
  const nominalny = `${String(r).padStart(4, '0')}-${dwie(m)}-${dwie(dzien)}`;
  return { nominalny, faktyczny: przesunTermin(nominalny) };
}
