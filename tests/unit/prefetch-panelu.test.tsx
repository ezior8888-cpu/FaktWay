// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan skalowania 3000, sesja 10: prefetch panelu.
 *
 * Każde pobranie trasy z wyprzedzeniem to żądanie RSC przez bramkę logowania
 * (`proxy.ts` pyta GoTrue) i render layoutu panelu na serwerze, a pełne
 * (`prefetch={true}`) renderuje do tego całą stronę z danymi. Po wejściu na
 * panel z góry idą więc tylko cztery cele dolnego paska (najczęstsze
 * czynności, te same na każdej szerokości). Resztę menu (pasek boczny,
 * zębatka, wiersze arkusza „Więcej”) pobiera najechanie, dotknięcie albo
 * fokus, a dolny pasek nie zamawia pełnego renderu.
 *
 * Link Nexta podstawiamy atrapą, która odkłada `prefetch` w `data-prefetch`:
 * prawdziwy pobiera dopiero w buildzie produkcyjnym, gdy jest na ekranie.
 * Link z `prefetch` innym niż `false` liczymy jako pobrany z góry, bo na swojej
 * szerokości stoi na ekranie od wejścia: pasek boczny od 1024 px, dolny pasek
 * poniżej, pasek górny zawsze.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  onchange: null,
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const router = vi.hoisted(() => ({
  prefetch: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  // Propsy Nexta, których `<a>` nie zna.
  const TYLKO_NEXT = new Set(['prefetch', 'scroll', 'replace', 'shallow', 'passHref', 'legacyBehavior', 'locale', 'onNavigate']);
  return {
    default: (props: Record<string, unknown>) => {
      const reszta = Object.fromEntries(Object.entries(props).filter(([klucz]) => !TYLKO_NEXT.has(klucz)));
      const prefetch = props.prefetch === undefined ? 'auto' : String(props.prefetch);
      return React.createElement('a', { ...reszta, 'data-prefetch': prefetch });
    },
    // `LinkPendingMark` w slotach dolnego paska.
    useLinkStatus: () => ({ pending: false }),
  };
});
vi.mock('@/app/(auth)/login/actions', () => ({ signOut: async () => {} }));
// Paleta ⌘K ma własny test i woła akcję wyszukiwania.
vi.mock('@/components/dashboard/command-menu', () => ({
  CommandMenu: () => <button type="button">Szukaj lub przejdź…</button>,
  CommandMenuPhoneTrigger: () => <button type="button" aria-label="Szukaj" />,
}));

const { AppHeader } = await import('@/components/dashboard/app-header');
const { AppSidebar } = await import('@/components/dashboard/app-sidebar');
const { BottomNav } = await import('@/components/dashboard/bottom-nav');
const { PrefetchDashboardRoutes } = await import('@/components/dashboard/prefetch-dashboard-routes');
const { SidebarProvider } = await import('@/components/ui/sidebar');
const { TooltipProvider } = await import('@/components/ui/tooltip');

/** Cele dolnego paska: Pulpit, Faktury, Nowa, Miesiąc. */
const Z_GORY = ['/dashboard', '/invoices', '/invoices/new', '/przeplywy'];
const LIMIT = 4;

const odmontuj: Array<() => void> = [];
afterEach(() => {
  for (const krok of odmontuj.splice(0)) krok();
  router.prefetch.mockClear();
});

/** Montuje powłokę panelu z prefetchem z layoutu i czeka, aż ten ruszy. */
async function wejdzNaPanel(powloka: ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <TooltipProvider>
        <SidebarProvider>
          {powloka}
          <PrefetchDashboardRoutes />
        </SidebarProvider>
      </TooltipProvider>,
    ),
  );
  // `PrefetchDashboardRoutes` czeka na bezczynność (w jsdom `setTimeout(0)`).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  odmontuj.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

/** Trasy pobrane z góry: `router.prefetch` i linki na ekranie bez `prefetch={false}`. */
function trasyZGory(): string[] {
  const zRoutera = router.prefetch.mock.calls.map(([href]) => String(href));
  const zLinkow = [...document.querySelectorAll<HTMLAnchorElement>('a[data-prefetch]')]
    .filter((a) => a.dataset.prefetch !== 'false')
    .map((a) => a.getAttribute('href') ?? '');
  return [...new Set([...zRoutera, ...zLinkow])].sort();
}

/** Najechanie myszą albo dotknięcie: na dotyku `pointerenter` przychodzi razem z dotknięciem, przed kliknięciem. */
function najedz(element: Element, pointerType: 'mouse' | 'touch' = 'mouse'): void {
  act(() => {
    element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType }));
  });
}

