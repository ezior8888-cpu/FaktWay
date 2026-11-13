// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({
  startExportAction: vi.fn(),
  downloadExportFileAction: vi.fn(),
}));
const statusActions = vi.hoisted(() => ({ getExportJobStatusesAction: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/app/actions/exports', () => actions);
vi.mock('@/app/actions/job-statuses', () => statusActions);
vi.mock('sonner', () => ({ toast }));

import { RecentExports } from '@/components/exports/export-history';
import type { ManualExportJobWithFiles } from '@/components/exports/export-formats';
import { MissingTaxOfficeError } from '@/lib/exports/tax-office';

/**
 * Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): historia
 * eksportów aktualizuje się sama, dopóki coś się generuje (tylko na
 * widocznej karcie), a po 3 minutach daje ręczne „Odśwież”. Nieudany
 * eksport pokazuje powód i przycisk wyjścia, gotowy — nigdy starego błędu,
 * a gotowy bez pliku to „Pusty”, nie „Gotowe”. Zmianę statusu ogłasza jeden
 * ukryty komunikat z nazwą pliku i okresem (gotowy i nieudany), a nie każda
 * plakietka z osobna.
 *
 * Plan skalowania, sesja 11 (REQ-08, CAC-V01) — świadoma zmiana oczekiwań:
 * takt nie woła już `router.refresh()` (pełny render strony z layoutem
 * i ponowny prefetch linków co 4 s), tylko lekką akcję z samymi statusami
 * eksportów w toku. Strona odświeża się raz, gdy status się zmieni. Odstęp
 * rośnie: 4 s, 6 s, 9 s, 13,5 s, potem co 15 s.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function job(overrides: Partial<ManualExportJobWithFiles> = {}): ManualExportJobWithFiles {
  return {
    id: 'job-1',
    tenant_id: 't',
    format: 'jpk_fa',
    status: 'completed',
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    invoices_count: 12,
    error_message: null,
    progress_message: null,
    include_issued: true,
    include_received: false,
    include_corrections: true,
    trigger_source: 'manual',
    created_at: '2026-10-01T08:00:00Z',
    export_files: [{ id: 'f1', filename: 'jpk.xml', format: 'jpk_fa', size_bytes: 2048, download_count: 0 }],
    ...overrides,
  } as ManualExportJobWithFiles;
}

beforeEach(() => {
  vi.useFakeTimers();
  router.refresh.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  actions.startExportAction.mockReset();
  statusActions.getExportJobStatusesAction.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

function mount(jobs: ManualExportJobWithFiles[]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<RecentExports jobs={jobs} />));
  return host;
}

function rerender(jobs: ManualExportJobWithFiles[]) {
  act(() => root!.render(<RecentExports jobs={jobs} />));
}

/** Ukryty komunikat dla czytników ekranu (`p.sr-only[aria-live]`). */
const liveRegion = (el: HTMLElement) => el.querySelector<HTMLElement>('p.sr-only[aria-live="polite"]');

const buttons = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll<HTMLElement>('button, a')].filter((b) => b.textContent?.trim() === text);

/**
 * Odstępy kolejnych pytań: 4 s, 6 s, 9 s, 13,5 s, potem co 15 s
 * (`pollDelays(STATUS_POLL)` — pilnuje tego `odpytywanie-statusu-petla.test.ts`).
 * Wpisane na sztywno, żeby test był czerwony na kodzie sprzed sesji 11.
 */
const DELAYS = [4000, 6000, 9000, 13_500, 15_000];
const delay = (n: number) => DELAYS[Math.min(n, DELAYS.length - 1)]!;
/** Czas od zamontowania do n-tego pytania (od 1). */
const until = (n: number) => Array.from({ length: n }, (_, i) => delay(i)).reduce((sum, ms) => sum + ms, 0);
/** Tyle pytań mieści 3 minuty odpytywania (13. pytanie po 167,5 s, 14. po 182,5 s). */
const POLLS_IN_3_MIN = 14;

const statuses = (...rows: Array<{ id: string; status: string }>) => ({ success: true as const, statuses: rows });
const flush = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const statusCalls = () => statusActions.getExportJobStatusesAction.mock.calls.length;

describe('Historia — odpytywanie eksportów w toku (lekka akcja statusu)', () => {
  it('pomiar: 3 minuty generowania bez zmiany statusu = 0 × router.refresh(), 14 lekkich pytań', async () => {
    statusActions.getExportJobStatusesAction.mockResolvedValue(statuses({ id: 'job-1', status: 'generating' }));
    mount([job({ status: 'generating', export_files: [] }), job({ id: 'job-2' })]);

    await flush(180_000);
    // Przed sesją 11: 45 × router.refresh() (co 4 s) i 0 lekkich pytań.
    expect(router.refresh).not.toHaveBeenCalled();
    expect(statusCalls()).toBe(POLLS_IN_3_MIN - 1);
    await flush(until(POLLS_IN_3_MIN) - 180_000);
    expect(statusCalls()).toBe(POLLS_IN_3_MIN);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('takt bez zmiany statusu: jedno pytanie o statusy eksportów w toku, bez router.refresh()', async () => {
    statusActions.getExportJobStatusesAction.mockResolvedValue(statuses({ id: 'job-1', status: 'generating' }));
    mount([job({ status: 'generating', export_files: [] }), job({ id: 'job-2' })]);

    await flush(until(1) - 1);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(statusCalls()).toBe(0);
    await flush(1);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(statusCalls()).toBe(1);
    // Tylko eksporty w toku: gotowego `job-2` nie odpytujemy.
    expect(statusActions.getExportJobStatusesAction).toHaveBeenLastCalledWith(['job-1']);
  });

  it('rosnący odstęp: pytania po 4 s, 6 s, 9 s, 13,5 s, potem co 15 s', async () => {
    statusActions.getExportJobStatusesAction.mockResolvedValue(statuses({ id: 'job-1', status: 'pending' }));
    mount([job({ status: 'pending', export_files: [] })]);

    for (let n = 1; n <= 7; n++) {
      await flush(delay(n - 1) - 1);
      expect(statusCalls()).toBe(n - 1);
      await flush(1);
      expect(statusCalls()).toBe(n);
    }
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('zmiana statusu: router.refresh() raz; dane z odświeżonej strony kończą odpytywanie', async () => {
    statusActions.getExportJobStatusesAction
      .mockResolvedValueOnce(statuses({ id: 'job-1', status: 'generating' }))
      .mockResolvedValueOnce(statuses({ id: 'job-1', status: 'completed' }));
    mount([job({ status: 'generating', export_files: [] })]);

    await flush(until(1));
    expect(router.refresh).not.toHaveBeenCalled();
    await flush(delay(1));
    expect(router.refresh).toHaveBeenCalledTimes(1);

    // Odświeżona strona: eksport gotowy, nic już nie trwa.
    rerender([job()]);
    await flush(until(10));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(statusCalls()).toBe(2);
  });

  it('krok w toku (pending → generating): jedno odświeżenie, dalej pytania bez odświeżania', async () => {
    statusActions.getExportJobStatusesAction.mockResolvedValue(statuses({ id: 'job-1', status: 'generating' }));
    mount([job({ status: 'pending', export_files: [] })]);

    await flush(until(1));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    rerender([job({ status: 'generating', export_files: [] })]);
    await flush(until(4) - until(1));
    expect(statusCalls()).toBe(4);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('nieudany odczyt statusu (sieć, błąd bazy) nie odświeża strony i nie kończy odpytywania', async () => {
    statusActions.getExportJobStatusesAction
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce({ success: false, retryable: true })
      .mockResolvedValue(statuses({ id: 'job-1', status: 'generating' }));
    mount([job({ status: 'generating', export_files: [] })]);

    await flush(until(3));
    expect(statusCalls()).toBe(3);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('jedno pytanie naraz: wolna odpowiedź nie nakłada się na następną', async () => {
    let resolve!: (value: unknown) => void;
    statusActions.getExportJobStatusesAction
      .mockReturnValueOnce(
        new Promise((r) => {
          resolve = r;
        }),
      )
      .mockResolvedValue(statuses({ id: 'job-1', status: 'generating' }));
    mount([job({ status: 'generating', export_files: [] })]);

    await flush(until(5));
    expect(statusCalls()).toBe(1);
    await act(async () => {
      resolve(statuses({ id: 'job-1', status: 'generating' }));
    });
    await flush(delay(1));
    expect(statusCalls()).toBe(2);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('po 3 minutach odpytywania stop i ręczne „Odśwież”, które wznawia lekkie odpytywanie', async () => {
    statusActions.getExportJobStatusesAction.mockResolvedValue(statuses({ id: 'job-1', status: 'pending' }));
    const el = mount([job({ status: 'pending', export_files: [] })]);
    expect(buttons(el, 'Odśwież')).toHaveLength(0);

    await flush(until(POLLS_IN_3_MIN));
    expect(statusCalls()).toBe(POLLS_IN_3_MIN);
    await flush(15_000 * 10);
    expect(statusCalls()).toBe(POLLS_IN_3_MIN);
    expect(router.refresh).not.toHaveBeenCalled();

    const refresh = buttons(el, 'Odśwież');
    expect(refresh).toHaveLength(1);
    act(() => refresh[0]!.click());
    // Ręczne „Odśwież” to jedno pełne odświeżenie, potem znów lekkie pytania.
    expect(router.refresh).toHaveBeenCalledTimes(1);
    await flush(until(1));
    expect(statusCalls()).toBe(POLLS_IN_3_MIN + 1);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(buttons(el, 'Odśwież')).toHaveLength(0);
  });

  it('bez eksportów w toku nie odpytuje; koniec generowania zatrzymuje odpytywanie', async () => {
    statusActions.getExportJobStatusesAction.mockResolvedValue(statuses({ id: 'job-1', status: 'generating' }));
    mount([job(), job({ id: 'job-2', status: 'failed', export_files: [] })]);
    await flush(until(5));
    expect(statusCalls()).toBe(0);

    rerender([job({ status: 'generating', export_files: [] })]);
    await flush(until(1));
    expect(statusCalls()).toBe(1);
    rerender([job()]);
    await flush(until(5));
    expect(statusCalls()).toBe(1);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('karta w tle nie odpytuje; po powrocie pyta od razu', async () => {
    let visibility: DocumentVisibilityState = 'hidden';
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    try {
      statusActions.getExportJobStatusesAction.mockResolvedValue(statuses({ id: 'job-1', status: 'generating' }));
      mount([job({ status: 'generating', export_files: [] })]);
      await flush(until(5));
      expect(statusCalls()).toBe(0);
      expect(router.refresh).not.toHaveBeenCalled();

      visibility = 'visible';
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(statusCalls()).toBe(1);
      expect(router.refresh).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('po odmontowaniu nic nie odpytuje', async () => {
    mount([job({ status: 'pending', export_files: [] })]);
    act(() => root!.unmount());
    root = null;
    await flush(until(3));
    expect(statusCalls()).toBe(0);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('odmontowanie w trakcie pytania: spóźniona zmiana statusu nie odświeża strony', async () => {
    let resolve!: (value: unknown) => void;
    statusActions.getExportJobStatusesAction.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    mount([job({ status: 'generating', export_files: [] })]);
    await flush(until(1));
    expect(statusCalls()).toBe(1);

    act(() => root!.unmount());
    root = null;
    await act(async () => {
      resolve(statuses({ id: 'job-1', status: 'completed' }));
    });
    await flush(until(3));
    expect(router.refresh).not.toHaveBeenCalled();
    expect(statusCalls()).toBe(1);
  });
});

describe('Historia — powiadomienia o zmianie statusu', () => {
  it('gotowy plik w trakcie wizyty: „Plik gotowy” z „Pobierz” i komunikat dla czytnika', () => {
    const el = mount([job({ status: 'generating', export_files: [] })]);
    rerender([job()]);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(
      'Plik gotowy',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Pobierz' }) }),
    );
    expect(liveRegion(el)?.textContent).toBe('Plik gotowy: JPK_FA(4), Wrzesień 2026');
  });

  it('nieudany w trakcie wizyty: „Eksport nie powstał” z nazwą pliku i okresem dla czytnika', () => {
    const el = mount([job({ status: 'pending', export_files: [] })]);
    rerender([job({ status: 'failed', error_message: 'x', export_files: [] })]);
    expect(toast.error).toHaveBeenCalledWith('Eksport nie powstał');
    expect(liveRegion(el)?.textContent).toBe('Eksport nie powstał: JPK_FA(4), Wrzesień 2026');
  });

  it('gotowy bez pliku w trakcie wizyty: bez powiadomienia, komunikat „Plik pusty” dla czytnika', () => {
    const el = mount([job({ status: 'generating', export_files: [] })]);
    rerender([job({ export_files: [] })]);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(liveRegion(el)?.textContent).toBe('Plik pusty: JPK_FA(4), Wrzesień 2026');
  });

  it('jedyny region aria-live to komunikat z nazwą pliku — plakietki statusu nie ogłaszają się same', () => {
    // Plakietka w regionie aria-live przy każdym odpytaniu mówiła samo „Generowanie”, „Gotowe”
    // (bez pliku i okresu, przy 20 wierszach nie wiadomo którego) — i to obok komunikatu niżej.
    const el = mount([job({ status: 'pending', export_files: [] }), job({ id: 'job-2' })]);
    rerender([job({ status: 'generating', export_files: [] }), job({ id: 'job-2' })]);
    expect(el.textContent).toContain('Generowanie');
    expect([...el.querySelectorAll('[aria-live]')]).toEqual([liveRegion(el)]);
    expect(liveRegion(el)?.textContent).toBe('');
  });

  it('bez powiadomień o eksportach zakończonych przed otwarciem strony', () => {
    mount([job(), job({ id: 'job-2', status: 'failed', export_files: [] })]);
    rerender([job(), job({ id: 'job-2', status: 'failed', export_files: [] })]);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('Historia — wiersze', () => {
  it('nieudany: powód i przycisk wyjścia, bez „Pobierz”', () => {
    const el = mount([job({ status: 'failed', error_message: new MissingTaxOfficeError().message, export_files: [] })]);
    expect(el.textContent).toContain('Ustaw urząd skarbowy firmy');
    expect(el.textContent).toContain('Błąd');
    const fix = buttons(el, 'Ustaw urząd');
    // Tabela (od lg) i karta (telefon) — ten sam przycisk w obu.
    expect(fix).toHaveLength(2);
    expect(fix[0]!.getAttribute('href')).toBe('/settings/accountant');
    expect(buttons(el, 'Pobierz')).toHaveLength(0);
  });

  it('nieudany z ogólnym błędem: „Ponów” zleca ten sam eksport', async () => {
    actions.startExportAction.mockResolvedValue({ success: true, jobId: 'job-9' });
    const el = mount([
      job({
        format: 'kpir_excel',
        status: 'failed',
        error_message: 'Nie udało się wygenerować pliku. Spróbuj ponownie albo napisz do nas.',
        include_received: false,
        export_files: [],
      }),
    ]);
    const retry = buttons(el, 'Ponów');
    expect(retry.length).toBeGreaterThan(0);
    await act(async () => retry[0]!.click());
    expect(actions.startExportAction).toHaveBeenCalledWith({
      format: 'kpir_excel',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      includeIssued: true,
      // F-058: KPiR zawsze z kosztami, także przy ponowieniu starego zlecenia.
      includeReceived: true,
      includeCorrections: true,
    });
    expect(router.refresh).toHaveBeenCalled();
  });

  it('gotowy z plikiem: „Gotowe”, „Pobierz” z nazwą pliku i okresem, bez starego błędu', () => {
    const el = mount([job({ error_message: 'stary błąd' })]);
    expect(el.textContent).toContain('Gotowe');
    expect(el.textContent).not.toContain('stary błąd');
    const download = buttons(el, 'Pobierz');
    expect(download.length).toBeGreaterThan(0);
    expect(download[0]!.getAttribute('aria-label')).toBe('Pobierz JPK_FA(4), Wrzesień 2026');
    expect(el.textContent).toContain('12 faktur');
  });

  it('gotowy bez pliku: „Pusty” z wyjaśnieniem, bez „Gotowe” i „Pobierz”', () => {
    const el = mount([job({ export_files: [], progress_message: 'Brak faktur w okresie' })]);
    expect(el.textContent).toContain('Pusty');
    expect(el.textContent).toContain('Brak faktur w okresie');
    expect(el.textContent).not.toContain('Gotowe');
    expect(buttons(el, 'Pobierz')).toHaveLength(0);
  });

  it('pobranie nie odświeża strony', async () => {
    actions.downloadExportFileAction.mockResolvedValue({ success: false, error: 'Plik nie znaleziony' });
    const el = mount([job()]);
    await act(async () => buttons(el, 'Pobierz')[0]!.click());
    expect(actions.downloadExportFileAction).toHaveBeenCalledWith('f1');
    expect(toast.error).toHaveBeenCalledWith('Plik nie znaleziony');
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('format spoza enuma (stare dane) nie wywraca listy: „Inny format” z ikoną ogólną', () => {
    const el = mount([job({ format: 'csv' as ManualExportJobWithFiles['format'], export_files: [] })]);
    expect(el.textContent).toContain('Inny format');
    expect(el.textContent).not.toContain('csv');
  });

  it('pusta historia: „Brak eksportów”', () => {
    const el = mount([]);
    expect(el.textContent).toContain('Brak eksportów');
    expect(el.textContent).toContain('Wysyłka do księgowej');
  });
});
