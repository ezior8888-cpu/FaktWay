// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  suggest: vi.fn(),
  saveDraft: vi.fn(),
  send: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/invoices/actions', () => ({
  saveDraftAction: m.saveDraft,
  saveAndSendInvoiceAction: m.send,
  lookupBuyerAction: vi.fn(),
  prefillFromLastInvoiceAction: vi.fn(),
}));
vi.mock('@/components/invoices/buyer-lookup', () => ({
  BuyerLookup: (p: { inputId?: string; nip: string }) => <input id={p.inputId} defaultValue={p.nip} />,
}));
vi.mock('@/app/actions/produkty', () => ({ suggestProductsAction: m.suggest }));

import { InvoiceForm } from '@/components/invoices/invoice-form';
import { LINES_LAYOUT_MEDIA } from '@/components/invoices/invoice-form-parts/constants';
import type { ProductSuggestion } from '@/lib/produkty/model';

/**
 * Podpowiedź produktów z katalogu w polu nazwy pozycji (plan kompletnej
 * aplikacji, krok 2.6, część 2a): lista po wpisaniu frazy, wybór
 * strzałkami i Enterem albo kliknięciem, uzupełnienie jednostki, ceny
 * netto i stawki VAT, starsza odpowiedź nie nadpisuje nowszej. Oba układy
 * pozycji: karty (poniżej 1360 px) i wiersze siatki.
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SZKOLENIE: ProductSuggestion = { id: 'p1', name: 'Szkolenie BHP', unit: 'godz.', priceNet: 150, vatRate: '8' };
const KONSULTACJA: ProductSuggestion = { id: 'p2', name: 'Konsultacja szkoleniowa', unit: 'usł.', priceNet: null, vatRate: null };

let container: HTMLDivElement;
let root: Root;

function ustawUklad(siatka: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: siatka && query === LINES_LAYOUT_MEDIA,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-16T08:00:00Z'));
  for (const f of Object.values(m)) f.mockReset();
  m.suggest.mockResolvedValue({ ok: true, items: [SZKOLENIE, KONSULTACJA] });
  window.confirm = vi.fn(() => true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const czekaj = (ms: number) => act(async () => {
  await new Promise((r) => setTimeout(r, ms));
});

async function pokaz(siatka: boolean, opcjeFormularza: { vatExempt?: boolean } = {}) {
  ustawUklad(siatka);
  await act(async () => {
    root.render(<InvoiceForm tenantId={TENANT} initialValues={{}} vatExempt={opcjeFormularza.vatExempt} />);
  });
}

const ustawWartosc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

async function wpisz(pole: HTMLInputElement, tekst: string, ms = 300) {
  await act(async () => {
    ustawWartosc.call(pole, tekst);
    pole.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await czekaj(ms);
}

function klawisz(pole: HTMLElement, key: string) {
  act(() => {
    pole.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

/** Pola pierwszej pozycji w danym układzie. */
function pola(siatka: boolean) {
  const q = <T extends Element>(sel: string) => {
    const el = container.querySelector<T>(sel);
    if (!el) throw new Error(`brak pola ${sel}`);
    return el;
  };
  return siatka
    ? {
        nazwa: q<HTMLInputElement>('input[aria-label="Nazwa pozycji 1"]'),
        jednostka: q<HTMLInputElement>('input[aria-label="Jednostka pozycji 1"]'),
        cena: q<HTMLInputElement>('input[aria-label="Cena netto pozycji 1"]'),
        stawka: q<HTMLSelectElement>('select[aria-label="Stawka VAT pozycji 1"]'),
      }
    : {
        nazwa: q<HTMLInputElement>('#line-0-name'),
        jednostka: q<HTMLInputElement>('#line-0-unit'),
        cena: q<HTMLInputElement>('#line-0-unit-price'),
        stawka: q<HTMLSelectElement>('#line-0-vat-rate'),
      };
}

const lista = () => container.querySelector<HTMLElement>('[role="listbox"]');
const opcje = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];

