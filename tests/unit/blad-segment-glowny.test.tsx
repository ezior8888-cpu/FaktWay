// @vitest-environment jsdom
import { act, startTransition, use, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ErrorBoundary, type ErrorComponent } from 'next/dist/client/components/error-boundary';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);
// `<Link>` w App Routerze zatrzymuje domyślne przejście i nawiguje miękko. Tu sam ten
// skutek: Vitest wziąłby wersję Pages Routera, która bez routera udaje zwykły <a>,
// a wersja z `app-dir` nie ładuje się bez bundlera Next.
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return {
    default: (props: Record<string, unknown>) =>
      createElement('a', { ...props, onClick: (e: MouseEvent) => e.preventDefault() }),
  };
});

import DashboardError from '@/app/(dashboard)/error';
import RootError from '@/app/error';
import { THEME_STORAGE_KEY } from '@/lib/theme/theme';

/**
 * Strona błędu segmentu głównego (`app/error.tsx`, decyzja Bartosza z 03.11,
 * osobne ustalenie z #351). `error.tsx` nie obejmuje layoutu własnego
 * segmentu, więc błąd `app/(dashboard)/layout.tsx` (np. odczyt członkostw
 * w `assertDashboardShellAccess`) mija kartę panelu i bez tego pliku kończył
 * się na `global-error.tsx`: cały dokument bez motywu i czcionek, twarde
 * przeładowanie.
 *
 * Model jak w `panel-blad-ponow.test.tsx`: PRAWDZIWE granice Next
 * (`ErrorBoundary`, ta, którą App Router owija `error.tsx`) pod uproszczonym
 * routerem, a `refresh()` ustawia w przejściu nowy stan NAD granicami. Układ
 * granic odpowiada drzewu App Routera: `app/error.tsx` jest wewnątrz
 * `app/layout.tsx` i obejmuje layout panelu, a `app/(dashboard)/error.tsx`
 * jest już wewnątrz tego layoutu.
 *
 * Bez dostawców panelu (pasek boczny, portal, podpowiedzi), bez sesji i bez
 * firmy: ta strona pojawia się też na logowaniu i stronach marketingowych,
 * więc kontekst panelu wywaliłby ją przy pierwszym renderze.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Next typuje `error` granicy jako `unknown` (TODO NAR-804 w error-boundary.js),
// `error.tsx` według dokumentacji jako `Error & { digest }`.
const rootErrorComponent = RootError as ErrorComponent;
const dashboardErrorComponent = DashboardError as ErrorComponent;

type Dane = 'padl-layout' | 'padla-strona' | 'ok';

// „Serwer”: co zwróci następne pobranie RSC i kiedy odpowie.
let serwer: Dane = 'ok';
let odpowiedzSerwera: Promise<void> = Promise.resolve();

const refresh = vi.fn();

function Strona({ dane }: { dane: Dane }) {
  if (dane === 'padla-strona') throw new Error('Nie udało się odczytać danych strony');
  return <p>Pulpit wczytany</p>;
}

function LayoutPanelu({ dane, children }: { dane: Dane; children: ReactNode }) {
  if (dane === 'padl-layout') throw new Error('Nie udało się odczytać członkostw');
  return <section data-testid="powloka-panelu">{children}</section>;
}

const trasaPanelu = (dane: Dane) => (
  <LayoutPanelu dane={dane}>
    <ErrorBoundary errorComponent={dashboardErrorComponent}>
      <Strona dane={dane} />
    </ErrorBoundary>
  </LayoutPanelu>
);

function StronaMarketingowa({ dane }: { dane: Dane }) {
  if (dane !== 'ok') throw new Error('Nie udało się wyrenderować strony');
  return <p>Cennik wczytany</p>;
}

const trasaMarketingowa = (dane: Dane) => <StronaMarketingowa dane={dane} />;

function Router({ start, trasa }: { start: Dane; trasa: (dane: Dane) => ReactNode }) {
  const [stan, ustaw] = useState<Dane | Promise<Dane>>(start);
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
      <ErrorBoundary errorComponent={rootErrorComponent}>{trasa(dane)}</ErrorBoundary>
    </AppRouterContext.Provider>
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  refresh.mockClear();
  sentry.captureException.mockReset();
  serwer = 'ok';
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

async function mount(start: Dane, trasa: (dane: Dane) => ReactNode = trasaPanelu) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Router start={start} trasa={trasa} />);
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

describe('app/error.tsx — awaria layoutu panelu', () => {
  it('pokazuje kartę panelu z nagłówkiem strony i wyjściem na stronę główną, a błąd trafia do Sentry raz', async () => {
    const el = await mount('padl-layout');

    expect(el.querySelector('[data-testid="powloka-panelu"]')).toBeNull();
    expect(el.querySelector('h1')?.textContent).toBe('Coś poszło nie tak');
    expect(el.textContent).toContain('Wystąpił nieoczekiwany błąd. Możesz spróbować ponownie.');
    expect(przycisk(el).disabled).toBe(false);
    // Skala i tokeny panelu, ale bez `ff-app-shell`: ta klasa blokuje przewijanie
    // dokumentu, a karta musi się dać przewinąć na małym ekranie.
    expect(el.querySelector('main.ff-dashboard')).not.toBeNull();
    expect(el.querySelector('.ff-app-shell')).toBeNull();
    // Bez powłoki nie ma innej nawigacji. Adres publiczny, bo stronę widzi też
    // niezalogowany. Zwykły <a> (nie `<Link>`, który zatrzymuje domyślne przejście):
    // gdy padła sama strona główna, ten sam adres nie zdjąłby błędu z granicy.
    const linki = [...el.querySelectorAll('a')];
    expect(linki.map((a) => a.getAttribute('href'))).toEqual(['/']);
    const klik = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      linki[0]!.dispatchEvent(klik);
    });
    expect(klik.defaultPrevented).toBe(false);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException.mock.calls[0]?.[0]).toMatchObject({ message: 'Nie udało się odczytać członkostw' });
  });

  it('awaria minęła: jedno pobranie strony i powłoka z danymi, bez przeładowania', async () => {
    const el = await mount('padl-layout');

    await kliknij(el);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(el.querySelector('[data-testid="powloka-panelu"]')?.textContent).toContain('Pulpit wczytany');
    expect(el.textContent).not.toContain('Coś poszło nie tak');
  });

  it('awaria trwa: jedno pobranie i znów karta; kolejne kliknięcie po awarii pokazuje dane', async () => {
    const el = await mount('padl-layout');

    serwer = 'padl-layout';
    await kliknij(el);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(el.querySelector('h1')?.textContent).toBe('Coś poszło nie tak');
    expect(przycisk(el).disabled).toBe(false);

    serwer = 'ok';
    await kliknij(el);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(el.textContent).toContain('Pulpit wczytany');
  });

  it('do odpowiedzi serwera karta zostaje, a przycisk jest wyłączony — kolejne kliknięcia nie odświeżają drugi raz', async () => {
    let odpowiedz!: () => void;
    odpowiedzSerwera = new Promise<void>((resolve) => {
      odpowiedz = resolve;
    });
    const el = await mount('padl-layout');

    await kliknij(el);
    expect(el.querySelector('h1')?.textContent).toBe('Coś poszło nie tak');
    expect(przycisk(el).disabled).toBe(true);

    await act(async () => {
      przycisk(el).click();
      przycisk(el).click();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    // Ta sama awaria nie zgłasza się drugi raz przy samym ponownym renderze.
    expect(sentry.captureException).toHaveBeenCalledTimes(1);

    await act(async () => {
      odpowiedz();
      await tik();
    });
    expect(el.textContent).toContain('Pulpit wczytany');
  });
});

describe('app/error.tsx — motyw po pełnym wczytaniu', () => {
  // Po awarii przy pełnym wczytaniu (HTTP 500) Next składa dokument w przeglądarce,
  // a skrypt `THEME_BOOT_SCRIPT` wstawiony przez React się nie wykonuje (sprawdzone
  // na zbudowanym Next 16.4.1, opis w PR). Tu: `<html>` bez klasy, jak w tym dokumencie.
  afterEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    document.documentElement.classList.remove('dark');
    document.documentElement.style.colorScheme = '';
  });

  it('klient z ciemnym motywem dostaje ciemną kartę i zostaje na ciemnym po udanym ponowieniu', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const el = await mount('padl-layout');

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');

    await kliknij(el);
    expect(el.textContent).toContain('Pulpit wczytany');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('bez zapisanego motywu zostaje jasny', async () => {
    await mount('padl-layout');

    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('niedostępny localStorage nie wywraca karty', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Odmowa dostępu', 'SecurityError');
    });
    const el = await mount('padl-layout');

    expect(el.querySelector('h1')?.textContent).toBe('Coś poszło nie tak');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

describe('app/error.tsx i karta panelu razem', () => {
  it('ponowienie na karcie panelu przy trwającej awarii layoutu kończy się kartą główną, a nie błędem bez granicy', async () => {
    const el = await mount('padla-strona');
    // Karta panelu: w powłoce, nagłówek drugiego poziomu (h1 ma powłoka), bez linku.
    expect(el.querySelector('[data-testid="powloka-panelu"]')).not.toBeNull();
    expect(el.querySelector('h2')?.textContent).toBe('Coś poszło nie tak');
    expect(el.querySelectorAll('a')).toHaveLength(0);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);

    serwer = 'padl-layout';
    await kliknij(el);

    expect(el.querySelector('[data-testid="powloka-panelu"]')).toBeNull();
    expect(el.querySelector('h1')?.textContent).toBe('Coś poszło nie tak');
    // Dwie różne awarie, dwa zgłoszenia.
    expect(sentry.captureException).toHaveBeenCalledTimes(2);

    serwer = 'ok';
    await kliknij(el);
    expect(el.querySelector('[data-testid="powloka-panelu"]')?.textContent).toContain('Pulpit wczytany');
  });
});

describe('app/error.tsx poza panelem', () => {
  it('strona marketingowa bez sesji i firmy: ta sama karta i to samo ponowienie', async () => {
    const el = await mount('padla-strona', trasaMarketingowa);

    expect(el.querySelector('h1')?.textContent).toBe('Coś poszło nie tak');
    expect([...el.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/']);

    await kliknij(el);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain('Cennik wczytany');
  });
});
