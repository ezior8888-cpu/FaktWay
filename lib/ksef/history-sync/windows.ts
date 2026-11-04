/**
 * Okna zapytań synchronizacji historii KSeF (decyzja Bartosza 22.10.2026) —
 * czysty moduł: bez bazy, KSeF i zegara (chwila `now` z argumentu).
 *
 * Dwa kursory na strumień:
 *   - ZALEGŁOŚĆ (backfill) idzie od najnowszych danych WSTECZ oknami ≤ 90 dni
 *     `[backfill_cursor, backfill_window_end)`, stronami `pageOffset`, aż do
 *     `history_floor`. Okno uznajemy za kompletne dopiero, gdy KSeF potwierdzi
 *     komplet (`permanentStorageHwmDate ≥ koniec okna`) albo nie poda HWM dla
 *     okna, które skończyło się ponad dobę temu. `isTruncated` (10 000 rekordów)
 *     zawęża okno od daty ostatniego rekordu — model `lib/ksef/inbox.ts`.
 *   - BIEŻĄCE (live, tylko sprzedaż) idzie do przodu od `live_hwm`, jak Skrzynka
 *     KSeF (`nextInboxHwm`). Brak HWM = kursor stoi.
 *
 * Granica S (sprzedaż) / U (zakupy) dzieli zaległość (< granicy) od bieżących
 * (≥ granicy) bez dziury. Zakładka na samej granicy jest nieszkodliwa:
 * dziennik ma unikalny klucz (firma, środowisko, kierunek, numer KSeF).
 *
 * Kursory przesuwa wywołujący dopiero PO zapisie strony w dzienniku, CAS-em
 * na poprzednich wartościach (`db.ts`) — tu tylko arytmetyka.
 */

import { nextInboxHwm } from '@/lib/ksef/hwm';

import {
  BOUNDARY_LAG_MS,
  BUDGET_DAY,
  BUDGET_NIGHT,
  KSEF_HISTORY_FLOOR,
  KSEF_HISTORY_WINDOW_MS,
  LIVE_INTERVAL_DAY_MS,
  LIVE_INTERVAL_NIGHT_MS,
  NIGHT_END_HOUR,
  NIGHT_START_HOUR,
  type HistoryBudget,
} from './constants';

export type HistoryDirection = 'outgoing' | 'incoming';

/** Kolumny kursora zaległości (`ksef_history_sync`). */
export type BackfillCursor = {
  backfill_window_end: string;
  backfill_cursor: string;
  backfill_page_offset: number;
  backfill_completed_at: string | null;
};

export type BackfillState = BackfillCursor & {
  history_floor: string;
  boundary_at: string;
};

/** Kolumny kursora bieżącego (tylko sprzedaż). */
export type LiveCursor = {
  live_hwm: string | null;
  live_page_offset: number;
};

/** Wartości startowe nowego strumienia (INSERT … ON CONFLICT DO NOTHING). */
export type InitialStream = BackfillState & LiveCursor;

/** Strona odpowiedzi KSeF w zakresie, którego potrzebują okna. */
export interface MetadataPageShape {
  invoices: ReadonlyArray<{ permanentStorageDate?: string | null }>;
  hasMore: boolean;
  isTruncated: boolean;
  hwm: string | null;
}

export interface QueryWindow {
  from: string;
  to: string;
  pageOffset: number;
}

export type CursorStep<T> =
  | { kind: 'advance'; next: T }
  | { kind: 'issue'; issue: 'waiting_for_ksef' | 'internal'; detail: string };

const DAY_MS = 24 * 60 * 60 * 1000;
/** Północ w Warszawie to 22:00 albo 23:00 UTC dnia poprzedniego — bierzemy 22:00 UTC. */
const WARSAW_MIDNIGHT_MARGIN_MS = 2 * 60 * 60 * 1000;

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (value: string) => Date.parse(value);

function truncMinute(at: number): number {
  return Math.floor(at / 60_000) * 60_000;
}

