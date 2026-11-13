// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CachedValidationResult } from '@/lib/validation/cache';

const h = vi.hoisted(() => ({
  state: { status: 'idle', result: null, error: null } as {
    status: string;
    result: unknown;
    error: string | null;
  },
}));

vi.mock('@/hooks/use-nip-validation', () => ({
  useNipValidation: () => ({ ...h.state, validate: () => {}, reset: () => {} }),
}));
vi.mock('@/components/invoices/actions', () => ({ lookupBuyerAction: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { BuyerLookup } from '@/components/invoices/buyer-lookup';

/** Audyt dostępności 11.2026, A-06 (T-6): wynik sprawdzenia NIP nabywcy. */

const baza: CachedValidationResult = {
  nip: '5252241585',
  countryCode: 'PL',
  isValid: true,
  vatStatus: 'active',
  legalName: 'Firma Czynna',
  bankAccounts: [],
  fromCache: false,
  source: 'whitelist',
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(nipError?: string) {
  await act(async () => {
    root.render(
      <BuyerLookup inputId="buyer-nip" nip="5252241585" onNipChange={() => {}} onSelected={() => {}} nipError={nipError} />,
    );
  });
}

describe('T-6: wynik NIP nabywcy', () => {
  it('aktywny podatnik: wynik w role=status, ikony aria-hidden, pole opisane', async () => {
    h.state = { status: 'success', result: baza, error: null };
    await render();
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain('Firma Czynna');
    const input = container.querySelector('#buyer-nip')!;
    expect(input.getAttribute('aria-invalid')).toBeNull();
    const ids = (input.getAttribute('aria-describedby') ?? '').split(/\s+/);
    expect(ids).toContain(status!.id);
    for (const svg of container.querySelectorAll('svg')) expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('wykreślony: role=alert i aria-invalid na polu', async () => {
    h.state = { status: 'success', result: { ...baza, isValid: false, vatStatus: 'inactive' }, error: null };
    await render();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Wykreślony z VAT');
    const input = container.querySelector('#buyer-nip')!;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain(alert!.id);
  });

  it('błąd pola z formularza: komunikat role=alert opisuje pole, aria-invalid', async () => {
    h.state = { status: 'idle', result: null, error: null };
    await render('NIP musi mieć 10 cyfr');
    const input = container.querySelector('#buyer-nip')!;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const opis = document.getElementById(input.getAttribute('aria-describedby')!.split(' ')[0]!);
    expect(opis?.getAttribute('role')).toBe('alert');
    expect(opis?.textContent).toBe('NIP musi mieć 10 cyfr');
  });

  it('błąd sprawdzenia w tle: role=alert', async () => {
    h.state = { status: 'error', result: null, error: 'brak połączenia' };
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('brak połączenia');
  });
});
