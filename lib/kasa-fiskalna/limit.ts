/**
 * Licznik limitu zwolnienia z kasy rejestrującej (plan kompletnej aplikacji,
 * krok 9.3, decyzja P6; ryzyko R2).
 *
 * Źródło: rozporządzenie Ministra Finansów z 17.12.2024 r. w sprawie zwolnień
 * z obowiązku prowadzenia ewidencji sprzedaży przy zastosowaniu kas
 * rejestrujących (Dz.U. 2024 poz. 1902):
 * - § 3 ust. 1 pkt 1: zwolnienie, gdy wartość sprzedaży na rzecz osób
 *   fizycznych nieprowadzących działalności i rolników ryczałtowych w roku
 *   poprzednim nie przekroczyła 20 000 zł;
 * - § 3 ust. 1 pkt 2 (rozpoczęcie po 31.12.2024): kwota 20 000 zł w proporcji
 *   do okresu wykonywania czynności w danym roku;
 * - § 5 ust. 1 pkt 1-2: zwolnienie traci moc po upływie dwóch miesięcy
 *   następujących po miesiącu, w którym sprzedaż przekroczyła 20 000 zł
 *   (w roku rozpoczęcia: kwotę w proporcji do okresu).
 * Wartość sprzedaży to kwota brutto (art. 111 ust. 3a ustawy o VAT).
 *
 * Funkcja jest czysta: bez odczytu bazy i bez porad, tylko liczby z przepisu.
 * Proporcja liczona w dniach (od daty rozpoczęcia do 31.12 włącznie).
 *
 * Ograniczenie: faktura rozliczająca zaliczki (`final`) nie wchodzi do sumy,
 * bo jej brutto zawiera zaliczki już policzone przy fakturach zaliczkowych;
 * reszta po zaliczkach nie jest więc liczona (niedoszacowanie).
 */

import { roundToCents } from '@/lib/xml/invoice-calculator';
export const LIMIT_KASY_PLN = 20000;
/** Od tego udziału limitu licznik mówi „blisko”. */
export const LIMIT_KASY_BLISKO = 0.8;

export interface SprzedazDlaLimitu {
  id: string;
  /** RRRR-MM-DD */
  issueDate: string;
  /** Brutto dokumentu; korekta: różnica (może być ujemna). */
  gross: number;
  kind: string | null;
  isB2c: boolean | null;
  buyerNip: string | null;
}

export type StanLimituKasy = 'below' | 'near' | 'exceeded';

export interface WynikLimituKasy {
  year: number;
  sum: number;
  limit: number;
  /** `sum / limit`, bez obcinania do 1. */
  share: number;
  state: StanLimituKasy;
  /** Limit proporcjonalny (rok rozpoczęcia działalności). */
  proportional: boolean;
  /** Brak daty rozpoczęcia w ustawieniach: liczony pełny limit. */
  startUnknown: boolean;
  /** RRRR-MM miesiąca, w którym suma narastająco przekroczyła limit. */
  exceededMonth: string | null;
}

const round2 = (n: number) => roundToCents(n);

function osobaPrywatna(s: SprzedazDlaLimitu): boolean {
  if (s.isB2c === true) return true;
  if (s.isB2c === false) return false;
  return !s.buyerNip || s.buyerNip.trim() === '';
}

function dayOfYear(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
}

function daysInYear(year: number): number {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
}

export function limitKasy(
  sales: readonly SprzedazDlaLimitu[],
  opts: { year: number; businessStartedOn: string | null },
): WynikLimituKasy {
  const { year, businessStartedOn } = opts;
  const startsThisYear = businessStartedOn !== null && businessStartedOn.slice(0, 4) === String(year);
  const proportional = startsThisYear && dayOfYear(businessStartedOn) > 1;
  const limit = proportional
    ? round2((LIMIT_KASY_PLN * (daysInYear(year) - dayOfYear(businessStartedOn) + 1)) / daysInYear(year))
    : LIMIT_KASY_PLN;

  const relevant = sales
    .filter((s) => s.issueDate.startsWith(`${year}-`) && s.kind !== 'final' && osobaPrywatna(s))
    .slice()
    .sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.id.localeCompare(b.id));

  let running = 0;
  let exceededMonth: string | null = null;
  for (const s of relevant) {
    running = round2(running + s.gross);
    if (exceededMonth === null && running > limit) exceededMonth = s.issueDate.slice(0, 7);
  }
  const sum = Math.max(0, running);
  const state: StanLimituKasy = sum > limit ? 'exceeded' : sum >= limit * LIMIT_KASY_BLISKO ? 'near' : 'below';
  return {
    year,
    sum,
    limit,
    share: limit > 0 ? sum / limit : 0,
    state,
    proportional,
    startUnknown: businessStartedOn === null,
    // Miesiąc przekroczenia tylko, gdy stan nadal „przekroczony” (korekta mogła go cofnąć).
    exceededMonth: state === 'exceeded' ? exceededMonth : null,
  };
}