/**
 * Najstarsza chwila, której szukamy: max(2022-01-01, data rozpoczęcia
 * działalności). Data rozpoczęcia to dzień w Polsce — granica o północy
 * w Warszawie (z zapasem na czas letni), nie o północy UTC.
 */
export function historyFloorFor(businessStartedOn: string | null | undefined): string {
  const base = ms(KSEF_HISTORY_FLOOR);
  if (!businessStartedOn || !/^\d{4}-\d{2}-\d{2}$/.test(businessStartedOn)) return KSEF_HISTORY_FLOOR;
  const started = ms(`${businessStartedOn}T00:00:00.000Z`);
  if (!Number.isFinite(started)) return KSEF_HISTORY_FLOOR;
  return iso(Math.max(base, started - WARSAW_MIDNIGHT_MARGIN_MS));
}

function completedAt(floor: string, now: Date): BackfillState {
  return {
    history_floor: floor,
    boundary_at: floor,
    backfill_window_end: floor,
    backfill_cursor: floor,
    backfill_page_offset: 0,
    backfill_completed_at: now.toISOString(),
  };
}

/**
 * Sprzedaż zakładana w chwili T: S = pełna minuta (T − 1 h). Zaległość szuka
 * < S, bieżące od S. Granica przed `floor` (data rozpoczęcia w przyszłości) =
 * zaległość od razu zakończona, bieżące i tak od S.
 */
export function initialOutgoingStream(now: Date, floor: string): InitialStream {
  const s = truncMinute(now.getTime() - BOUNDARY_LAG_MS);
  const f = ms(floor);
  const live = { live_hwm: iso(s), live_page_offset: 0 };
  if (s <= f) return { ...completedAt(floor, now), ...live };
  return {
    history_floor: floor,
    boundary_at: iso(s),
    backfill_window_end: iso(s),
    backfill_cursor: iso(Math.max(f, s - KSEF_HISTORY_WINDOW_MS)),
    backfill_page_offset: 0,
    backfill_completed_at: null,
    ...live,
  };
}

/**
 * Zakupy: granica U = HWM Skrzynki KSeF przy założeniu strumienia. Skrzynka
 * zapisała każdą fakturę od swojego startu (≤ U), więc zaległość < U nie
 * zapisze bieżącego zakupu bez kosztu. U ≤ floor = nic do pobrania.
 */
export function initialIncomingStream(now: Date, floor: string, inboxHwm: string): InitialStream {
  const u = ms(inboxHwm);
  const f = ms(floor);
  const live = { live_hwm: null, live_page_offset: 0 };
  if (!Number.isFinite(u) || u <= f) return { ...completedAt(floor, now), ...live };
  return {
    history_floor: floor,
    boundary_at: iso(u),
    backfill_window_end: iso(u),
    backfill_cursor: iso(Math.max(f, u - KSEF_HISTORY_WINDOW_MS)),
    backfill_page_offset: 0,
    backfill_completed_at: null,
    ...live,
  };
}

/** Zmiana strumienia przy niższym początku historii. */
export type HistoryFloorPatch = { history_floor: string } & Partial<BackfillCursor> & {
  backfill_issue?: null;
  backfill_issue_at?: null;
};

