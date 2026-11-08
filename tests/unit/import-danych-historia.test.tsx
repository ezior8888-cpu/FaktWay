// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const actions = vi.hoisted(() => ({ startFileImportAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/app/actions/import-danych', () => actions);

import { EMPTY_STEPS, ImportHistory } from '@/components/import-danych/import-history';
import { MAX_POLL_TICKS, POLL_INTERVAL_MS, type ImportHistoryJob } from '@/components/import-danych/import-model';
import { ImportSourceGrid } from '@/components/import-danych/import-source-grid';

/**
 * Poprawka Bartosza 22.10.2026 (import danych w stylu Finory): historia
 * importów odświeża się sama, dopóki coś się importuje (co 4 s, najwyżej
 * 45 razy, tylko na widocznej karcie), potem daje ręczne „Odśwież”; koniec
 * importu w czasie wizyty zgłasza powiadomienie. Karty źródeł z pliku
 * otwierają to samo okno `FileImportDialog` co onboarding.
 *
 * Decyzja Bartosza 22.10.2026 — świadome zmiany oczekiwań: importy w toku
 * w tych testach to import pliku (dawny ręczny import z KSeF „w toku” jest
 * przerwany i nie odpytuje serwera), z pliku zostają cztery programy (bez
 * „Inny program (JPK_FA)”), a pusta historia ma nowe trzy kroki.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function job(overrides: Partial<ImportHistoryJob> = {}): ImportHistoryJob {
  return {
    id: 'imp-1',
    source: 'fakturownia_csv',
    direction: null,
    date_from: null,
    date_to: null,
    status: 'completed',
    progress_percent: 100,
    progress_message: 'Import zakończony',
    invoices_imported: 12,
    contractors_created: 3,
    contractors_updated: 0,
    products_created: 0,
    warnings: [],
    source_filename: 'eksport.csv',
    created_at: '2026-10-01T08:00:00Z',
    completed_at: '2026-10-01T08:01:00Z',
    ...overrides,
  };
}

const running = (overrides: Partial<ImportHistoryJob> = {}) =>
  job({ status: 'extracting', progress_percent: 30, invoices_imported: null, completed_at: null, ...overrides });

beforeEach(() => {
  vi.useFakeTimers();
  router.refresh.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const rerender = (jobs: ImportHistoryJob[]) => act(() => root!.render(<ImportHistory jobs={jobs} />));
const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const buttons = (el: ParentNode, text: string) =>
  [...el.querySelectorAll<HTMLElement>('button, a')].filter((b) => b.textContent?.trim() === text);

describe('Historia importów — odświeżanie w toku', () => {
  it('co 4 s, dopóki coś się importuje; po 45 razach stop i ręczne „Odśwież”', () => {
    const el = mount(<ImportHistory jobs={[running()]} />);
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
    tick(POLL_INTERVAL_MS);
    expect(router.refresh).toHaveBeenCalledTimes(MAX_POLL_TICKS + 2);
  });

  it('bez importów w toku nie odpytuje; koniec importu zatrzymuje odpytywanie', () => {
    mount(<ImportHistory jobs={[job(), job({ id: 'imp-2', status: 'failed' })]} />);
    tick(POLL_INTERVAL_MS * 5);
    expect(router.refresh).not.toHaveBeenCalled();

    rerender([running()]);
    tick(POLL_INTERVAL_MS);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    rerender([job()]);
    tick(POLL_INTERVAL_MS * 5);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('karta w tle nie odpytuje', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      mount(<ImportHistory jobs={[running()]} />);
      tick(POLL_INTERVAL_MS * 3);
      expect(router.refresh).not.toHaveBeenCalled();
    } finally {
      visibility.mockRestore();
    }
  });
});

describe('Historia importów — koniec importu w czasie wizyty', () => {
  it('zakończony: powiadomienie z wynikiem i komunikat dla czytnika', () => {
    const el = mount(<ImportHistory jobs={[running()]} />);
    rerender([job()]);
    expect(toast.success).toHaveBeenCalledWith('Import zakończony', { description: '12 faktur · 3 kontrahenci' });
    expect(el.querySelector('p.sr-only[aria-live="polite"]')?.textContent).toBe(
      'Import zakończony: Fakturownia. 12 faktur · 3 kontrahenci',
    );
  });

  it('nieudany: powiadomienie z powodem', () => {
    mount(<ImportHistory jobs={[running()]} />);
    rerender([job({ status: 'failed', progress_message: 'Zawęź zakres dat i ponów import.' })]);
    expect(toast.error).toHaveBeenCalledWith('Import się nie udał', { description: 'Zawęź zakres dat i ponów import.' });
  });

  it('import zakończony przed wizytą nie zgłasza się drugi raz', () => {
    mount(<ImportHistory jobs={[job()]} />);
    rerender([job(), job({ id: 'imp-2' })]);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('Historia importów — dawny ręczny import z KSeF', () => {
  it('„w toku” to przerwany: „Anulowano” z notką, bez odpytywania serwera', () => {
    const el = mount(
      <ImportHistory
        jobs={[running({ source: 'ksef_history', direction: 'issued', source_filename: null, date_from: '2026-04-01', date_to: '2026-09-30' })]}
      />,
    );
    expect(el.textContent).toContain('Import z KSeF (ręczny)');
    expect(el.textContent).toContain('Anulowano');
    expect(el.textContent).toContain('Przerwany — zastąpiony automatyczną historią z KSeF');
    expect(el.textContent).not.toContain('W toku');
    tick(POLL_INTERVAL_MS * 3);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  // Poprawka po przeglądzie (decyzja Bartosza 22.10.2026): nieudany dawny
  // import z KSeF nie podpowiada już „ponów import” — tego importu nie ma.
  // Pokazujemy go jak przerwany (zastąpiony automatyczną historią z KSeF),
  // a liczbę zapisanych faktur zostawiamy.
  it('nieudany: zastąpiony automatyczną historią, bez „ponów import”; zapisane faktury zostają', () => {
    const el = mount(
      <ImportHistory
        jobs={[
          job({
            source: 'ksef_history',
            direction: 'issued',
            source_filename: null,
            date_from: '2026-04-01',
            date_to: '2026-09-30',
            status: 'failed',
            progress_message: 'Lista faktur KSeF jest niepełna. Zawęź zakres dat i ponów import.',
            invoices_imported: 7,
          }),
        ]}
      />,
    );
    expect(el.textContent).toContain('Import z KSeF (ręczny)');
    expect(el.textContent).toContain('Przerwany — zastąpiony automatyczną historią z KSeF');
    expect(el.textContent).toContain('Zapisano 7 faktur');
    expect(el.textContent).toContain('Anulowano');
    expect(el.textContent).not.toContain('ponów import');
    expect(el.textContent).not.toContain('Błąd');
  });

  it('nieudany import z pliku dalej pokazuje powód i „Błąd”', () => {
    const el = mount(<ImportHistory jobs={[job({ status: 'failed', progress_message: 'Plik nie wygląda na eksport z Fakturowni.' })]} />);
    expect(el.textContent).toContain('Plik nie wygląda na eksport z Fakturowni.');
    expect(el.textContent).toContain('Błąd');
  });

  it('pusta historia: trzy kroki bez ręcznego startu importu z KSeF', () => {
    const el = mount(<ImportHistory jobs={[]} />);
    expect(EMPTY_STEPS).toEqual(['Wgraj certyfikat KSeF', 'Historię z KSeF pobieramy sami', 'Pliki z innego programu wgrasz tu raz']);
    for (const step of EMPTY_STEPS) expect(el.textContent).toContain(step);
  });
});

describe('Karty źródeł — import z pliku', () => {
  it('karta programu otwiera okno importu z pliku tego programu; „Anuluj” je zamyka', async () => {
    const el = mount(<ImportSourceGrid tenantId="org-1" />);
    const card = el.querySelector<HTMLButtonElement>('button[aria-label="Fakturownia — wgraj plik CSV"]');
    expect(card).not.toBeNull();
    act(() => card!.click());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(document.body.textContent).toContain('Import z Fakturownia CSV');
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input?.accept).toBe('.csv');

    act(() => buttons(document.body, 'Anuluj')[0]!.click());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(document.body.querySelector('input[type="file"]')).toBeNull();
    expect(actions.startFileImportAction).not.toHaveBeenCalled();
  });

  it('tylko cztery programy CSV — bez „Inny program (JPK_FA)”', async () => {
    const el = mount(<ImportSourceGrid tenantId="org-1" />);
    const labels = [...el.querySelectorAll<HTMLButtonElement>('button[aria-label]')].map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Fakturownia — wgraj plik CSV',
      'inFakt — wgraj plik CSV',
      'wFirma — wgraj plik CSV',
      'iFirma — wgraj plik CSV',
    ]);
    expect(el.textContent).not.toContain('JPK_FA');
    act(() => el.querySelector<HTMLButtonElement>('button[aria-label="iFirma — wgraj plik CSV"]')!.click());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(document.body.textContent).toContain('Import z iFirma CSV');
    expect(document.body.querySelector<HTMLInputElement>('input[type="file"]')?.accept).toBe('.csv');
  });
});
