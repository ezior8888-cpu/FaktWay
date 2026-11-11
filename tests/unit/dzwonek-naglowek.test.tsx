// @vitest-environment jsdom
import { act, forwardRef, type AnchorHTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Dzwonek w nagłówku (plan kompletnej aplikacji, krok 8.1, część 2, 00188):
 * prawdziwe powiadomienia zamiast komunikatu „wkrótce FLO”. Liczba
 * nieprzeczytanych, ostatnie wpisy z linkiem do obiektu, „Oznacz wszystkie
 * jako przeczytane”, kliknięcie wpisu oznacza go. Wygląd bez zmian (D1):
 * czerwona kropka przy ikonie, plakietka „N nowe”, ikona ustawień.
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

const m = vi.hoisted(() => ({ load: vi.fn(), markRead: vi.fn() }));

vi.mock('@/app/actions/app-notifications', () => ({
  loadAppNotificationsAction: m.load,
  markAppNotificationsReadAction: m.markRead,
}));
// Link bez routera aplikacji: zwykły odnośnik, kliknięcie nie przeładowuje jsdom.
vi.mock('next/link', () => ({
  default: forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }>(
    function LinkStub({ prefetch: _prefetch, onClick, ...props }, ref) {
      return (
        <a
          ref={ref}
          {...props}
          onClick={(e) => {
            onClick?.(e);
            e.preventDefault();
          }}
        />
      );
    },
  ),
}));

const { NotificationDropdown } = await import('@/components/dashboard/notification-dropdown');

const ITEMS = [
  {
    id: 'n1',
    kind: 'inbox_new',
    title: 'Nowa faktura zakupu',
    body: 'FV 1/2026 od Dostawca sp. z o.o., 123,00 zł',
    link: '/expenses/e1',
    createdAt: '2026-11-11T07:00:00Z',
    read: false,
  },
  {
    id: 'n2',
    kind: 'invoice_rejected',
    title: 'Faktura odrzucona w KSeF',
    body: 'FV/2/11/2026: powód odrzucenia jest na stronie faktury.',
    link: '/invoices/i2',
    createdAt: '2026-11-10T07:00:00Z',
    read: false,
  },
  {
    id: 'n3',
    kind: 'tax_deadline',
    title: 'Termin 20.11.2026: rozliczenie za październik 2026',
    body: 'Za 5 dni, 20.11.2026, mija termin za październik 2026.',
    link: '/reports/ten-miesiac?month=10&year=2026',
    createdAt: '2026-11-09T07:00:00Z',
    read: true,
  },
];

let host: HTMLDivElement;
let root: Root;

async function render(defaultOpen = true) {
  await act(async () => {
    root.render(<NotificationDropdown defaultOpen={defaultOpen} />);
  });
  await act(async () => {});
}

const text = () => document.body.textContent ?? '';
const bell = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
const menuItem = (label: string) =>
  [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes(label));
const unreadMarks = () => (text().match(/Nieprzeczytane\./g) ?? []).length;

