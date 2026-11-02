// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan Finora E9 (P6): arkusz „+ Nowa faktura cykliczna” / „Edytuj” w oprawie
 * `create-recurring-invoice-sheet.tsx` Finory. Zamiast pozycji faktury: wybór
 * faktury-wzoru, nazwa, częstotliwość, dzień 1–28 i „Następne wystawienie”
 * tylko do odczytu. Odmowa akcji (po polsku) zostaje w formularzu.
 */

const m = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  search: vi.fn(),
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: m.refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: m.toastSuccess, error: vi.fn() } }));
vi.mock('@/app/actions/recurring-invoices', () => ({
  createRecurringInvoiceAction: m.create,
  updateRecurringInvoiceAction: m.update,
}));
vi.mock('@/app/actions/recurring-invoice-templates', () => ({ searchRecurringTemplatesAction: m.search }));

import {
  NO_TEMPLATES_TEXT,
  RecurringInvoiceSheet,
  type RecurringInvoiceSheetProps,
} from '@/app/(dashboard)/(faktury)/invoices/recurring/_components/recurring-invoice-sheet';
import type { RecurringInvoiceListItem, RecurringTemplateCandidate } from '@/lib/invoices/recurring/queries';

const TPL = '7f1c2d3e-4b5a-4c6d-8e7f-901234567890';
const REC = '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d';

const CANDIDATE: RecurringTemplateCandidate = {
  id: TPL,
  internalNumber: 'FV/7/10/2026',
  issueDate: '2026-10-07',
  grossTotal: 1230,
  contractorName: 'Acme spółka z ograniczoną odpowiedzialnością',
};

