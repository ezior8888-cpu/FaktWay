// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  saveDraft: vi.fn(),
  send: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: m.toastError } }));
vi.mock('@/components/invoices/actions', () => ({
  saveDraftAction: m.saveDraft,
  saveAndSendInvoiceAction: m.send,
  lookupBuyerAction: vi.fn(),
  prefillFromLastInvoiceAction: vi.fn(),
}));
vi.mock('@/components/invoices/buyer-lookup', () => ({
  BuyerLookup: (p: { inputId?: string; nip: string }) => <input id={p.inputId} defaultValue={p.nip} />,
}));

import { InvoiceForm } from '@/components/invoices/invoice-form';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

/**
 * Audyt dostępności 11.2026, A-01 (T-1) i A-05 (T-5): błędy pól są powiązane
 * z polami, a po nieudanym zapisie stoi blok `role="alert"` z listą błędów
 * i odnośnikami do pól, który przejmuje fokus.
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const podklad: Partial<InvoiceFormValues> = {
  internalNumber: 'FV/2/10/2026',
  buyerNip: '5252241585',
  buyerName: 'Klient Podkład',
  buyerAddressLine1: 'ul. B 2',
  buyerAddressLine2: '00-002 Warszawa',
  paymentMethod: 'transfer',
  bankAccount: 'PL61109010140000071219812874',
  lines: [{ name: 'Abonament', unit: 'mies.', quantity: 1, unitPriceNet: 500, vatRate: '23' }],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T08:00:00Z'));
  for (const f of Object.values(m)) f.mockReset();
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

async function wyslij(values: Partial<InvoiceFormValues>) {
  await act(async () => {
    root.render(<InvoiceForm tenantId={TENANT} initialValues={values} />);
  });
  const b = [...container.querySelectorAll('button')].find(
    (x) => x.textContent?.trim() === 'Wystaw i wyślij do KSeF',
  );
  if (!b) throw new Error('brak przycisku');
  await act(async () => {
    b.click();
    await new Promise((r) => setTimeout(r, 30));
  });
}

const blok = () => container.querySelector<HTMLElement>('[data-testid="blok-bledow-formularza"]');

describe('T-1: błędy pól powiązane z polami', () => {
  it('źródła: każdy <p className={errorTextClass}> ma id albo role', () => {
    const dir = join(process.cwd(), 'components/invoices/invoice-form-parts');
    const zle: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.tsx'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const t of src.matchAll(/<p\b[^>]*className=\{(?:cn\()?errorTextClass[^>]*>/g)) {
        if (!/\bid=/.test(t[0]) && !/role=/.test(t[0])) zle.push(`${f}: ${t[0]}`);
      }
    }
    expect(zle).toEqual([]);
  });

  it('render: pole z błędem ma aria-invalid i aria-describedby na komunikat z role=alert', async () => {
    await wyslij({});
    const niepoprawne = [...container.querySelectorAll<HTMLElement>('[aria-invalid="true"]')];
    expect(niepoprawne.length).toBeGreaterThan(0);
    for (const pole of niepoprawne) {
      const ids = (pole.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      const opisy = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
      expect(opisy.some((e) => e.getAttribute('role') === 'alert' && (e.textContent ?? '').trim().length > 0)).toBe(true);
    }
  });
});

describe('T-5: blok błędów nad akcjami', () => {
  it('błąd walidacji: role=alert z listą odnośników do pól i fokus na bloku; toast zostaje', async () => {
    await wyslij({});
    const b = blok();
    expect(b).not.toBeNull();
    expect(b!.getAttribute('role')).toBe('alert');
    const linki = [...b!.querySelectorAll<HTMLAnchorElement>('li a[href^="#"]')];
    expect(linki.length).toBeGreaterThan(0);
    for (const a of linki) expect(document.getElementById(a.getAttribute('href')!.slice(1))).not.toBeNull();
    expect(document.activeElement).toBe(b);
    expect(m.toastError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ duration: 10000 }));
  });

  it('błąd zapisu z serwera: ten sam blok z treścią błędu, dłuższy toast', async () => {
    m.send.mockResolvedValue({ success: false, error: 'KSeF odmówił przyjęcia' });
    await wyslij(podklad);
    const b = blok();
    expect(b).not.toBeNull();
    expect(b!.textContent).toContain('KSeF odmówił przyjęcia');
    expect(document.activeElement).toBe(b);
    expect(m.toastError).toHaveBeenCalledWith('KSeF odmówił przyjęcia', expect.objectContaining({ duration: 10000 }));
  });

  it('poprawny formularz bez błędu: bloku nie ma', async () => {
    m.send.mockResolvedValue({ success: true, invoiceId: 'inv-1' });
    await wyslij(podklad);
    expect(blok()).toBeNull();
  });
});
