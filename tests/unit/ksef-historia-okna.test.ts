import { describe, expect, it } from 'vitest';

import { nextInboxHwm as inboxReexport, INBOX_MAX_WINDOW_MS as inboxWindowReexport } from '@/lib/jobs/runners/inbox-polling';
import { BUDGET_DAY, BUDGET_NIGHT, KSEF_HISTORY_FLOOR, KSEF_HISTORY_WINDOW_MS } from '@/lib/ksef/history-sync/constants';
import { INBOX_MAX_WINDOW_MS, nextInboxHwm } from '@/lib/ksef/hwm';
import {
  applyBackfillPage,
  applyLivePage,
  backfillWindow,
  historyBudget,
  historyFloorFor,
  initialIncomingStream,
  initialOutgoingStream,
  isLiveDue,
  isNight,
  liveWindow,
  lowerHistoryFloor,
  type BackfillState,
} from '@/lib/ksef/history-sync/windows';

/**
 * Okna synchronizacji historii KSeF (decyzja Bartosza 22.10.2026): zaległość
 * wstecz do `history_floor` oknami ≤ 90 dni, stronami `pageOffset`, zawężanie
 * po `isTruncated`, komplet okna tylko z potwierdzeniem KSeF (HWM); bieżąca
 * sprzedaż do przodu jak skrzynka. Bez dziury i zakładki na granicy S.
 */

const DAY = 24 * 60 * 60 * 1000;
const T = new Date('2026-10-22T10:37:42.123Z');
const iso = (ms: number) => new Date(ms).toISOString();
const page = (p: Partial<{ invoices: Array<{ permanentStorageDate: string }>; hasMore: boolean; isTruncated: boolean; hwm: string | null }>) => ({
  invoices: [], hasMore: false, isTruncated: false, hwm: null, ...p,
});

describe('lib/ksef/hwm — przeniesione ze skrzynki bez zmian', () => {
  it('inbox-polling re-eksportuje te same obiekty', () => {
    expect(inboxReexport).toBe(nextInboxHwm);
    expect(inboxWindowReexport).toBe(INBOX_MAX_WINDOW_MS);
    expect(INBOX_MAX_WINDOW_MS).toBe(KSEF_HISTORY_WINDOW_MS);
  });
});

describe('początek historii (floor)', () => {
  it('bez daty rozpoczęcia — 2022-01-01', () => {
    expect(historyFloorFor(null)).toBe(KSEF_HISTORY_FLOOR);
    expect(historyFloorFor('nie-data')).toBe(KSEF_HISTORY_FLOOR);
  });
  it('data rozpoczęcia po 2022 podnosi floor (północ w Warszawie z zapasem na czas letni)', () => {
    expect(historyFloorFor('2024-03-01')).toBe('2024-02-29T22:00:00.000Z');
  });
  it('data rozpoczęcia przed 2022 — nadal 2022-01-01', () => {
    expect(historyFloorFor('2015-06-01')).toBe(KSEF_HISTORY_FLOOR);
  });
});

describe('inicjalizacja strumieni', () => {
  it('sprzedaż: S = pełna minuta (T − 1 h); zaległość [max(F, S − 90 dni), S); bieżące od S', () => {
    const s = initialOutgoingStream(T, KSEF_HISTORY_FLOOR);
    const S = '2026-10-22T09:37:00.000Z';
    expect(s).toMatchObject({
      boundary_at: S, backfill_window_end: S, backfill_cursor: iso(Date.parse(S) - 90 * DAY),
      backfill_page_offset: 0, backfill_completed_at: null, live_hwm: S, live_page_offset: 0,
    });
  });
  it('sprzedaż: floor bliżej niż 90 dni — kursor na floor', () => {
    const s = initialOutgoingStream(T, '2026-09-01T00:00:00.000Z');
    expect(s.backfill_cursor).toBe('2026-09-01T00:00:00.000Z');
  });
  it('sprzedaż: data rozpoczęcia w przyszłości — zaległość od razu zakończona, bieżące od S', () => {
    const s = initialOutgoingStream(T, '2027-01-01T00:00:00.000Z');
    expect(s.backfill_completed_at).toBe(T.toISOString());
    expect(s.live_hwm).toBe('2026-10-22T09:37:00.000Z');
    // CHECK okna: floor ≤ cursor ≤ window_end ≤ boundary
    expect(s.backfill_cursor <= s.backfill_window_end && s.backfill_window_end <= s.boundary_at).toBe(true);
  });
  it('zakupy: granica U = HWM skrzynki; bez kursora bieżącego', () => {
    const U = '2026-10-22T09:00:00.000Z';
    const s = initialIncomingStream(T, KSEF_HISTORY_FLOOR, U);
    expect(s).toMatchObject({ boundary_at: U, backfill_window_end: U, live_hwm: null, backfill_completed_at: null });
    expect(s.backfill_cursor).toBe(iso(Date.parse(U) - 90 * DAY));
  });
  it('zakupy: U ≤ floor — nic do pobrania (zakończone od razu)', () => {
    const s = initialIncomingStream(T, '2026-10-22T10:00:00.000Z', '2026-10-01T00:00:00.000Z');
    expect(s.backfill_completed_at).toBe(T.toISOString());
    expect(backfillWindow(s)).toBeNull();
  });
});