/**
 * Niższy początek historii: właściciel poprawił datę rozpoczęcia działalności
 * na wcześniejszą (poprawka po przeglądzie, decyzja Bartosza 22.10.2026).
 * Strumień ma początek zamrożony przy założeniu — bez tej zmiany zaległość
 * kończyłaby się na starej dacie, a ekran mówiłby „cała historia pobrana”.
 * Początku NIE podnosimy (to, co już pobrane, zostaje).
 *
 *   - zaległość zakończona: otwieramy ją od starego początku (do niego KSeF
 *     jest przeszukany) w dół, oknem ≤ 90 dni;
 *   - zaległość w toku, okno nieprzycięte przez stary początek: tylko niższy
 *     początek — kursor i strona bez zmian;
 *   - zaległość w toku, okno przycięte przez stary początek: okno szukamy od
 *     nowa szerzej (offset 0). Jego „pierwotny początek” max(F, E − 90 dni)
 *     zmienia się razem z F — bez poszerzenia po zakończeniu okna zostałaby
 *     dziura [E − 90 dni, stary F). Ponownie znalezione faktury trafiają
 *     w klucz tożsamości dziennika.
 *
 * Wynik spełnia CHECK 00155 (`history_floor ≤ kursor ≤ koniec okna ≤ granica`).
 * Wywołuje przebieg firmy POD DZIERŻAWĄ (bez wyścigu z odkrywaniem), CAS-em
 * na kursorze. `null` = nic do zmiany.
 */
export function lowerHistoryFloor(state: BackfillState, floor: string): HistoryFloorPatch | null {
  const oldFloor = ms(state.history_floor);
  const target = ms(floor);
  if (!Number.isFinite(oldFloor) || !Number.isFinite(target) || !(target < oldFloor)) return null;
  if (state.backfill_completed_at) {
    // Zakończona zaległość przeszukała KSeF do starego początku (przy zakończeniu
    // `backfill_window_end` = `history_floor`) — dalej od niego w dół.
    return {
      history_floor: iso(target),
      backfill_window_end: iso(oldFloor),
      backfill_cursor: iso(Math.max(target, oldFloor - KSEF_HISTORY_WINDOW_MS)),
      backfill_page_offset: 0,
      backfill_completed_at: null,
      backfill_issue: null,
      backfill_issue_at: null,
    };
  }
  const end = ms(state.backfill_window_end);
  if (end - KSEF_HISTORY_WINDOW_MS < oldFloor) {
    return {
      history_floor: iso(target),
      backfill_cursor: iso(Math.max(target, end - KSEF_HISTORY_WINDOW_MS)),
      backfill_page_offset: 0,
    };
  }
  return { history_floor: iso(target) };
}

/** Następne zapytanie zaległości albo `null`, gdy zakończona. */
export function backfillWindow(state: BackfillState): QueryWindow | null {
  if (state.backfill_completed_at) return null;
  return {
    from: state.backfill_cursor,
    to: state.backfill_window_end,
    pageOffset: state.backfill_page_offset,
  };
}

/**
 * Kursor zaległości po zapisanej stronie. `issue` = kursor stoi (KSeF jeszcze
 * nie potwierdził kompletu albo okna nie da się zawęzić).
 */
export function applyBackfillPage(
  state: BackfillState,
  page: MetadataPageShape,
  now: Date,
): CursorStep<BackfillCursor> {
  const floor = ms(state.history_floor);
  const cursor = ms(state.backfill_cursor);
  const end = ms(state.backfill_window_end);

  if (!page.hasMore) {
    const hwm = page.hwm ? ms(page.hwm) : Number.NaN;
    const confirmed = Number.isFinite(hwm)
      ? hwm >= end
      : end <= now.getTime() - DAY_MS;
    if (!confirmed) {
      return {
        kind: 'issue',
        issue: 'waiting_for_ksef',
        detail: page.hwm ? `HWM KSeF ${page.hwm} przed końcem okna` : 'KSeF nie podał HWM dla świeżego okna',
      };
    }
    // Okno kompletne — następne wstecz od pierwotnego początku tego okna.
    const nextEnd = Math.max(floor, end - KSEF_HISTORY_WINDOW_MS);
    if (nextEnd <= floor) {
      return {
        kind: 'advance',
        next: {
          backfill_window_end: state.history_floor,
          backfill_cursor: state.history_floor,
          backfill_page_offset: 0,
          backfill_completed_at: now.toISOString(),
        },
      };
    }
    return {
      kind: 'advance',
      next: {
        backfill_window_end: iso(nextEnd),
        backfill_cursor: iso(Math.max(floor, nextEnd - KSEF_HISTORY_WINDOW_MS)),
        backfill_page_offset: 0,
        backfill_completed_at: null,
      },
    };
  }

  if (page.isTruncated) {
    const last = page.invoices[page.invoices.length - 1]?.permanentStorageDate;
    const lastMs = last ? ms(last) : Number.NaN;
    if (!Number.isFinite(lastMs) || lastMs <= cursor) {
      return { kind: 'issue', issue: 'internal', detail: 'okno nie do zawężenia (isTruncated bez postępu)' };
    }
    return {
      kind: 'advance',
      next: {
        backfill_window_end: state.backfill_window_end,
        backfill_cursor: iso(Math.min(lastMs, end)),
        backfill_page_offset: 0,
        backfill_completed_at: null,
      },
    };
  }

  return {
    kind: 'advance',
    next: {
      backfill_window_end: state.backfill_window_end,
      backfill_cursor: state.backfill_cursor,
      backfill_page_offset: state.backfill_page_offset + 1,
      backfill_completed_at: null,
    },
  };
}

