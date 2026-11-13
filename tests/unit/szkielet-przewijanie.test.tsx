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

describe('ShellScrollMemory: kliknięcie, zanim przyjdzie strona podzakładki (13.11.2026)', () => {
  // Zakładka, której strona nie była pobrana wcześniej, czeka na serwer.
  // Kliknięcie w tym czasie, które samo nie przenosi w tej karcie (drugie
  // dotknięcie obok zakładki, przycisk), nie może zabrać jej zamiaru: strona
  // zakładki przyszłaby wtedy bez niego i panel skoczyłby na górę.
  const TAB = '/invoices/recurring';
  const added: Element[] = [];

  function add<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    document.body.append(el);
    added.push(el);
    return el;
  }

  function click(el: Element, init: MouseEventInit = {}) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
  }

  /** Strona zakładki przychodzi z serwera: Next zmienia adres i ścieżkę. */
  function land(pathname: string) {
    window.history.pushState(null, '', pathname);
    goTo(pathname);
  }

  afterEach(() => {
    for (const el of added.splice(0)) el.remove();
  });

  it.each([
    ['puste miejsce obok zakładek', () => click(add('nav'))],
    ['przycisk (filtr, zaznaczenie)', () => click(add('button', { type: 'button' }))],
    ['element bez linku w tabeli', () => click(add('span'))],
    ['link bez adresu', () => click(add('a', { role: 'button' }))],
    ['link otwierany w nowej karcie', () => click(add('a', { href: '/pomoc', target: '_blank' }))],
    ['link do pobrania', () => click(add('a', { href: '/api/eksport.csv', download: '' }))],
    ['link z Ctrl (nowa karta)', () => click(add('a', { href: '/przeplywy' }), { ctrlKey: true })],
    ['link z Cmd (nowa karta)', () => click(add('a', { href: '/przeplywy' }), { metaKey: true })],
    ['link z Shift (nowe okno)', () => click(add('a', { href: '/przeplywy' }), { shiftKey: true })],
    ['link z Alt (pobranie)', () => click(add('a', { href: '/przeplywy' }), { altKey: true })],
  ] as const)('drugie kliknięcie bez przejścia w tej karcie (%s) zostawia ekran na miejscu', (_, secondClick) => {
    const tab = add('a', { href: TAB, 'data-ff-keep-scroll': '' });
    setScrollTop(520);
    click(tab);
    secondClick();
    land(TAB);
    expect(scroller.scrollTop).toBe(520);
  });

  it('drugie dotknięcie tej samej zakładki (w znacznik w środku) zostawia ekran na miejscu', () => {
    const tab = add('a', { href: TAB, 'data-ff-keep-scroll': '' });
    const mark = document.createElement('span');
    tab.append(mark);
    setScrollTop(520);
    click(tab);
    click(mark);
    land(TAB);
    expect(scroller.scrollTop).toBe(520);
  });

  it('zwykły link kliknięty w czasie ładowania wygrywa: jego strona zaczyna się od góry', () => {
    const tab = add('a', { href: TAB, 'data-ff-keep-scroll': '' });
    setScrollTop(520);
    click(tab);
    click(add('a', { href: '/przeplywy' }));
    land('/przeplywy');
    expect(scroller.scrollTop).toBe(0);
  });

  it('zwykły link pod adres zakładki kasuje jej zamiar: strona od góry', () => {
    const tab = add('a', { href: TAB, 'data-ff-keep-scroll': '' });
    setScrollTop(520);
    click(tab);
    click(add('a', { href: TAB }));
    land(TAB);
    expect(scroller.scrollTop).toBe(0);
  });

  it('Ctrl + klik w zakładkę (nowa karta) nie zostawia zamiaru w tej karcie', () => {
    const tab = add('a', { href: TAB, 'data-ff-keep-scroll': '' });
    setScrollTop(520);
    click(tab, { ctrlKey: true });
    // Ta karta została na liście. Przejście pod adres zakładki przychodzi
    // później bez kliknięcia linku (np. `router.push` po zapisie formularza).
    land(TAB);
    expect(scroller.scrollTop).toBe(0);
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
