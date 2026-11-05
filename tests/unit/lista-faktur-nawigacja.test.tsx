// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Przegląd E3 (C4–C8): nawigacja i stan ekranu /invoices.
 *  - C4: pasek filtrów odtwarzany po zmianie adresu (Wyczyść / Wstecz to soft nawigacja),
 *  - C5: paginacja na telefonie (< sm) nie wypycha Poprzednia/Następna poza ekran,
 *  - C6: odświeżenie danych z serwera nie remontuje listy (zaznaczenie przeżywa),
 *  - C7: karta telefonu pisze „Opłacona” raz,
 *  - C8: linki paginacji to next/link o semantyce linku (bez role="button").
 */

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
const realtime = vi.hoisted(() => ({
  handlers: [] as Array<{ event: string; cb: (payload: { new?: unknown; old?: unknown }) => void }>,
}));

vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ children, ...props }: React.ComponentProps<'a'>) =>
      React.createElement('a', { 'data-next-link': '', ...props }, children),
  };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/invoices/actions-detail', () => ({ downloadInvoiceXmlAction: vi.fn() }));
vi.mock('@/components/invoices/draft-actions', () => ({ deleteDraftInvoiceAction: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const channel = {
      on(_type: string, config: { event: string }, cb: (payload: { new?: unknown; old?: unknown }) => void) {
        realtime.handlers.push({ event: config.event, cb });
        return channel;
      },
      subscribe() {
        return channel;
      },
    };
    return { channel: () => channel, removeChannel: vi.fn() };
  },
}));

import { InvoiceList } from '@/components/invoices/invoice-list';
import type { InvoiceRow } from '@/components/invoices/invoice-row-types';
import { SwipeableInvoiceRow } from '@/components/invoices/swipeable-invoice-row';
import { InvoicesPagination } from '@/app/(dashboard)/invoices/_components/invoices-pagination';
import { InvoicesPullToRefresh } from '@/app/(dashboard)/invoices/_components/invoices-pull-to-refresh';
import { InvoicesToolbar } from '@/app/(dashboard)/invoices/_components/invoices-toolbar';
import type { InvoiceListRowFacts } from '@/lib/invoices/list-row-facts';
import { parseInvoiceListParams } from '@/lib/invoices/list-query';

const TODAY = '2026-10-17';

function invoice(over: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: 'inv-1',
    internal_number: 'FV/1/2026',
    issue_date: '2026-10-01',
    buyer_data: { name: 'Acme spółka z ograniczoną odpowiedzialnością', nip: '1234567890' },
    gross_total: 1230,
    ksef_status: 'accepted',
    ksef_number: '1234567890-20261001-ABC',
    created_at: '2026-10-01T10:00:00Z',
    xml_storage_path: 'ten-1/inv-1.xml',
    payment_status: 'unpaid',
    payment_due_date: '2026-10-30',
    paid_amount: 0,
    currency: 'PLN',
    invoice_kind: 'regular',
    last_error_code: null,
    ...over,
  };
}

