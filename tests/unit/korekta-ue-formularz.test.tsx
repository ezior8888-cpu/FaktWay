// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AUD-70 KOR: formularz korekty zwykłej faktury dla firmy z UE.
 *  - nabywca z UE pokazany numerem VAT UE i krajem (lista faktur i formularz),
 *  - stawka „np. II” do wyboru tylko dla firmy z innego kraju UE (bez XI),
 *  - korekta kwotowa przejmuje wspólną stawkę bez VAT z faktury pierwotnej:
 *    zmiana VAT 0, brutto = netto, `amountChange.vatRate` w danych.
 */

const mocks = vi.hoisted(() => ({
  getContext: vi.fn(),
  saveDraft: vi.fn(),
  saveAndSend: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/invoices/correction-actions', () => ({
  getCorrectionParentContextAction: mocks.getContext,
  saveCorrectionDraftAction: mocks.saveDraft,
  saveAndSendCorrectionAction: mocks.saveAndSend,
}));
// Fikcyjny NIP testowy 1234567890 nie ma poprawnej sumy kontrolnej — tu nie
// ona jest przedmiotem testu, a bez niej szkic nie przeszedłby walidacji.
vi.mock('@/lib/xml/invoice-calculator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/xml/invoice-calculator')>()),
  validateNipChecksum: () => true,
}));

import {
  CorrectionInvoiceForm,
  type CorrectionParentInvoiceRow,
} from '@/components/invoices/correction-form';
import { NP_II_NOT_FOR_XI_MESSAGE } from '@/lib/schemas/invoice-form';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NP_II_LABEL = 'np. II (usługa dla firmy z UE)';
const PARENT_ID = '11111111-1111-4111-8111-111111111111';

const seller = {
  nip: '1234567890',
  name: 'Moja Firma',
  address: { addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa', countryCode: 'PL' },
};

const euBuyer = (vatUeNumber: string, countryCode: string) => ({
  type: 'eu' as const,
  vatUeNumber,
  name: 'Muster GmbH',
  address: { addressLine1: 'Musterstraße 1', addressLine2: '10115 Berlin', countryCode },
});

const b2bBuyer = {
  type: 'b2b' as const,
  idType: 'nip' as const,
  nip: '1234567890',
  name: 'Klient PL',
  address: { addressLine1: 'ul. Klienta 2', addressLine2: '00-002 Warszawa', countryCode: 'PL' },
};

const line = (vatRate: string) => ({
  name: 'Usługa programistyczna',
  unit: 'h',
  quantity: 10,
  unitPriceNet: 100,
  vatRate,
});

function parentRow(buyerData: unknown): CorrectionParentInvoiceRow {
  return {
    id: PARENT_ID,
    internal_number: 'FV/1/10/2026',
    ksef_number: '1234567890-20261001-0100A0B0C0D0-E1',
    issue_date: '2026-10-01',
    gross_total: 1000,
    buyer_data: buyerData,
  };
}

function context(buyer: unknown, lines: Array<ReturnType<typeof line>>) {
  return {
    success: true,
    issueDate: '2026-10-01',
    internalNumber: 'FV/1/10/2026',
    ksefNumber: '1234567890-20261001-0100A0B0C0D0-E1',
    grossTotal: 1000,
    seller,
    buyer,
    linesBefore: lines,
    linesAfter: structuredClone(lines),
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** Firma, dla której strona wyrenderowała listę faktur — zapis odsyła ją akcji (UX-01). */
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveDraft.mockResolvedValue({ success: true, invoiceId: 'kor-1' });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(rows: CorrectionParentInvoiceRow[], preselectedParentId?: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <CorrectionInvoiceForm parentInvoices={rows} preselectedParentId={preselectedParentId} tenantId={TENANT} />,
    );
  });
  // Kontekst faktury pierwotnej przychodzi asynchronicznie z akcji.
  await act(async () => {});
  return host;
}

async function renderFillForm(buyer: unknown, lines: Array<ReturnType<typeof line>>) {
  mocks.getContext.mockResolvedValue(context(buyer, lines));
  const el = await render([parentRow({ name: 'nieistotne' })], PARENT_ID);
  expect(el.textContent).toContain('Korekta faktury FV/1/10/2026');
  return el;
}

