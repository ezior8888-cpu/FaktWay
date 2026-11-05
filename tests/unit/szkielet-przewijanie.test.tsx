// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Przewijanie szkieletu panelu na telefonie (zgłoszenie Bartosza 23.10.2026:
 * „zablokuj górny pasek tak, żeby nie znikał i się nie chował”).
 *
 *  - Dokument się nie przewija: przewija się wyłącznie `.ff-shell-scroll`.
 *    `<body>` ma `min-h-screen` (100vh, na telefonie wyższe niż widać), więc
 *    `scrollIntoView()` Nexta po zmianie zakładki przewijał dokument i pasek
 *    górny wyjeżdżał poza ekran.
 *  - Nowa strona zaczyna się od góry, „Wstecz” wraca w to samo miejsce.
 */

const nav = vi.hoisted(() => ({ pathname: '/invoices' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

const { ShellScrollMemory } = await import('@/components/dashboard/shell-scroll-memory');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let scroller: HTMLDivElement;
let host: HTMLDivElement;
let root: Root;

function setScrollTop(value: number) {
  // jsdom nie liczy układu — `scrollTop` trzymamy jako zwykłą własność.
  Object.defineProperty(scroller, 'scrollTop', { value, writable: true, configurable: true });
}

function goTo(pathname: string) {
  nav.pathname = pathname;
  act(() => root.render(<ShellScrollMemory />));
}

beforeEach(() => {
  window.history.replaceState(null, '', '/invoices');
  nav.pathname = '/invoices';
  scroller = document.createElement('div');
  scroller.className = 'ff-shell-scroll';
  host = document.createElement('div');
  document.body.append(scroller, host);
  setScrollTop(0);
  root = createRoot(host);
  act(() => root.render(<ShellScrollMemory />));
});

afterEach(() => {
  act(() => root.unmount());
  scroller.remove();
  host.remove();
});

describe('ShellScrollMemory — przewijanie panelu przy zmianie trasy', () => {
  it('przejście linkiem: nowa strona zaczyna się od samej góry', () => {
    setScrollTop(640);
    document.body.click();
    window.history.pushState(null, '', '/przeplywy');
    goTo('/przeplywy');
    expect(scroller.scrollTop).toBe(0);
  });

  it('„Wstecz” z podglądu faktury wraca w to samo miejsce listy', () => {
    setScrollTop(640);
    // Dotknięcie karty faktury zapisuje pozycję listy, zanim zmieni się treść.
    document.body.click();
    window.history.pushState(null, '', '/invoices/inv-1');
    goTo('/invoices/inv-1');
    expect(scroller.scrollTop).toBe(0);

    setScrollTop(120);
    // „Wstecz”: przeglądarka zmienia adres, potem wysyła `popstate`.
    window.history.replaceState(null, '', '/invoices');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    goTo('/invoices');
    expect(scroller.scrollTop).toBe(640);
  });

  it('cofnięcie w obrębie tej samej ścieżki nie psuje kolejnego kliknięcia linku', () => {
    setScrollTop(300);
    window.history.replaceState(null, '', '/invoices?page=2');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    // Ta sama ścieżka — efekt się nie uruchamia, a następne przejście linkiem
    // ma przewinąć na górę, nie „przywracać”.
    document.body.click();
    window.history.pushState(null, '', '/contractors');
    goTo('/contractors');
    expect(scroller.scrollTop).toBe(0);
  });
});

describe('ShellScrollMemory — podzakładka sekcji zmienia tylko tabelę (25.10.2026)', () => {
  it('kliknięcie zakładki z `data-ff-keep-scroll` nie wraca na górę ekranu', () => {
    const tab = document.createElement('a');
    tab.href = '/invoices/recurring';
    tab.setAttribute('data-ff-keep-scroll', '');
    document.body.append(tab);
    setScrollTop(520);
    tab.click();
    window.history.pushState(null, '', '/invoices/recurring');
    goTo('/invoices/recurring');
    expect(scroller.scrollTop).toBe(520);
    tab.remove();
  });

  it('zwykły link po podzakładce znowu zaczyna od góry', () => {
    const tab = document.createElement('a');
    tab.href = '/invoices/recurring';
    tab.setAttribute('data-ff-keep-scroll', '');
    document.body.append(tab);
    setScrollTop(520);
    tab.click();
    window.history.pushState(null, '', '/invoices/recurring');
    goTo('/invoices/recurring');
    document.body.click();
    window.history.pushState(null, '', '/przeplywy');
    goTo('/przeplywy');
    expect(scroller.scrollTop).toBe(0);
    tab.remove();
  });
});

describe('blokada przewijania dokumentu w panelu', () => {
  const css = readFileSync('app/globals.css', 'utf8');
  const layout = readFileSync('app/(dashboard)/layout.tsx', 'utf8');

  it('korzeń szkieletu ma `ff-app-shell`, a obok niego stoi `ShellScrollMemory`', () => {
    expect(layout).toContain('className="ff-dashboard ff-app-shell relative h-[100dvh]');
    expect(layout).toContain('<ShellScrollMemory />');
  });

  it('dokument nie ma przewijania ani „gumki”, ale tylko na ekranie (wydruk bez zmian)', () => {
    const rule = /@media screen \{\s*html:has\(\.ff-app-shell\),\s*html:has\(\.ff-app-shell\) body \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('height: 100%;');
    expect(rule).toContain('min-height: 0;');
    expect(rule).toContain('overflow: hidden;');
    expect(rule).toContain('overscroll-behavior: none;');
  });

  it('obszar treści nie przekazuje przewijania dalej', () => {
    const rule = /\.ff-shell-scroll \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('overscroll-behavior-y: contain;');
  });
});
