// @vitest-environment jsdom
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ push: vi.fn() }));
// Jak w pozostałych testach KPiR: atrapa daje tylko `push`.
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import { KpirView, type KpirExpenseRow, type KpirInvoiceRow } from '@/components/expenses/kpir-view';
import { KpirResultCard } from '@/components/reports/kpir/kpir-result-card';
import { kpirTotals } from '@/lib/reports/kpir-totals';

import { color, contrast, oklch, over, themes } from './helpers/kontrast';

/**
 * Księga KPiR po przeglądzie (poprawka Bartosza 21.10.2026:
 * przeprojektowanie Księgowości):
 * - zmiana miesiąca zdejmuje segment i filtr kolumny (Next 16 trzyma stan
 *   strony bez parametrów adresu — bez tego „Do sprawdzenia” zostawało
 *   wybrane w miesiącu, który go nie ma, a księga była pusta);
 * - „Pokaż” i legenda pierścienia przenoszą fokus do księgi;
 * - filtr kolumny z legendy jest widoczny i do zdjęcia poniżej `lg`;
 * - zmiana segmentu i wyszukiwanie wracają na stronę 1 (bez automatu
 *   tanstacka, który strzelał przed zamontowaniem — „1 Issue” w dev);
 * - dopisek pod kwotą zawija się w tabeli i nie ściska karty telefonu;
 * - wykres nie ma fokusowalnego `svg` w `role="img"`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sprzedaz = (o: Partial<KpirInvoiceRow>): KpirInvoiceRow => ({
  id: 'fv', internal_number: 'FV/1', issue_date: '2026-09-05', sale_date: null, gross_total: 1230,
  net_total: 1000, buyer_data: { name: 'Klient', nip: '1234567890' }, invoice_kind: 'regular',
  settled_advances_net: null, ...o,
});

const koszt = (o: Partial<KpirExpenseRow>): KpirExpenseRow => ({
  id: 'exp', issue_date: '2026-09-03', seller_name: 'Dostawca', seller_nip: '5260001246', document_number: 'ZAK/1',
  category_label: 'Paliwo', kpir_column: 'col_13', is_deductible: true, net_amount: 100, vat_amount: 23,
  gross_amount: 123, vat_deductible_amount: 23, document_type: 'invoice', ...o,
} as KpirExpenseRow);

const WRZESIEN = {
  invoices: [sprzedaz({ id: 'f1', internal_number: 'FV/1' })],
  expenses: [
    koszt({ id: 'k13', document_number: 'ZAK/13', kpir_column: 'col_13' }),
    koszt({ id: 'kbez', document_number: 'ZAK/BEZ', kpir_column: null, issue_date: '2026-09-09' }),
  ],
};

const PAZDZIERNIK = {
  invoices: [sprzedaz({ id: 'f10', internal_number: 'FV/10', issue_date: '2026-10-05' })],
  expenses: [koszt({ id: 'k10', document_number: 'ZAK/10', kpir_column: 'col_10', issue_date: '2026-10-03' })],
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const scrollIntoView = vi.fn();

beforeAll(() => {
  // jsdom nie ma ResizeObserver (wykresy recharts) ani scrollIntoView.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = scrollIntoView;
});

beforeEach(() => {
  scrollIntoView.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function mount(node: ReactNode): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
  return host;
}

async function rerender(node: ReactNode) {
  await act(async () => {
    root!.render(node);
  });
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Numery dowodów w wierszach tabeli (od `lg`; jsdom nie ukrywa jej klasami). */
function rows(el: HTMLElement): string[] {
  return [...el.querySelectorAll('tbody tr')]
    .filter((tr) => tr.querySelectorAll('td').length > 1)
    .map((tr) => tr.querySelectorAll('td')[2]!.textContent ?? '');
}

function segment(el: HTMLElement, text: string): HTMLElement {
  const group = el.querySelector('[role="radiogroup"][aria-label="Rodzaj wpisu"]')!;
  const label = [...group.querySelectorAll('label')].find((l) => l.textContent?.includes(text));
  expect(label, text).toBeDefined();
  return label as HTMLElement;
}

