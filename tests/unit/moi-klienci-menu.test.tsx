// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Link „Moi klienci” w menu profilu (krok 6.2, część 2): tylko dla
 * księgowej w co najmniej dwóch firmach. Decyzja D1: istniejący komponent
 * (`DropdownMenuItem` z linkiem jak „Ustawienia”), dopisany na końcu grupy,
 * więc pozycje, które są, zostają na swoich miejscach.
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

const mocks = vi.hoisted(() => ({
  memberships: [] as Array<{ organizationId: string; name: string; nip: string; role: string; isActive: boolean }>,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(auth)/login/actions', () => ({ signOut: async () => {} }));
vi.mock('@/app/actions/organizations', () => ({ setActiveOrganizationAction: vi.fn() }));
vi.mock('@/lib/dashboard-shell-data', () => ({
  getDashboardOrgSwitcherProps: async () => ({
    memberships: mocks.memberships,
    activeOrgId: 'org-a',
    activeName: 'Firma A',
    activeNip: '1234567890',
  }),
}));

const { ProfileMenu } = await import('@/components/dashboard/profile-menu');
const { default: DashboardProfileMenu } = await import('@/app/(dashboard)/_components/dashboard-profile-menu');

const czlonkostwo = (organizationId: string, role: string, isActive = false) => ({
  organizationId,
  name: `Firma ${organizationId}`,
  nip: '1234567890',
  role,
  isActive,
});

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

function otworzMenu(clientsLink?: boolean) {
  act(() => {
    root.render(
      <ProfileMenu
        email="ksiegowa@example.test"
        company="Firma A"
        memberships={[czlonkostwo('org-a', 'accountant', true), czlonkostwo('org-b', 'accountant')] as never}
        clientsLink={clientsLink}
        defaultOpen
      />,
    );
  });
}

describe('ProfileMenu: pozycja „Moi klienci”', () => {
  it('z flagą: link na końcu grupy, po pozycjach, które już są', () => {
    otworzMenu(true);
    const link = document.body.querySelector('a[href="/moi-klienci"]');
    expect(link?.textContent).toContain('Moi klienci');
    const adresy = [...document.body.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
    expect(adresy.filter((h) => h === '/settings' || h === '/analizy/sprzedaz' || h === '/moi-klienci')).toEqual([
      '/settings',
      '/analizy/sprzedaz',
      '/moi-klienci',
    ]);
  });

  it('bez flagi: menu takie jak dotąd', () => {
    otworzMenu();
    expect(document.body.querySelector('a[href="/moi-klienci"]')).toBeNull();
    expect(document.body.querySelector('a[href="/settings"]')).not.toBeNull();
  });
});

describe('DashboardProfileMenu liczy, komu pokazać link', () => {
  async function flaga(): Promise<unknown> {
    const element = (await DashboardProfileMenu({ email: 'ksiegowa@example.test' })) as ReactElement<{ clientsLink?: boolean }>;
    return element.props.clientsLink;
  }

  it('księgowa w dwóch firmach dostaje link', async () => {
    mocks.memberships = [czlonkostwo('org-a', 'accountant', true), czlonkostwo('org-b', 'accountant')];
    expect(await flaga()).toBe(true);
  });

  it('właściciel kilku firm i księgowa w jednej firmie: bez linku', async () => {
    mocks.memberships = [czlonkostwo('org-a', 'owner', true), czlonkostwo('org-b', 'owner')];
    expect(await flaga()).toBe(false);
    mocks.memberships = [czlonkostwo('org-a', 'owner', true), czlonkostwo('org-b', 'accountant')];
    expect(await flaga()).toBe(false);
  });
});