describe('podpowiedź produktów w polu nazwy pozycji', () => {
  it('karty: po wpisaniu frazy lista z katalogu, pole jest comboboxem z odnośnikiem do listy', async () => {
    await pokaz(false);
    const p = pola(false);
    expect(p.nazwa.getAttribute('role')).toBe('combobox');
    expect(p.nazwa.getAttribute('aria-expanded')).toBe('false');
    await wpisz(p.nazwa, 'Szk');
    expect(m.suggest).toHaveBeenCalledWith('Szk');
    expect(lista()).not.toBeNull();
    expect(p.nazwa.getAttribute('aria-expanded')).toBe('true');
    expect(p.nazwa.getAttribute('aria-controls')).toBe(lista()!.id);
    expect(opcje().map((o) => o.textContent)).toEqual([
      expect.stringContaining('Szkolenie BHP'),
      expect.stringContaining('Konsultacja szkoleniowa'),
    ]);
    expect(opcje()[0]!.textContent).toContain('150,00 zł netto');
    expect(p.nazwa.parentElement?.querySelector('[role="status"]')?.textContent).toContain('2 podpowiedzi');
  });

  it('karty: strzałka w dół i Enter wstawiają produkt, Enter nie zapisuje faktury', async () => {
    await pokaz(false);
    const p = pola(false);
    await wpisz(p.nazwa, 'Szk');
    klawisz(p.nazwa, 'ArrowDown');
    expect(p.nazwa.getAttribute('aria-activedescendant')).toBe(opcje()[0]!.id);
    expect(opcje()[0]!.getAttribute('aria-selected')).toBe('true');
    klawisz(p.nazwa, 'Enter');
    await czekaj(10);
    expect(p.nazwa.value).toBe('Szkolenie BHP');
    expect(p.jednostka.value).toBe('godz.');
    expect(p.cena.value).toBe('150');
    expect(p.stawka.value).toBe('8');
    expect(lista()).toBeNull();
    expect(p.nazwa.getAttribute('aria-expanded')).toBe('false');
    expect(m.saveDraft).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });

  it('siatka: kliknięcie w podpowiedź wstawia produkt do tej pozycji', async () => {
    await pokaz(true);
    const p = pola(true);
    await wpisz(p.nazwa, 'Szk');
    const pierwsza = opcje()[0]!;
    act(() => {
      pierwsza.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      pierwsza.click();
    });
    await czekaj(10);
    expect(p.nazwa.value).toBe('Szkolenie BHP');
    expect(p.jednostka.value).toBe('godz.');
    expect(p.cena.value).toBe('150');
    expect(p.stawka.value).toBe('8');
  });

  it('produkt bez ceny i stawki zostawia cenę i stawkę wpisane w pozycji', async () => {
    await pokaz(false);
    const p = pola(false);
    await act(async () => {
      ustawWartosc.call(p.cena, '99');
      p.cena.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const stawkaPrzed = p.stawka.value;
    await wpisz(p.nazwa, 'Kons');
    klawisz(p.nazwa, 'ArrowDown');
    klawisz(p.nazwa, 'ArrowDown');
    klawisz(p.nazwa, 'Enter');
    await czekaj(10);
    expect(p.nazwa.value).toBe('Konsultacja szkoleniowa');
    expect(p.jednostka.value).toBe('usł.');
    expect(p.cena.value).toBe('99');
    expect(p.stawka.value).toBe(stawkaPrzed);
  });

  it('jeden znak nie pyta katalogu, Escape zamyka listę bez zmiany pozycji', async () => {
    await pokaz(false);
    const p = pola(false);
    await wpisz(p.nazwa, 'S');
    expect(m.suggest).not.toHaveBeenCalled();
    expect(lista()).toBeNull();
    await wpisz(p.nazwa, 'Szk');
    expect(lista()).not.toBeNull();
    klawisz(p.nazwa, 'Escape');
    expect(lista()).toBeNull();
    expect(p.nazwa.value).toBe('Szk');
    expect(p.jednostka.value).toBe('szt');
  });

  it('starsza odpowiedź nie nadpisuje nowszej', async () => {
    m.suggest.mockReset();
    m.suggest
      .mockImplementationOnce(
        () => new Promise((r) => setTimeout(() => r({ ok: true, items: [KONSULTACJA] }), 500)),
      )
      .mockResolvedValue({ ok: true, items: [SZKOLENIE] });
    await pokaz(false);
    const p = pola(false);
    await wpisz(p.nazwa, 'Sz', 300);
    await wpisz(p.nazwa, 'Szk', 300);
    expect(opcje().map((o) => o.textContent)).toEqual([expect.stringContaining('Szkolenie BHP')]);
    await czekaj(400);
    expect(opcje().map((o) => o.textContent)).toEqual([expect.stringContaining('Szkolenie BHP')]);
  });

  it('firma zwolniona z VAT: produkt ze stawką z podatkiem nie zmienia „zw”, informacja pod polem', async () => {
    await pokaz(false, { vatExempt: true });
    const p = pola(false);
    expect(p.stawka.value).toBe('zw');
    await wpisz(p.nazwa, 'Szk');
    klawisz(p.nazwa, 'ArrowDown');
    klawisz(p.nazwa, 'Enter');
    await czekaj(10);
    expect(p.nazwa.value).toBe('Szkolenie BHP');
    expect(p.jednostka.value).toBe('godz.');
    expect(p.cena.value).toBe('150');
    expect(p.stawka.value).toBe('zw');
    expect(p.nazwa.parentElement?.textContent).toContain('stawka pozycji została bez zmian');
  });

  it('opuszczenie pola w trakcie zapytania: lista się nie otwiera', async () => {
    await pokaz(false);
    const p = pola(false);
    act(() => p.nazwa.focus());
    await wpisz(p.nazwa, 'Szk', 50);
    act(() => p.nazwa.blur());
    await czekaj(400);
    expect(lista()).toBeNull();
    expect(p.nazwa.getAttribute('aria-expanded')).toBe('false');
  });

  it('błąd katalogu: krótka informacja pod polem, wpis ręczny dalej działa', async () => {
    m.suggest.mockResolvedValue({ ok: false });
    await pokaz(false);
    const p = pola(false);
    await wpisz(p.nazwa, 'Szk');
    expect(lista()).toBeNull();
    expect(container.textContent).toContain('Podpowiedzi z katalogu są chwilowo niedostępne');
    expect(p.nazwa.value).toBe('Szk');
  });
});
