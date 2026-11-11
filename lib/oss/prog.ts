/**
 * Licznik progu 10 000 euro dla sprzedaży do konsumentów z innych państw UE
 * (plan kompletnej aplikacji, krok 9.4, decyzja P5; ryzyko R2). Bez deklaracji
 * VIU-DO, tylko liczba i ostrzeżenie.
 *
 * Źródło: ustawa o VAT (Dz.U. 2004 nr 54 poz. 535, tekst jednolity z
 * obwieszczenia DU/2026/1263, odczytany z api.sejm.gov.pl):
 * - art. 22a ust. 1 pkt 3 (dostawy towarów wysyłanych do innego państwa UE) i
 *   art. 28k ust. 2 pkt 3 (usługi telekomunikacyjne, nadawcze, elektroniczne):
 *   suma wartości "pomniejszona o kwotę podatku" "nie przekroczyła w trakcie
 *   roku podatkowego ani w poprzednim roku podatkowym" 10 000 euro;
 * - tamże: dla sprzedawcy z siedzibą tylko w kraju "wyrażona w złotych
 *   równowartość kwoty w euro wynosi 42 000 zł" (stała kwota, bez przeliczania
 *   progu kursem);
 * - art. 22a ust. 2 i art. 28k ust. 3: po przekroczeniu w trakcie roku reguła
 *   miejsca dostawy działa "począwszy od dostawy", w związku z którą przekroczono;
 * - art. 31a ust. 1: kwoty w walucie obcej przelicza się na złote kursem
 *   średnim NBP z ostatniego dnia roboczego przed powstaniem obowiązku
 *   podatkowego (art. 31a ust. 2: przed dniem wystawienia faktury, gdy wystawiono ją wcześniej).
 *
 * Reguły licznika:
 * - liczy się kwota NETTO (bez podatku), korekta jako różnica;
 * - przekroczenie to suma STRICTE większa od 42 000 zł (przepis: "nie przekroczyła");
 * - przekroczenie w roku poprzednim też wyłącza regułę (stan "przekroczony");
 * - faktura w walucie obcej wchodzi tylko z kursem (`rateToPln`); bez kursu
 *   albo bez waluty nie jest zgadywana, tylko liczona osobno w `withoutRate`.
 *
 * Niepewne (źródła nie rozstrzygają, patrz opis PR):
 * - faktura nie mówi, czy to towar wysyłany, usługa TBE czy inna usługa, więc
 *   licznik liczy wszystkie faktury dla konsumentów z UE (może zawyżać);
 * - rok liczony po dacie wystawienia, nie po dacie dostawy ani obowiązku podatkowego;
 * - nabywca bez NIP i bez numeru VAT-UE, nieoznaczony jako firma, to konsument.
 */

import { roundToCents } from '@/lib/xml/invoice-calculator';

export const PROG_OSS_PLN = 42000;
export const PROG_OSS_EURO = 10000;
/** Od tego udziału progu licznik mówi „blisko”. */
export const PROG_OSS_BLISKO = 0.8;

/** Kody ISO państw członkowskich UE bez Polski (Grecja to GR w adresie). */
const KRAJE_UE_BEZ_PL: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'RO', 'SE', 'SI', 'SK',
]);

export interface SprzedazDlaOss {
  id: string;
  /** RRRR-MM-DD */
  issueDate: string;
  /** Netto dokumentu w jego walucie; korekta: różnica (może być ujemna). */
  net: number;
  kind: string | null;
  currency: string | null;
  /** Kurs do złotych (art. 31a); `null` = brak kursu. Dla PLN nieużywany. */
  rateToPln: number | null;
  /** Kraj nabywcy z adresu (ISO). */
  countryCode: string | null;
  isB2c: boolean | null;
  buyerNip: string | null;
  /** Numer VAT-UE nabywcy. */
  vatUe: string | null;
}