const facts = (over: Partial<InvoiceListRowFacts> = {}): InvoiceListRowFacts => ({
  payment: 'unpaid',
  outstanding: 1230,
  canCorrect: false,
  canMarkPaid: false,
  ...over,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  realtime.handlers.length = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (node: ReactElement) => act(() => root.render(node));
const field = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
const html = (node: ReactElement) => {
  const div = document.createElement('div');
  div.innerHTML = renderToStaticMarkup(node);
  return div;
};

describe('C4: pasek filtrów podąża za adresem', () => {
  const filteredParams = () =>
    parseInvoiceListParams({
      q: 'Acme',
      status: 'przyjete',
      platnosc: 'po_terminie',
      rodzaj: 'final',
      // Lista 1:1 z Finory (21.10.2026): 10 jest teraz domyślne, więc ustawione w adresie jest niedomyślne 25 (było 10).
      na_stronie: '25',
      od: '2026-09-01',
    });

  it('po „Wyczyść” (soft nawigacja, ten sam segment) wszystkie pola wracają do domyślnych', () => {
    render(<InvoicesToolbar params={filteredParams()} filtered />);
    expect(field('status')?.value).toBe('przyjete');
    expect(field('platnosc')?.value).toBe('po_terminie');
    expect(field('rodzaj')?.value).toBe('final');
    expect(field('na_stronie')?.value).toBe('25');

    render(<InvoicesToolbar params={parseInvoiceListParams({})} filtered={false} />);
    expect(field('status')?.value).toBe('wszystkie');
    expect(field('platnosc')?.value).toBe('wszystkie');
    expect(field('rodzaj')?.value).toBe('wszystkie');
    // Lista 1:1 z Finory (21.10.2026): po „Wyczyść” wraca domyślne „Pokaż 10” (było 50).
    expect(field('na_stronie')?.value).toBe('10');
    expect(field('od')?.value).toBe('');
  });

  it('wpisana, niezatwierdzona fraza znika po „Wyczyść”', () => {
    render(<InvoicesToolbar params={filteredParams()} filtered />);
    const q = field('q') as HTMLInputElement;
    act(() => {
      q.value = 'coś innego';
    });
    render(<InvoicesToolbar params={parseInvoiceListParams({})} filtered={false} />);
    expect(field('q')?.value).toBe('');
  });

  it('zmiana samej strony nie odtwarza formularza (wpisany tekst zostaje przy paginacji)', () => {
    render(<InvoicesToolbar params={parseInvoiceListParams({ q: 'Acme' })} filtered />);
    const before = host.querySelector('form');
    render(<InvoicesToolbar params={parseInvoiceListParams({ q: 'Acme', strona: '2' })} filtered />);
    expect(host.querySelector('form')).toBe(before);
  });

  it('„Pokaż N” nie odtwarza formularza (fokus zostaje na wyborze), a wybór idzie za adresem', () => {
    render(<InvoicesToolbar params={parseInvoiceListParams({ q: 'Acme' })} filtered />);
    const before = host.querySelector('form');
    // Lista 1:1 z Finory (21.10.2026): domyślne jest 10, więc zmiana na niedomyślne 25 (było 10 → 50 i z powrotem).
    render(<InvoicesToolbar params={parseInvoiceListParams({ q: 'Acme', na_stronie: '25' })} filtered />);
    expect(host.querySelector('form')).toBe(before);
    expect(field('na_stronie')?.value).toBe('25');
    // Wstecz do domyślnych 10 też bez odtwarzania formularza.
    render(<InvoicesToolbar params={parseInvoiceListParams({ q: 'Acme' })} filtered />);
    expect(host.querySelector('form')).toBe(before);
    expect(field('na_stronie')?.value).toBe('10');
  });
});

describe('C5: paginacja na telefonie', () => {
  const pager = () => html(<InvoicesPagination params={parseInvoiceListParams({ strona: '5', na_stronie: '10' })} total={100} />);
  const itemOf = (el: Element) => el.closest('li') as HTMLElement;
  const hiddenOnPhone = (el: Element) => /(^|\s)hidden(\s|$)/.test(itemOf(el).className) && /sm:/.test(itemOf(el).className);

  it('numery stron i wielokropki są ukryte poniżej sm', () => {
    const doc = pager();
    const numbered = [...doc.querySelectorAll('a[aria-label^="Strona "]')];
    expect(numbered.length).toBeGreaterThanOrEqual(5);
    for (const link of numbered) expect(hiddenOnPhone(link), link.getAttribute('aria-label') ?? '').toBe(true);
    const ellipses = [...doc.querySelectorAll('[data-slot="pagination-ellipsis"]')];
    expect(ellipses.length).toBe(2);
    for (const e of ellipses) expect(hiddenOnPhone(e)).toBe(true);
  });

  it('Poprzednia i Następna zostają widoczne, a między nimi „Strona 5 z 10” (tylko telefon)', () => {
    const doc = pager();
    const items = [...doc.querySelectorAll('li')];
    const first = items[0] as HTMLLIElement;
    const last = items[items.length - 1] as HTMLLIElement;
    expect(first.querySelector('[aria-label="Przejdź do poprzedniej strony"]')).not.toBeNull();
    expect(last.querySelector('[aria-label="Przejdź do następnej strony"]')).not.toBeNull();
    expect(first.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(last.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    const compact = items.find((li) => li.textContent === 'Strona 5 z 10');
    expect(compact, 'brak zwartego „Strona 5 z 10”').toBeDefined();
    expect(compact?.className).toMatch(/sm:hidden/);
    expect(items.indexOf(compact as HTMLLIElement)).toBeGreaterThan(0);
    expect(items.indexOf(compact as HTMLLIElement)).toBeLessThan(items.length - 1);
  });
});

describe('paginacja: dostępność wyłączonych strzałek i zawijanie', () => {
  it('wyłączona „Poprzednia” ma rolę linku, więc aria-label jest dozwolony (axe aria-prohibited-attr)', () => {
    const doc = html(<InvoicesPagination params={parseInvoiceListParams({})} total={120} />);
    const prev = doc.querySelector('[aria-label="Przejdź do poprzedniej strony"]') as HTMLElement;
    expect(prev.getAttribute('aria-disabled')).toBe('true');
    expect(prev.hasAttribute('href')).toBe(false);
    expect(prev.getAttribute('role')).toBe('link');
  });

  it('lista stron zawija się zamiast wystawać (szerokości 640–720 px przy dotyku)', () => {
    const doc = html(<InvoicesPagination params={parseInvoiceListParams({ strona: '5', na_stronie: '10' })} total={100} />);
    const list = doc.querySelector('[data-slot="pagination-content"]') as HTMLElement;
    expect(list.className).toMatch(/(^|\s)flex-wrap(\s|$)/);
  });
});

describe('C6: odświeżenie danych nie remontuje listy', () => {
  const rows = () => [invoice(), invoice({ id: 'inv-2', internal_number: 'FV/2/2026' })];
  const factsById = () => ({ 'inv-1': facts(), 'inv-2': facts() });
  const checkbox = (number: string) => host.querySelector<HTMLElement>(`[aria-label="Zaznacz fakturę ${number}"]`);
  const text = () => host.textContent ?? '';
  const pullToRefresh = (initialInvoices: InvoiceRow[]) => (
    <InvoicesPullToRefresh tenantId="ten-1" initialInvoices={initialInvoices} facts={factsById()} today={TODAY} />
  );

  it('nowy snapshot ze zmienionym statusem z serwera: zaznaczenie zostaje, dane się aktualizują', () => {
    render(pullToRefresh(rows()));
    act(() => checkbox('FV/1/2026')?.click());
    expect(text()).toContain('Pobierz PDF zaznaczonych (1)');
    expect(text()).not.toContain('Odrzucona');

    const [first, second] = rows();
    render(pullToRefresh([first as InvoiceRow, { ...(second as InvoiceRow), ksef_status: 'rejected' }]));
    expect(text()).toContain('Odrzucona');
    expect(text()).toContain('Pobierz PDF zaznaczonych (1)');
    expect(checkbox('FV/1/2026')?.getAttribute('aria-checked')).toBe('true');
  });

  it('Realtime: zmiana statusu widocznej faktury odświeża stronę i nie kasuje zaznaczenia', () => {
    render(pullToRefresh(rows()));
    act(() => checkbox('FV/1/2026')?.click());

    const update = [...realtime.handlers].reverse().find((h) => h.event === 'UPDATE');
    expect(update).toBeDefined();
    act(() => update?.cb({ new: { id: 'inv-2', ksef_status: 'rejected' } }));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Odrzucona');
    expect(text()).toContain('Pobierz PDF zaznaczonych (1)');

    // Serwer odpowiada nowym snapshotem (ta sama zawartość co po Realtime).
    const [first, second] = rows();
    render(pullToRefresh([first as InvoiceRow, { ...(second as InvoiceRow), ksef_status: 'rejected' }]));
    expect(text()).toContain('Pobierz PDF zaznaczonych (1)');
    expect(checkbox('FV/1/2026')?.getAttribute('aria-checked')).toBe('true');
  });

  it('InvoiceList bierze nowy snapshot z serwera (nowe wiersze, brak starych)', () => {
    render(<InvoiceList tenantId="ten-1" initialInvoices={rows()} facts={factsById()} today={TODAY} />);
    expect(text()).toContain('FV/2/2026');
    render(
      <InvoiceList
        tenantId="ten-1"
        initialInvoices={[invoice({ id: 'inv-3', internal_number: 'FV/3/2026' })]}
        facts={{ 'inv-3': facts() }}
        today={TODAY}
      />,
    );
    expect(text()).toContain('FV/3/2026');
    expect(text()).not.toContain('FV/2/2026');
  });

  it('zaznaczenie przycinane do wierszy, które nadal są: zniknięta faktura nie wraca zaznaczona', () => {
    render(<InvoiceList tenantId="ten-1" initialInvoices={rows()} facts={factsById()} today={TODAY} />);
    act(() => checkbox('FV/1/2026')?.click());
    act(() => checkbox('FV/2/2026')?.click());
    expect(text()).toContain('Pobierz PDF zaznaczonych (2)');

    const [, second] = rows();
    render(<InvoiceList tenantId="ten-1" initialInvoices={[second as InvoiceRow]} facts={factsById()} today={TODAY} />);
    expect(text()).toContain('Pobierz PDF zaznaczonych (1)');

    // FV/1 wraca na listę (np. inna strona/filtr) — nie jest już zaznaczona.
    render(<InvoiceList tenantId="ten-1" initialInvoices={rows()} facts={factsById()} today={TODAY} />);
    expect(text()).toContain('Pobierz PDF zaznaczonych (1)');
    expect(checkbox('FV/1/2026')?.getAttribute('aria-checked')).toBe('false');
    expect(checkbox('FV/2/2026')?.getAttribute('aria-checked')).toBe('true');
  });
});

describe('C7: karta telefonu — opłacona', () => {
  const card = (inv: InvoiceRow, f: InvoiceListRowFacts) =>
    renderToStaticMarkup(<SwipeableInvoiceRow invoice={inv} facts={f} today={TODAY} />);

  it('„Opłacona” pojawia się raz', () => {
    const out = card(invoice({ payment_status: 'paid', paid_amount: 1230 }), facts({ payment: 'paid', outstanding: 0 }));
    expect((out.match(/>Opłacona</g) ?? []).length).toBe(1);
    expect(out).not.toContain('Do zapłaty:');
  });

  it('nieopłacona: wskaźnik i kwota Do zapłaty, bez „Opłacona”', () => {
    const out = card(invoice(), facts());
    expect(out).not.toContain('>Opłacona<');
    expect(out).toContain('Nieopłacona');
    expect(out).toContain('Do zapłaty: ');
  });
});

describe('C8: linki paginacji to next/link o semantyce linku', () => {
  const pager = (strona: string) => html(<InvoicesPagination params={parseInvoiceListParams({ strona })} total={200} />);

  it('strony, Poprzednia i Następna idą przez next/link i nie są role="button"', () => {
    const doc = pager('2');
    const links = [...doc.querySelectorAll('[data-slot="pagination-link"]')];
    expect(links.length).toBeGreaterThanOrEqual(5);
    for (const link of links) {
      expect(link.tagName).toBe('A');
      expect(link.hasAttribute('data-next-link'), link.getAttribute('aria-label') ?? '').toBe(true);
      expect(link.getAttribute('role')).toBeNull();
      expect(link.getAttribute('href')).toMatch(/^\/invoices/);
    }
    expect(doc.querySelectorAll('[role="button"]').length).toBe(0);
    expect(doc.querySelector('[aria-current="page"]')?.textContent).toBe('2');
  });

  it('nieaktywna Poprzednia (strona 1) nie nawiguje: bez href, aria-disabled, rola linku (nie przycisku)', () => {
    const doc = pager('1');
    const prev = doc.querySelector('[aria-label="Przejdź do poprzedniej strony"]') as HTMLElement;
    expect(prev.tagName).not.toBe('A');
    expect(prev.hasAttribute('href')).toBe(false);
    expect(prev.getAttribute('aria-disabled')).toBe('true');
    expect(prev.getAttribute('role')).toBe('link');
    expect(prev.hasAttribute('data-next-link')).toBe(false);
  });

  it('aktywne linki dostają wygląd przycisku (klasy buttonVariants)', () => {
    const doc = pager('2');
    const active = doc.querySelector('[aria-current="page"]') as HTMLElement;
    expect(active.className).toMatch(/inline-flex/);
    expect(active.getAttribute('data-active')).toBe('true');
  });
});
