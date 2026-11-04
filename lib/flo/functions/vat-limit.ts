/**
 * T-02 — licznik limitu zwolnienia podmiotowego z VAT (krok 37 planu).
 *
 * ⚠️ FUNKCJA ZA FLAGĄ (`tax.limit` w `lib/flo/flags.ts`) i za bramką M12.
 * Limit i reguły proporcji to dane prawne — patrz `PARAMS_VERIFIED`
 * w `lib/flo/tax-params.ts`.
 *
 * DLACZEGO TA FUNKCJA W OGÓLE ISTNIEJE: przekroczenie limitu zwolnienia
 * oznacza obowiązek rejestracji do VAT-u OD TRANSAKCJI, KTÓRA GO PRZEKROCZYŁA.
 * Klient, który dowiaduje się o tym po fakcie, ma do rozwiązania problem
 * wsteczny — a to jest najgorszy rodzaj problemu podatkowego. Cała funkcja
 * służy temu, żeby ta wiadomość przyszła przed, a nie po.
 *
 * TRZY REGUŁY, KTÓRE TRZYMAJĄ TĘ FUNKCJĘ W RYZACH:
 *
 * 1. AGENT NIE KWALIFIKUJE TRANSAKCJI. To, czy dana sprzedaż wlicza się do
 *    limitu, jest kwalifikacją prawną — a nie zadaniem dla programu.
 *    Domyślnie WLICZAMY WSZYSTKO; wyłączenie musi przyjść z zewnątrz razem
 *    z powodem, który da się pokazać na ekranie. Kierunek domyślnej pomyłki
 *    jest wybrany świadomie: policzenie za dużo kończy się niepotrzebnym
 *    ostrzeżeniem, policzenie za mało — przekroczeniem limitu, o którym
 *    klient dowiaduje się od urzędu.
 *
 * 2. WZÓR JEST WIDOCZNY. Licznik bez wzoru to znowu wyrocznia. Klient ma
 *    prawo zobaczyć limit, proporcję, liczbę dni i to, co zostało wyłączone.
 *
 * 3. PROGNOZA TO SCENARIUSZ, NIE PRZEPOWIEDNIA. Zawsze „jeśli tempo się
 *    utrzyma”, zawsze z przyciskiem „to był jednorazowy kontrakt” — i ten
 *    przycisk ZMIENIA WYŁĄCZNIE PROGNOZĘ, nigdy licznik. Licznik pokazuje,
 *    co się wydarzyło; jednorazowość kontraktu nie sprawia, że pieniądze
 *    nie wpłynęły.
 */

import { fingerprintOf } from '@/lib/flo/fingerprint';
import { formatPln, formatPlnPlain } from '@/lib/flo/money';
import type { CreateProposalInput } from '@/lib/flo/proposals';
import { roundToCents } from '@/lib/xml/invoice-calculator';
import type { FloEvidence } from '@/types/flo';

const DAY_MS = 86_400_000;

/** Progi ostrzeżeń w procentach limitu. */
export const THRESHOLDS = [60, 80, 90] as const;

/** Przekroczenie limitu — sprawa natychmiastowa, nie kolejny próg. */
export const EXCEEDED = 100;

export type LimitThreshold = (typeof THRESHOLDS)[number] | typeof EXCEEDED;

// ═══════════════════════════════════════════════════════════════
// Stan licznika
// ═══════════════════════════════════════════════════════════════

export interface SalesEntry {
  /** kwota netto sprzedaży */
  net: number;
  /** data sprzedaży, ISO YYYY-MM-DD */
  date: string;
  /**
   * Czy pozycja wlicza się do limitu. DOMYŚLNIE TAK — patrz reguła 1
   * w nagłówku. Wyłączenie wymaga podania powodu.
   */
  countsToLimit?: boolean;
  /** Dlaczego wyłączona — trafia na ekran, do wzoru. */
  excludedReason?: string;
}