function state(patch: Partial<BackfillState> = {}): BackfillState {
  return {
    history_floor: KSEF_HISTORY_FLOOR,
    boundary_at: '2026-10-01T00:00:00.000Z',
    backfill_window_end: '2026-10-01T00:00:00.000Z',
    backfill_cursor: '2026-07-03T00:00:00.000Z',
    backfill_page_offset: 0,
    backfill_completed_at: null,
    ...patch,
  };
}

describe('zaległość: strony, zawężanie, komplet okna', () => {
  it('kolejna strona (hasMore bez isTruncated) — offset + 1, okno bez zmian', () => {
    const step = applyBackfillPage(state({ backfill_page_offset: 2 }), page({ hasMore: true }), T);
    expect(step).toEqual({ kind: 'advance', next: expect.objectContaining({ backfill_page_offset: 3, backfill_cursor: '2026-07-03T00:00:00.000Z' }) });
  });
  it('isTruncated — kursor od ostatniego rekordu, offset 0', () => {
    const step = applyBackfillPage(state({ backfill_page_offset: 39 }), page({
      hasMore: true, isTruncated: true,
      invoices: [{ permanentStorageDate: '2026-07-10T00:00:00.000Z' }, { permanentStorageDate: '2026-08-15T12:00:00.000Z' }],
    }), T);
    expect(step).toEqual({ kind: 'advance', next: expect.objectContaining({ backfill_cursor: '2026-08-15T12:00:00.000Z', backfill_page_offset: 0 }) });
  });
  it('isTruncated bez postępu (ostatni rekord ≤ kursor) — `internal`, kursor stoi', () => {
    const step = applyBackfillPage(state(), page({
      hasMore: true, isTruncated: true, invoices: [{ permanentStorageDate: '2026-07-03T00:00:00.000Z' }],
    }), T);
    expect(step).toMatchObject({ kind: 'issue', issue: 'internal' });
  });
  it('koniec stron z HWM ≥ koniec okna — następne okno wstecz od pierwotnego początku', () => {
    const step = applyBackfillPage(state({ backfill_cursor: '2026-08-15T12:00:00.000Z' }), page({ hwm: '2026-10-22T09:00:00.000Z' }), T);
    const end = iso(Date.parse('2026-10-01T00:00:00.000Z') - 90 * DAY);
    expect(step).toEqual({ kind: 'advance', next: {
      backfill_window_end: end, backfill_cursor: iso(Date.parse(end) - 90 * DAY), backfill_page_offset: 0, backfill_completed_at: null,
    } });
  });
  it('HWM < koniec okna — `waiting_for_ksef`, kursor stoi (to nie błąd)', () => {
    const step = applyBackfillPage(state(), page({ hwm: '2026-09-30T23:00:00.000Z' }), T);
    expect(step).toMatchObject({ kind: 'issue', issue: 'waiting_for_ksef' });
  });
  it('brak HWM: okno zakończone ponad dobę temu — komplet; świeże okno — czekamy', () => {
    expect(applyBackfillPage(state(), page({ hwm: null }), T).kind).toBe('advance');
    const fresh = state({ boundary_at: iso(T.getTime() - 3600_000), backfill_window_end: iso(T.getTime() - 3600_000) });
    expect(applyBackfillPage(fresh, page({ hwm: null }), T)).toMatchObject({ kind: 'issue', issue: 'waiting_for_ksef' });
  });
  it('schodzi do floor i kończy zaległość', () => {
    let s = state({ boundary_at: '2022-06-01T00:00:00.000Z', backfill_window_end: '2022-06-01T00:00:00.000Z', backfill_cursor: '2022-03-03T00:00:00.000Z' });
    const windows: string[] = [];
    for (let i = 0; i < 10 && !s.backfill_completed_at; i++) {
      windows.push(`${s.backfill_cursor}→${s.backfill_window_end}`);
      const step = applyBackfillPage(s, page({ hwm: '2026-10-22T09:00:00.000Z' }), T);
      if (step.kind !== 'advance') throw new Error('oczekiwano postępu');
      s = { ...s, ...step.next };
    }
    expect(s.backfill_completed_at).toBe(T.toISOString());
    expect(s.backfill_cursor).toBe(KSEF_HISTORY_FLOOR);
    expect(s.backfill_window_end).toBe(KSEF_HISTORY_FLOOR);
    expect(windows).toEqual([
      '2022-03-03T00:00:00.000Z→2022-06-01T00:00:00.000Z',
      '2022-01-01T00:00:00.000Z→2022-03-03T00:00:00.000Z',
    ]);
    expect(backfillWindow(s)).toBeNull();
  });
});

