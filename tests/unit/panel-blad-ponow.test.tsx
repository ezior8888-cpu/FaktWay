// @vitest-environment jsdom
import { act, startTransition, use, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ErrorBoundary, type ErrorComponent } from 'next/dist/client/components/error-boundary';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);

import DashboardError from '@/app/(dashboard)/error';

/**
 * „Spróbuj ponownie” na stronie błędu panelu (ustalenie 3 sesji 9 planu
 * skalowania, #350). Błąd Server Componentu (np. odczyt członkostw
 * w `getPageContext` przy miękkiej nawigacji) przychodzi w ładunku RSC.
 * Samo `reset()` granicy Next tylko czyści jej stan i renderuje ten sam
 * ładunek — klient od razu widzi ten sam błąd. Ponowienie musi pobrać
 * stronę od nowa (`router.refresh()`) i wyrenderować segment dopiero
 * z nowymi danymi, czyli `reset()` w tym samym przejściu.
 *
 * Test stawia PRAWDZIWĄ granicę błędu Next (`ErrorBoundary`, tę samą, którą
 * App Router owija `error.tsx`) pod uproszczonym routerem, który działa jak
 * Next 16.4: `refresh()` ustawia w przejściu nowy stan routera NAD granicą
 * (obietnicę odpowiedzi serwera), a ten stan czytają layouty nad nią —
 * dopóki serwer nie odpowie, React trzyma poprzedni ekran.
 *
 * Poza modelem: przy ponowieniu Next renderuje od nowa także layout panelu.
 * Gdy padnie i on (ta sama awaria bazy), błąd trafia do `global-error.tsx`,
 * tak samo jak po F5 — sprawdzone na zbudowanym Next 16.4.1 (PR).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Next typuje `error` granicy jako `unknown` (TODO NAR-804 w error-boundary.js),
// `error.tsx` według dokumentacji jako `Error & { digest }`.
const errorComponent = DashboardError as ErrorComponent;

type Dane = 'blad' | 'ok';

// „Serwer”: co zwróci następne pobranie RSC i kiedy odpowie.
let serwer: Dane = 'blad';
let odpowiedzSerwera: Promise<void> = Promise.resolve();

const refresh = vi.fn();

function Strona({ dane }: { dane: Dane }) {
  if (dane === 'blad') throw new Error('Nie udało się odczytać członkostw');
  return <p>Pulpit wczytany</p>;
}

function Router() {
  const [stan, ustaw] = useState<Dane | Promise<Dane>>('blad');
  // Jak `refresh()` w Next 16.4 (`sequential-router-queue.js` →
  // `dispatchAppRouterAction`): nowy stan routera w przejściu.
  const [router] = useState<AppRouterInstance>(() => ({
    back: vi.fn(),
    forward: vi.fn(),
    refresh: () => {
      refresh();
      const odpowiedz = odpowiedzSerwera.then(() => serwer);
      startTransition(() => ustaw(odpowiedz));
    },
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    bfcacheId: '_b_0_',
  }));
  // Layouty nad granicą czekają na odpowiedź serwera (`use` jak w Next).
  const dane = typeof stan === 'string' ? stan : use(stan);
  return (
    <AppRouterContext.Provider value={router}>
      <ErrorBoundary errorComponent={errorComponent}>
        <Strona dane={dane} />
      </ErrorBoundary>
    </AppRouterContext.Provider>
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  refresh.mockClear();
  sentry.captureException.mockReset();
  serwer = 'blad';
  odpowiedzSerwera = Promise.resolve();
  // React wypisuje każdy błąd złapany przez granicę — tu jest oczekiwany.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

const tik = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Router />);
  });
  return host;
}

function przycisk(el: HTMLElement) {
  const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Spróbuj ponownie'));
  expect(button).toBeDefined();
  return button!;
}

async function kliknij(el: HTMLElement) {
  await act(async () => {
    przycisk(el).click();
    await tik();
  });
}

describe('panel — „Spróbuj ponownie” na stronie błędu', () => {
  it('awaria minęła: pobiera stronę od nowa i pokazuje dane', async () => {
    const el = await mount();
    expect(el.textContent).toContain('Coś poszło nie tak');
    expect(sentry.captureException).toHaveBeenCalledTimes(1);

    serwer = 'ok';
    await kliknij(el);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain('Pulpit wczytany');
    expect(el.textContent).not.toContain('Coś poszło nie tak');
  });

  it('awaria strony trwa: jedno pobranie i znów ekran błędu; kolejne kliknięcie po awarii pokazuje dane', async () => {
    const el = await mount();

    await kliknij(el);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain('Coś poszło nie tak');

    serwer = 'ok';
    await kliknij(el);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(el.textContent).toContain('Pulpit wczytany');
  });

  it('do odpowiedzi serwera ekran błędu zostaje, a przycisk jest wyłączony — kolejne kliknięcia nie odświeżają drugi raz', async () => {
    let odpowiedz!: () => void;
    odpowiedzSerwera = new Promise<void>((resolve) => {
      odpowiedz = resolve;
    });
    const el = await mount();

    serwer = 'ok';
    await kliknij(el);
    expect(el.textContent).toContain('Coś poszło nie tak');
    expect(przycisk(el).disabled).toBe(true);

    await act(async () => {
      przycisk(el).click();
      przycisk(el).click();
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      odpowiedz();
      await tik();
    });
    expect(el.textContent).toContain('Pulpit wczytany');
  });
});
