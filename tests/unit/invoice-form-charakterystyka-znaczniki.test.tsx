// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/invoices/actions', () => ({
  saveDraftAction: vi.fn(),
  saveAndSendInvoiceAction: vi.fn(),
  lookupBuyerAction: vi.fn(),
  prefillFromLastInvoiceAction: vi.fn(),
}));

import { InvoiceForm } from '@/components/invoices/invoice-form';
import type { PrefillFromLastInvoice } from '@/components/invoices/actions';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

/**
 * Plan usprawnień 3.7c: znaczniki formularza zwykłej faktury przed podziałem
 * `invoice-form.tsx` na moduły. Wzorce w `__snapshots__` powstały na kodzie
 * sprzed podziału; podział ma dać te same znaczniki co do znaku (Mac
 * zamrożony, zero zmiany wyglądu). Jedyna normalizacja: identyfikatory
 * z `useId` zależą od kształtu drzewa komponentów, więc zamieniamy je na
 * kolejne numery w kolejności wystąpienia (powiązania `id` ↔ `aria-*`
 * zostają widoczne).
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const POS = '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d';
const seller = {
  nip: '1234567890',
  name: 'Firma Testowa sp. z o.o.',
  address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
};
const prefill: PrefillFromLastInvoice = {
  contractorName: 'Klient Poprzedni',
  values: {
    buyerNip: '5252241585',
    buyerName: 'Klient Poprzedni',
    buyerAddressLine1: 'ul. A 1',
    buyerAddressLine2: '00-001 Warszawa',
    buyerEmail: 'klient@example.com',
    paymentMethod: 'transfer',
    bankAccount: 'PL61109010140000071219812874',
    lines: [{ name: 'Usługa', unit: 'godz.', quantity: 10, unitPriceNet: 150, vatRate: '23' }],
  },
} as PrefillFromLastInvoice;
const podklad: Partial<InvoiceFormValues> = {
  internalNumber: 'FV/2/10/2026',
  buyerNip: '5252241585',
  buyerName: 'Klient Podkład',
  buyerAddressLine1: 'ul. B 2',
  buyerAddressLine2: '00-002 Warszawa',
  bankAccount: 'PL61109010140000071219812874',
  lines: [
    { name: 'Abonament', unit: 'mies.', quantity: 1, unitPriceNet: 20000, vatRate: '23' },
    { name: 'Wdrożenie', unit: 'szt', quantity: 2, unitPriceNet: 99.99, vatRate: '8' },
  ],
};

function normalizujId(html: string): string {
  const mapa = new Map<string, string>();
  return html.replace(/_[rR]_[0-9a-zA-Z]+_|«[rR][0-9a-zA-Z]+»|:[rR][0-9a-zA-Z]+:/g, (id) => {
    if (!mapa.has(id)) mapa.set(id, `«id${mapa.size + 1}»`);
    return mapa.get(id)!;
  });
}

let container: HTMLDivElement;
let root: Root;
let desktop = false;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T08:00:00Z'));
  desktop = false;
  window.matchMedia = ((query: string) => ({
    matches: desktop, media: query, addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render(el: React.ReactElement) {
  await act(async () => {
    root.render(el);
  });
  return () => normalizujId(container.innerHTML);
}

function klik(el: Element | null | undefined) {
  if (!el) throw new Error('brak elementu');
  (el as HTMLElement).click();
}

describe('formularz faktury: znaczniki przed podziałem (3.7c)', () => {
  it('SSR, puste propsy', () => {
    expect(normalizujId(renderToStaticMarkup(<InvoiceForm tenantId={TENANT} />))).toMatchSnapshot();
  });

  it('telefon (karty pozycji), sprzedawca i numer', async () => {
    const html = await render(<InvoiceForm tenantId={TENANT} seller={seller} suggestedNumber="FV/10/2026/007" />);
    expect(html()).toMatchSnapshot();
  });

  it('od 1360 px (wiersze pozycji), dwie pozycje, MPP', async () => {
    desktop = true;
    const html = await render(<InvoiceForm tenantId={TENANT} initialValues={podklad} />);
    expect(html()).toMatchSnapshot();
  });

  it('baner „Wypełnij”, firma zwolniona z VAT; po kliknięciu baner znika', async () => {
    const html = await render(<InvoiceForm tenantId={TENANT} prefill={prefill} vatExempt />);
    expect(html()).toMatchSnapshot('z banerem');
    await act(async () => {
      klik([...container.querySelectorAll('button')].find((b) => b.textContent === 'Wypełnij →'));
    });
    expect(html()).toMatchSnapshot('po wypełnieniu');
  });

  it('tryb cykliczny: bez szkicu, z tekstem C2 i ukrytymi polami', async () => {
    const html = await render(
      <InvoiceForm tenantId={TENANT} initialValues={podklad} recurringInvoiceId={POS} recurringPeriod="2026-11" />,
    );
    expect(html()).toMatchSnapshot();
  });

  it('nabywca z UE i osoba prywatna z dowodem', async () => {
    const ue = await render(
      <InvoiceForm
        tenantId={TENANT}
        initialValues={{ buyerIsEu: true, buyerVatUe: 'EL123456789', buyerCountryCode: 'GR', lines: [{ name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 10, vatRate: 'np_ii' }] }}
      />,
    );
    expect(ue()).toMatchSnapshot('firma z UE');
    const osoba = await render(
      <InvoiceForm tenantId={TENANT} key="osoba" initialValues={{ buyerIsConsumer: true, buyerConsumerIdType: 'id_card' }} />,
    );
    expect(osoba()).toMatchSnapshot('osoba z dowodem');
  });

  it('błędy walidacji po „Wystaw i wyślij” na pustym formularzu, w obu układach', async () => {
    const html = await render(<InvoiceForm tenantId={TENANT} initialValues={{ lines: [{ name: '', unit: 'szt', quantity: 1, unitPriceNet: 0, vatRate: 'np_ii' }] }} />);
    await act(async () => {
      klik([...container.querySelectorAll('button')].find((b) => b.textContent === 'Wystaw i wyślij do KSeF'));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(html()).toMatchSnapshot('karty');
    act(() => root.unmount());
    root = createRoot(container);
    desktop = true;
    await render(<InvoiceForm tenantId={TENANT} initialValues={{ lines: [{ name: '', unit: 'szt', quantity: 1, unitPriceNet: 0, vatRate: 'np_ii' }] }} />);
    await act(async () => {
      klik([...container.querySelectorAll('button')].find((b) => b.textContent === 'Wystaw i wyślij do KSeF'));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(html()).toMatchSnapshot('wiersze');
  });
});
