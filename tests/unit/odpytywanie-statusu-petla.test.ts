// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ARCHIVE_POLL,
  OCR_POLL,
  STATUS_POLL,
  nextPollDelay,
  pollDelays,
  startPollLoop,
  type PollSchedule,
} from '@/lib/polling/poll-loop';

/**
 * Plan skalowania, sesja 11 (REQ-08, CAC-V01, CAC-10): wspólna pętla
 * lekkiego odpytywania statusu. Jedno pytanie naraz, rosnący odstęp, tylko
 * na widocznej karcie (powrót na kartę pyta od razu, gdy termin minął),
 * limit liczony z odstępów przed zadanymi pytaniami (czas w tle się nie
 * liczy), błąd pytania nie kończy pętli, `stop()` sprząta timer i nasłuch.
 */

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('Harmonogramy odpytywania', () => {
  it('statusy eksportów i importów: 4 s, 6 s, 9 s, 13,5 s, potem co 15 s; limit 3 minuty', () => {
    expect(pollDelays(STATUS_POLL, 7)).toEqual([4000, 6000, 9000, 13_500, 15_000, 15_000, 15_000]);
    expect(STATUS_POLL.budgetMs).toBe(180_000);
  });

  it('archiwum dokumentów: 15 s, 22,5 s, 33,75 s, 50,625 s, potem co minutę; bez limitu', () => {
    expect(pollDelays(ARCHIVE_POLL, 6)).toEqual([15_000, 22_500, 33_750, 50_625, 60_000, 60_000]);
    expect(ARCHIVE_POLL.budgetMs).toBeNull();
  });

  it('odczyt zdjęcia kosztu (OCR): 2 s, 3 s, 4,5 s, 6,75 s, potem co 10 s', () => {
    expect(pollDelays(OCR_POLL, 6)).toEqual([2000, 3000, 4500, 6750, 10_000, 10_000]);
  });

  it('odstęp rośnie najwyżej do maksimum', () => {
    expect(nextPollDelay(4000, STATUS_POLL)).toBe(6000);
    expect(nextPollDelay(14_000, STATUS_POLL)).toBe(15_000);
    expect(nextPollDelay(15_000, STATUS_POLL)).toBe(15_000);
  });
});

/** Odstępy 1 s, 2 s, 4 s, 4 s…; limit 10 s mija przy czwartym pytaniu (1 + 2 + 4 + 4 = 11 s). */
const SCHEDULE: PollSchedule = { firstMs: 1000, maxMs: 4000, factor: 2, budgetMs: 10_000 };

describe('startPollLoop', () => {
  it('pyta w terminach z harmonogramu; po wyczerpaniu limitu staje i raz zgłasza koniec', async () => {
    const poll = vi.fn().mockResolvedValue(undefined);
    const onBudgetSpent = vi.fn();
    startPollLoop({ schedule: SCHEDULE, poll, onBudgetSpent });

    await vi.advanceTimersByTimeAsync(999);
    expect(poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(onBudgetSpent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4000);
    expect(poll).toHaveBeenCalledTimes(4);
    expect(onBudgetSpent).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(4);
    expect(onBudgetSpent).toHaveBeenCalledOnce();
  });

  it('jedno pytanie naraz: następny termin liczy się od odpowiedzi', async () => {
    let resolve!: () => void;
    const poll = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<void>((r) => {
          resolve = r;
        }),
      )
      .mockResolvedValue(undefined);
    startPollLoop({ schedule: SCHEDULE, poll });

    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(poll).toHaveBeenCalledTimes(1);

    resolve();
    await vi.advanceTimersByTimeAsync(1999);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('błąd pytania (sieć, serwer) nie kończy pętli', async () => {
    const poll = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue(undefined);
    startPollLoop({ schedule: SCHEDULE, poll });

    await vi.advanceTimersByTimeAsync(3000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('karta w tle nie pyta; powrót po terminie pyta od razu, przed terminem czeka resztę', async () => {
    const poll = vi.fn().mockResolvedValue(undefined);
    visibility = 'hidden';
    startPollLoop({ schedule: SCHEDULE, poll });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).not.toHaveBeenCalled();

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);

    // Następne pytanie za 2 s; ukrycie i powrót po 0,5 s czekają pozostałe 1,5 s.
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(500);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(1499);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('czas w tle nie zjada limitu', async () => {
    const poll = vi.fn().mockResolvedValue(undefined);
    const onBudgetSpent = vi.fn();
    startPollLoop({ schedule: SCHEDULE, poll, onBudgetSpent });

    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(onBudgetSpent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(8000);
    expect(poll).toHaveBeenCalledTimes(4);
    expect(onBudgetSpent).toHaveBeenCalledOnce();
  });

  it('stop(): bez kolejnych pytań, także po powrocie na kartę', async () => {
    const poll = vi.fn().mockResolvedValue(undefined);
    const stop = startPollLoop({ schedule: SCHEDULE, poll });

    await vi.advanceTimersByTimeAsync(1000);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    setVisibility('hidden');
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('stop() w trakcie pytania: po odpowiedzi nic się nie planuje ani nie zgłasza', async () => {
    let resolve!: () => void;
    const poll = vi.fn().mockReturnValueOnce(
      new Promise<void>((r) => {
        resolve = r;
      }),
    );
    const onBudgetSpent = vi.fn();
    const stop = startPollLoop({ schedule: { ...SCHEDULE, budgetMs: 1000 }, poll, onBudgetSpent });

    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);
    stop();
    resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(onBudgetSpent).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bez limitu (archiwum) pyta dalej po godzinie', async () => {
    const poll = vi.fn().mockResolvedValue(undefined);
    startPollLoop({ schedule: ARCHIVE_POLL, poll });

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    // 4 pytania do 121,875 s, potem co minutę: 57 do pełnej godziny.
    expect(poll).toHaveBeenCalledTimes(61);
  });
});
