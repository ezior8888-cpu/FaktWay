// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ saveDraft: vi.fn(), send: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/invoices/actions', () => ({
  saveDraftAction: m.saveDraft,
  saveAndSendInvoiceAction: m.send,
  lookupBuyerAction: vi.fn(),
  prefillFromLastInvoiceAction: vi.fn(),
}));

import { InvoiceForm } from '@/components/invoices/invoice-form';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

const POS = '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d';
/** Firma, dla której strona wyrenderowała formularz — zapis odsyła ją akcji (UX-01). */
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/**
 * Plan Finora N1: podkład (`?cykliczna=`, `?wzor=`) wpisany od razu
 * w formularz i ukryte pole pozycji cyklicznej, które dochodzi do akcji
 * zapisu. Bez podkładu formularz jak dotąd.
 */

const podklad: Partial<InvoiceFormValues> = {
  internalNumber: 'FV/2/10/2026',
  issueDate: '2026-10-20',
  saleDate: '2026-10-20',
  paymentDueDate: '2026-11-03',
  buyerNip: '5252241585',
  buyerName: 'Klient Podkład',
  buyerAddressLine1: 'ul. B 2',
  buyerAddressLine2: '00-002 Warszawa',
  paymentMethod: 'transfer',
  bankAccount: 'PL61109010140000071219812874',
  lines: [{ name: 'Abonament miesięczny', unit: 'mies.', quantity: 1, unitPriceNet: 500, vatRate: '23' }],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T08:00:00Z'));
  m.saveDraft.mockReset().mockResolvedValue({ success: false, error: 'stop' });
  m.send.mockReset().mockResolvedValue({ success: false, error: 'stop' });
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

function input(name: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!el) throw new Error(`brak pola ${name}`);
  return el;
}

async function zapiszSzkic() {
  const przycisk = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Szkic');
  await act(async () => {
    przycisk!.click();
    await new Promise((r) => setTimeout(r, 20));
  });
}

function przyciski(): string[] {
  return [...container.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
}

async function wystaw() {
  const przycisk = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Wystaw i wyślij do KSeF'));
  await act(async () => {
    przycisk!.click();
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe('formularz faktury — podkład i pozycja cykliczna', () => {
  it('podkład w polach od pierwszego renderu; pozycja i okres dochodzą do „Wystaw i wyślij” (C3)', async () => {
    await act(async () => {
      root.render(
        <InvoiceForm tenantId={TENANT} initialValues={podklad} recurringInvoiceId={POS} recurringPeriod="2026-11" suggestedNumber="FV/9/10/2026" />,
      );
    });
    expect(input('buyerName').value).toBe('Klient Podkład');
    expect(input('internalNumber').value).toBe('FV/2/10/2026');
    expect(input('lines.0.name').value).toBe('Abonament miesięczny');
    expect(input('recurringInvoiceId').type).toBe('hidden');
    expect(input('recurringInvoiceId').value).toBe(POS);
    expect(input('recurringPeriod').type).toBe('hidden');
    expect(input('recurringPeriod').value).toBe('2026-11');

    await wystaw();
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.send.mock.calls[0]![1]).toBe(TENANT);
    expect(m.send.mock.calls[0]![0]).toMatchObject({
      recurringInvoiceId: POS,
      recurringPeriod: '2026-11',
      buyerName: 'Klient Podkład',
    });
  });

  it('z pozycji cyklicznej nie ma szkicu: bez „Szkic” i „Zapisz szkic”, z wyjaśnieniem (C2)', async () => {
    await act(async () => {
      root.render(<InvoiceForm tenantId={TENANT} initialValues={podklad} recurringInvoiceId={POS} recurringPeriod="2026-11" />);
    });
    const etykiety = przyciski();
    expect(etykiety).not.toContain('Szkic');
    expect(etykiety.some((t) => t.includes('Zapisz'))).toBe(false);
    expect(etykiety.some((t) => t.includes('Wystaw i wyślij do KSeF'))).toBe(true);
    expect(container.textContent).toContain('Fakturę cykliczną wystawiasz od razu — szkic nie zamyka okresu.');
    expect(m.saveDraft).not.toHaveBeenCalled();
  });

  it('„Duplikuj” (podkład bez pozycji) — bez ukrytego pola i bez recurringInvoiceId w zapisie', async () => {
    await act(async () => {
      root.render(<InvoiceForm tenantId={TENANT} initialValues={podklad} />);
    });
    expect(container.querySelector('input[name="recurringInvoiceId"]')).toBeNull();
    expect(container.querySelector('input[name="recurringPeriod"]')).toBeNull();
    expect(container.textContent).not.toContain('szkic nie zamyka okresu');
    await zapiszSzkic();
    expect(m.saveDraft.mock.calls[0]![0]).not.toHaveProperty('recurringInvoiceId');
    expect(m.saveDraft.mock.calls[0]![1]).toBe(TENANT);
  });
});