function rateSelects(el: HTMLElement): HTMLSelectElement[] {
  return [...el.querySelectorAll<HTMLSelectElement>('select[aria-label^="Stawka VAT pozycji"]')];
}

function optionValues(select: HTMLSelectElement): string[] {
  return [...select.options].map((o) => o.value);
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function chooseAmountChange(el: HTMLElement) {
  // E1: Base UI Select — otwieramy listę prawdziwym triggerem (mousedown) i klikamy opcję.
  const trigger = [...el.querySelectorAll<HTMLElement>('[role="combobox"]')].find((t) =>
    /Korekta|Typ/.test(t.textContent ?? ''),
  );
  expect(trigger).toBeDefined();
  await act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      trigger!.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }))
    }
  });
  const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (o) => o.textContent?.trim().startsWith('Korekta kwotowa'),
  );
  expect(option).toBeDefined();
  await act(async () => {
    option!.click()
  });
}

describe('lista faktur do korekty — identyfikator nabywcy', () => {
  it('firma z UE: VAT UE z krajem; firma z Polski: NIP', async () => {
    const el = await render([
      {
        ...parentRow({
          vatUeNumber: 'DE123456789',
          name: 'Muster GmbH',
          address: { addressLine1: 'Musterstraße 1', countryCode: 'DE' },
        }),
        id: '1',
      },
      { ...parentRow({ nip: '1234567890', name: 'Klient PL' }), id: '2', internal_number: 'FV/2/10/2026' },
    ]);
    const text = el.textContent ?? '';
    expect(text).toContain('Muster GmbH');
    expect(text).toContain('VAT UE: DE123456789 · Niemcy');
    expect(text).toContain('Klient PL');
    expect(text).toContain('NIP: 1234567890');
  });
});

describe('formularz korekty — nabywca z UE i stawka np. II', () => {
  it('firma z UE (DE): VAT UE w formularzu i np. II do wyboru', async () => {
    const el = await renderFillForm(euBuyer('DE123456789', 'DE'), [line('np_ii')]);
    const text = el.textContent ?? '';
    expect(text).toContain('Muster GmbH');
    expect(text).toContain('VAT UE: DE123456789 · Niemcy');

    const selects = rateSelects(el);
    expect(selects).toHaveLength(2); // „Było” i „Jest”
    for (const s of selects) {
      expect(optionValues(s)).toContain('np_ii');
      expect(optionValues(s)).toContain('np');
      expect(s.value).toBe('np_ii');
      expect(s.getAttribute('aria-invalid')).toBeNull();
    }
    expect(el.innerHTML).toContain(`<option value="np_ii">${NP_II_LABEL}</option>`);
  });

  it('Grecja (EL): np. II dozwolona, kraj z adresu (GR)', async () => {
    const el = await renderFillForm(euBuyer('EL123456789', 'GR'), [line('23')]);
    expect(el.textContent).toContain('VAT UE: EL123456789 · Grecja');
    for (const s of rateSelects(el)) expect(optionValues(s)).toContain('np_ii');
  });

  it('firma z Polski: NIP i bez np. II', async () => {
    const el = await renderFillForm(b2bBuyer, [line('23')]);
    expect(el.textContent).toContain('NIP: 1234567890');
    const selects = rateSelects(el);
    expect(selects).toHaveLength(2);
    for (const s of selects) {
      expect(optionValues(s)).not.toContain('np_ii');
      expect(optionValues(s)).toContain('np');
    }
  });

  it('Irlandia Płn. (XI) z pozycją np. II: wartość zostaje, ale z komunikatem', async () => {
    const el = await renderFillForm(euBuyer('XI123456789', 'XI'), [line('np_ii')]);
    for (const s of rateSelects(el)) {
      expect(s.value).toBe('np_ii');
      expect(s.getAttribute('aria-invalid')).toBe('true');
    }
    expect(el.textContent).toContain(NP_II_NOT_FOR_XI_MESSAGE);
  });

  it('Irlandia Płn. (XI) bez np. II w pozycjach: stawki nie ma do wyboru', async () => {
    const el = await renderFillForm(euBuyer('XI123456789', 'XI'), [line('np')]);
    for (const s of rateSelects(el)) expect(optionValues(s)).not.toContain('np_ii');
    expect(el.textContent).not.toContain(NP_II_NOT_FOR_XI_MESSAGE);
  });
});

