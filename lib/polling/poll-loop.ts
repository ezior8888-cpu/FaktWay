/**
 * Lekkie odpytywanie statusu z rosnącym odstępem (plan skalowania 3000,
 * sesja 11; REQ-08, CAC-V01, CAC-10).
 *
 * Po co: historia eksportów i importów odświeżała całą stronę
 * (`router.refresh()`) co 4 s, a archiwum dokumentów co 15 s. Każde takie
 * odświeżenie to pełny render strony na serwerze: bramka logowania, layout
 * (użytkownik, członkostwa), zapytania strony i ponowny prefetch linków.
 * Teraz przeglądarka pyta lekką akcją o same statusy (`app/actions/job-statuses.ts`)
 * i odświeża stronę raz, gdy status się zmieni (`hooks/use-status-poll.ts`).
 *
 * Zasady pętli `startPollLoop`:
 * - jedno pytanie naraz: następny termin liczy się od odpowiedzi;
 * - odstęp rośnie ×`factor`, najwyżej do `maxMs`;
 * - karta w tle nie pyta; powrót na kartę pyta od razu, gdy termin minął,
 *   a przed terminem czeka resztę;
 * - limit `budgetMs` to suma odstępów przed zadanymi pytaniami, więc czas
 *   w tle go nie zjada; po limicie pętla staje i woła `onBudgetSpent`;
 * - błąd pytania (sieć, serwer) nie kończy pętli: pytamy w następnym terminie.
 */

export type PollSchedule = {
  /** Odstęp przed pierwszym pytaniem (ms). */
  readonly firstMs: number;
  /** Najdłuższy odstęp (ms). */
  readonly maxMs: number;
  /** Mnożnik kolejnego odstępu. */
  readonly factor: number;
  /** Limit odpytywania (ms) z sumy odstępów przed zadanymi pytaniami; `null` = bez limitu. */
  readonly budgetMs: number | null;
};

/**
 * Historia eksportów i importów: 4 s, 6 s, 9 s, 13,5 s, potem co 15 s przez
 * 3 minuty (14 pytań), potem ręczne „Odśwież”. Dawniej 45 odświeżeń strony
 * co 4 s w tym samym czasie.
 */
export const STATUS_POLL: PollSchedule = { firstMs: 4000, maxMs: 15_000, factor: 1.5, budgetMs: 180_000 };

/**
 * Archiwum dokumentów w ustawieniach firmy: 15 s (jak dawniej), 22,5 s,
 * 33,75 s, 50,6 s, potem co minutę, bez limitu. Paczka powstaje minutami,
 * a formularz nie ma przycisku „Odśwież” (dołożenie go zmieniałoby wygląd).
 */
export const ARCHIVE_POLL: PollSchedule = { firstMs: 15_000, maxMs: 60_000, factor: 1.5, budgetMs: null };

/**
 * Odczyt zdjęcia kosztu (OCR): po pytaniu od razu takty po 2 s, 3 s, 4,5 s,
 * 6,75 s i co 10 s. Pytanie od razu i limit 60 s trzyma
 * `components/expenses/use-expense-capture.tsx` (własny zegar: czeka też na
 * karcie w tle, patrz tam), więc `budgetMs` tu nie gra roli.
 */
export const OCR_POLL: PollSchedule = { firstMs: 2000, maxMs: 10_000, factor: 1.5, budgetMs: null };

/** Kolejny odstęp: poprzedni × `factor`, najwyżej `maxMs`, w pełnych milisekundach. */
export function nextPollDelay(delayMs: number, schedule: PollSchedule): number {
  return Math.min(schedule.maxMs, Math.round(delayMs * schedule.factor));
}

/** Pierwsze `count` odstępów harmonogramu. */
export function pollDelays(schedule: PollSchedule, count: number): number[] {
  const delays: number[] = [];
  let delay = schedule.firstMs;
  for (let i = 0; i < count; i++) {
    delays.push(delay);
    delay = nextPollDelay(delay, schedule);
  }
  return delays;
}

export type PollLoopOptions = {
  schedule: PollSchedule;
  /** Jedno pytanie. Pętla czeka na jego koniec; odrzucenie znaczy „pytaj dalej”. */
  poll: () => Promise<void>;
  /** Wołane raz, gdy minie limit `budgetMs` (pętla już wtedy stoi). */
  onBudgetSpent?: () => void;
};

/** Uruchamia pętlę w przeglądarce. Zwraca `stop()`, które kasuje timer i nasłuch widoczności. */
export function startPollLoop({ schedule, poll, onBudgetSpent }: PollLoopOptions): () => void {
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = schedule.firstMs;
  let dueAt = Date.now() + delay;
  let spentMs = 0;

  const visible = () => document.visibilityState === 'visible';

  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function stop() {
    stopped = true;
    clearTimer();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  function arm() {
    clearTimer();
    timer = setTimeout(
      () => {
        timer = undefined;
        void fire();
      },
      Math.max(0, dueAt - Date.now()),
    );
  }

  async function fire() {
    // Karta w tle: termin czeka na powrót (`onVisibilityChange`).
    if (stopped || inFlight || !visible()) return;
    inFlight = true;
    spentMs += delay;
    try {
      await poll();
    } catch {
      // Sieć albo serwer: stan nieznany, pytamy w następnym terminie.
    }
    inFlight = false;
    if (stopped) return;
    if (schedule.budgetMs !== null && spentMs >= schedule.budgetMs) {
      stop();
      onBudgetSpent?.();
      return;
    }
    delay = nextPollDelay(delay, schedule);
    dueAt = Date.now() + delay;
    arm();
  }

  function onVisibilityChange() {
    if (stopped || inFlight || !visible()) return;
    if (dueAt <= Date.now()) {
      clearTimer();
      void fire();
    } else {
      arm();
    }
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  arm();
  return stop;
}