export type StanProguOss = 'below' | 'near' | 'exceeded';

export interface WynikProguOss {
  year: number;
  sum: number;
  sumPrevYear: number;
  limit: number;
  /** `sum / limit`, bez obcinania do 1. */
  share: number;
  state: StanProguOss;
  /** Suma z poprzedniego roku przekroczyła próg (art. 22a ust. 1 pkt 3: "ani w poprzednim roku"). */
  previousYearExceeded: boolean;
  /** RRRR-MM miesiąca, w którym suma narastająco przekroczyła próg w roku bieżącym. */
  exceededMonth: string | null;
  /** Faktury w walucie obcej (lub bez waluty) bez kursu: nie wchodzą do sum. */
  withoutRate: { count: number; currencies: string[] };
}

const blank = (v: string | null | undefined) => !v || v.trim() === '';

function konsumentZUe(s: SprzedazDlaOss): boolean {
  const country = (s.countryCode ?? '').trim().toUpperCase();
  if (!KRAJE_UE_BEZ_PL.has(country)) return false;
  if (!blank(s.buyerNip) || !blank(s.vatUe)) return false;
  return s.isB2c !== false;
}

/** Netto w złotych albo `null`, gdy waluta obca nie ma kursu. */
function netPln(s: SprzedazDlaOss): number | null {
  const currency = (s.currency ?? '').trim().toUpperCase();
  if (currency === 'PLN') return s.net;
  if (currency === '' || s.rateToPln === null || !(s.rateToPln > 0)) return null;
  return roundToCents(s.net * s.rateToPln);
}

function sumOf(items: readonly { issueDate: string; id: string; pln: number }[], limit: number) {
  let running = 0;
  let exceededMonth: string | null = null;
  for (const s of items) {
    running = roundToCents(running + s.pln);
    if (exceededMonth === null && running > limit) exceededMonth = s.issueDate.slice(0, 7);
  }
  return { sum: Math.max(0, running), exceededMonth };
}

export function licznikOss(sales: readonly SprzedazDlaOss[], opts: { year: number }): WynikProguOss {
  const { year } = opts;
  const relevant = sales
    .filter((s) => konsumentZUe(s) && (s.issueDate.startsWith(`${year}-`) || s.issueDate.startsWith(`${year - 1}-`)))
    .slice()
    .sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.id.localeCompare(b.id));

  const counted: { issueDate: string; id: string; pln: number }[] = [];
  let missing = 0;
  const missingCurrencies = new Set<string>();
  for (const s of relevant) {
    const pln = netPln(s);
    if (pln === null) {
      missing += 1;
      const code = (s.currency ?? '').trim().toUpperCase();
      if (code) missingCurrencies.add(code);
    } else {
      counted.push({ issueDate: s.issueDate, id: s.id, pln });
    }
  }

  const current = sumOf(counted.filter((s) => s.issueDate.startsWith(`${year}-`)), PROG_OSS_PLN);
  const previous = sumOf(counted.filter((s) => s.issueDate.startsWith(`${year - 1}-`)), PROG_OSS_PLN);
  const previousYearExceeded = previous.sum > PROG_OSS_PLN;
  const currentExceeded = current.sum > PROG_OSS_PLN;
  const state: StanProguOss = currentExceeded || previousYearExceeded
    ? 'exceeded'
    : current.sum >= PROG_OSS_PLN * PROG_OSS_BLISKO ? 'near' : 'below';
  return {
    year,
    sum: current.sum,
    sumPrevYear: previous.sum,
    limit: PROG_OSS_PLN,
    share: current.sum / PROG_OSS_PLN,
    state,
    previousYearExceeded,
    // Miesiąc przekroczenia tylko, gdy nadal przekroczony (korekta mogła go cofnąć).
    exceededMonth: currentExceeded ? current.exceededMonth : null,
    withoutRate: { count: missing, currencies: [...missingCurrencies].sort() },
  };
}
