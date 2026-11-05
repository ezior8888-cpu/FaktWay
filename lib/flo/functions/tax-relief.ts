// NIEAKTYWNE (AUD-115): moduł agenta FLO bez importera w kodzie produkcyjnym —
// na produkcji nie działa. Podpięcie = przegląd i zdjęcie znacznika
// (pilnuje tests/unit/flo-nieaktywne.test.ts).

/**
 * T-03 — zegar ulg na starcie (krok 38 planu).
 *
 * ⚠️ FUNKCJA ZA FLAGĄ (`tax.relief`) i za bramką M12. Kwoty składek to dane
 * prawne: od kroku K1 planu księgowości podaje je wywołujący
 * (`ReliefParams.zusMonthly`), a długości ulg są w `lib/flo/tax-params.ts`
 * (`PARAMS_VERIFIED`).
 *
 * CO ROBI: na 60 dni przed końcem ulgi na start albo preferencyjnego ZUS-u
 * mówi, o ile urośnie składka i ile odkładać, żeby ten wzrost nie był
 * zaskoczeniem. To jest jedyny moment w roku, w którym młoda firma może
 * przygotować się na skokowy wzrost kosztu stałego — po fakcie zostaje
 * tylko szukanie pieniędzy.
 *
 * TRZY AWARIE:
 *
 * 1. ZŁA DATA, ZŁY KOMUNIKAT. Cała funkcja stoi na jednej dacie z profilu.
 *    Jeżeli klient wpisał ją źle (albo kreator podstawił datę rejestracji
 *    zamiast rozpoczęcia działalności), agent straszy wzrostem składki
 *    w niewłaściwym miesiącu — a klient nie ma jak tego sprawdzić, bo nie
 *    wie, na czym agent się oparł. Obrona: DATA JEST POKAZYWANA PRZY KAŻDYM
 *    KOMUNIKACIE, razem z odnośnikiem „to nie ta data". Brak pewnej daty =
 *    milczenie, nie oszacowanie.
 *
 * 2. ZAWIESZENIE POLICZONE JAK PRACA. Zawieszenie działalności przerywa bieg
 *    ulgi. Agent liczący po kalendarzu skróciłby ulgę o czas zawieszenia
 *    i zapowiedział wzrost składki, którego w tym miesiącu nie będzie —
 *    klient odłożyłby pieniądze na podstawie nieprawdy i stracił zaufanie
 *    do wszystkich pozostałych liczb agenta.
 *
 * 3. ZŁA WIADOMOŚĆ BEZ KONKRETU. „Od marca składka rośnie czterokrotnie”
 *    bez dalszego ciągu to czysty stres. Żaden komunikat grupy T nie kończy
 *    się na złej wiadomości — zawsze pada konkret „odkładaj po tyle”.
 *    Pilnuje tego osobny test na każdym wariancie komunikatu.
 */

import { fingerprintOf } from '@/lib/flo/fingerprint';
import { formatPln } from '@/lib/flo/money';
import type { CreateProposalInput } from '@/lib/flo/proposals';
import type { TaxParams } from '@/lib/flo/tax-params';

/**
 * Składki miesięczne na trzech etapach. Atrapy 400/700/1600 zł zniknęły
 * z tabeli parametrów w kroku K1 planu księgowości (D7): kwoty podaje
 * wywołujący, docelowo z modułu `lib/ksiegowosc` po sprawdzeniu przez
 * księgową. Funkcja jest nieaktywna, więc dziś wywołującego nie ma.
 */
export interface ReliefMonthlyContributions {
  startRelief: number;
  preferential: number;
  standard: number;
}

export type ReliefParams = Pick<TaxParams, 'reliefStartMonths' | 'reliefPreferentialMonths'> & {
  zusMonthly: ReliefMonthlyContributions;
};

const DAY_MS = 86_400_000;

/** Ile dni przed końcem ulgi agent się odzywa. */
export const NOTICE_BEFORE_DAYS = 60;

export type ReliefKind = 'start' | 'preferential';

export interface ReliefProfileInput {
  /** Data rozpoczęcia działalności z profilu podatkowego, ISO. */
  startedOn: string | null;
  /**
   * Czy klient korzysta z ulgi na start. `null` = nie wiemy.
   *
   * Nie każdy ma do niej prawo (decyduje m.in. praca dla byłego pracodawcy
   * i przerwa w prowadzeniu działalności), a agent tego nie rozstrzyga.
   * Bez deklaracji człowieka funkcja milczy.
   */
  usesStartRelief: boolean | null;
  /** Łączna liczba dni zawieszenia działalności od jej rozpoczęcia. */
  suspendedDays?: number;
}

