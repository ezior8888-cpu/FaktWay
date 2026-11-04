// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

/**
 * Dolny pasek telefonu.
 *
 * Poprawka Bartosza 21.10.2026: koło plusa stoi w pasku na miejscu napisu
 * (bez `-mt-5`), napis zostaje tylko dla czytników ekranu (`sr-only`).
 *
 * Poprawka Bartosza 25.10.2026:
 *  - koło ugina się i obraca pod palcem (`[data-ff-plus]`, framer-motion);
 *  - „podświetla się i nic się nie dzieje, dopiero za drugim razem”: samo
 *    dotknięcie (`pointerdown`) nie może zapalić slotu — zapala go dopiero
 *    trwająca nawigacja; wybór w arkuszu „Więcej” zamyka arkusz od razu.
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
}));
vi.mock('@/app/(auth)/login/actions', () => ({ signOut: async () => {} }));

const { BottomNav } = await import('@/components/dashboard/bottom-nav');
const { dashboardMobileTabs } = await import('@/lib/dashboard-nav-config');

function mount(pathname: string) {
  nav.pathname = pathname;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<BottomNav />));
  return {
    host,
    bar: host.querySelector('nav[aria-label="Nawigacja główna"]')!,
    unmount() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** Nazwa dostępna: tekst bez elementów `aria-hidden` (jak w przeglądarce). */
function nazwaDostepna(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof Element) || node.getAttribute('aria-hidden') === 'true') return '';
  return [...node.childNodes].map(nazwaDostepna).join('').trim();
}

/** Tekst WIDOCZNY: pomija `aria-hidden` oraz elementy `sr-only`. */
function widocznyTekst(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof Element)) return '';
  if (node.getAttribute('aria-hidden') === 'true' || node.classList.contains('sr-only')) return '';
  return [...node.childNodes].map(widocznyTekst).join('').trim();
}

describe('Dolna nawigacja — koło „Nowa”', () => {
  it('koło nie jest wyniesione (bez -mt-5), a napis jest tylko dla czytników (sr-only)', () => {
    const m = mount('/dashboard');
    const link = m.bar.querySelector<HTMLAnchorElement>('a[href="/invoices/new"]')!;
    expect(link).not.toBeNull();

    const circle = link.querySelector<HTMLElement>('[data-ff-plus]')!;
    expect(circle.getAttribute('aria-hidden')).toBe('true');
    expect(circle.className).toContain('rounded-full');
    expect(circle.className).not.toContain('-mt-5');

    // Napis: osobny span po kole, sr-only, bez podciągania pod koło (-mt-3).
    const label = [...link.querySelectorAll('span')].find((s) => s.textContent === 'Nowa')!;
    expect(label).toBeDefined();
    expect(label.classList.contains('sr-only')).toBe(true);
    expect(label.className).not.toContain('-mt-3');
    expect(link.innerHTML).not.toMatch(/-mt-[35]/);

    // Wzrokowo w slocie jest samo koło — żadnego widocznego tekstu.
    expect(widocznyTekst(link)).toBe('');
    m.unmount();
  });

  it('każdy slot ma dolny bezpieczny obszar — koło nie zjeżdża w strefę paska domowego iPhone’a', () => {
    const m = mount('/dashboard');
    for (const slot of m.bar.querySelectorAll<HTMLElement>(':scope > a, :scope > button')) {
      expect(slot.className, slot.textContent ?? '').toContain('pb-[var(--ff-safe-b)]');
    }
    m.unmount();
  });

  it('link zachowuje nazwę dostępną „Nowa” i aria-current na /invoices/new', () => {
    const poza = mount('/dashboard');
    const linkPoza = poza.bar.querySelector<HTMLAnchorElement>('a[href="/invoices/new"]')!;
    expect(nazwaDostepna(linkPoza)).toBe('Nowa');
    expect(linkPoza.hasAttribute('aria-current')).toBe(false);
    poza.unmount();

    const na = mount('/invoices/new');
    const linkNa = na.bar.querySelector<HTMLAnchorElement>('a[href="/invoices/new"]')!;
    expect(nazwaDostepna(linkNa)).toBe('Nowa');
    expect(linkNa.getAttribute('aria-current')).toBe('page');
    na.unmount();
  });
});

describe('Dolna nawigacja — podświetlenie tylko przy prawdziwej nawigacji', () => {
  it('samo dotknięcie (pointerdown bez kliknięcia) nie zapala slotu', () => {
    const m = mount('/dashboard');
    const faktury = m.bar.querySelector<HTMLAnchorElement>('a[href="/invoices"]')!;
    const pulpit = m.bar.querySelector<HTMLAnchorElement>('a[href="/dashboard"]')!;
    const before = faktury.className;

    act(() => {
      faktury.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    });

    expect(faktury.className).toBe(before);
    expect(faktury.className).not.toContain('text-[var(--ff-accent)]');
    expect(pulpit.className).toContain('text-[var(--ff-accent)]');
    m.unmount();
  });

  it('wybór w arkuszu „Więcej” zamyka arkusz od razu, a „Więcej” czeka na stronę', () => {
    const m = mount('/dashboard');
    const more = [...m.bar.querySelectorAll('button')].find((b) => b.textContent === 'Więcej')!;
    act(() => more.click());
    const row = document.querySelector<HTMLAnchorElement>('a[href="/contractors"]')!;
    expect(row).not.toBeNull();

    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(more.querySelector('[data-link-pending]')).not.toBeNull();
    m.unmount();
  });

  it('linki slotów: aria-current na swojej trasie, widoczne podpisy', () => {
    const m = mount('/invoices');
    for (const tab of dashboardMobileTabs.filter((t) => !t.emphasis)) {
      const slot =
        tab.href === null
          ? [...m.bar.querySelectorAll('button')].find((b) => b.textContent === tab.label)!
          : m.bar.querySelector<HTMLAnchorElement>(`a[href="${tab.href}"]`)!;
      expect(slot, `slot ${tab.label}`).toBeDefined();
      expect(widocznyTekst(slot)).toBe(tab.label);
      expect(slot.querySelector('.sr-only')).toBeNull();
    }
    expect(m.bar.querySelector('a[href="/invoices"]')?.getAttribute('aria-current')).toBe('page');
    expect(m.bar.querySelector('a[href="/dashboard"]')?.hasAttribute('aria-current')).toBe(false);
    m.unmount();
  });
});
