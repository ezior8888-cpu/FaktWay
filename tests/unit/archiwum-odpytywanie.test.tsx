// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan skalowania, sesja 11 (REQ-08, CAC-V01): archiwum dokumentów
 * w ustawieniach firmy (`/settings#archiwum`). Dawniej zlecenie
 * w przygotowaniu odświeżało całą stronę ustawień (`router.refresh()`) co
 * 15 s, bez końca i także na karcie w tle. Teraz lekka akcja pyta o same
 * statusy zleceń w toku (po 15 s, 22,5 s, 33,75 s, 50,6 s, potem co minutę,
 * tylko na widocznej karcie), a strona odświeża się raz, gdy status się
 * zmieni. Bez limitu czasu: formularz nie ma przycisku „Odśwież”, a dołożenie
 * go zmieniałoby wygląd (sesja zadaniowa, nie design).
 */

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), replace: vi.fn() }));
const statusActions = vi.hoisted(() => ({ getDocumentArchiveStatusesAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/actions/archiwum', () => ({
  getDocumentArchiveLinkAction: vi.fn(),
  requestDocumentArchiveAction: vi.fn(),
}));
vi.mock('@/app/actions/job-statuses', () => statusActions);

import { DocumentArchiveForm } from '@/components/settings/document-archive-form';

type Order = Parameters<typeof DocumentArchiveForm>[0]['orders'][number];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = '0190dddd-0000-4000-8000-000000000011';

function order(status: 'pending' | 'generating' | 'completed' | 'failed'): Order {
  const done = status === 'completed';
  return {
    id: ID,
    kind: 'archive',
    status,
    period_start: '2026-03-01',
    period_end: '2026-03-31',
    created_at: '2026-11-20T09:00:00Z',
    finished_at: done ? '2026-11-20T09:05:00Z' : null,
    expires_at: done ? '2026-11-27T09:05:00Z' : null,
    file_deleted_at: null,
    size_bytes: done ? 2048 : null,
    files_count: done ? 5 : null,
    missing_count: done ? 0 : null,
    error_message: null,
  } as unknown as Order;
}

/**
 * Odstępy kolejnych pytań: 15 s, 22,5 s, 33,75 s, 50,625 s, potem co 60 s
 * (`pollDelays(ARCHIVE_POLL)` — pilnuje tego `odpytywanie-statusu-petla.test.ts`).
 * Wpisane na sztywno, żeby test był czerwony na kodzie sprzed sesji 11.
 */
const DELAYS = [15_000, 22_500, 33_750, 50_625, 60_000];

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  router.refresh.mockReset();
  statusActions.getDocumentArchiveStatusesAction.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

const form = (orders: Order[]) => <DocumentArchiveForm canRequest orders={orders} today="2026-11-20" />;

function mount(orders: Order[]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(form(orders)));
  return host;
}

const rerender = (orders: Order[]) => act(() => root!.render(form(orders)));
const flush = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const statusCalls = () => statusActions.getDocumentArchiveStatusesAction.mock.calls.length;
const statuses = (status: string) => ({ success: true as const, statuses: [{ id: ID, status }] });

describe('Archiwum dokumentów — odpytywanie zlecenia w przygotowaniu', () => {
  it('pomiar: 10 minut przygotowania bez zmiany = 0 × router.refresh(), 11 lekkich pytań', async () => {
    statusActions.getDocumentArchiveStatusesAction.mockResolvedValue(statuses('generating'));
    mount([order('generating')]);

    await flush(10 * 60_000);
    // Przed sesją 11: 40 × router.refresh() (co 15 s) i 0 lekkich pytań.
    expect(router.refresh).not.toHaveBeenCalled();
    // 15 + 22,5 + 33,75 + 50,625 s = 121,875 s, potem co minutę do 541,875 s.
    expect(statusCalls()).toBe(11);
    expect(statusActions.getDocumentArchiveStatusesAction).toHaveBeenLastCalledWith([ID]);
  });

  it('rosnący odstęp: 15 s, 22,5 s, 33,75 s, 50,6 s, potem co minutę', async () => {
    statusActions.getDocumentArchiveStatusesAction.mockResolvedValue(statuses('pending'));
    mount([order('pending')]);

    for (let n = 1; n <= 6; n++) {
      const wait = DELAYS[Math.min(n - 1, DELAYS.length - 1)]!;
      await flush(wait - 1);
      expect(statusCalls()).toBe(n - 1);
      await flush(1);
      expect(statusCalls()).toBe(n);
    }
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('paczka gotowa: router.refresh() raz; odświeżona lista kończy odpytywanie', async () => {
    statusActions.getDocumentArchiveStatusesAction.mockResolvedValue(statuses('completed'));
    mount([order('generating')]);

    await flush(DELAYS[0]!);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    rerender([order('completed')]);
    await flush(10 * 60_000);
    expect(statusCalls()).toBe(1);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('karta w tle nie pyta i nie odświeża (dawniej co 15 s także w tle)', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      statusActions.getDocumentArchiveStatusesAction.mockResolvedValue(statuses('generating'));
      mount([order('generating')]);
      await flush(5 * 60_000);
      expect(statusCalls()).toBe(0);
      expect(router.refresh).not.toHaveBeenCalled();
    } finally {
      visibility.mockRestore();
    }
  });

  it('bez zleceń w przygotowaniu nie pyta', async () => {
    mount([order('completed'), { ...order('failed'), id: '0190dddd-0000-4000-8000-000000000012' } as Order]);
    await flush(5 * 60_000);
    expect(statusCalls()).toBe(0);
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