export interface ReliefWindow {
  kind: ReliefKind;
  /** ISO YYYY-MM-DD */
  startsOn: string;
  /** Pierwszy dzień, w którym obowiązuje już wyższa składka. */
  endsOn: string;
  /** O ile dni zawieszenie przesunęło koniec. */
  shiftedByDays: number;
  /** Składka w tym okresie. */
  monthly: number;
  /** Składka po zakończeniu okresu. */
  nextMonthly: number;
}

/**
 * Oś czasu ulg — funkcja czysta.
 *
 * Ulga na start biegnie od rozpoczęcia działalności, preferencyjny ZUS
 * zaraz po niej (albo od razu od startu, jeżeli klient z ulgi na start
 * nie korzysta). Dni zawieszenia przesuwają OBA końce: zawieszenie nie
 * konsumuje ulgi.
 */
export function reliefWindows(
  profile: ReliefProfileInput,
  params: ReliefParams,
): ReliefWindow[] {
  if (!profile.startedOn) return [];
  const started = Date.parse(`${profile.startedOn}T00:00:00.000Z`);
  if (Number.isNaN(started)) return [];
  if (profile.usesStartRelief === null) return [];

  const suspended = Math.max(0, profile.suspendedDays ?? 0);
  const windows: ReliefWindow[] = [];

  let cursor = new Date(started);

  if (profile.usesStartRelief) {
    const end = shiftDays(addMonths(cursor, params.reliefStartMonths), suspended);
    windows.push({
      kind: 'start',
      startsOn: iso(cursor),
      endsOn: iso(end),
      shiftedByDays: suspended,
      monthly: params.zusMonthly.startRelief,
      nextMonthly: params.zusMonthly.preferential,
    });
    cursor = end;
  }

  const preferentialEnd = shiftDays(
    addMonths(cursor, params.reliefPreferentialMonths),
    // Zawieszenie doliczamy raz — do końca całego ciągu ulg, nie do każdej
    // z osobna. Inaczej pół roku przerwy wydłużałoby ulgi o rok.
    profile.usesStartRelief ? 0 : suspended,
  );

  windows.push({
    kind: 'preferential',
    startsOn: iso(cursor),
    endsOn: iso(preferentialEnd),
    shiftedByDays: profile.usesStartRelief ? 0 : suspended,
    monthly: params.zusMonthly.preferential,
    nextMonthly: params.zusMonthly.standard,
  });

  return windows;
}

export type ReliefSilentReason =
  /** Brak daty rozpoczęcia działalności. */
  | 'no_start_date'
  /** Klient nie zadeklarował, czy korzysta z ulgi na start. */
  | 'relief_unknown'
  /** Do końca ulgi jeszcze daleko. */
  | 'too_early'
  /** Wszystkie ulgi już się skończyły. */
  | 'no_relief_left';

export type ReliefVerdict =
  | { kind: 'silent'; reason: ReliefSilentReason }
  | { kind: 'notice'; window: ReliefWindow; daysLeft: number; increase: number };

export function decideReliefNotice(input: {
  profile: ReliefProfileInput;
  params: ReliefParams;
  today: Date;
}): ReliefVerdict {
  if (!input.profile.startedOn) return { kind: 'silent', reason: 'no_start_date' };
  if (input.profile.usesStartRelief === null) {
    return { kind: 'silent', reason: 'relief_unknown' };
  }

  const windows = reliefWindows(input.profile, input.params);
  if (windows.length === 0) return { kind: 'silent', reason: 'no_start_date' };

  const now = input.today.getTime();
  const upcoming = windows
    .filter((window) => Date.parse(`${window.endsOn}T00:00:00.000Z`) > now)
    .sort((a, b) => a.endsOn.localeCompare(b.endsOn))[0];

  if (!upcoming) return { kind: 'silent', reason: 'no_relief_left' };

  const daysLeft = Math.ceil(
    (Date.parse(`${upcoming.endsOn}T00:00:00.000Z`) - now) / DAY_MS,
  );
  if (daysLeft > NOTICE_BEFORE_DAYS) return { kind: 'silent', reason: 'too_early' };

  return {
    kind: 'notice',
    window: upcoming,
    daysLeft,
    increase: Math.max(0, upcoming.nextMonthly - upcoming.monthly),
  };
}