export interface VatLimitInput {
  /** Rok, którego dotyczy licznik. */
  year: number;
  /** Limit roczny z tabeli parametrów. */
  limit: number;
  /** Data rozpoczęcia działalności z profilu podatkowego, ISO. */
  startedOn: string;
  /** Dni zawieszenia działalności w tym roku. */
  suspendedDays?: number;
  sales: readonly SalesEntry[];
  today: Date;
}

export interface VatLimitState {
  /** Limit roczny, bez proporcji. */
  limit: number;
  /** Limit po proporcji — ten obowiązuje to konto w tym roku. */
  effectiveLimit: number;
  /** Ile dni roku klient prowadzi działalność. */
  activeDays: number;
  daysInYear: number;
  /** Czy limit został zmniejszony proporcją. */
  prorated: boolean;
  /** Sprzedaż wliczona do limitu. */
  used: number;
  /** Sprzedaż wyłączona z limitu. */
  excluded: number;
  /** Ile zostało do progu; nigdy poniżej zera. */
  remaining: number;
  /** Wykorzystanie limitu w procentach; może przekroczyć 100. */
  pct: number;
  /** Wzór do pokazania na ekranie. */
  formula: string;
  /** Co zostało wyłączone i dlaczego. */
  exclusions: string[];
}

/**
 * Proporcja limitu dla firmy założonej w trakcie roku.
 *
 * Limit roczny × (dni prowadzenia działalności w roku / dni w roku).
 * Zawieszenie działalności NIE zmniejsza tej proporcji — wpływa tylko na
 * tempo w prognozie. To rozróżnienie jest celowe i wymaga potwierdzenia
 * razem z resztą tabeli parametrów.
 */
export function proratedLimit(input: {
  limit: number;
  year: number;
  startedOn: string;
}): { limit: number; activeDays: number; daysInYear: number; prorated: boolean } {
  const daysInYear = isLeapYear(input.year) ? 366 : 365;
  const yearStart = Date.UTC(input.year, 0, 1);
  const yearEnd = Date.UTC(input.year, 11, 31);
  const started = Date.parse(`${input.startedOn}T00:00:00.000Z`);

  if (Number.isNaN(started) || started <= yearStart) {
    return { limit: input.limit, activeDays: daysInYear, daysInYear, prorated: false };
  }

  if (started > yearEnd) {
    return { limit: 0, activeDays: 0, daysInYear, prorated: true };
  }

  // Dzień rozpoczęcia liczy się do działalności, stąd +1.
  const activeDays = Math.round((yearEnd - started) / DAY_MS) + 1;

  return {
    limit: roundToCents((input.limit * activeDays) / daysInYear),
    activeDays,
    daysInYear,
    prorated: true,
  };
}

export function vatLimitState(input: VatLimitInput): VatLimitState {
  const { limit, activeDays, daysInYear, prorated } = proratedLimit(input);

  let used = 0;
  let excluded = 0;
  const exclusions: string[] = [];

  for (const entry of input.sales) {
    // Brak jawnego wyłączenia = wliczamy. Patrz reguła 1.
    if (entry.countsToLimit === false) {
      excluded = roundToCents(excluded + entry.net);
      exclusions.push(
        `${formatPlnPlain(entry.net)} — ${entry.excludedReason ?? 'wyłączone z limitu'}`,
      );
      continue;
    }
    used = roundToCents(used + entry.net);
  }

  const pct = limit > 0 ? (used / limit) * 100 : 100;

  return {
    limit: input.limit,
    effectiveLimit: limit,
    activeDays,
    daysInYear,
    prorated,
    used,
    excluded,
    remaining: Math.max(0, roundToCents(limit - used)),
    pct,
    formula: buildFormula({ input, limit, activeDays, daysInYear, prorated, used }),
    exclusions,
  };
}

function buildFormula(args: {
  input: VatLimitInput;
  limit: number;
  activeDays: number;
  daysInYear: number;
  prorated: boolean;
  used: number;
}): string {
  const base = args.prorated
    ? `${formatPlnPlain(args.input.limit)} × ${args.activeDays}/${args.daysInYear} dni = ${formatPlnPlain(args.limit)}`
    : `${formatPlnPlain(args.limit)} (pełny rok)`;

  return `${base}; wliczone ${formatPlnPlain(args.used)}`;
}

