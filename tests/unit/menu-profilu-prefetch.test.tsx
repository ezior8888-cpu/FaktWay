// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan skalowania 3000, sesja 10 (przegląd kodu): menu profilu w pasku górnym
 * nie pobiera Analiz z wyprzedzeniem.
 *
 * Link Nexta bez `prefetch` w buildzie produkcyjnym pobiera trasę, gdy tylko
 * stanie na ekranie. Menu profilu montuje pozycje dopiero po otwarciu, więc
 * samo otwarcie pobierało `/analizy/sprzedaz`: żądanie przez bramkę logowania
 * (`proxy.ts` pyta GoTrue) i render na serwerze. Plan Finora §4: strony
 * z ciężkimi agregatami (`/analizy/*`, `/bank/*`) bez prefetchu, tak jak
 * pozycja Analiz w `lib/dashboard-nav-config.ts`. W App Routerze
 * `prefetch={false}` nie pobiera ani po wejściu na ekran, ani po najechaniu.
 *
 * Atrapa linku Nexta (ta sama co w teście prefetchu panelu z sesji 10)
 * odkłada `prefetch` w `data-prefetch`: prawdziwy link pobiera dopiero
 * w buildzie produkcyjnym.
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

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
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
  };
});
vi.mock('@/app/(auth)/login/actions', () => ({ signOut: async () => {} }));
vi.mock('@/app/actions/organizations', () => ({ setActiveOrganizationAction: vi.fn() }));

const { ProfileMenu } = await import('@/components/dashboard/profile-menu');

const memberships = [
  { organizationId: 'org-a', name: 'Firma Testowa sp. z o.o.', nip: '1234567890', role: 'accountant' as const, isActive: true },
  { organizationId: 'org-b', name: 'Druga Firma S.A.', nip: '1234567890', role: 'accountant' as const, isActive: false },
];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

const link = (href: string) => document.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);

describe('Menu profilu: Analizy bez prefetchu (plan Finora §4)', () => {
  it('po otwarciu menu link do Analiz ma prefetch={false}', async () => {
    // Pełne menu: firmy i „Moi klienci” (księgowa w dwóch firmach).
    act(() => {
      root.render(<ProfileMenu email="ksiegowa@example.test" company="Firma Testowa sp. z o.o." memberships={memberships} clientsLink />);
    });
    // Zamknięte menu nie montuje pozycji: link staje na ekranie dopiero po otwarciu.
    expect(link('/analizy/sprzedaz')).toBeNull();

    const przycisk = host.querySelector<HTMLButtonElement>('button[aria-label="Menu konta"]');
    expect(przycisk).not.toBeNull();
    await act(async () => {
      przycisk!.click();
    });

    // Menu jest otwarte, a atrapa widzi zwykłą pozycję.
    expect(link('/settings'), 'menu się nie otworzyło').not.toBeNull();
    expect(link('/analizy/sprzedaz')?.getAttribute('data-prefetch')).toBe('false');

    // Żadna pozycja menu do ciężkich stron nie pobiera się z góry.
    const ciezkie = [...document.querySelectorAll<HTMLAnchorElement>('a[data-prefetch]')]
      .map((a) => ({ href: a.getAttribute('href') ?? '', prefetch: a.dataset.prefetch }))
      .filter(({ href }) => href.startsWith('/analizy') || href.startsWith('/bank'));
    expect(ciezkie.map(({ href }) => href)).toContain('/analizy/sprzedaz');
    expect(ciezkie.filter(({ prefetch }) => prefetch !== 'false')).toEqual([]);
  });
});
