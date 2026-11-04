// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Paleta ⌘K otwarta w jsdom (plan Finora E2): unikalne wartości pozycji
 * (strzałki), reset stanu przy zamknięciu skrótem, pojedynczy „Szukam…”
 * i dialog bez nagłówka w DOM, gdy zamknięty.
 */

const m = vi.hoisted(() => ({ search: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/app/actions/command-search', () => ({ searchCommandPaletteAction: m.search }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= RO;
Element.prototype.scrollIntoView ??= () => {};

const { CommandMenu } = await import('@/components/dashboard/command-menu');

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  m.search.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<CommandMenu />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function skrot(init: KeyboardEventInit) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

function wpisz(input: HTMLInputElement, value: string) {
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const input = () => document.querySelector<HTMLInputElement>('[cmdk-input]');

describe('CommandMenu otwarta', () => {
  it('zamknięta nie ma w DOM nagłówka dialogu (tytuł/opis)', () => {
    expect(document.querySelector('[data-slot="dialog-title"]')).toBeNull();
    expect(document.querySelector('[data-slot="dialog-description"]')).toBeNull();
  });

  it('otwarta: nagłówek jest w treści dialogu, a lista ma polską etykietę', () => {
    skrot({ key: 'k', ctrlKey: true });
    const content = document.querySelector('[data-slot="dialog-content"]');
    expect(content).not.toBeNull();
    expect(content!.querySelector('[data-slot="dialog-title"]')?.textContent).toBe('Szukaj lub przejdź');
    expect(content!.querySelector('[cmdk-label]')?.textContent).toBe('Szukaj lub przejdź');
  });

  it('każda pozycja ma unikalną wartość cmdk (strzałki nie utykają)', () => {
    skrot({ key: 'k', ctrlKey: true });
    const values = [...document.querySelectorAll('[cmdk-item]')].map((el) => el.getAttribute('data-value'));
    expect(values.length).toBeGreaterThan(5);
    expect(new Set(values).size).toBe(values.length);
  });

  it('zamknięcie skrótem czyści wyszukiwanie', () => {
    m.search.mockResolvedValue({ success: true, invoices: [], contractors: [] });
    skrot({ key: 'k', ctrlKey: true });
    wpisz(input()!, 'acme');
    expect(input()!.value).toBe('acme');

    skrot({ key: 'k', ctrlKey: true }); // zamknij
    skrot({ key: 'k', ctrlKey: true }); // otwórz ponownie
    expect(input()!.value).toBe('');
  });

  it('podczas ładowania jest jeden „Szukam…” w roli status', async () => {
    m.search.mockReturnValue(new Promise(() => {}));
    skrot({ key: 'k', ctrlKey: true });
    wpisz(input()!, 'zzzzqq');
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    const dialog = document.querySelector('[data-slot="dialog-content"]')!;
    const trafienia = dialog.textContent!.match(/Szukam…/g) ?? [];
    expect(trafienia).toHaveLength(1);
    expect(dialog.textContent).not.toContain('Brak wyników.');
    expect(dialog.querySelector('[role="status"][aria-live="polite"]')?.textContent).toContain('Szukam…');
  });

  it('po zakończeniu bez wyników pokazuje „Brak wyników.”', async () => {
    m.search.mockResolvedValue({ success: true, invoices: [], contractors: [] });
    skrot({ key: 'k', ctrlKey: true });
    wpisz(input()!, 'zzzzqq');
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    const dialog = document.querySelector('[data-slot="dialog-content"]')!;
    expect(dialog.textContent).toContain('Brak wyników.');
    expect(dialog.textContent).not.toContain('Szukam…');
  });
});
