// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Szkielet panelu (plan Finora P0, E2): pasek boczny, nagłówek, menu avatara
 * i stopka. Renderujemy prawdziwe komponenty; podstawiamy tylko router Next
 * (poza aplikacją nie istnieje), akcję wylogowania (`'use server'` ciągnie
 * backend) i paletę ⌘K (ma własny test i woła akcję wyszukiwania).
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

const nav = vi.hoisted(() => ({ pathname: '/dashboard' }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/app/(auth)/login/actions', () => ({ signOut: async () => {} }));

vi.mock('@/components/dashboard/command-menu', () => ({
  CommandMenu: () => <button type="button">Szukaj lub przejdź…</button>,
}));

const { AppSidebar } = await import('@/components/dashboard/app-sidebar');
const { Footer } = await import('@/components/dashboard/footer');
const { SidebarProvider } = await import('@/components/ui/sidebar');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { dashboardNavSections, dashboardSettingsNavItem } = await import('@/lib/dashboard-nav-config');

function renderSidebar(pathname: string): string {
  nav.pathname = pathname;
  return renderToStaticMarkup(
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    </TooltipProvider>,
  );
}

/** Pozycja menu (`<a data-slot="sidebar-menu-button">`) prowadząca pod `href`. */
function anchorFor(html: string, href: string): string {
  const tags = html.match(/<a\s[^>]*>/g) ?? [];
  const hit = tags.filter(
    (tag) => tag.includes('data-slot="sidebar-menu-button"') && tag.includes(` href="${href}"`),
  );
  if (hit.length !== 1) throw new Error(`pozycja menu ${href}: ${hit.length} trafień`);
  return hit[0];
}

/** Atrybut stanu `data-active` (nie klasa `data-active:…` w `class`). */
const ACTIVE_ATTR = /\sdata-active(?:=""|\s|>)/;

describe('AppSidebar — pasek boczny Finory', () => {
  it('rysuje wszystkie sekcje i pozycje z poprawnymi adresami', () => {
    const html = renderSidebar('/dashboard');

    for (const section of dashboardNavSections) {
      expect(html).toContain(`>${section.title}</div>`);
      for (const item of section.items) {
        expect(html).toContain(`>${item.label}</span>`);
        anchorFor(html, item.href);
      }
    }
    expect(html).toContain(`>${dashboardSettingsNavItem.label}</span>`);
    anchorFor(html, dashboardSettingsNavItem.href);
  });

  it('podgląd faktury podświetla „Faktury”, a kreator nie', () => {
    const podglad = renderSidebar('/invoices/abc');
    expect(anchorFor(podglad, '/invoices')).toMatch(ACTIVE_ATTR);
    expect(anchorFor(podglad, '/invoices/new')).not.toMatch(ACTIVE_ATTR);

    const kreator = renderSidebar('/invoices/new/regular');
    expect(anchorFor(kreator, '/invoices')).not.toMatch(ACTIVE_ATTR);
    expect(anchorFor(kreator, '/invoices/new')).toMatch(ACTIVE_ATTR);
  });

  it('Ustawienia w stopce paska świecą na podstronach ustawień', () => {
    const html = renderSidebar('/settings/ksef');
    expect(anchorFor(html, '/settings')).toMatch(ACTIVE_ATTR);
    expect(anchorFor(html, '/dashboard')).not.toMatch(ACTIVE_ATTR);
  });

  it('wariant inset ze zwijaniem do ikon (stałe z D2)', () => {
    const html = renderSidebar('/dashboard');
    expect(html).toContain('data-variant="inset"');
    expect(html).toContain('data-state="expanded"');
  });
});

/** Montuje pasek w jsdom; `przejdz` zmienia adres i renderuje ponownie. */
function mountSidebar(pathname: string) {
  nav.pathname = pathname;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  // Nowy element przy każdym renderze — inaczej React pominie ponowne
  // renderowanie (ten sam obiekt), a podstawiony `usePathname` nie jest stanem.
  const tree = () => (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    </TooltipProvider>
  );
  act(() => root.render(tree()));
  return {
    host,
    przejdz(next: string) {
      nav.pathname = next;
      act(() => root.render(tree()));
    },
    link: (href: string) =>
      host.querySelector<HTMLAnchorElement>(`a[data-slot="sidebar-menu-button"][href="${href}"]`)!,
    sidebar: () => host.querySelector('[data-slot="sidebar"]')!,
    unmount() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('AppSidebar — podświetlenie oczekującego celu', () => {
  it('po A → B → Wstecz do A pozycja B nie zostaje podświetlona', () => {
    const m = mountSidebar('/dashboard');
    act(() => {
      m.link('/invoices').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    expect(m.link('/invoices').hasAttribute('data-active')).toBe(true);
    expect(m.link('/dashboard').hasAttribute('data-active')).toBe(false);

    m.przejdz('/invoices');
    m.przejdz('/dashboard');

    expect(m.link('/dashboard').hasAttribute('data-active')).toBe(true);
    expect(m.link('/invoices').hasAttribute('data-active')).toBe(false);
    m.unmount();
  });
});

describe('AppSidebar — dostępność', () => {
  it('aria-current="page" tylko na pozycji z faktycznie aktywną trasą', () => {
    const m = mountSidebar('/dashboard');
    act(() => {
      m.link('/invoices').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    // Wizualnie świeci cel, ale bieżąca strona to wciąż Pulpit.
    expect(m.link('/invoices').hasAttribute('data-active')).toBe(true);
    expect(m.link('/invoices').getAttribute('aria-current')).toBeNull();
    expect(m.link('/dashboard').getAttribute('aria-current')).toBe('page');
    m.unmount();

    const u = mountSidebar('/settings/ksef');
    expect(u.link('/settings').getAttribute('aria-current')).toBe('page');
    expect(u.link('/dashboard').getAttribute('aria-current')).toBeNull();
    u.unmount();
  });

  it('menu jest w nawigacji z etykietą „Nawigacja główna”', () => {
    const m = mountSidebar('/dashboard');
    const navEl = m.host.querySelector('nav[aria-label="Nawigacja główna"]');
    expect(navEl).not.toBeNull();
    expect(navEl!.querySelector('a[href="/invoices"]')).not.toBeNull();
    expect(navEl!.querySelector('a[href="/settings"]')).not.toBeNull();
    m.unmount();
  });

  it('klasy nie zawierają kombinacji o za niskim kontraście', () => {
    const sidebar = readFileSync(join(__dirname, '../../components/dashboard/app-sidebar.tsx'), 'utf8');

    expect(sidebar).not.toContain('text-sidebar-foreground/50');
    expect(sidebar).toContain('data-active:text-chart-3');
    expect(sidebar).toContain('hover:data-active:text-chart-3');
    expect(sidebar).toContain('dark:data-active:text-primary');
    expect(sidebar).not.toMatch(/(?<!dark:)(?<!dark:hover:)data-active:text-primary/);
  });
});

describe('SidebarProvider — skrót ⌘/Ctrl+B', () => {
  function press(target: EventTarget, init: KeyboardEventInit) {
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true, ...init }));
    });
  }

  it('przełącza pasek z ciała strony, ale nie podczas pisania ani z Shift/Alt', () => {
    const m = mountSidebar('/dashboard');
    const stan = () => m.sidebar().getAttribute('data-state');
    expect(stan()).toBe('expanded');

    const input = document.createElement('input');
    const area = document.createElement('textarea');
    const edit = document.createElement('div');
    edit.contentEditable = 'true';
    // jsdom nie liczy `isContentEditable` z atrybutu — ustawiamy wprost.
    Object.defineProperty(edit, 'isContentEditable', { value: true });
    document.body.append(input, area, edit);

    for (const el of [input, area, edit]) press(el, { ctrlKey: true });
    expect(stan()).toBe('expanded');

    press(document.body, { ctrlKey: true, shiftKey: true });
    press(document.body, { ctrlKey: true, altKey: true });
    expect(stan()).toBe('expanded');

    press(document.body, { ctrlKey: true });
    expect(stan()).toBe('collapsed');
    input.remove();
    area.remove();
    edit.remove();
    m.unmount();
  });
});

describe('Footer — stopka panelu', () => {
  it('nosi nazwę FaktWay, linki prawne i Pomoc', () => {
    const html = renderToStaticMarkup(<Footer />);

    expect(html).toMatch(/^<footer[^>]*class="ff-shell-footer"/);
    expect(html).toContain('FaktWay');
    expect(html).toContain(String(new Date().getFullYear()));
    expect(html).toContain('href="/legal/regulamin"');
    expect(html).toContain('href="/legal/polityka-prywatnosci"');
    expect(html).toContain('>Pomoc</button>');
    // Pływający bąbelek pomocy (prawy dolny róg) nie może zasłaniać „Pomocy”.
    expect(html).toContain('lg:pr-[100px]');
  });

  it('Regulamin, Polityka prywatności i Pomoc mają na telefonie cel dotykowy 44 px', () => {
    const html = renderToStaticMarkup(<Footer />);
    const targets = html.match(/<(?:a|button)\b[^>]*class="[^"]*"/g) ?? [];

    expect(targets).toHaveLength(3);
    for (const tag of targets) {
      expect(tag).toContain('max-sm:min-h-[44px]');
      expect(tag).toContain('max-sm:min-w-[44px]');
    }
  });
});

// Pasek górny i menu profilu (1:1 z Finory, 21.10.2026): tests/unit/finora-pasek-gorny.test.tsx.

