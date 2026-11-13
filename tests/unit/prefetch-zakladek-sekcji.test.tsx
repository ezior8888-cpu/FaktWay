// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SectionTab } from '@/components/lists/section-tabs';

/**
 * Plan skalowania 3000, sesja 10: zakładki sekcji bez pełnego prefetchu z góry.
 *
 * Rząd zakładek Faktur, Kosztów i Księgowości miał pełny prefetch
 * (`prefetch={true}`). Wejście na „Wystawione” renderowało więc na serwerze,
 * z danymi, także „Cykliczne” i „Po terminie”: każda zakładka to żądanie RSC
 * przez bramkę logowania (`proxy.ts` pyta GoTrue) i zapytania strony do bazy.
 * Link Nexta pobiera to od nowa po każdym `router.refresh()` na ekranie sekcji,
 * bo unieważnienie pamięci każe mu pobrać jeszcze raz wszystko, co ma na ekranie.
 *
 * Nowy limit: zaraz po wejściu na ekran sekcji 0 zakładek pobranych w pełni.
 * Zakładka pobiera się w pełni dopiero z zamiarem: kursor zostanie na niej
 * (przelot się nie liczy) albo dojdzie do niej klawiatura. Wejście kursora od
 * razu zamawia samo drzewo trasy (domyślny prefetch), żeby przejście nie
 * pobrało strony drugi raz. Dotyk nie pobiera z wyprzedzeniem, bo samo
 * przejście po dotknięciu pobiera stronę.
 *
 * Link Nexta podstawiamy atrapą, która odkłada `prefetch` w `data-prefetch`
 * (prawdziwy pobiera dopiero w buildzie produkcyjnym), a `router.prefetch`
 * to szpieg. Czasy zamiaru są w `components/lists/section-tab-link.tsx`.
 * Tu „zatrzymanie” to 1 s, a „przelot” 20 ms, czyli wyraźnie po obu stronach
 * obu czasów.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({ pathname: '/invoices' }));
const router = vi.hoisted(() => ({ prefetch: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => router,
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  // Propsy Nexta, których `<a>` nie zna.
  const TYLKO_NEXT = new Set(['prefetch', 'scroll']);
  return {
    default: (props: Record<string, unknown>) => {
      const reszta = Object.fromEntries(Object.entries(props).filter(([klucz]) => !TYLKO_NEXT.has(klucz)));
      const prefetch = props.prefetch === undefined ? 'auto' : String(props.prefetch);
      return React.createElement('a', { ...reszta, 'data-prefetch': prefetch });
    },
    // `LinkPendingMark` w każdej zakładce.
    useLinkStatus: () => ({ pending: false }),
  };
});

const { SectionTabsNav } = await import('@/components/lists/section-tabs-nav');
const { INVOICES_TABS } = await import('@/components/invoices/invoices-tabs');
const { COSTS_TABS } = await import('@/components/expenses/costs-tabs');
const { zakladkiKsiegowosci } = await import('@/components/reports/ksiegowosc-tabs');

const KSIEGOWOSC_PELNA = zakladkiKsiegowosci({ tenMiesiac: true, ewidencja: true, vat: true, ustawienia: true });

const SEKCJE: { sekcja: string; tabs: readonly SectionTab[] }[] = [
  { sekcja: 'Faktury', tabs: INVOICES_TABS },
  { sekcja: 'Koszty', tabs: COSTS_TABS },
  // Wszystkie zakładki modułu JDG naraz, czyli najdłuższy rząd.
  { sekcja: 'Księgowość', tabs: KSIEGOWOSC_PELNA },
];

/** Każdy ekran każdej sekcji jako miejsce wejścia. */
const WEJSCIA = SEKCJE.flatMap(({ sekcja, tabs }) => tabs.map((tab) => ({ sekcja, tabs, tab })));

/** Najwyżej tyle zakładek może się pobrać w pełni zaraz po wejściu na ekran sekcji. */
const LIMIT_PELNYCH_Z_GORY = 0;

const ZATRZYMANIE_MS = 1000;
const PRZELOT_MS = 20;
/** Fokus, który Tab przenosi dalej szybciej niż zamiar klawiatury. */
const FOKUS_W_PRZEJSCIU_MS = 150;

/** Domyślny prefetch (drzewo trasy) i pełny prefetch, jak w wywołaniach `router.prefetch`. */
const drzewo = (href: string) => [href];
const pelny = (href: string) => [href, { kind: 'full' }];

