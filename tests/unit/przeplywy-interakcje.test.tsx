// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Komponenty klienckie Przepływów (PLAN-PRAWDZIWE-DANE E6, E7 pkt 4):
 * sumy nad wykresem idą za AKTYWNĄ zakładką, a menu wiersza tabeli otwiera
 * dokument zamiast udawać „Edytuj / Duplikuj / Usuń”.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const { default: CashFlowCard } = await import('@/components/przeplywy/finora-1do1/chart-cash-flow');
const tabela = await import('@/components/przeplywy/finora-1do1/datatable-transaction');

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const bucket = (label: string, inflow: number, outflow: number) =>
  ({ key: label, label, period: label, inflow, outflow, inflowCount: inflow > 0 ? 1 : 0 });

const tabs = {
  weekly: [bucket('06.10', 100, 50), bucket('13.10', 200, 70)],
  monthly: [bucket('Wrz', 3000, 1000), bucket('Paź', 4000, 1500)],
  yearly: [bucket('2025', 30000, 12000), bucket('2026', 41000, 15500)],
};

const tekst = () => (host.textContent ?? '').replace(/ /g, ' ');

describe('wykres przepływów: sumy z aktywnej zakładki', () => {
  it('po przełączeniu na „Rocznie” suma = suma serii roku, nie miesięcy', async () => {
    act(() => {
      root.render(<CashFlowCard tabs={tabs} subTitle="Oznaczone wpłaty i koszty brutto" />);
    });
    expect(tekst()).toContain('7000 zł');
    expect(tekst()).toContain('2500 zł');

    const rocznie = [...host.querySelectorAll('[role="tab"]')].find((el) => el.textContent === 'Rocznie');
    expect(rocznie).toBeTruthy();
    await act(async () => { (rocznie as HTMLElement).click(); });

    expect(tekst()).toContain('71 000 zł');
    expect(tekst()).toContain('27 500 zł');
    expect(tekst()).not.toContain('7000 zł');
  });
});

describe('menu wiersza tabeli (E7 pkt 4)', () => {
  it('„Otwórz fakturę” z linkiem do dokumentu, bez „Edytuj / Duplikuj / Usuń”', () => {
    act(() => {
      root.render(<tabela.RowActions href="/invoices/f1" label="Otwórz fakturę" defaultOpen />);
    });
    const text = document.body.textContent ?? '';
    expect(text).toContain('Otwórz fakturę');
    for (const old of ['Edytuj', 'Duplikuj', 'Usuń']) expect(text).not.toContain(old);
    expect(document.body.querySelector('a[href="/invoices/f1"]')).not.toBeNull();
  });

  it('dane przykładowe (bez dokumentu): pozycja wyłączona, bez linku', () => {
    act(() => {
      root.render(<tabela.RowActions href={null} label="Otwórz wydatek" defaultOpen />);
    });
    expect(document.body.textContent).toContain('Otwórz wydatek');
    expect(document.body.querySelector('a[href^="/expenses"]')).toBeNull();
  });
});