/** Okno bieżące `[L, min(now, L + 90 dni)]` albo `null`, gdy nie ma czego pytać. */
export function liveWindow(state: LiveCursor, now: Date): QueryWindow | null {
  if (!state.live_hwm) return null;
  const from = ms(state.live_hwm);
  if (!Number.isFinite(from) || from >= now.getTime()) return null;
  return {
    from: state.live_hwm,
    to: iso(Math.min(now.getTime(), from + KSEF_HISTORY_WINDOW_MS)),
    pageOffset: state.live_page_offset,
  };
}

/** Kursor bieżący po zapisanej stronie (przy braku HWM stoi — jak skrzynka). */
export function applyLivePage(
  state: LiveCursor,
  window: QueryWindow,
  page: MetadataPageShape,
): CursorStep<{ live_hwm: string; live_page_offset: number }> {
  const from = ms(window.from);
  if (!page.hasMore) {
    if (!page.hwm) {
      return { kind: 'issue', issue: 'waiting_for_ksef', detail: 'KSeF nie podał HWM — kursor bieżący stoi' };
    }
    return { kind: 'advance', next: { live_hwm: nextInboxHwm(page.hwm, window), live_page_offset: 0 } };
  }
  if (page.isTruncated) {
    const last = page.invoices[page.invoices.length - 1]?.permanentStorageDate;
    const lastMs = last ? ms(last) : Number.NaN;
    if (!Number.isFinite(lastMs) || lastMs <= from) {
      return { kind: 'issue', issue: 'internal', detail: 'okno bieżące nie do zawężenia (isTruncated bez postępu)' };
    }
    return { kind: 'advance', next: { live_hwm: iso(lastMs), live_page_offset: 0 } };
  }
  return {
    kind: 'advance',
    next: { live_hwm: state.live_hwm ?? window.from, live_page_offset: state.live_page_offset + 1 },
  };
}

/** Godzina w Polsce (0–23). */
function warsawHour(now: Date): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  return Number(hour);
}

/** Noc: 20:00–06:00 Europe/Warsaw. */
export function isNight(now: Date): boolean {
  const hour = warsawHour(now);
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

export function historyBudget(now: Date): HistoryBudget {
  return isNight(now) ? { ...BUDGET_NIGHT } : { ...BUDGET_DAY };
}

/** Czy kursor bieżący ma dziś pytać (dzień co 29 min, noc co 14 min). */
export function isLiveDue(liveCheckedAt: string | null, now: Date): boolean {
  if (!liveCheckedAt) return true;
  const checked = ms(liveCheckedAt);
  if (!Number.isFinite(checked)) return true;
  const interval = isNight(now) ? LIVE_INTERVAL_NIGHT_MS : LIVE_INTERVAL_DAY_MS;
  return now.getTime() - checked >= interval;
}