let kontener: HTMLDivElement;
let korzen: Root;
const bezNawigacji = (e: Event) => e.preventDefault();

beforeEach(() => {
  vi.useFakeTimers();
  router.prefetch.mockClear();
  kontener = document.createElement('div');
  document.body.append(kontener);
  korzen = createRoot(kontener);
  // jsdom nie umie przechodzić między stronami po kliknięciu linku.
  document.addEventListener('click', bezNawigacji);
});

afterEach(() => {
  act(() => korzen.unmount());
  kontener.remove();
  document.removeEventListener('click', bezNawigacji);
  vi.useRealTimers();
});

/** Wejście na adres: ścieżka dla `usePathname`, cały adres (z parametrami) w pasku. */
function wejdz(adres: string, tabs: readonly SectionTab[]) {
  window.history.replaceState(null, '', adres);
  nav.pathname = window.location.pathname;
  act(() => korzen.render(<SectionTabsNav label="Zakładki sekcji" tabs={tabs} />));
}

function zakladka(label: string): HTMLAnchorElement {
  const link = [...kontener.querySelectorAll('a')].find((a) => a.textContent === label);
  if (!link) throw new Error(`brak zakładki „${label}”`);
  return link;
}

/** Trasy pobrane w pełni: Link z `prefetch={true}` (pobiera sam, gdy stoi na ekranie) i `router.prefetch` z `kind: 'full'`. */
function pelnePobrania(): string[] {
  const zLinku = [...kontener.querySelectorAll('a[data-prefetch="true"]')].map((a) => a.getAttribute('href') ?? '?');
  const zRoutera = router.prefetch.mock.calls
    .filter(([, opcje]) => (opcje as { kind?: string } | undefined)?.kind === 'full')
    .map(([href]) => String(href));
  return [...zLinku, ...zRoutera];
}

function czekaj(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function wyslij(el: Element, zdarzenie: Event) {
  act(() => {
    el.dispatchEvent(zdarzenie);
  });
}

const najedz = (el: Element, pointerType = 'mouse') =>
  wyslij(el, new PointerEvent('pointerover', { bubbles: true, pointerType }));
const zjedz = (el: Element) =>
  wyslij(el, new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body }));
const wcisnij = (el: Element) => wyslij(el, new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));

/** Fokus jak po klawiszu Tab (`:focus-visible`). */
function fokusKlawiatura(el: HTMLElement) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    el.focus();
  });
}

describe('zakładki sekcji: bez pełnego prefetchu z góry', () => {
  for (const { sekcja, tabs, tab } of WEJSCIA) {
    it(`${sekcja}, wejście na „${tab.label}”: pełny prefetch najwyżej dla ${LIMIT_PELNYCH_Z_GORY} zakładek`, () => {
      wejdz(tab.href, tabs);
      czekaj(5 * ZATRZYMANIE_MS);
      const pelne = pelnePobrania();
      expect(pelne.length, `pobrane w pełni od razu: ${pelne.join(', ')}`).toBeLessThanOrEqual(LIMIT_PELNYCH_Z_GORY);
      // Bez zamiaru link nie zamawia też drzewa.
      expect(router.prefetch).not.toHaveBeenCalled();
    });
  }

  for (const { sekcja, tabs } of SEKCJE) {
    it(`${sekcja}: Link nie pobiera zakładek sam, więc router.refresh() nie pobiera ich od nowa`, () => {
      wejdz(tabs[0]!.href, tabs);
      // Każdy prefetch inny niż `false` (także domyślny) Link powtarza po
      // unieważnieniu pamięci. Domyślny dla Faktur i Kosztów i tak niczego nie
      // daje: najbliższy `loading.tsx` stoi nad layoutem sekcji, więc przyszłoby
      // samo drzewo trasy.
      const zLinku = [...kontener.querySelectorAll('a:not([data-prefetch="false"])')].map((a) => a.getAttribute('href'));
      expect(zLinku).toEqual([]);
    });
  }
});