describe('niższy początek historii (klient poprawił datę rozpoczęcia działalności)', () => {
  const OLD = '2025-05-31T22:00:00.000Z';
  const NEW = KSEF_HISTORY_FLOOR;
  const base = (patch: Partial<BackfillState>): BackfillState => ({
    history_floor: OLD, boundary_at: '2026-10-01T00:00:00.000Z', backfill_window_end: '2026-10-01T00:00:00.000Z',
    backfill_cursor: '2026-07-03T00:00:00.000Z', backfill_page_offset: 3, backfill_completed_at: null, ...patch,
  });
  const ordered = (st: BackfillState) => Date.parse(st.history_floor) <= Date.parse(st.backfill_cursor)
    && Date.parse(st.backfill_cursor) <= Date.parse(st.backfill_window_end)
    && Date.parse(st.backfill_window_end) <= Date.parse(st.boundary_at);

  it('zaległość zakończona — otwieramy ją od starego początku w dół (okno ≤ 90 dni), kolejność okna jak CHECK 00155', () => {
    const done = base({ backfill_window_end: OLD, backfill_cursor: OLD, backfill_page_offset: 0, backfill_completed_at: '2026-10-20T00:00:00.000Z' });
    const patch = lowerHistoryFloor(done, NEW)!;
    expect(patch).toEqual({
      history_floor: NEW, backfill_window_end: OLD, backfill_cursor: iso(Date.parse(OLD) - 90 * DAY),
      backfill_page_offset: 0, backfill_completed_at: null, backfill_issue: null, backfill_issue_at: null,
    });
    expect(ordered({ ...done, ...patch })).toBe(true);
    // Dalej zaległość schodzi do nowego początku i kończy się dopiero na nim.
    let st: BackfillState = { ...done, ...patch };
    for (let i = 0; i < 20 && !st.backfill_completed_at; i++) {
      const step = applyBackfillPage(st, page({ hwm: st.backfill_window_end }), T);
      if (step.kind !== 'advance') throw new Error('okno stoi');
      st = { ...st, ...step.next };
      expect(ordered(st)).toBe(true);
    }
    expect(st).toMatchObject({ backfill_cursor: NEW, backfill_window_end: NEW });
  });

  it('zakończona tuż nad nowym początkiem — okno przycięte do nowego początku', () => {
    const near = '2022-02-01T00:00:00.000Z';
    const done = base({ history_floor: near, backfill_window_end: near, backfill_cursor: near, backfill_completed_at: '2026-10-20T00:00:00.000Z' });
    expect(lowerHistoryFloor(done, NEW)).toMatchObject({ backfill_window_end: near, backfill_cursor: NEW });
  });

  it('zaległość w toku, okno nieprzycięte przez stary początek — tylko niższy początek (kursor i strona bez zmian)', () => {
    expect(lowerHistoryFloor(base({}), NEW)).toEqual({ history_floor: NEW });
  });

  it('zaległość w toku, okno przycięte przez stary początek — okno poszerzone od nowa (offset 0), bez dziury pod starym początkiem', () => {
    const clamped = base({ backfill_window_end: '2025-07-01T00:00:00.000Z', backfill_cursor: OLD, backfill_page_offset: 2 });
    const patch = lowerHistoryFloor(clamped, NEW)!;
    expect(patch).toEqual({
      history_floor: NEW, backfill_cursor: iso(Date.parse('2025-07-01T00:00:00.000Z') - 90 * DAY), backfill_page_offset: 0,
    });
    expect(ordered({ ...clamped, ...patch })).toBe(true);
  });

  it('ten sam albo wyższy początek — nic (początku nie podnosimy)', () => {
    expect(lowerHistoryFloor(base({}), OLD)).toBeNull();
    expect(lowerHistoryFloor(base({}), '2026-01-01T00:00:00.000Z')).toBeNull();
  });
});

