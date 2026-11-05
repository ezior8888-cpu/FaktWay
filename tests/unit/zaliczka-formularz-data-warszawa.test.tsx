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
vi.mock('@/components/invoices/actions', () => ({ lookupBuyerAction: vi.fn() }));

import { AdvanceInvoiceForm } from '@/components/invoices/advance-form';

/**
 * A1 (W5 z rewizji 03.10.2026): formularz zaliczki brał „dziś” z UTC. Między
 * polską północą a 1:00/2:00 domyślna data wystawienia była wczorajsza
 * (na przełomie miesiąca — poprzedni okres VAT), a wysyłka, która wymaga
 * dzisiejszej daty, odmawiała klientowi, który niczego nie zmieniał.
 */
/** Firma formularza (UX-01) — w tym teście tylko wymagany prop. */
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const seller = {
  nip: '1234567890', name: 'Firma testowa',
  address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 1 listopada 00:30 czasu polskiego = 31 października 23:30 UTC.
  vi.setSystemTime(new Date('2026-10-31T23:30:00Z'));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

async function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<AdvanceInvoiceForm initialSeller={seller} tenantId={TENANT} />);
  });
  return host;
}

const valueOf = (el: HTMLElement, name: string) =>
  el.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value;

describe('formularz zaliczki — daty w czasie polskim', () => {
  it('po polskiej północy domyślna data wystawienia to już nowy dzień', async () => {
    expect(valueOf(await render(), 'issueDate')).toBe('2026-11-01');
  });

  it('termin płatności: 14 dni od daty wystawienia w Polsce', async () => {
    expect(valueOf(await render(), 'paymentDueDate')).toBe('2026-11-15');
  });
});