describe('Po wejściu na panel z góry idą najwyżej cztery trasy', () => {
  it('komputer (od 1024 px): pasek boczny i pasek górny', async () => {
    await wejdzNaPanel(
      <>
        <AppSidebar />
        <AppHeader profile={null} />
      </>,
    );
    const trasy = trasyZGory();
    expect(trasy.length, trasy.join(', ')).toBeLessThanOrEqual(LIMIT);
    expect(trasy).toEqual([...Z_GORY].sort());
  });

  it('telefon i tablet (poniżej 1024 px): pasek górny i dolny pasek', async () => {
    await wejdzNaPanel(
      <>
        <AppHeader profile={null} />
        <BottomNav />
      </>,
    );
    const trasy = trasyZGory();
    expect(trasy.length, trasy.join(', ')).toBeLessThanOrEqual(LIMIT);
    expect(trasy).toEqual([...Z_GORY].sort());
  });

  it('layout panelu montuje jeden komponent pobierający z góry', () => {
    const layout = readFileSync(join(__dirname, '../../app/(dashboard)/layout.tsx'), 'utf8');
    expect(layout.match(/<Prefetch\w*/g)).toEqual(['<PrefetchDashboardRoutes']);
  });
});

describe('Dolny pasek bez pełnego prefetchu', () => {
  it('żaden link paska ani arkusza „Więcej” nie ma prefetch={true}', async () => {
    const host = await wejdzNaPanel(<BottomNav />);
    const wiecej = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Więcej');
    expect(wiecej).toBeDefined();
    act(() => wiecej!.click());

    const linki = [...document.querySelectorAll<HTMLAnchorElement>('a[data-prefetch]')];
    // Arkusz jest otwarty: są w nim pozycje spoza paska.
    expect(linki.map((a) => a.getAttribute('href'))).toEqual(expect.arrayContaining(['/contractors', '/settings']));
    expect(linki.filter((a) => a.dataset.prefetch === 'true').map((a) => a.getAttribute('href'))).toEqual([]);
    // Ciężkie strony (plan Finora §4) dalej bez prefetchu.
    expect(document.querySelector('a[href="/analizy/sprzedaz"]')?.getAttribute('data-prefetch')).toBe('false');
  });

  it('otwarcie arkusza „Więcej” niczego nie pobiera, wiersz pobiera się przy dotknięciu albo fokusie', async () => {
    const host = await wejdzNaPanel(<BottomNav />);
    const wiecej = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Więcej');
    act(() => wiecej!.click());
    // Po otwarciu myszą albo klawiaturą Base UI stawia fokus na pierwszym wierszu, a wiersz
    // pobiera się przy fokusie. Czekamy na ten fokus: dziś pierwszy jest wiersz Analiz, bez pobrania.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(document.activeElement?.closest('[data-slot="sheet-content"] a')).not.toBeNull();

    const wiersz = (href: string) => document.querySelector(`[data-slot="sheet-content"] a[href="${href}"]`);
    const wiersze = [...document.querySelectorAll<HTMLAnchorElement>('[data-slot="sheet-content"] a[data-prefetch]')];
    expect(wiersze.map((a) => a.getAttribute('href'))).toEqual(expect.arrayContaining(['/contractors', '/settings']));
    // Otwarcie arkusza to jeszcze nie wybór trasy: przy otwarciu nic z niego nie idzie.
    expect(wiersze.filter((a) => a.dataset.prefetch !== 'false').map((a) => a.getAttribute('href'))).toEqual([]);
    expect(trasyZGory()).toEqual([...Z_GORY].sort());

    najedz(wiersz('/contractors')!, 'touch');
    expect(router.prefetch).toHaveBeenCalledWith('/contractors');
    act(() => (wiersz('/settings') as HTMLElement).focus());
    expect(router.prefetch).toHaveBeenCalledWith('/settings');
    // Ciężkie strony (plan Finora §4): także przy dotknięciu nic.
    najedz(wiersz('/analizy/sprzedaz')!, 'touch');
    expect(router.prefetch).not.toHaveBeenCalledWith('/analizy/sprzedaz');
  });
});

describe('Reszta menu pobiera się przy najechaniu', () => {
  it('pozycja spoza czterech: nic z góry, pobranie po najechaniu', async () => {
    const host = await wejdzNaPanel(<AppSidebar />);
    const kontrahenci = host.querySelector('a[href="/contractors"]');
    expect(kontrahenci).not.toBeNull();
    expect(kontrahenci!.getAttribute('data-prefetch')).toBe('false');
    expect(router.prefetch).not.toHaveBeenCalledWith('/contractors');

    najedz(kontrahenci!);
    expect(router.prefetch).toHaveBeenCalledWith('/contractors');
  });

  it('zębatka w pasku górnym pobiera Ustawienia dopiero po najechaniu', async () => {
    const host = await wejdzNaPanel(<AppHeader profile={null} />);
    const zebatka = host.querySelector('a[aria-label="Ustawienia"]');
    expect(zebatka).not.toBeNull();
    expect(zebatka!.getAttribute('data-prefetch')).toBe('false');
    expect(router.prefetch).not.toHaveBeenCalledWith('/settings');

    najedz(zebatka!);
    expect(router.prefetch).toHaveBeenCalledWith('/settings');
  });

  it('Analizy nie pobierają się nawet po najechaniu (ciężkie agregaty, plan Finora §4)', async () => {
    const host = await wejdzNaPanel(<AppSidebar />);
    const analizy = host.querySelector('a[href="/analizy/sprzedaz"]');
    expect(analizy).not.toBeNull();

    najedz(analizy!);
    expect(router.prefetch).not.toHaveBeenCalledWith('/analizy/sprzedaz');
  });
});