describe('bieżąca sprzedaż (live)', () => {
  const live = { live_hwm: '2026-10-22T09:37:00.000Z', live_page_offset: 0 };
  it('okno [L, min(teraz, L + 90 dni)]; L ≥ teraz — nic do pytania', () => {
    expect(liveWindow(live, T)).toEqual({ from: live.live_hwm, to: T.toISOString(), pageOffset: 0 });
    expect(liveWindow({ live_hwm: T.toISOString(), live_page_offset: 0 }, T)).toBeNull();
    const old = { live_hwm: '2026-01-01T00:00:00.000Z', live_page_offset: 0 };
    expect(liveWindow(old, T)?.to).toBe(iso(Date.parse(old.live_hwm) + 90 * DAY));
  });
  it('strony, zawężanie i HWM jak skrzynka (`nextInboxHwm`)', () => {
    const w = liveWindow(live, T)!;
    expect(applyLivePage(live, w, page({ hasMore: true }))).toEqual({ kind: 'advance', next: { live_hwm: live.live_hwm, live_page_offset: 1 } });
    expect(applyLivePage(live, w, page({ hasMore: true, isTruncated: true, invoices: [{ permanentStorageDate: '2026-10-22T10:00:00.000Z' }] })))
      .toEqual({ kind: 'advance', next: { live_hwm: '2026-10-22T10:00:00.000Z', live_page_offset: 0 } });
    expect(applyLivePage(live, w, page({ hasMore: true, isTruncated: true, invoices: [{ permanentStorageDate: live.live_hwm }] })))
      .toMatchObject({ kind: 'issue', issue: 'internal' });
    const hwm = '2026-10-22T10:30:00.000Z';
    expect(applyLivePage(live, w, page({ hwm }))).toEqual({ kind: 'advance', next: { live_hwm: nextInboxHwm(hwm, w), live_page_offset: 0 } });
    expect(applyLivePage(live, w, page({ hwm: null }))).toMatchObject({ kind: 'issue', issue: 'waiting_for_ksef' });
  });
  it('granica S: zaległość < S i bieżące od S — bez dziury', () => {
    const s = initialOutgoingStream(T, KSEF_HISTORY_FLOOR);
    expect(backfillWindow(s)?.to).toBe(s.live_hwm);
    expect(liveWindow(s, T)?.from).toBe(s.boundary_at);
  });
  it('dzień co 29 min, noc co 14 min', () => {
    const day = new Date('2026-10-22T10:00:00.000Z'); // 12:00 w Warszawie
    const night = new Date('2026-10-22T21:00:00.000Z'); // 23:00 w Warszawie
    expect(isLiveDue(null, day)).toBe(true);
    expect(isLiveDue(iso(day.getTime() - 20 * 60_000), day)).toBe(false);
    expect(isLiveDue(iso(day.getTime() - 30 * 60_000), day)).toBe(true);
    expect(isLiveDue(iso(night.getTime() - 15 * 60_000), night)).toBe(true);
  });
});

describe('budżet dzień / noc (Europe/Warsaw)', () => {
  it('20:00–06:00 to noc', () => {
    expect(isNight(new Date('2026-10-22T17:59:00.000Z'))).toBe(false); // 19:59
    expect(isNight(new Date('2026-10-22T18:00:00.000Z'))).toBe(true); // 20:00
    expect(isNight(new Date('2026-10-23T03:59:00.000Z'))).toBe(true); // 05:59
    expect(isNight(new Date('2026-10-23T04:00:00.000Z'))).toBe(false); // 06:00
  });
  it('dzień 1 + 5, noc 2 + 10; zwraca kopię (wywołujący może zmniejszyć)', () => {
    expect(historyBudget(new Date('2026-10-22T10:00:00.000Z'))).toEqual(BUDGET_DAY);
    expect(historyBudget(new Date('2026-10-22T22:00:00.000Z'))).toEqual(BUDGET_NIGHT);
    const b = historyBudget(new Date('2026-10-22T10:00:00.000Z'));
    b.downloads = 0;
    expect(BUDGET_DAY.downloads).toBe(5);
  });
});