const EDITING: RecurringInvoiceListItem = {
  id: REC,
  tenant_id: 'firma-a',
  template_invoice_id: TPL,
  name: 'Abonament Acme',
  frequency: 'quarterly',
  day_of_month: 10,
  next_run_date: '2026-11-10',
  active: true,
  created_by: null,
  created_at: '2026-10-01T08:00:00Z',
  updated_at: '2026-10-01T08:00:00Z',
  status: 'active',
  period: '2026-Q4',
  contractorName: 'Acme spółka z ograniczoną odpowiedzialnością',
  templateNumber: 'FV/7/10/2026',
  templateGrossTotal: 1230,
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function renderSheet(props: Partial<RecurringInvoiceSheetProps> = {}) {
  act(() => {
    root.render(
      <RecurringInvoiceSheet open onOpenChange={vi.fn()} today="2026-10-20" candidates={[CANDIDATE]} {...props} />,
    );
  });
}

const input = (id: string) => document.getElementById(id) as HTMLInputElement | null;
const text = () => document.body.textContent ?? '';

async function submit() {
  const form = document.getElementById('recurring-invoice-form') as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  // RHF waliduje asynchronicznie, potem akcja w `startTransition`.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('arkusz „Nowa faktura cykliczna”', () => {
  it('oprawa Finory po polsku: tytuł, pola, sekcja Harmonogram, przyciski stopki', () => {
    renderSheet({ initialTemplate: CANDIDATE });
    expect(text()).toContain('Nowa faktura cykliczna');
    expect(text()).toContain('Faktura-wzór');
    expect(text()).toContain('Harmonogram');
    expect(text()).toContain('Częstotliwość');
    expect(text()).toContain('Dzień miesiąca');
    expect(text()).toContain('Następne wystawienie');
    expect(text()).toContain('Dodaj fakturę cykliczną');
    expect(text()).toContain('Anuluj');
  });

  it('wzór z ?wzor=: nazwa z kontrahenta (skrócona forma), dzień z daty wzoru, podgląd daty tylko do odczytu', () => {
    renderSheet({ initialTemplate: CANDIDATE });
    expect(input('recurring-invoice-form-name')?.value).toBe('Acme sp. z o.o.');
    expect(input('recurring-invoice-form-day')?.value).toBe('7');
    const next = input('recurring-invoice-form-next');
    expect(next?.readOnly).toBe(true);
    // Dziś 20.10, dzień 7 już minął → 07.11.2026, faktura za listopad.
    expect(next?.value).toBe('07.11.2026');
    expect(text()).toContain('Faktura za listopad 2026');
  });

  it('wzór wystawiony dziś: podgląd jak zapis — pierwszy termin za miesiąc, nie okres wzoru (C5, C6)', () => {
    renderSheet({ initialTemplate: { ...CANDIDATE, issueDate: '2026-10-20' } });
    expect(input('recurring-invoice-form-day')?.value).toBe('20');
    // Bez daty wzoru w podglądzie byłoby 20.10.2026 — październik, który pokrywa już wzór.
    expect(input('recurring-invoice-form-next')?.value).toBe('20.11.2026');
    expect(text()).toContain('Faktura za listopad 2026');
  });

  it('brak faktur do wyboru: wyjaśnienie warunków wzoru zamiast pustej listy', () => {
    renderSheet({ candidates: [] });
    expect(text()).toContain(NO_TEMPLATES_TEXT);
  });

  it('wzór z adresu nie spełnia warunków: komunikat w arkuszu', () => {
    renderSheet({ templateNotice: 'Nie znaleźliśmy tej faktury wśród możliwych wzorów.' });
    expect(text()).toContain('Nie znaleźliśmy tej faktury wśród możliwych wzorów.');
  });

  it('odmowa akcji zostaje w formularzu po polsku, arkusz się nie zamyka', async () => {
    m.create.mockResolvedValue({ success: false, error: 'Wzorem może być tylko faktura przyjęta przez KSeF.' });
    const onOpenChange = vi.fn();
    renderSheet({ initialTemplate: CANDIDATE, onOpenChange });
    await submit();
    expect(m.create).toHaveBeenCalledWith({
      templateInvoiceId: TPL,
      name: 'Acme sp. z o.o.',
      frequency: 'monthly',
      dayOfMonth: 7,
    });
    expect(text()).toContain('Wzorem może być tylko faktura przyjęta przez KSeF.');
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(m.refresh).not.toHaveBeenCalled();
  });

  it('błędy walidacji po polsku: bez wzoru i z dniem 31 nic nie idzie do serwera', async () => {
    renderSheet();
    const day = input('recurring-invoice-form-day')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(day, '31');
      day.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await submit();
    expect(m.create).not.toHaveBeenCalled();
    expect(text()).toContain('Wybierz fakturę-wzór');
    expect(text()).toContain('29, 30 i 31 nie ma w każdym miesiącu');
  });

  it('zapis: komunikat z datą DD.MM.RRRR, zamknięcie i odświeżenie listy', async () => {
    m.create.mockResolvedValue({
      success: true,
      recurringInvoice: { ...EDITING, name: 'Acme sp. z o.o.', next_run_date: '2026-11-07' },
    });
    const onOpenChange = vi.fn();
    renderSheet({ initialTemplate: CANDIDATE, onOpenChange });
    await submit();
    expect(m.toastSuccess).toHaveBeenCalledWith('Dodano „Acme sp. z o.o.”. Następne wystawienie: 07.11.2026.');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(m.refresh).toHaveBeenCalled();
  });
});

describe('arkusz „Edytuj fakturę cykliczną”', () => {
  it('wzór tylko do odczytu (bez wyszukiwarki), pola z pozycji, zapis przez akcję edycji', async () => {
    m.update.mockResolvedValue({ success: true, recurringInvoice: EDITING });
    renderSheet({ editing: EDITING });
    expect(text()).toContain('Edytuj fakturę cykliczną');
    expect(input('recurring-invoice-form-template-readonly')?.value).toBe('FV/7/10/2026 · Acme sp. z o.o.');
    expect(input('recurring-invoice-form-search')).toBeNull();
    expect(input('recurring-invoice-form-name')?.value).toBe('Abonament Acme');
    expect(input('recurring-invoice-form-day')?.value).toBe('10');
    // Bez zmiany dnia i częstotliwości data zostaje.
    expect(input('recurring-invoice-form-next')?.value).toBe('10.11.2026');
    expect(text()).toContain('Zapisz zmiany');
    await submit();
    expect(m.update).toHaveBeenCalledWith(REC, {
      templateInvoiceId: TPL,
      name: 'Abonament Acme',
      frequency: 'quarterly',
      dayOfMonth: 10,
    });
    expect(m.create).not.toHaveBeenCalled();
  });
});
