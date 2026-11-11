// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ saveDraft: vi.fn(), send: vi.fn(), push: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: m.push, refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/invoices/actions', () => ({
  saveDraftAction: m.saveDraft,
  saveAndSendInvoiceAction: m.send,
  lookupBuyerAction: vi.fn(),
  prefillFromLastInvoiceAction: vi.fn(),
}));

import { InvoiceForm } from '@/components/invoices/invoice-form';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

/**
 * Faktura do paragonu w formularzu (krok 1.2): pole wyboru na końcu nagłówka
 * dokumentu, pola paragonu po zaznaczeniu, potwierdzenie NIP tylko przy firmie.
 * Data paragonu ustawia datę sprzedaży, a odznaczenie FP przywraca datę
 * sprzedaży sprzed zmiany (zwykła faktura nie może zostać z datą z paragonu).
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DZIS = '2026-11-09';
const podklad: Partial<InvoiceFormValues> = {
  internalNumber: 'FV/5/11/2026',
  buyerNip: '5252241585',
  buyerName: 'Klient Sp. z o.o.',
  buyerAddressLine1: 'ul. B 2',
  buyerAddressLine2: '00-002 Warszawa',
  paymentMethod: 'cash',
  lines: [{ name: 'Rower', unit: 'szt.', quantity: 1, unitPriceNet: 1000, vatRate: '23' }],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${DZIS}T09:00:00Z`));
  for (const f of Object.values(m)) f.mockReset();
  m.send.mockResolvedValue({ success: false, error: 'stop' });
  window.confirm = vi.fn(() => true);
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
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
}

const q = <T extends Element = HTMLInputElement>(selector: string): T | null => container.querySelector<T>(selector);

async function klik(el: HTMLElement) {
  await act(async () => {
    el.click();
    await new Promise((r) => setTimeout(r, 20));
  });
}

async function wpisz(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
  });
}

describe('formularz: faktura do paragonu', () => {
  it('bez zaznaczenia tylko pole wyboru; po zaznaczeniu pola paragonu i potwierdzenie NIP przy firmie', async () => {
    await render(<InvoiceForm tenantId={TENANT} initialValues={podklad} />);
    expect(q('#receipt-invoice')).not.toBeNull();
    expect(q('#receipt-number')).toBeNull();

    await klik(q('#receipt-invoice')!);
    for (const id of ['#receipt-number', '#receipt-date', '#cash-register-number', '#receipt-request-date', '#buyer-nip-on-receipt']) {
      expect(q(id), id).not.toBeNull();
    }
  });

  it('osoba prywatna: bez potwierdzenia NIP na paragonie', async () => {
    await render(
      <InvoiceForm tenantId={TENANT} initialValues={{ ...podklad, buyerNip: '', buyerIsConsumer: true, buyerConsumerIdType: 'no_id' }} />,
    );
    await klik(q('#receipt-invoice')!);
    expect(q('#receipt-number')).not.toBeNull();
    expect(q('#buyer-nip-on-receipt')).toBeNull();
  });

  it('data paragonu ustawia datę sprzedaży, a odznaczenie FP przywraca poprzednią datę sprzedaży', async () => {
    await render(<InvoiceForm tenantId={TENANT} initialValues={podklad} />);
    expect(q('#sale-date')!.value).toBe(DZIS);

    await klik(q('#receipt-invoice')!);
    await wpisz(q('#receipt-date')!, '2026-10-15');
    expect(q('#sale-date')!.value).toBe('2026-10-15');

    await klik(q('#receipt-invoice')!);
    expect(q('#sale-date')!.value).toBe(DZIS);
  });

  it('odznaczenie FP nie rusza daty sprzedaży zmienionej ręcznie po dacie paragonu', async () => {
    await render(<InvoiceForm tenantId={TENANT} initialValues={podklad} />);
    await klik(q('#receipt-invoice')!);
    await wpisz(q('#receipt-date')!, '2026-10-15');
    await wpisz(q('#sale-date')!, '2026-11-01');
    await klik(q('#receipt-invoice')!);
    expect(q('#sale-date')!.value).toBe('2026-11-01');
  });

  it('„Wystaw i wyślij” wysyła pola paragonu do akcji serwera', async () => {
    await render(<InvoiceForm tenantId={TENANT} initialValues={podklad} />);
    await klik(q('#receipt-invoice')!);
    await wpisz(q('#receipt-number')!, '000123');
    await wpisz(q('#receipt-date')!, '2026-10-15');
    await wpisz(q('#cash-register-number')!, 'ABC1234567890');
    await klik(q('#buyer-nip-on-receipt')!);
    const wyslij = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Wystaw i wyślij do KSeF');
    await klik(wyslij!);

    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.send.mock.calls[0]![0]).toMatchObject({
      receiptInvoice: true,
      receiptNumber: '000123',
      receiptDate: '2026-10-15',
      saleDate: '2026-10-15',
      cashRegisterNumber: 'ABC1234567890',
      buyerNipOnReceipt: true,
    });
  });
});
