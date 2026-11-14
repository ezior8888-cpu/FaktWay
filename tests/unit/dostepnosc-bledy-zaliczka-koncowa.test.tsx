// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/invoices/advance-actions', () => ({
  saveAdvanceAction: vi.fn(),
  saveAndSendAdvanceAction: vi.fn(),
}));
vi.mock('@/components/invoices/final-actions', () => ({
  saveFinalAction: vi.fn(),
  saveAndSendFinalAction: vi.fn(),
}));
vi.mock('@/components/invoices/actions', () => ({ lookupBuyerAction: vi.fn() }));

import { AdvanceInvoiceForm } from '@/components/invoices/advance-form';
import { FinalInvoiceForm } from '@/components/invoices/final-form';

/**
 * Audyt dostępności 11.2026, A-01: w formularzach faktury zaliczkowej
 * i rozliczającej komunikat błędu pola ma `id` i `role="alert"`, a pole
 * `aria-invalid` i `aria-describedby` na ten komunikat (jak w głównym
 * formularzu faktury, #712).
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const seller = {
  nip: '1234567890', name: 'Firma testowa',
  address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
};
const zaliczki = [
  { id: 'zal-1', internal_number: 'ZAL/1', ksef_number: null, issue_date: '2026-10-01', advance_amount: 100, gross_total: 100 },
];

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(el: React.ReactElement) {
  await act(async () => {
    root.render(el);
  });
}

async function wpisz(id: string, value: string) {
  const el = host.querySelector<HTMLInputElement>(`#${id}`);
  if (!el) throw new Error(`brak pola ${id}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function zapisz() {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Zapisz szkic');
  if (!b) throw new Error('brak przycisku');
  await act(async () => {
    b.click();
    await new Promise((r) => setTimeout(r, 50));
  });
}

function sprawdzPowiazanie(oczekiwane: string[]) {
  // Każdy czerwony komunikat pola ma id i role=alert.
  const komunikaty = [...host.querySelectorAll<HTMLElement>('p.text-destructive')];
  expect(komunikaty.length).toBeGreaterThan(0);
  for (const p of komunikaty) {
    expect(p.id, `komunikat „${p.textContent}” bez id`).not.toBe('');
    expect(p.getAttribute('role'), `komunikat „${p.textContent}” bez role`).toBe('alert');
  }
  // Każde pole z aria-invalid wskazuje komunikat, a każdy komunikat ma pole.
  const niepoprawne = [...host.querySelectorAll<HTMLElement>('[aria-invalid="true"]')];
  const wskazane = new Set<string>();
  for (const pole of niepoprawne) {
    const id = pole.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(id), `pole ${pole.id || pole.outerHTML.slice(0, 60)} bez opisu`).not.toBeNull();
    wskazane.add(id);
  }
  for (const p of komunikaty) expect(wskazane.has(p.id), `komunikat ${p.id} bez pola`).toBe(true);
  for (const id of oczekiwane) expect(document.getElementById(id), `brak komunikatu ${id}`).not.toBeNull();
}

describe('A-01: błędy pól w formularzu faktury zaliczkowej', () => {
  it('błędy są powiązane z polami', async () => {
    await render(<AdvanceInvoiceForm initialSeller={seller} tenantId={TENANT} />);
    await wpisz('internalNumber', '');
    await wpisz('payment-due-date', '');
    await wpisz('advance-bank-account', 'abc');
    await wpisz('advance-amount', '0');
    await zapisz();
    sprawdzPowiazanie(['internalNumber-error', 'advance-bank-account-error', 'advance-amount-error']);
  });
});

describe('A-01: błędy pól w formularzu faktury rozliczającej', () => {
  it('błędy są powiązane z polami', async () => {
    await render(<FinalInvoiceForm initialSeller={seller} advanceInvoices={zaliczki} tenantId={TENANT} />);
    await wpisz('internalNumber', '');
    await wpisz('payment-due-date', '');
    await wpisz('final-bank-account', 'abc');
    await zapisz();
    sprawdzPowiazanie(['internalNumber-error', 'final-bank-account-error', 'final-advance-ids-error', 'final-lines-error']);
  });
});