// ═══════════════════════════════════════════════════════════════
// Progi
// ═══════════════════════════════════════════════════════════════

/**
 * Który próg przekroczyła TA faktura.
 *
 * Przeliczenie idzie po każdej wystawionej fakturze, nie w cyklu dobowym:
 * przy jednym przebiegu na dobę klient mógłby wystawić fakturę przekraczającą
 * limit i dowiedzieć się o tym nazajutrz — po wystawieniu trzech kolejnych.
 *
 * Gdy jedna faktura przeskakuje kilka progów naraz, zwracamy NAJWYŻSZY.
 * Trzy karty za jedną fakturę to nie ostrzeżenie, tylko hałas.
 */
export function crossedThreshold(
  pctBefore: number,
  pctAfter: number,
): LimitThreshold | null {
  const levels: LimitThreshold[] = [...THRESHOLDS, EXCEEDED];

  let crossed: LimitThreshold | null = null;
  for (const level of levels) {
    if (pctBefore < level && pctAfter >= level) crossed = level;
  }

  return crossed;
}

// ═══════════════════════════════════════════════════════════════
// Prognoza
// ═══════════════════════════════════════════════════════════════

export interface Forecast {
  /** Kiedy limit zostanie przekroczony przy dotychczasowym tempie; ISO. */
  crossesOn: string | null;
  /** Sprzedaż na dzień działalności. */
  perDay: number;
  /** Ile dni działalności złożyło się na to tempo. */
  countedDays: number;
  /** Czy prognoza wychodzi poza koniec roku (czyli: limitu nie przekroczysz). */
  beyondYear: boolean;
}

/**
 * Prognoza jako SCENARIUSZ „jeśli tempo się utrzyma”.
 *
 * Dni zawieszenia działalności wypadają z mianownika: firma zawieszona przez
 * pół roku nie ma zerowego tempa, tylko nie miała kiedy sprzedawać.
 * Wliczenie tych dni zaniżyłoby tempo i przesunęło ostrzeżenie na po fakcie.
 */
export function forecast(
  input: VatLimitInput,
  state: VatLimitState,
  options: { ignoreLargestSale?: boolean } = {},
): Forecast {
  const counted = countedSales(input, options.ignoreLargestSale === true);
  const countedDays = activeDaysElapsed(input);

  if (countedDays <= 0 || counted <= 0) {
    return { crossesOn: null, perDay: 0, countedDays: Math.max(0, countedDays), beyondYear: true };
  }

  const perDay = counted / countedDays;
  // Prognozę odnosimy do PEŁNEGO licznika, nie do sumy użytej do tempa:
  // pominięcie jednorazowego kontraktu zmienia tempo, ale nie cofa sprzedaży,
  // która już się wydarzyła.
  const daysToLimit = (state.effectiveLimit - state.used) / perDay;

  if (daysToLimit <= 0) {
    return { crossesOn: isoDay(input.today), perDay, countedDays, beyondYear: false };
  }

  const crossing = new Date(input.today.getTime() + Math.ceil(daysToLimit) * DAY_MS);
  const yearEnd = Date.UTC(input.year, 11, 31);

  if (crossing.getTime() > yearEnd) {
    return { crossesOn: null, perDay, countedDays, beyondYear: true };
  }

  return { crossesOn: isoDay(crossing), perDay, countedDays, beyondYear: false };
}

function countedSales(input: VatLimitInput, ignoreLargest: boolean): number {
  const counted = input.sales.filter((entry) => entry.countsToLimit !== false);
  const total = counted.reduce((sum, entry) => sum + entry.net, 0);
  if (!ignoreLargest || counted.length === 0) return roundToCents(total);

  const largest = counted.reduce((max, entry) => Math.max(max, entry.net), 0);
  return roundToCents(total - largest);
}

function activeDaysElapsed(input: VatLimitInput): number {
  const yearStart = Date.UTC(input.year, 0, 1);
  const started = Date.parse(`${input.startedOn}T00:00:00.000Z`);
  const from = Number.isNaN(started) ? yearStart : Math.max(yearStart, started);
  const elapsed = Math.floor((input.today.getTime() - from) / DAY_MS) + 1;

  return elapsed - (input.suspendedDays ?? 0);
}

