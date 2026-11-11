// @vitest-environment jsdom
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Poprawka Bartosza 21.10.2026: górny pasek 1:1 z `src/components/layout/Header.tsx`
 * Finory — zwijanie paska, wyszukiwarka | dzwonek, motyw (księżyc), ustawienia
 * (zębatka), profil (szary ludzik zamiast zdjęcia; w menu e‑mail, firma
 * i analiza). Bez panelu personalizacji (paleta kolorów), bez tytułu strony,
 * przełącznika firmy i wordmarku z naszego dawnego paska.
 * Do tego: znika baner „Organizacja niezweryfikowana” (klient dowie się inaczej).
 *
 * Krok 8.1 planu kompletnej aplikacji, część 2 (00188): w dzwonku prawdziwe
 * powiadomienia zamiast komunikatu „wkrótce FLO”, a czerwona kropka tylko przy
 * nieprzeczytanych. Liczba, lista i oznaczanie: `dzwonek-naglowek.test.tsx`.
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

const mocks = vi.hoisted(() => ({ switchOrg: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/invoices',
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: mocks.refresh, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(auth)/login/actions', () => ({ signOut: async () => {} }));
vi.mock('@/app/actions/organizations', () => ({ setActiveOrganizationAction: mocks.switchOrg }));
vi.mock('@/components/dashboard/command-menu', () => ({
  CommandMenu: () => <button type="button">Szukaj lub przejdź…</button>,
  CommandMenuPhoneTrigger: () => <button type="button" aria-label="Szukaj" />,
}));
// Dzwonek czyta powiadomienia akcją serwera (00188); tu bez wpisów.
vi.mock('@/app/actions/app-notifications', () => ({
  loadAppNotificationsAction: vi.fn(async () => ({ success: true, unread: 0, items: [] })),
  markAppNotificationsReadAction: vi.fn(async () => ({ success: true, updated: 0 })),
}));

const { AppHeader } = await import('@/components/dashboard/app-header');
const { NotificationBellButton, NotificationDropdown } = await import('@/components/dashboard/notification-dropdown');
const { ProfileMenu } = await import('@/components/dashboard/profile-menu');
const { SidebarProvider } = await import('@/components/ui/sidebar');
const { TooltipProvider } = await import('@/components/ui/tooltip');

const ROOT = join(__dirname, '..', '..');

const memberships = [
  { organizationId: 'org-a', name: 'Firma Testowa sp. z o.o.', nip: '1234567890', role: 'owner' as const, isActive: true },
  { organizationId: 'org-b', name: 'Druga Firma S.A.', nip: '1234567890', role: 'accountant' as const, isActive: false },
];

function header(profile: ReactNode = <div data-testid="slot-profil" />): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <SidebarProvider>
        <AppHeader profile={profile} />
      </SidebarProvider>
    </TooltipProvider>,
  );
}

describe('AppHeader — pasek górny 1:1 z Finory', () => {
  it('lewa strona: zwijanie paska, separator, wyszukiwarka; bez tytułu strony i wordmarku', () => {
    const html = header();
    expect(html).toMatch(/<header[^>]*class="ff-shell-header/);
    expect(html).toContain('aria-label="Przełącz pasek boczny"');
    expect(html).toContain('data-slot="separator"');
    expect(html).toContain('Szukaj lub przejdź…');
    expect(html).not.toContain('<h1');
    // Telefon (poprawka Bartosza 03.11.2026): logo zamiast lupy, tylko poniżej `sm`.
    // Od `sm` w górę pasek dalej nie ma wordmarku.
    const phoneLogo = /<a[^>]*aria-label="FaktWay, pulpit"[^>]*>[\s\S]*?<\/a>/;
    expect(html.match(phoneLogo)?.[0]).toMatch(/class="[^"]*\bsm:hidden/);
    expect(html.replace(phoneLogo, '')).not.toMatch(/FaktWay|Fakt<\/span>/);
  });

  it('prawa strona w kolejności Finory: dzwonek, motyw, zębatka do ustawień, profil', () => {
    const html = header();
    const bell = html.indexOf('aria-label="Powiadomienia"');
    const gear = html.indexOf('aria-label="Ustawienia"');
    const profile = html.indexOf('data-testid="slot-profil"');
    expect(bell).toBeGreaterThan(-1);
    expect(gear).toBeGreaterThan(bell);
    expect(profile).toBeGreaterThan(gear);
    // Telefon: lupa po prawej przed dzwonkiem, zębatka tylko od `sm` (Ustawienia są w menu profilu).
    const search = html.indexOf('aria-label="Szukaj"');
    expect(search).toBeGreaterThan(-1);
    expect(search).toBeLessThan(bell);
    expect(html.match(/<a[^>]*aria-label="Ustawienia"[^>]*>/)?.[0]).toContain('max-sm:hidden');
    // Dzwonek i profil są prawdziwymi wyzwalaczami menu (props wyzwalacza dochodzą do przycisku).
    expect(html).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*aria-label="Powiadomienia"|<button[^>]*aria-label="Powiadomienia"[^>]*aria-haspopup="menu"/);
    // Czerwona kropka tylko przy nieprzeczytanych (krok 8.1, część 2): pasek z serwera
    // jeszcze ich nie zna, więc bez kropki. Miejsce kropki: test „kropki są przypięte do ikony”.
    expect(html).not.toContain('bg-destructive');
    // Zębatka to link do /settings; panelu personalizacji (paleta) nie ma.
    expect(html).toMatch(/<a[^>]*href="\/settings"[^>]*aria-label="Ustawienia"|<a[^>]*aria-label="Ustawienia"[^>]*href="\/settings"/);
    expect(html).not.toMatch(/Personaliz|Customizer|paleta/i);
  });

  it('bez przełącznika firmy w pasku (firma jest w menu profilu)', () => {
    const html = header();
    expect(html).not.toContain('Wybór organizacji');
    expect(html).not.toContain('NIP ');
  });
});