beforeEach(() => {
  m.load.mockReset();
  m.markRead.mockReset();
  m.load.mockResolvedValue({ success: true, unread: 2, items: ITEMS });
  m.markRead.mockResolvedValue({ success: true, updated: 2 });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

describe('dzwonek: liczba, lista, oznaczanie', () => {
  it('liczba nieprzeczytanych: plakietka „2 nowe”, kropka przy ikonie i etykieta przycisku', async () => {
    await render();
    expect(m.load).toHaveBeenCalled();
    expect(text()).toContain('2 nowe');
    expect(text()).not.toMatch(/FLO|wkrótce/i);
    expect(bell()?.getAttribute('aria-label')).toBe('Powiadomienia, nieprzeczytane: 2');
    // Kropka przypięta do ikony (jak dotąd), nie do przycisku.
    expect(bell()?.querySelector('span.relative > svg + span.bg-destructive')).not.toBeNull();
    // Ikona ustawień w nagłówku dzwonka prowadzi do ustawień powiadomień.
    expect(document.body.querySelector('a[href="/settings/notifications"]')).not.toBeNull();
  });

  it('lista: tytuł, treść, link do obiektu i znacznik nieprzeczytanych', async () => {
    await render();
    const links = [...document.body.querySelectorAll<HTMLAnchorElement>('a[role="menuitem"]')].map((a) => a.getAttribute('href'));
    for (const item of ITEMS) {
      expect(text()).toContain(item.title);
      expect(text()).toContain(item.body);
      expect(links, item.link).toContain(item.link);
    }
    expect(unreadMarks()).toBe(2);
  });

  it('„Oznacz wszystkie jako przeczytane”: jedna akcja bez listy, potem zero nieprzeczytanych', async () => {
    await render();
    const all = menuItem('Oznacz wszystkie jako przeczytane');
    expect(all).toBeDefined();
    await act(async () => {
      all!.click();
    });
    expect(m.markRead).toHaveBeenCalledTimes(1);
    expect(m.markRead.mock.calls[0]).toEqual([]);
    expect(text()).not.toContain('2 nowe');
    expect(unreadMarks()).toBe(0);
    expect(bell()?.getAttribute('aria-label')).toBe('Powiadomienia');
    expect(bell()?.querySelector('.bg-destructive')).toBeNull();
    expect(menuItem('Oznacz wszystkie jako przeczytane')).toBeUndefined();
  });

  it('kliknięcie nieprzeczytanego wpisu oznacza tylko ten wpis', async () => {
    await render();
    await act(async () => {
      document.body.querySelector<HTMLAnchorElement>('a[href="/expenses/e1"]')!.click();
    });
    expect(m.markRead).toHaveBeenCalledWith(['n1']);
  });

  it('błąd oznaczania: komunikat i ponowny odczyt stanu z bazy', async () => {
    m.markRead.mockResolvedValue({ success: false, error: 'Nie udało się oznaczyć powiadomień. Spróbuj ponownie za chwilę.' });
    await render();
    const before = m.load.mock.calls.length;
    await act(async () => {
      menuItem('Oznacz wszystkie jako przeczytane')!.click();
    });
    await act(async () => {});
    expect(text()).toContain('Nie udało się oznaczyć powiadomień');
    expect(m.load.mock.calls.length).toBeGreaterThan(before);
  });

  it('brak powiadomień: zwykły komunikat, bez plakietki, kropki i „Oznacz wszystkie”', async () => {
    m.load.mockResolvedValue({ success: true, unread: 0, items: [] });
    await render();
    expect(text()).toContain('Nie masz jeszcze powiadomień');
    expect(text()).not.toMatch(/\d+ now(e|ych)/);
    expect(bell()?.querySelector('.bg-destructive')).toBeNull();
    expect(menuItem('Oznacz wszystkie jako przeczytane')).toBeUndefined();
  });

  it('błąd odczytu: komunikat z wyjściem „Spróbuj ponownie”, które czyta jeszcze raz', async () => {
    m.load.mockResolvedValueOnce({ success: false, error: 'Nie udało się wczytać powiadomień. Spróbuj ponownie za chwilę.' });
    await render();
    expect(text()).toContain('Nie udało się wczytać powiadomień');
    const retry = menuItem('Spróbuj ponownie');
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.click();
    });
    await act(async () => {});
    expect(text()).toContain('Nowa faktura zakupu');
  });

  it('wyjątek akcji (np. brak sieci) nie wywraca nagłówka', async () => {
    m.load.mockRejectedValueOnce(new Error('Failed to fetch'));
    await render();
    expect(text()).toContain('Nie udało się wczytać powiadomień');
  });

  it('otwarcie dzwonka czyta powiadomienia ponownie', async () => {
    await render(false);
    expect(m.load).toHaveBeenCalledTimes(1);
    await act(async () => {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        bell()!.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
      }
    });
    await act(async () => {});
    expect(m.load.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(text()).toContain('Nowa faktura zakupu');
  });
});
