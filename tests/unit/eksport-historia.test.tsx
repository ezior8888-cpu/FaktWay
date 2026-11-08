// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({
  startExportAction: vi.fn(),
  downloadExportFileAction: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/app/actions/exports', () => actions);
vi.mock('sonner', () => ({ toast }));

import { MAX_POLL_TICKS, POLL_INTERVAL_MS, RecentExports } from '@/components/exports/export-history';
import type { ManualExportJobWithFiles } from '@/components/exports/export-formats';
import { MissingTaxOfficeError } from '@/lib/exports/tax-office';

/**
 * Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): historia
 * eksportów odświeża się sama, dopóki coś się generuje (co 4 s, najwyżej
 * 45 razy, tylko na widocznej karcie), a potem daje ręczne „Odśwież”.
 * Nieudany eksport pokazuje powód i przycisk wyjścia, gotowy — nigdy
 * starego błędu, a gotowy bez pliku to „Pusty”, nie „Gotowe”. Zmianę
 * statusu ogłasza jeden ukryty komunikat z nazwą pliku i okresem (gotowy
 * i nieudany), a nie każda plakietka z osobna.
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

const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms));

/** Ukryty komunikat dla czytników ekranu (`p.sr-only[aria-live]`). */
const liveRegion = (el: HTMLElement) => el.querySelector<HTMLElement>('p.sr-only[aria-live="polite"]');

const buttons = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll<HTMLElement>('button, a')].filter((b) => b.textContent?.trim() === text);

describe('Historia — odświeżanie eksportów w toku', () => {
  it('co 4 s, dopóki coś się generuje; po 45 razach stop i ręczne „Odśwież”', () => {
    const el = mount([job({ status: 'pending', export_files: [] })]);
    expect(router.refresh).not.toHaveBeenCalled();

    tick(POLL_INTERVAL_MS - 1);
    expect(router.refresh).not.toHaveBeenCalled();
    tick(1);
    expect(router.refresh).toHaveBeenCalledTimes(1);

    tick(POLL_INTERVAL_MS * (MAX_POLL_TICKS - 1));
    expect(router.refresh).toHaveBeenCalledTimes(MAX_POLL_TICKS);
    expect(MAX_POLL_TICKS).toBe(45);

    tick(POLL_INTERVAL_MS * 10);
    expect(router.refresh).toHaveBeenCalledTimes(MAX_POLL_TICKS);

    const refresh = buttons(el, 'Odśwież');
    expect(refresh).toHaveLength(1);
    act(() => refresh[0]!.click());
    expect(router.refresh).toHaveBeenCalledTimes(MAX_POLL_TICKS + 1);
    // Ręczne odświeżenie wznawia odpytywanie.
    tick(POLL_INTERVAL_MS);
    expect(router.refresh).toHaveBeenCalledTimes(MAX_POLL_TICKS + 2);
  });

  it('bez eksportów w toku nie odpytuje; koniec generowania zatrzymuje odpytywanie', () => {
    mount([job(), job({ id: 'job-2', status: 'failed', export_files: [] })]);
    tick(POLL_INTERVAL_MS * 5);
    expect(router.refresh).not.toHaveBeenCalled();

    rerender([job({ status: 'generating', export_files: [] })]);
    tick(POLL_INTERVAL_MS);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    rerender([job()]);
    tick(POLL_INTERVAL_MS * 5);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('karta w tle nie odpytuje', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      mount([job({ status: 'generating', export_files: [] })]);
      tick(POLL_INTERVAL_MS * 3);
      expect(router.refresh).not.toHaveBeenCalled();
    } finally {
      visibility.mockRestore();
    }
  });

  it('po odmontowaniu nic nie odpytuje', () => {
    mount([job({ status: 'pending', export_files: [] })]);
    act(() => root!.unmount());
    root = null;
    tick(POLL_INTERVAL_MS * 3);
    expect(router.refresh).not.toHaveBeenCalled();
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