function checkedRadios(el: HTMLElement): Element[] {
  return [...el.querySelectorAll('[role="radiogroup"][aria-label="Rodzaj wpisu"] [role="radio"][aria-checked="true"]')];
}

function legendButton(el: HTMLElement, label: string): HTMLButtonElement {
  const button = [...el.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((b) => b.textContent?.includes(label));
  expect(button, label).toBeDefined();
  return button!;
}

function view(month: number, data: { invoices: KpirInvoiceRow[]; expenses: KpirExpenseRow[] }) {
  return <KpirView month={month} year={2026} invoices={data.invoices} expenses={data.expenses} today="2026-10-21" />;
}

describe('KPiR — zmiana miesiąca zdejmuje filtry księgi', () => {
  it('„Do sprawdzenia” we wrześniu, potem październik bez kosztów poza sumą: wszystkie wpisy, zaznaczone „Wszystko”', async () => {
    const el = await mount(view(9, WRZESIEN));
    await click(segment(el, 'Do sprawdzenia'));
    expect(rows(el)).toEqual(['ZAK/BEZ']);

    await rerender(view(10, PAZDZIERNIK));
    expect(rows(el)).toEqual(['ZAK/10', 'FV/10']);
    const checked = checkedRadios(el);
    expect(checked).toHaveLength(1);
    expect(checked[0]!.parentElement?.querySelector('label')?.textContent).toContain('Wszystko');
    expect(el.textContent).not.toContain('Brak wpisów dla tych filtrów');
  });

  it('kolumna z legendy i wyszukiwanie nie przechodzą na następny miesiąc', async () => {
    const el = await mount(view(9, WRZESIEN));
    await click(legendButton(el, 'Pozostałe wydatki'));
    await type(el.querySelector<HTMLInputElement>('input[placeholder="Szukaj w księdze"]')!, 'zak');
    expect(rows(el)).toEqual(['ZAK/13']);

    await rerender(view(10, PAZDZIERNIK));
    expect(rows(el)).toEqual(['ZAK/10', 'FV/10']);
    expect(el.querySelector<HTMLInputElement>('input[placeholder="Szukaj w księdze"]')!.value).toBe('');
  });
});

describe('KPiR — fokus po przejściu do księgi', () => {
  it('„Pokaż” przenosi fokus na zaznaczony segment „Do sprawdzenia” w księdze', async () => {
    const el = await mount(view(9, WRZESIEN));
    const show = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Pokaż')!;
    show.focus();
    await click(show);
    const active = document.activeElement as HTMLElement;
    expect(el.querySelector('#ksiega')!.contains(active)).toBe(true);
    expect(active.getAttribute('role')).toBe('radio');
    expect(active.getAttribute('aria-checked')).toBe('true');
    expect(active.parentElement?.querySelector('label')?.textContent).toContain('Do sprawdzenia');
  });

  it('legenda pierścienia przenosi fokus do księgi; drugi klik (zdjęcie filtra) zostawia fokus w legendzie', async () => {
    const el = await mount(view(9, WRZESIEN));
    const button = legendButton(el, 'Pozostałe wydatki');
    button.focus();
    await click(button);
    expect(el.querySelector('#ksiega')!.contains(document.activeElement)).toBe(true);

    const again = legendButton(el, 'Pozostałe wydatki');
    again.focus();
    await click(again);
    expect(document.activeElement).toBe(again);
  });
});

describe('KPiR — filtr kolumny poniżej lg', () => {
  it('po kliknięciu legendy księga ma zdejmowalny znacznik kolumny (tylko poniżej lg)', async () => {
    const el = await mount(view(9, WRZESIEN));
    expect(el.querySelector('button[aria-label^="Usuń filtr kolumny"]')).toBeNull();

    await click(legendButton(el, 'Pozostałe wydatki'));
    const chip = el.querySelector<HTMLButtonElement>('#ksiega button[aria-label^="Usuń filtr kolumny"]');
    expect(chip).not.toBeNull();
    expect(chip!.className.split(/\s+/)).toContain('lg:hidden');
    expect(chip!.textContent).toContain('13 · Pozostałe');

    await click(chip!);
    expect(rows(el)).toEqual(['ZAK/13', 'ZAK/BEZ']);
    expect(legendButton(el, 'Pozostałe wydatki').getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelector('button[aria-label^="Usuń filtr kolumny"]')).toBeNull();
  });
});

describe('KPiR — paginacja', () => {
  const many = {
    invoices: [] as KpirInvoiceRow[],
    expenses: Array.from({ length: 60 }, (_, i) =>
      koszt({ id: `k${i}`, document_number: `ZAK/${i + 1}`, issue_date: `2026-09-${String(1 + Math.floor(i / 3)).padStart(2, '0')}`, kpir_column: i === 59 ? null : 'col_13' })),
  };

  async function secondPage(el: HTMLElement) {
    await click(el.querySelector('button[aria-label="Następna strona"]')!);
    expect(rows(el)[0]).toBe('ZAK/51');
  }

  it('segment i wyszukiwanie wracają na stronę 1', async () => {
    const el = await mount(view(9, many));
    expect(rows(el)).toHaveLength(50);

    await secondPage(el);
    await click(segment(el, 'Koszty'));
    expect(rows(el)[0]).toBe('ZAK/1');

    await secondPage(el);
    await type(el.querySelector<HTMLInputElement>('input[placeholder="Szukaj w księdze"]')!, 'zak/');
    expect(rows(el)[0]).toBe('ZAK/1');

    await secondPage(el);
    await click(legendButton(el, 'Pozostałe wydatki'));
    expect(rows(el)[0]).toBe('ZAK/1');
  });

  // Automat tanstacka (`autoResetPageIndex`) kolejkował reset strony już przy
  // pierwszym renderze — w dev „Can't perform a React state update on
  // a component that hasn't mounted yet” i „1 Issue”. Bez automatu nowe dane
  // tego samego miesiąca (`router.refresh`) nie wyrzucają na stronę 1,
  // a strona poza zakresem cofa się na ostatnią.
  it('odświeżenie danych tego samego miesiąca zostaje na stronie; za krótka lista cofa na ostatnią', async () => {
    const el = await mount(view(9, many));
    await secondPage(el);

    await rerender(view(9, { invoices: [...many.invoices], expenses: many.expenses.map((e) => ({ ...e })) }));
    expect(rows(el)[0]).toBe('ZAK/51');

    await rerender(view(9, { invoices: [], expenses: many.expenses.slice(0, 10) }));
    expect(rows(el)[0]).toBe('ZAK/1');
    expect(rows(el)).toHaveLength(10);
  });
});

describe('KPiR — dopisek pod kwotą', () => {
  const roz = sprzedaz({
    id: 'roz', internal_number: 'FV/ROZ/1', invoice_kind: 'final', net_total: 10_000, settled_advances_net: 4_000,
    buyer_data: { name: 'Przedsiębiorstwo Handlowe sp. z o.o.', nip: '1234567890' },
  });
  const paragon = koszt({
    id: 'par', document_number: 'PAR/1', seller_name: 'Restauracja Przy Rynku', document_type: 'receipt', net_amount: 150, vat_amount: 34.5,
  });
  const REMARK = 'zamówienie 10 000,00, minus zaliczki 4000,00';

  function remarks(el: HTMLElement, text: string): HTMLElement[] {
    // formatPlMoney rozdziela tysiące twardą spacją.
    return [...el.querySelectorAll<HTMLElement>('span')].filter((s) => s.textContent?.replace(/[\u00a0\u202f]/g, ' ') === text);
  }

  it('w tabeli zawija się pod kwotą (komórka ma `whitespace-nowrap`)', async () => {
    const el = await mount(view(9, { invoices: [roz], expenses: [paragon] }));
    const inTable = remarks(el, REMARK).find((s) => s.closest('table'));
    expect(inTable).toBeDefined();
    expect(inTable!.className.split(/\s+/)).toContain('whitespace-normal');
  });

  it('na karcie telefonu jest osobnym wierszem, nie w wąskiej kolumnie kwoty', async () => {
    const el = await mount(view(9, { invoices: [roz], expenses: [paragon] }));
    for (const text of [REMARK, 'w tym VAT bez odliczenia 34,50']) {
      const inCard = remarks(el, text).find((s) => !s.closest('table'));
      expect(inCard, text).toBeDefined();
      expect(inCard!.closest('.shrink-0'), text).toBeNull();
      expect(inCard!.className.split(/\s+/), text).toContain('basis-full');
    }
  });

  it('karta bez nazwy kontrahenta: link nazwany dokumentem, nie „—”', async () => {
    const el = await mount(view(9, { invoices: [], expenses: [koszt({ id: 'anon', seller_name: '', document_number: 'ZAK/9' })] }));
    // Karta telefonu (poza tabelą) — w tabeli linkiem jest numer dowodu.
    const links = [...el.querySelectorAll('a[href="/expenses/anon"]')].filter((a) => !a.closest('table'));
    expect(links).toHaveLength(1);
    expect(links[0]!.textContent).toBe('Wydatek ZAK/9');
  });
});

describe('KPiR — wykres i legenda pierścienia', () => {
  it('wykres w `role="img"` bez fokusowalnego svg (recharts dodaje tabindex=0 i role=application)', async () => {
    const invoices = [sprzedaz({ issue_date: '2026-09-05' })];
    const expenses = [koszt({ issue_date: '2026-09-02' })];
    // recharts mierzy kontener `getBoundingClientRect` — w jsdom to zera i wykres się nie rysuje.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      { width: 600, height: 152, top: 0, left: 0, right: 600, bottom: 152, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    );
    const series = Array.from({ length: 30 }, (_, i) => ({
      day: i + 1, date: `2026-09-${String(i + 1).padStart(2, '0')}`, revenue: i >= 4 ? 1000 : 0, costs: i >= 1 ? 123 : 0,
    }));
    const el = await mount(
      <KpirResultCard
        totals={kpirTotals(expenses, invoices)} monthTitle="Wrzesień 2026" series={series} lastDay={30}
        nonDeductedVat={0} uncountedCount={0} settledError={false} onShowUncounted={() => {}}
      />,
    );
    const chart = el.querySelector('[role="img"][aria-label="Przychody i koszty narastająco"]')!;
    expect(chart).not.toBeNull();
    expect(chart.querySelector('svg')).not.toBeNull();
    expect(chart.querySelector('[role="application"]')).toBeNull();
    expect(chart.querySelector('[tabindex]:not([tabindex="-1"])')).toBeNull();
  });

  it('wybrany wiersz legendy ma widoczne obramowanie w obu motywach (≥ 3:1 do karty, WCAG 1.4.11)', async () => {
    const el = await mount(view(9, WRZESIEN));
    await click(legendButton(el, 'Pozostałe wydatki'));
    const pressed = legendButton(el, 'Pozostałe wydatki');
    // Kolor obramowania (nie szerokość `ring-1` ani `ring-inset`).
    const ring = [...pressed.className.matchAll(/(?:^|\s)aria-pressed:ring-([a-z][a-z0-9-]*)(?=\s|$)/g)]
      .map((m) => m[1]!)
      .find((token) => token !== 'inset');
    expect(ring, pressed.className).toBeDefined();
    for (const theme of [themes.jasny, themes.ciemny]) {
      expect(contrast(color(ring!, theme), oklch(theme['--card']))).toBeGreaterThanOrEqual(3);
    }
  });

  it('notka „poza sumą” odcina się od karty także w ciemnym motywie (muted = card)', async () => {
    const el = await mount(view(9, WRZESIEN));
    const note = [...el.querySelectorAll('p')].find((p) => p.textContent?.includes('poza sumą'))!.parentElement!;
    const t = themes.ciemny;
    expect(t['--muted']).toBe(t['--card']);
    const bg = /(?:^|\s)dark:bg-([a-z0-9-]+)\/(\d+)(?=\s|$)/.exec(note.className);
    expect(bg, note.className).not.toBeNull();
    const card = oklch(t['--card']);
    expect(contrast(over(color(bg![1]!, t), Number(bg![2]) / 100, card), card)).toBeGreaterThan(1.1);
  });
});