describe('menu w DOM', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.switchOrg.mockReset();
    mocks.refresh.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('dzwonek: nagłówek „Powiadomienia” i ikona ustawień; bez komunikatu „wkrótce FLO” (krok 8.1, część 2)', async () => {
    await act(async () => {
      root.render(<NotificationDropdown defaultOpen />);
    });
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Powiadomienia/i);
    expect(text).not.toContain('FLO');
    expect(text).not.toMatch(/wkrótce/i);
    // Ikona ustawień w nagłówku dzwonka prowadzi do ustawień powiadomień.
    expect(document.body.querySelector('a[href="/settings/notifications"]')).not.toBeNull();
  });

  it('profil: szary ludzik zamiast zdjęcia i inicjałów', () => {
    const html = renderToStaticMarkup(
      <ProfileMenu email="jan.kowalski@example.test" company="Firma Testowa sp. z o.o." memberships={memberships} />,
    );
    expect(html).toContain('aria-label="Menu konta"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('bg-muted text-muted-foreground');
    expect(html).toContain('<svg');
    expect(html).not.toContain('>JK<');
  });

  it('profil po kliknięciu: e‑mail, firma, Moje firmy, Ustawienia, Analiza, Wyloguj', () => {
    act(() => {
      root.render(
        <ProfileMenu
          email="jan.kowalski@example.test"
          company="Firma Testowa sp. z o.o."
          memberships={memberships}
          defaultOpen
        />,
      );
    });
    const text = document.body.textContent ?? '';
    expect(text).toContain('jan.kowalski@example.test');
    expect(text).toContain('Firma Testowa sp. z o.o.');
    expect(text).toContain('Moje firmy');
    expect(text).toContain('Wyloguj');
    expect(document.body.querySelector('a[href="/settings"]')).not.toBeNull();
    expect(document.body.querySelector('a[href="/analizy/sprzedaz"]')?.textContent).toMatch(/Analiza/);
  });
});