describe('korekta kwotowa — stawka bez VAT z faktury pierwotnej', () => {
  it('np. II z pozycji: VAT 0, brutto = netto, vatRate w danych szkicu', async () => {
    const el = await renderFillForm(euBuyer('DE123456789', 'DE'), [line('np_ii'), line('np_ii')]);
    await chooseAmountChange(el);

    expect(el.textContent).toContain(`Stawka z faktury pierwotnej: ${NP_II_LABEL} — bez VAT`);
    const vat = el.querySelector<HTMLInputElement>('#amount-change-vat')!;
    const gross = el.querySelector<HTMLInputElement>('#amount-change-gross')!;
    expect(vat.disabled).toBe(true);
    expect(vat.value).toBe('0');
    expect(gross.readOnly).toBe(true);
    // Etykiety nowych/zmienionych pól są powiązane z polami.
    expect(el.querySelector('label[for="amount-change-vat"]')?.textContent).toBe('Zmiana VAT (±)');
    expect(el.querySelector('label[for="amount-change-gross"]')?.textContent).toBe('Zmiana brutto (±)');

    await act(async () => {
      setValue(el.querySelector<HTMLInputElement>('#amount-change-net')!, '-100');
      setValue(el.querySelector<HTMLInputElement>('input[placeholder="KOR/2026/04/001"]')!, 'KOR/2026/10/001');
      setValue(el.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Np. błąd"]')!, 'Rabat posprzedażowy');
      setValue(el.querySelector<HTMLInputElement>('#amount-change-description')!, 'Rabat');
    });
    expect(gross.value).toBe('-100');

    const draft = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Zapisz szkic')!;
    await act(async () => draft.click());
    await act(async () => {});

    expect(mocks.saveDraft).toHaveBeenCalledTimes(1);
    expect(mocks.saveDraft.mock.calls[0]![1]).toBe(TENANT);
    expect(mocks.saveDraft.mock.calls[0]![0]).toMatchObject({
      correctionType: 'amount_change',
      buyer: { type: 'eu', vatUeNumber: 'DE123456789' },
      amountChange: { netDelta: -100, vatDelta: 0, grossDelta: -100, vatRate: 'np_ii', description: 'Rabat' },
    });
  });

  it('pozycje z różnymi stawkami: VAT do wpisania, bez vatRate', async () => {
    const el = await renderFillForm(euBuyer('DE123456789', 'DE'), [line('np_ii'), line('23')]);
    await chooseAmountChange(el);

    expect(el.textContent).not.toContain('Stawka z faktury pierwotnej');
    const vat = el.querySelector<HTMLInputElement>('#amount-change-vat')!;
    const gross = el.querySelector<HTMLInputElement>('#amount-change-gross')!;
    expect(vat.disabled).toBe(false);
    expect(gross.readOnly).toBe(false);

    await act(async () => {
      setValue(el.querySelector<HTMLInputElement>('#amount-change-net')!, '-100');
      setValue(vat, '-23');
      setValue(gross, '-123');
      setValue(el.querySelector<HTMLInputElement>('input[placeholder="KOR/2026/04/001"]')!, 'KOR/2026/10/002');
      setValue(el.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Np. błąd"]')!, 'Rabat posprzedażowy');
      setValue(el.querySelector<HTMLInputElement>('#amount-change-description')!, 'Rabat');
    });
    const draft = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Zapisz szkic')!;
    await act(async () => draft.click());
    await act(async () => {});

    expect(mocks.saveDraft).toHaveBeenCalledTimes(1);
    const payload = mocks.saveDraft.mock.calls[0]![0] as { amountChange: Record<string, unknown> };
    expect(payload.amountChange).toMatchObject({ netDelta: -100, vatDelta: -23, grossDelta: -123 });
    expect(payload.amountChange.vatRate).toBeUndefined();
  });
});