// ═══════════════════════════════════════════════════════════════
// Propozycja
// ═══════════════════════════════════════════════════════════════

const RELIEF_NAME: Record<ReliefKind, string> = {
  start: 'ulga na start',
  preferential: 'preferencyjny ZUS',
};

export function buildReliefProposal(input: {
  tenantId: string;
  profile: ReliefProfileInput;
  params: ReliefParams;
  today: Date;
}): CreateProposalInput | null {
  const verdict = decideReliefNotice(input);
  if (verdict.kind !== 'notice') return null;

  const { window, increase } = verdict;

  return {
    tenantId: input.tenantId,
    kind: 'tax.relief',
    // Jeden koniec ulgi = jedna karta w życiu konta.
    topicKey: `tax.relief:${window.kind}:${window.endsOn}`,
    title: `Od ${formatDayMonth(window.endsOn)} składka rośnie`,
    body:
      `Kończy się ${RELIEF_NAME[window.kind]}. Składka rośnie z ` +
      `${formatPln(window.monthly)} do około ${formatPln(window.nextMonthly)}. ` +
      // KONKRET, BEZ KTÓREGO TEN KOMUNIKAT JEST SAMYM STRESEM.
      `Odkładaj po ${formatPln(increase)} miesięcznie od teraz, a różnicę ` +
      `będziesz miał odłożoną, zanim przyjdzie pierwszy wyższy przelew.` +
      describeShift(window),
    fingerprint: fingerprintOf({
      kind: window.kind,
      endsOn: window.endsOn,
      increase,
    }),
    // Karta ma sens do dnia, w którym wyższa składka zaczyna obowiązywać.
    expiresAt: new Date(Date.parse(`${window.endsOn}T23:59:59.000Z`)),
    priority: 30,
    payload: {
      reliefKind: window.kind,
      endsOn: window.endsOn,
      monthlySetAside: increase,
      // Agent niczego tu nie wykonuje — nie zmienia nikomu składek w ZUS-ie.
      primaryIntent: 'open',
      primaryLabel: 'Zobacz wyliczenie',
    },
    evidence: buildReliefEvidence(input.profile, window),
  };
}

/**
 * Data, na której stoi cała funkcja — POKAZANA, nie schowana.
 *
 * Razem z odnośnikiem „to nie ta data”. Bez tego klient nie ma jak sprawdzić,
 * czy agent liczy od właściwego dnia, a wpisana kiedyś przez pomyłkę data
 * rejestracji zamiast rozpoczęcia działalności przesuwa cały komunikat
 * o kilka tygodni.
 */
function buildReliefEvidence(profile: ReliefProfileInput, window: ReliefWindow) {
  const evidence = [
    {
      label: `Działalność od ${formatFullDate(profile.startedOn!)} — to nie ta data?`,
      href: '/settings/flo#profil-podatkowy',
    },
    {
      label: `${capitalize(RELIEF_NAME[window.kind])}: ${formatFullDate(window.startsOn)} – ${formatFullDate(window.endsOn)}`,
      href: '/settings/flo#profil-podatkowy',
    },
  ];

  if (window.shiftedByDays > 0) {
    evidence.push({
      label: `Zawieszenie przesunęło koniec o ${window.shiftedByDays} dni`,
      href: '/settings/flo#profil-podatkowy',
    });
  }

  return evidence;
}

function describeShift(window: ReliefWindow): string {
  if (window.shiftedByDays === 0) return '';
  return ` Zawieszenie działalności przesunęło ten termin o ${window.shiftedByDays} dni — ulga nie biegnie, kiedy firma stoi.`;
}

// ═══════════════════════════════════════════════════════════════
// Kalendarz
// ═══════════════════════════════════════════════════════════════

/**
 * Dodanie miesięcy z zachowaniem końca miesiąca.
 *
 * 31 sierpnia + 6 miesięcy to 28 lutego, a nie 3 marca. Bez tego zabezpieczenia
 * `Date.UTC` przewija na kolejny miesiąc i termin ucieka o kilka dni —
 * niewiele, ale wystarczy, żeby komunikat wypadł po pierwszym wyższym przelewie.
 */
function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const day = date.getUTCDate();

  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)));
}

function shiftDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatDayMonth(isoDate: string): string {
  const [, month, day] = isoDate.split('-');
  return `${Number(day)}.${month}`;
}

function formatFullDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${Number(day)}.${month}.${year}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