describe('po przeglądzie: kropki, pełne wartości, stan przełączania', () => {
  it('kropki są przypięte do ikony, nie do przycisku (na dotyku przycisk ma 44 px)', () => {
    const html = header(
      <ProfileMenu email="jan.kowalski@example.test" company="Firma Testowa sp. z o.o." memberships={memberships} />,
    );
    // Zielona kropka profilu siedzi w `relative` razem z ikoną.
    expect(html).toMatch(/<span class="relative block"><span[^>]*data-slot="avatar"[\s\S]*?<\/span><span class="ring-card absolute/);
    // Czerwona kropka dzwonka (przy nieprzeczytanych) też. Finora: `top-1.75 right-2` wobec
    // 32-pikselowego przycisku; u nas wobec ikony (przycisk na dotyku ma 44 px), to samo miejsce przy 32 px.
    const bell = renderToStaticMarkup(<NotificationBellButton unread={1} />);
    expect(bell).toMatch(/<span class="relative[^"]*"><svg[^>]*>.*?<\/svg><span class="bg-destructive absolute -top-px right-0 size-1.5 rounded-full"/);
    expect(renderToStaticMarkup(<NotificationBellButton unread={0} />)).not.toContain('bg-destructive');
  });

  it('ucięty e‑mail i nazwa firmy mają pełną wartość w title', () => {
    let host: HTMLDivElement | null = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <ProfileMenu email="bardzo.dlugi.adres@example.test" company="Bardzo Długa Nazwa Firmy sp. z o.o." memberships={memberships} defaultOpen />,
      );
    });
    expect(document.body.querySelector('[title="bardzo.dlugi.adres@example.test"]')).not.toBeNull();
    expect(document.body.querySelector('[title="Bardzo Długa Nazwa Firmy sp. z o.o."]')).not.toBeNull();
    act(() => root.unmount());
    host.remove();
    host = null;
  });

  it('podczas przełączania firmy przycisk profilu jest wyłączony (menu zamknięte nie gubi stanu)', async () => {
    let resolve!: (v: { success: true }) => void;
    mocks.switchOrg.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <ProfileMenu email="jan.kowalski@example.test" company="Firma Testowa sp. z o.o." memberships={memberships} defaultOpen />,
      );
    });
    const sub = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes('Moje firmy'));
    expect(sub).toBeDefined();
    await act(async () => {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        sub!.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
      }
    });
    const druga = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes('Druga Firma S.A.'));
    expect(druga).toBeDefined();
    await act(async () => {
      druga!.click();
    });
    expect(mocks.switchOrg).toHaveBeenCalledWith('org-b');
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Menu konta"]');
    expect(trigger?.disabled).toBe(true);
    await act(async () => {
      resolve({ success: true });
    });
    expect(mocks.refresh).toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Menu konta"]')?.disabled).toBe(false);
    act(() => root.unmount());
    host.remove();
  });
});

describe('baner „Organizacja niezweryfikowana” usunięty', () => {
  it('layout panelu go nie montuje, a pliku banera nie ma', () => {
    const layout = readFileSync(join(ROOT, 'app/(dashboard)/layout.tsx'), 'utf8');
    expect(layout).not.toContain('DashboardVerificationBanner');
    expect(existsSync(join(ROOT, 'app/(dashboard)/_components/dashboard-verification-banner.tsx'))).toBe(false);
  });

  it('żaden ekran nie pokazuje tekstu „Organizacja niezweryfikowana”', () => {
    const hits: string[] = [];
    // Typ wpisu z `readdirSync({ withFileTypes })`, bez osobnego `statSync` przed
    // odczytem — CodeQL (js/file-system-race) odrzuca sprawdzenie i odczyt rozdzielone w czasie.
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(tsx?|mdx)$/.test(entry.name) && /Organizacja niezweryfikowana/.test(readFileSync(path, 'utf8'))) hits.push(path);
      }
    };
    for (const dir of ['app', 'components', 'content']) walk(join(ROOT, dir));
    expect(hits).toEqual([]);
  });
});
