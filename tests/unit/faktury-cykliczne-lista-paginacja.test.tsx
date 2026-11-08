// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan Finora E9 (P6), przegląd C10: lista faktur cyklicznych odświeża dane z
 * serwera po każdej akcji (`router.refresh()`), a tanstack przy zmianie `data`
 * zerował stronę (`autoResetPageIndex`). Klient na stronie 2 po „Wstrzymaj”
 * lądował na stronie 1. Tu prawdziwy widok w jsdom: klikamy „Strona N”, potem
 * podajemy nową tablicę `items` (to samo, co robi serwer po odświeżeniu).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/actions/recurring-invoices', () => ({
  createRecurringInvoiceAction: vi.fn(),
  updateRecurringInvoiceAction: vi.fn(),
  pauseRecurringInvoiceAction: vi.fn(),
  resumeRecurringInvoiceAction: vi.fn(),
  deleteRecurringInvoiceAction: vi.fn(),
}));
vi.mock('@/app/actions/recurring-invoice-templates', () => ({ searchRecurringTemplatesAction: vi.fn() }));

import { RecurringInvoicesView } from '@/app/(dashboard)/(faktury)/invoices/recurring/_components/recurring-invoices-view';
import type { RecurringInvoiceListItem } from '@/lib/invoices/recurring/queries';

function make(n: number, overrides: Partial<RecurringInvoiceListItem> = {}): RecurringInvoiceListItem {
  const id = String(n).padStart(2, '0');
  return {
    id: `00000000-0000-4000-8000-0000000000${id}`,
    tenant_id: 'firma-a',
    template_invoice_id: '7f1c2d3e-4b5a-4c6d-8e7f-901234567890',
    name: `Szablon numer ${id}`,
    frequency: 'monthly',
    day_of_month: 10,
    next_run_date: '2026-11-10',
    active: true,
    created_by: null,
    created_at: '2026-10-01T08:00:00Z',
    updated_at: '2026-10-01T08:00:00Z',
    status: 'active',
    period: '2026-11',
    contractorName: `Kontrahent ${id}`,
    templateNumber: `FV/${n}/10/2026`,
    templateGrossTotal: 100 + n,
    ...overrides,
  };
}

const list = (count: number, patch: (n: number) => Partial<RecurringInvoiceListItem> = () => ({})) =>
  Array.from({ length: count }, (_, i) => make(i + 1, patch(i + 1)));

let host: HTMLDivElement;
let root: Root;

/** `await act(async)`: tanstack zeruje stronę w mikrozadaniu (`_queue`), a nie synchronicznie. */
async function render(items: RecurringInvoiceListItem[]) {
  await act(async () => root.render(<RecurringInvoicesView items={items} today="2026-10-20" candidates={[]} />));
}

const currentPage = () => host.querySelector('button[aria-current="page"]')?.textContent;
const footer = () => host.querySelector('p[aria-live="polite"]')?.textContent?.replace(/\s+/g, ' ').trim();
/** Dojście do strony przyciskiem „Następna” (numery stron są okienkiem, nie zawsze widać docelowy). */
const goTo = async (page: number) => {
  while (Number(currentPage()) < page) {
    const next = host.querySelector<HTMLButtonElement>('button[aria-label="Następna strona"]');
    expect(next, `przycisk „Następna” przy stronie ${currentPage()}`).not.toBeNull();
    await act(async () => next!.click());
  }
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('C10 — lista faktur cyklicznych zostaje na tej samej stronie po odświeżeniu danych', () => {
  it('wstrzymanie / wznowienie / edycja (nowa tablica z tą samą liczbą pozycji) nie wraca na stronę 1', async () => {
    await render(list(25));
    expect(footer()).toBe('Pozycje 1–10 z 25');
    await goTo(2);
    expect(currentPage()).toBe('2');
    expect(footer()).toBe('Pozycje 11–20 z 25');

    // Serwer po „Wstrzymaj” przysyła nową tablicę: pozycja 12 jest wstrzymana.
    await render(list(25, (n) => (n === 12 ? { active: false, status: 'paused' as const } : {})));
    expect(currentPage()).toBe('2');
    expect(footer()).toBe('Pozycje 11–20 z 25');
    expect(host.textContent).toContain('Szablon numer 12');
    expect(host.textContent).not.toContain('Szablon numer 02');
  });

  it('usunięcie jedynej pozycji ostatniej strony przycina stronę do ostatniej istniejącej (bez pustej tabeli)', async () => {
    await render(list(21));
    await goTo(3);
    expect(footer()).toBe('Pozycje 21–21 z 21');

    await render(list(20));
    expect(currentPage()).toBe('2');
    expect(footer()).toBe('Pozycje 11–20 z 20');
    expect(host.textContent).not.toContain('Brak wyników');
  });

  it('usunięcie z innej strony niż ostatnia zostawia numer strony', async () => {
    await render(list(25));
    await goTo(2);
    await render(list(24));
    expect(currentPage()).toBe('2');
    expect(footer()).toBe('Pozycje 11–20 z 24');
  });

  it('wyszukiwanie wraca na stronę 1 (inaczej wynik leży poza stroną)', async () => {
    await render(list(25));
    await goTo(3);
    expect(currentPage()).toBe('3');

    const search = host.querySelector<HTMLInputElement>('input[type="text"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(search, 'Szablon numer 0');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(currentPage()).toBe('1');
    expect(footer()).toBe('Pozycje 1–9 z 9');
  });
});