// ═══════════════════════════════════════════════════════════════
// Propozycja
// ═══════════════════════════════════════════════════════════════

export interface VatLimitProposalInput {
  tenantId: string;
  input: VatLimitInput;
  state: VatLimitState;
  threshold: LimitThreshold;
  forecast: Forecast;
}

export function buildVatLimitProposal(
  args: VatLimitProposalInput,
): CreateProposalInput {
  const { state, threshold, input } = args;
  const exceeded = threshold === EXCEEDED;

  return {
    tenantId: args.tenantId,
    kind: 'tax.limit',
    // Klucz po progu: każdy próg ogłaszamy raz w roku. Bez tego karta
    // wracałaby po każdej fakturze przy 61, 62, 63 procentach.
    topicKey: `tax.limit:${input.year}:${threshold}`,
    title: exceeded
      ? 'Limit zwolnienia z VAT został przekroczony'
      : `Zostało ${formatPln(state.remaining)} do progu VAT`,
    body: exceeded
      ? `Sprzedaż w ${input.year} przekroczyła ${formatPln(state.effectiveLimit)}. Od transakcji, która przekroczyła limit, jesteś podatnikiem VAT — to sprawa na teraz, nie na koniec miesiąca. Pokaż to księgowej.`
      : `Wykorzystane ${Math.floor(state.pct)}% limitu. ${describeForecast(args.forecast)}`,
    fingerprint: fingerprintOf({
      year: input.year,
      threshold,
      used: state.used,
    }),
    // Licznik żyje do końca roku — limit jest roczny.
    expiresAt: new Date(Date.UTC(input.year, 11, 31, 23, 59, 59)),
    // Przekroczenie to sprawa natychmiastowa: na górze wątku, przed
    // wszystkim innym.
    priority: exceeded ? 0 : threshold === 90 ? 12 : 35,
    payload: {
      year: input.year,
      threshold,
      pct: Math.floor(state.pct),
      remaining: state.remaining,
      // Agent nie rejestruje nikogo do VAT-u i nie ma takiego przycisku.
      primaryIntent: 'open',
      primaryLabel: exceeded ? 'Zobacz sprzedaż' : 'Zobacz wyliczenie',
      secondary: exceeded
        ? [{ label: 'Ukryj', intent: 'dismiss' }]
        : [
            // Poprawia FAKT, na którym stoi prognoza — nie odrzuca karty
            // i nie wycisza rodzaju. Patrz `correct` w types/flo.ts.
            { label: 'To był jednorazowy kontrakt', intent: 'correct' },
            { label: 'Ukryj', intent: 'dismiss' },
          ],
      correction: exceeded ? undefined : 'ignore_largest_sale',
    },
    evidence: buildLimitEvidence(state),
  };
}

/**
 * Wzór trafia do dowodów jako ETYKIETA, nie jako osobny ekran.
 *
 * „Dlaczego to widzę” przy liczniku limitu to właśnie wzór: limit, proporcja,
 * dni i to, co zostało wyłączone. Odesłanie po wzór w inne miejsce znaczy,
 * że nikt go nigdy nie zobaczy.
 */
function buildLimitEvidence(state: VatLimitState): FloEvidence[] {
  const evidence: FloEvidence[] = [{ label: state.formula, href: '/invoices' }];

  for (const exclusion of state.exclusions) {
    evidence.push({ label: `Poza limitem: ${exclusion}`, href: '/invoices' });
  }

  return evidence;
}

function describeForecast(f: Forecast): string {
  if (f.beyondYear || !f.crossesOn) {
    return 'Jeśli tempo się utrzyma, w tym roku nie przekroczysz limitu.';
  }
  return `Jeśli tempo się utrzyma, przekroczysz go około ${formatDayMonth(f.crossesOn)}.`;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatDayMonth(iso: string): string {
  const [, month, day] = iso.split('-');
  return `${Number(day)}.${month}`;
}