describe('zakładki sekcji: pełne pobranie z zamiarem', () => {
  beforeEach(() => wejdz('/invoices', INVOICES_TABS));

  it('wejście kursora od razu zamawia drzewo trasy, jeszcze bez strony z danymi', () => {
    najedz(zakladka('Cykliczne'));
    expect(router.prefetch.mock.calls).toEqual([drzewo('/invoices/recurring')]);
  });

  it('kursor, który zostaje na zakładce, pobiera jej stronę w pełni, raz', () => {
    najedz(zakladka('Cykliczne'));
    czekaj(ZATRZYMANIE_MS);
    expect(router.prefetch.mock.calls).toEqual([drzewo('/invoices/recurring'), pelny('/invoices/recurring')]);
  });

  it('przelot kursora nad zakładką nie pobiera strony w pełni', () => {
    const poTerminie = zakladka('Po terminie');
    najedz(poTerminie);
    czekaj(PRZELOT_MS);
    zjedz(poTerminie);
    czekaj(ZATRZYMANIE_MS);
    expect(router.prefetch.mock.calls).toEqual([drzewo('/payments/overdue')]);
  });

  it('kliknięcie przed upływem zamiaru nie pobiera strony w pełni, bo przyniesie ją samo przejście', () => {
    const cykliczne = zakladka('Cykliczne');
    najedz(cykliczne);
    czekaj(PRZELOT_MS);
    wcisnij(cykliczne);
    czekaj(ZATRZYMANIE_MS);
    expect(router.prefetch.mock.calls).toEqual([drzewo('/invoices/recurring')]);
  });

  it('dotyk niczego nie pobiera z wyprzedzeniem', () => {
    najedz(zakladka('Cykliczne'), 'touch');
    czekaj(ZATRZYMANIE_MS);
    expect(router.prefetch).not.toHaveBeenCalled();
  });

  it('bieżąca zakładka nie pobiera się po najechaniu', () => {
    najedz(zakladka('Wystawione'));
    czekaj(ZATRZYMANIE_MS);
    expect(router.prefetch).not.toHaveBeenCalled();
  });

  it('fokus z klawiatury pobiera zakładkę jak kursor, który na niej został', () => {
    fokusKlawiatura(zakladka('Po terminie'));
    czekaj(ZATRZYMANIE_MS);
    expect(router.prefetch.mock.calls).toEqual([drzewo('/payments/overdue'), pelny('/payments/overdue')]);
  });

  it('Tab przez rząd nie pobiera mijanych zakładek w pełni', () => {
    fokusKlawiatura(zakladka('Cykliczne'));
    czekaj(FOKUS_W_PRZEJSCIU_MS);
    fokusKlawiatura(zakladka('Po terminie'));
    czekaj(FOKUS_W_PRZEJSCIU_MS);
    act(() => zakladka('Po terminie').blur());
    czekaj(ZATRZYMANIE_MS);
    expect(router.prefetch.mock.calls).toEqual([drzewo('/invoices/recurring'), drzewo('/payments/overdue')]);
  });

  it('Enter tuż po fokusie nie pobiera strony w pełni, bo przyniesie ją samo przejście', () => {
    const poTerminie = zakladka('Po terminie');
    fokusKlawiatura(poTerminie);
    wyslij(poTerminie, new MouseEvent('click', { bubbles: true, cancelable: true }));
    czekaj(ZATRZYMANIE_MS);
    expect(router.prefetch.mock.calls).toEqual([drzewo('/payments/overdue')]);
  });

  it('fokus od kliknięcia myszką niczego nie dokłada', () => {
    const cykliczne = zakladka('Cykliczne');
    act(() => {
      cykliczne.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      cykliczne.focus();
    });
    czekaj(ZATRZYMANIE_MS);
    expect(router.prefetch).not.toHaveBeenCalled();
  });

  it('zakładka zdjęta z ekranu przed upływem zamiaru nie pobiera strony w pełni', () => {
    najedz(zakladka('Cykliczne'));
    czekaj(PRZELOT_MS);
    act(() => korzen.render(<p>inny ekran</p>));
    czekaj(ZATRZYMANIE_MS);
    expect(router.prefetch.mock.calls).toEqual([drzewo('/invoices/recurring')]);
  });
});

describe('zakładki sekcji: podświetlona zakładka przy parametrach w adresie', () => {
  // Decyzja z przeglądu: kursor często stoi na podświetlonej zakładce, a klik w nią
  // (zerowanie miesiąca albo filtra) jest rzadki, więc jej nie pobieramy, choć
  // adres bez parametrów to inna strona.
  it('KPiR przy ?month= nie pobiera się po najechaniu', () => {
    wejdz('/reports/kpir?month=9&year=2026', KSIEGOWOSC_PELNA);
    const kpir = zakladka('KPiR');
    expect(kpir.getAttribute('aria-current')).toBe('page');
    najedz(kpir);
    czekaj(ZATRZYMANIE_MS);
    expect(router.prefetch).not.toHaveBeenCalled();
  });
});
