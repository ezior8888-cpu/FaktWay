// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { KsefHealthBannerClient } from '@/app/(dashboard)/_components/ksef-health-banner-client';

/**
 * Plan skalowania 3000, sesja 1 (REQ-03, CAC-01, HOR-07, CPU-02).
 *
 * Baner KSeF siedzi w layoucie panelu, więc odpytuje każda otwarta karta.
 * Dawniej co 30 s, także karta w tle i przy zdrowym KSeF (baner ukryty).
 * Teraz: tylko widoczna karta, co 120 s z rozrzutem, a po powrocie do karty
 * jedno odpytanie od razu (najwyżej raz na 60 s), żeby baner awarii się nie
 * spóźnił.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MIN = 60_000;

const operational = {
  level: 'operational' as const,
  lastCheckedAt: '2026-10-29T10:00:00.000Z',
  responseTimeMs: 120,
  consecutiveFailures: 0,
  isMfOutage: false,
  env: 'test' as const,
};
const down = { ...operational, level: 'down' as const, responseTimeMs: null, consecutiveFailures: 3 };

let visibility: DocumentVisibilityState;
let health: typeof operational | typeof down;
let fetchedAt: number[];
let root: Root | null = null;
let host: HTMLDivElement;

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<KsefHealthBannerClient initial={operational} />));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T10:00:00Z'));
  visibility = 'visible';
  health = operational;
  fetchedAt = [];
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.stubGlobal('fetch', vi.fn(async () => {
    fetchedAt.push(Date.now());
    return Response.json({ ...health, stale: false });
  }));
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

it('ukryta karta przez 10 minut nie odpytuje serwera', async () => {
  visibility = 'hidden';
  mount();
  await wait(10 * MIN);
  expect(fetchedAt).toEqual([]);
});

it('karta schowana po wejściu przestaje odpytywać', async () => {
  mount();
  setVisibility('hidden');
  await wait(10 * MIN);
  expect(fetchedAt).toEqual([]);
});

it('widoczna karta odpytuje najwyżej raz na 120 s', async () => {
  mount();
  await wait(10 * MIN);

  // 600 s / 120–150 s = 4–5 odpytań; dawniej 20.
  expect(fetchedAt.length).toBeGreaterThanOrEqual(4);
  expect(fetchedAt.length).toBeLessThanOrEqual(5);
  const start = new Date('2026-10-29T10:00:00Z').getTime();
  [start, ...fetchedAt].reduce((prev, at) => {
    expect(at - prev).toBeGreaterThanOrEqual(2 * MIN);
    return at;
  });
});

it('rozrzut: karty otwarte w tej samej chwili nie odpytują w tej samej sekundzie', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  mount();
  await wait(5 * MIN);
  const early = [...fetchedAt];
  act(() => root?.unmount());
  root = null;

  fetchedAt = [];
  vi.setSystemTime(new Date('2026-10-29T10:00:00Z'));
  vi.spyOn(Math, 'random').mockReturnValue(0.99);
  mount();
  await wait(5 * MIN);

  expect(early[0]).not.toBe(fetchedAt[0]);
});

it('po powrocie do karty odpytuje od razu i pokazuje baner awarii', async () => {
  mount();
  setVisibility('hidden');
  await wait(5 * MIN);
  expect(fetchedAt).toEqual([]);

  health = down;
  setVisibility('visible');
  await wait(0);

  expect(fetchedAt).toHaveLength(1);
  expect(host.textContent).toContain('KSeF jest niedostępny');
});

it('szybkie przełączanie kart daje najwyżej jedno odpytanie na 60 s', async () => {
  mount();
  await wait(MIN); // od wczytania strony minęła minuta
  for (let i = 0; i < 24; i++) {
    setVisibility(i % 2 === 0 ? 'hidden' : 'visible');
    await wait(5_000);
  }
  // 2 minuty przełączania co 5 s to 12 powrotów do karty, a odpytania najwyżej 2.
  expect(fetchedAt.length).toBeLessThanOrEqual(2);
  fetchedAt.reduce((prev, at) => {
    expect(at - prev).toBeGreaterThanOrEqual(MIN);
    return at;
  });
});

it('krótkie wyjście z karty nie odsuwa następnego odpytania', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.99); // termin: 120 s + 29,7 s
  mount();
  await wait(10_000);
  setVisibility('hidden');
  await wait(45_000);
  setVisibility('visible'); // 55 s od wczytania: za wcześnie na odpytanie
  expect(fetchedAt).toEqual([]);

  // Termin liczy się od ostatniego odczytu (wczytania strony), nie od powrotu.
  await wait(95_000);
  expect(fetchedAt).toHaveLength(1);
});

it('cofnięcie zegara systemowego nie zatrzymuje odpytywania', async () => {
  mount();
  await wait(30_000);
  // Synchronizacja czasu cofa zegar o godzinę; zegary przeglądarki liczą dalej.
  vi.setSystemTime(Date.now() - 60 * MIN);
  setVisibility('hidden');
  await wait(5_000);
  setVisibility('visible');
  const before = fetchedAt.length;
  await wait(30 * MIN);
  expect(fetchedAt.length - before).toBeGreaterThanOrEqual(12);
});

it('zawieszone żądanie nie zatrzymuje odpytywania widocznej karty', async () => {
  const fetchMock = vi.mocked(fetch);
  fetchMock.mockImplementationOnce((_input, init) => {
    fetchedAt.push(Date.now());
    // Odpowiedź nie przychodzi nigdy; kończy ją tylko przerwanie.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  });
  mount();
  await wait(10 * MIN);
  expect(fetchedAt.length).toBeGreaterThanOrEqual(4);
});

it('odmontowany baner nie zostawia zegarów ani nasłuchu', async () => {
  mount();
  act(() => root!.unmount());
  root = null;
  setVisibility('hidden');
  setVisibility('visible');
  await wait(10 * MIN);
  expect(fetchedAt).toEqual([]);
});
