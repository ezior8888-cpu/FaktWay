// @vitest-environment jsdom
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ push: vi.fn() }));
// Jak w pozostałych testach KPiR: atrapa daje tylko `push`.
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import { KpirView, type KpirExpenseRow, type KpirInvoiceRow } from '@/components/expenses/kpir-view';

/**
 * Księga KPiR w przeglądarce (poprawka Bartosza 21.10.2026:
 * przeprojektowanie Księgowości): przełącznik „Wszystko / Przychody /
 * Koszty / Do sprawdzenia” filtruje wiersze, klik w legendę pierścienia
 * pokazuje koszty jednej kolumny i przewija do księgi (drugi klik zdejmuje
 * filtr), a „Pokaż” w notce o kosztach poza sumą otwiera „Do sprawdzenia”.
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

const INVOICES = [sprzedaz({ id: 'f1', internal_number: 'FV/1' }), sprzedaz({ id: 'f2', internal_number: 'FV/2', issue_date: '2026-09-20' })];
const EXPENSES = [
  koszt({ id: 'k13', document_number: 'ZAK/13', kpir_column: 'col_13' }),
  koszt({ id: 'k10', document_number: 'ZAK/10', kpir_column: 'col_10', issue_date: '2026-09-08' }),
  koszt({ id: 'kbez', document_number: 'ZAK/BEZ', kpir_column: null, issue_date: '2026-09-09' }),
];

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

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
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

function checkedSegment(el: HTMLElement): string | null {
  const group = el.querySelector('[role="radiogroup"][aria-label="Rodzaj wpisu"]')!;
  const radio = group.querySelector('[role="radio"][aria-checked="true"]');
  return radio?.parentElement?.querySelector('label')?.textContent ?? null;
}

function legendButton(el: HTMLElement, label: string): HTMLButtonElement {
  const button = [...el.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((b) => b.textContent?.includes(label));
  expect(button, label).toBeDefined();
  return button!;
}

describe('KPiR — filtry księgi', () => {
  it('przełącznik: przychody, koszty, do sprawdzenia, wszystko', async () => {
    const el = await mount(<KpirView month={9} year={2026} invoices={INVOICES} expenses={EXPENSES} today="2026-10-21" />);
    expect(rows(el)).toEqual(['ZAK/13', 'FV/1', 'ZAK/10', 'ZAK/BEZ', 'FV/2']);

    await click(segment(el, 'Przychody'));
    expect(rows(el)).toEqual(['FV/1', 'FV/2']);

    await click(segment(el, 'Koszty'));
    expect(rows(el)).toEqual(['ZAK/13', 'ZAK/10', 'ZAK/BEZ']);

    await click(segment(el, 'Do sprawdzenia'));
    expect(rows(el)).toEqual(['ZAK/BEZ']);

    await click(segment(el, 'Wszystko'));
    expect(rows(el)).toHaveLength(5);
  });

  it('legenda pierścienia: koszty jednej kolumny i przewinięcie do księgi; drugi klik zdejmuje filtr', async () => {
    const el = await mount(<KpirView month={9} year={2026} invoices={INVOICES} expenses={EXPENSES} today="2026-10-21" />);
    const pozostale = legendButton(el, 'Pozostałe wydatki');
    expect(pozostale.getAttribute('aria-pressed')).toBe('false');

    await click(pozostale);
    expect(rows(el)).toEqual(['ZAK/13']);
    expect(legendButton(el, 'Pozostałe wydatki').getAttribute('aria-pressed')).toBe('true');
    expect(checkedSegment(el)).toContain('Koszty');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(el.querySelector('#ksiega'));

    await click(legendButton(el, 'Pozostałe wydatki'));
    expect(rows(el)).toEqual(['ZAK/13', 'ZAK/10', 'ZAK/BEZ']);
    expect(legendButton(el, 'Pozostałe wydatki').getAttribute('aria-pressed')).toBe('false');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // Zmiana segmentu zdejmuje filtr kolumny.
    await click(legendButton(el, 'Towary i materiały'));
    expect(rows(el)).toEqual(['ZAK/10']);
    await click(segment(el, 'Wszystko'));
    expect(rows(el)).toHaveLength(5);
  });

  it('„Pokaż” przy kosztach poza sumą: segment „Do sprawdzenia” i przewinięcie', async () => {
    const el = await mount(<KpirView month={9} year={2026} invoices={INVOICES} expenses={EXPENSES} today="2026-10-21" />);
    expect(el.textContent).toContain('1 koszt poza sumą');
    const show = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Pokaż');
    expect(show).toBeDefined();

    await click(show!);
    expect(rows(el)).toEqual(['ZAK/BEZ']);
    expect(checkedSegment(el)).toContain('Do sprawdzenia');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('bez kosztów poza sumą nie ma segmentu „Do sprawdzenia” ani notki', async () => {
    const el = await mount(
      <KpirView month={9} year={2026} invoices={INVOICES} expenses={EXPENSES.filter((e) => e.kpir_column)} today="2026-10-21" />,
    );
    const group = el.querySelector('[role="radiogroup"][aria-label="Rodzaj wpisu"]')!;
    expect(group.textContent).not.toContain('Do sprawdzenia');
    expect(el.textContent).not.toContain('poza sumą');
  });
});
