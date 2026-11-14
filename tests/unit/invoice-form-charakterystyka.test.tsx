// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CachedValidationResult } from '@/lib/validation/cache';

const m = vi.hoisted(() => ({
  saveDraft: vi.fn(),
  send: vi.fn(),
  push: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: m.push, refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: m.toastSuccess, error: m.toastError } }));
vi.mock('@/components/invoices/actions', () => ({
  saveDraftAction: m.saveDraft,
  saveAndSendInvoiceAction: m.send,
  lookupBuyerAction: vi.fn(),
  prefillFromLastInvoiceAction: vi.fn(),
}));

/**
 * Wyszukiwarka NIP zastąpiona przyciskami: wynik białej listy i wybór z GUS
 * wchodzą do formularza tymi samymi wywołaniami zwrotnymi co w aplikacji.
 */
const nieaktywny: CachedValidationResult = {
  nip: '5252241585',
  countryCode: 'PL',
  isValid: false,
  vatStatus: 'inactive',
  legalName: 'Firma Wykreślona',
  bankAccounts: [],
  fromCache: false,
  source: 'whitelist',
};
vi.mock('@/components/invoices/buyer-lookup', () => ({
  BuyerLookup: (p: {
    inputId?: string;
    nip: string;
    onNipChange: (digits: string) => void;
    onSelected: (d: { nip: string; name: string; addressLine1: string; addressLine2: string }) => void;
    onValidationComplete?: (r: CachedValidationResult | null) => void;
  }) => (
    <div>
      <input id={p.inputId} data-testid="nip" value={p.nip} onChange={(e) => p.onNipChange(e.target.value)} />
      <button type="button" onClick={() => p.onValidationComplete?.(nieaktywny)}>biała lista</button>
      <button
        type="button"
        onClick={() => p.onSelected({ nip: '5252241585', name: 'Z GUS', addressLine1: 'ul. GUS 1', addressLine2: '00-950 Warszawa' })}
      >
        gus
      </button>
    </div>
  ),
}));

import { InvoiceForm } from '@/components/invoices/invoice-form';
import type { PrefillFromLastInvoice } from '@/components/invoices/actions';
import { EU_BUYER_COUNTRIES, NP_II_REQUIRES_EU_BUYER_MESSAGE, type InvoiceFormValues } from '@/lib/schemas/invoice-form';

/**
 * Plan usprawnień 3.7c: zachowanie formularza zwykłej faktury spisane przed
 * podziałem `invoice-form.tsx` (niezmienniki w `PLAN-USPRAWNIENIA-PRACY.md`,
 * 3.7c). Po podziale ten plik przechodzi bez zmian.
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
let desktop = false;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T08:00:00Z'));
  for (const f of Object.values(m)) f.mockReset();
  m.saveDraft.mockResolvedValue({ success: false, error: 'stop' });
  m.send.mockResolvedValue({ success: false, error: 'stop' });
  window.confirm = vi.fn(() => true);
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
}

function q<T extends Element = HTMLInputElement>(selector: string): T {
  const el = container.querySelector<T>(selector);
  if (!el) throw new Error(`brak ${selector}`);
  return el;
}

function przycisk(tekst: string): HTMLButtonElement {
  const b = [...container.querySelectorAll('button')].find((x) => x.textContent?.trim() === tekst);
  if (!b) throw new Error(`brak przycisku ${tekst}`);
  return b;
}

async function klik(el: HTMLElement) {
  await act(async () => {
    el.click();
    await new Promise((r) => setTimeout(r, 20));
  });
}

async function wpisz(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(el) as object;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
  });
}

const wyslij = () => klik(przycisk('Wystaw i wyślij do KSeF'));

describe('wysyłka i szkic', () => {
  it('poprawny formularz: akcja z wartościami i firmą strony, toast, przejście do faktury', async () => {
    m.send.mockResolvedValue({ success: true, invoiceId: 'inv-1' });
    await render(<InvoiceForm tenantId={TENANT} initialValues={podklad} />);
    await wyslij();
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.send.mock.calls[0]![1]).toBe(TENANT);
    expect(m.send.mock.calls[0]![0]).toMatchObject({
      internalNumber: 'FV/2/10/2026',
      issueDate: '2026-10-20',
      saleDate: '2026-10-20',
      paymentDueDate: '2026-11-03',
      buyerName: 'Klient Podkład',
      lines: [{ name: 'Abonament', unit: 'mies.', quantity: 1, unitPriceNet: 500, vatRate: '23' }],
    });
    expect(m.toastSuccess).toHaveBeenCalledWith('Wysyłanie faktury do KSeF rozpoczęte');
    expect(m.push).toHaveBeenCalledWith('/invoices/inv-1');
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('podwójne kliknięcie: jedna akcja (audyt #11)', async () => {
    let zwolnij: (v: unknown) => void = () => {};
    m.send.mockReturnValue(new Promise((r) => { zwolnij = r; }));
    await render(<InvoiceForm tenantId={TENANT} initialValues={podklad} />);
    const b = przycisk('Wystaw i wyślij do KSeF');
    await act(async () => {
      b.click();
      b.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(m.send).toHaveBeenCalledTimes(1);
    await act(async () => {
      zwolnij({ success: false, error: 'stop' });
    });
  });

  it('błąd akcji z fakturą: toast i przejście; bez faktury: tylko toast; blokada zwolniona', async () => {
    m.send.mockResolvedValueOnce({ success: false, error: 'KSeF odmówił', invoiceId: 'inv-2' });
    m.send.mockResolvedValueOnce({ success: false, error: 'Brak firmy' });
    await render(<InvoiceForm tenantId={TENANT} initialValues={podklad} />);
    await wyslij();
    expect(m.toastError).toHaveBeenLastCalledWith('KSeF odmówił', { duration: 10000 });
    expect(m.push).toHaveBeenCalledWith('/invoices/inv-2');
    await wyslij();
    expect(m.toastError).toHaveBeenLastCalledWith('Brak firmy', { duration: 10000 });
    expect(m.push).toHaveBeenCalledTimes(1);
    expect(m.send).toHaveBeenCalledTimes(2);
  });

  it('wyjątek akcji: jego komunikat albo „Błąd wysyłki” / „Błąd zapisu”', async () => {
    m.send.mockRejectedValueOnce(new Error('sieć padła'));
    m.send.mockRejectedValueOnce('coś');
    m.saveDraft.mockRejectedValueOnce('coś');
    await render(<InvoiceForm tenantId={TENANT} initialValues={podklad} />);
    await wyslij();
    expect(m.toastError).toHaveBeenLastCalledWith('sieć padła', { duration: 10000 });
    await wyslij();
    expect(m.toastError).toHaveBeenLastCalledWith('Błąd wysyłki', { duration: 10000 });
    await klik(przycisk('Szkic'));
    expect(m.toastError).toHaveBeenLastCalledWith('Błąd zapisu', { duration: 10000 });
  });

  it('szkic: akcja szkicu z firmą strony, toast i przejście', async () => {
    m.saveDraft.mockResolvedValue({ success: true, invoiceId: 'd-1' });
    await render(<InvoiceForm tenantId={TENANT} initialValues={podklad} />);
    await klik(przycisk('Szkic'));
    expect(m.saveDraft).toHaveBeenCalledTimes(1);
    expect(m.saveDraft.mock.calls[0]![1]).toBe(TENANT);
    expect(m.toastSuccess).toHaveBeenCalledWith('Szkic zapisany');
    expect(m.push).toHaveBeenCalledWith('/invoices/d-1');
    expect(m.send).not.toHaveBeenCalled();
  });

  it('błąd walidacji: toast z pierwszym komunikatem, bez akcji', async () => {
    await render(<InvoiceForm tenantId={TENANT} />);
    await wyslij();
    await klik(przycisk('Szkic'));
    expect(m.send).not.toHaveBeenCalled();
    expect(m.saveDraft).not.toHaveBeenCalled();
    expect(m.toastError.mock.calls).toEqual([[PIERWSZY_BLAD, { duration: 10000 }], [PIERWSZY_BLAD, { duration: 10000 }]]);
  });

  it('cena 0 zł: pytanie; „Anuluj” zatrzymuje wysyłkę, „OK” ją puszcza', async () => {
    const zero = { ...podklad, lines: [{ ...podklad.lines![0]!, unitPriceNet: 0 }] };
    await render(<InvoiceForm tenantId={TENANT} initialValues={zero} />);
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await wyslij();
    expect(window.confirm).toHaveBeenCalledWith(
      'Co najmniej jedna pozycja ma cenę 0.00 zł. Czy na pewno chcesz wystawić fakturę bezpłatną?',
    );
    expect(m.send).not.toHaveBeenCalled();
    await wyslij();
    expect(m.send).toHaveBeenCalledTimes(1);
  });

  it('szkic z ceną 0 zł nie pyta', async () => {
    const zero = { ...podklad, lines: [{ ...podklad.lines![0]!, unitPriceNet: 0 }] };
    await render(<InvoiceForm tenantId={TENANT} initialValues={zero} />);
    await klik(przycisk('Szkic'));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(m.saveDraft).toHaveBeenCalledTimes(1);
  });

  it('kontrahent spoza białej listy: pytanie tylko przy firmie z Polski', async () => {
    await render(<InvoiceForm tenantId={TENANT} initialValues={podklad} />);
    await klik(przycisk('biała lista'));
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await wyslij();
    expect(window.confirm).toHaveBeenCalledWith(
      'Uwaga: kontrahent Firma Wykreślona ma status "inactive". KSeF może odrzucić fakturę. Kontynuować?',
    );
    expect(m.send).not.toHaveBeenCalled();
    // Biała lista nie nadpisuje wpisanej nazwy.
    expect(q('#buyer-name').value).toBe('Klient Podkład');
  });

  it('wynik białej listy wpisuje nazwę w puste pole; zmiana rodzaju nabywcy kasuje wynik', async () => {
    await render(<InvoiceForm tenantId={TENANT} initialValues={{ ...podklad, buyerName: '' }} />);
    await klik(przycisk('biała lista'));
    expect(q('#buyer-name').value).toBe('Firma Wykreślona');
    await klik(q('#buyer-is-consumer'));
    await klik(q('#buyer-kind-pl'));
    await wyslij();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('tryb cykliczny: bez szkicu w nagłówku, karcie i pasku', async () => {
    await render(<InvoiceForm tenantId={TENANT} initialValues={podklad} recurringInvoiceId="3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d" />);
    const etykiety = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(etykiety.filter((t) => t?.includes('Szkic') || t?.includes('Zapisz'))).toEqual([]);
    expect(container.querySelector('input[name="recurringPeriod"]')).toBeNull();
  });
});

describe('nabywca', () => {
  it('GUS wpisuje NIP, nazwę i adres', async () => {
    await render(<InvoiceForm tenantId={TENANT} />);
    await klik(przycisk('gus'));
    expect(q('[data-testid="nip"]').value).toBe('5252241585');
    expect(q('#buyer-name').value).toBe('Z GUS');
    expect(q('#buyer-address-1').value).toBe('ul. GUS 1');
    expect(q('#buyer-address-2').value).toBe('00-950 Warszawa');
  });

  it('zmiana rodzaju czyści NIP, zostawia nazwę; osoba prywatna startuje od PESEL', async () => {
    await render(<InvoiceForm tenantId={TENANT} initialValues={podklad} />);
    await klik(q('#buyer-is-consumer'));
    expect(container.querySelector('[data-testid="nip"]')).toBeNull();
    expect(q('#buyer-pesel')).toBeTruthy();
    expect(q('#buyer-id-type').textContent).toContain('PESEL');
    await klik(q('#buyer-kind-pl'));
    expect(q('[data-testid="nip"]').value).toBe('');
    expect(q('#buyer-name').value).toBe('Klient Podkład');
    expect(container.querySelector('#buyer-pesel')).toBeNull();
  });

  it('po pierwszej próbie zapisu zmiana rodzaju sprawdza cały formularz od nowa', async () => {
    const npII = { ...podklad, lines: [{ ...podklad.lines![0]!, vatRate: 'np_ii' as const }] };
    const bladVatUe = 'Numer VAT-UE — prefiks kraju UE i numer, np. DE123456789 (Grecja: EL)';
    await render(<InvoiceForm tenantId={TENANT} initialValues={npII} />);
    await klik(q('#buyer-kind-eu'));
    await klik(q('#buyer-kind-pl'));
    // Przed pierwszą próbą zapisu zmiana rodzaju niczego nie sprawdza.
    expect(container.textContent).not.toContain(NP_II_REQUIRES_EU_BUYER_MESSAGE);
    await wyslij();
    expect(m.send).not.toHaveBeenCalled();
    expect(container.textContent).toContain(NP_II_REQUIRES_EU_BUYER_MESSAGE);
    expect(container.textContent).not.toContain(bladVatUe);
    await klik(q('#buyer-kind-eu'));
    expect(container.textContent).toContain(bladVatUe);
  });

  it('VAT-UE: podpowiedź na bieżąco, kraj z prefiksu tylko przy zmianie prefiksu (EL → Grecja)', async () => {
    const kraj = (k: string) => EU_BUYER_COUNTRIES.find((c) => c.code === k)!.name;
    await render(
      <InvoiceForm tenantId={TENANT} initialValues={{ buyerIsEu: true, buyerVatUe: 'DE123456789', buyerCountryCode: 'AT' }} />,
    );
    expect(q('#buyer-vat-ue-hint').textContent).toBe(`${kraj('DE')} · DE123456789`);
    expect(q('#buyer-country').textContent).toContain(kraj('AT'));
    await wpisz(q('#buyer-vat-ue'), 'DE1234567890');
    expect(q('#buyer-country').textContent).toContain(kraj('AT'));
    await wpisz(q('#buyer-vat-ue'), 'EL123456789');
    expect(q('#buyer-country').textContent).toContain(kraj('GR'));
    expect(q('#buyer-vat-ue-hint').textContent).toBe(`${kraj('GR')} · EL123456789`);
    await wpisz(q('#buyer-vat-ue'), 'PL5252241585');
    expect(q('#buyer-vat-ue-hint').textContent).toBe('To polski numer — wybierz „Firma z Polski (NIP)”.');
    await wpisz(q('#buyer-vat-ue'), 'X');
    expect(q('#buyer-vat-ue-hint').textContent).toBe('Niepoprawny format — dwuliterowy prefiks kraju UE i do 12 znaków numeru.');
    await wpisz(q('#buyer-vat-ue'), '');
    expect(q('#buyer-vat-ue-hint').textContent).toBe('Prefiks kraju i numer, np. DE123456789 (Grecja: EL).');
  });
});

describe('podkład z ostatniej faktury i termin', () => {
  const prefill = (ue: boolean): PrefillFromLastInvoice => ({
    contractorName: 'Klient Poprzedni',
    values: {
      buyerNip: ue ? '' : '5252241585',
      buyerIsEu: ue,
      buyerVatUe: ue ? 'DE123456789' : '',
      buyerCountryCode: ue ? 'DE' : '',
      buyerName: 'Klient Poprzedni',
      buyerAddressLine1: 'ul. A 1',
      buyerAddressLine2: '00-001 Warszawa',
      buyerEmail: 'klient@example.com',
      paymentMethod: 'cash',
      bankAccount: '',
      lines: [{ name: 'Usługa', unit: 'godz.', quantity: 10, unitPriceNet: 150, vatRate: '23' }],
    },
  });

  it('„Wypełnij” podmienia nabywcę, płatność i pozycje, nie rusza numeru ani dat; baner znika', async () => {
    await render(<InvoiceForm tenantId={TENANT} prefill={prefill(false)} suggestedNumber="FV/9" initialValues={{ bankAccount: 'PL61109010140000071219812874' }} />);
    await wpisz(q('#issue-date'), '2026-10-18');
    await klik(przycisk('Wypełnij →'));
    expect(m.toastSuccess).toHaveBeenCalledWith('Wypełniłem na podstawie faktury dla Klient Poprzedni');
    expect(container.textContent).not.toContain('Mogę wypełnić to za Ciebie');
    expect(q('#internalNumber').value).toBe('FV/9');
    expect(q('#issue-date').value).toBe('2026-10-18');
    expect(q('#sale-date').value).toBe('2026-10-20');
    expect(q('#payment-due-date').value).toBe('2026-11-03');
    expect(q('[data-testid="nip"]').value).toBe('5252241585');
    expect(q('#buyer-name').value).toBe('Klient Poprzedni');
    expect(q('#buyer-email').value).toBe('klient@example.com');
    expect(q('#payment-method').textContent).toContain('Gotówka');
    // Pusty rachunek z podkładu nie kasuje wpisanego.
    expect(q('#bank-account').value).toBe('PL61109010140000071219812874');
    expect(q('#line-0-name').value).toBe('Usługa');
    expect(q('#line-0-quantity').value).toBe('10');
  });

  it('podkład z UE ustawia rodzaj, numer VAT-UE i kraj', async () => {
    await render(<InvoiceForm tenantId={TENANT} prefill={prefill(true)} />);
    await klik(przycisk('Wypełnij →'));
    expect(q('#buyer-kind-eu').checked).toBe(true);
    expect(q('#buyer-vat-ue').value).toBe('DE123456789');
    expect(q('#buyer-country').textContent).toContain(EU_BUYER_COUNTRIES.find((c) => c.code === 'DE')!.name);
  });

  it('pigułki terminu liczą od daty wystawienia z formularza', async () => {
    await render(<InvoiceForm tenantId={TENANT} />);
    await wpisz(q('#issue-date'), '2026-10-01');
    await klik(przycisk('30 dni'));
    expect(q('#payment-due-date').value).toBe('2026-10-31');
    await klik(przycisk('7 dni'));
    expect(q('#payment-due-date').value).toBe('2026-10-08');
  });
});

describe('pozycje i sumy', () => {
  it('sumy liczone na bieżąco z pozycji; podsumowanie i karta pozycji', async () => {
    await render(<InvoiceForm tenantId={TENANT} />);
    await wpisz(q('#line-0-quantity'), '2');
    await wpisz(q('#line-0-unit-price'), '100');
    expect(container.innerHTML).toMatch(/Do zapłaty<\/span><span[^>]*>246,00 zł/);
    expect(container.textContent).toContain('Netto: 200,00 zł');
    await wpisz(q<HTMLSelectElement>('#line-0-vat-rate'), '8');
    expect(container.innerHTML).toMatch(/Do zapłaty<\/span><span[^>]*>216,00 zł/);
  });

  it('dodawanie i usuwanie pozycji; ostatniej nie da się usunąć', async () => {
    await render(<InvoiceForm tenantId={TENANT} />);
    expect(q<HTMLButtonElement>('button[aria-label="Usuń pozycję 1"]').disabled).toBe(true);
    await klik(przycisk('Dodaj pozycję'));
    expect(q<HTMLSelectElement>('#line-1-vat-rate').value).toBe('23');
    expect(q<HTMLButtonElement>('button[aria-label="Usuń pozycję 1"]').disabled).toBe(false);
    await wpisz(q('#line-1-name'), 'Druga');
    await klik(q<HTMLButtonElement>('button[aria-label="Usuń pozycję 1"]'));
    expect(container.querySelector('#line-1-name')).toBeNull();
    expect(q('#line-0-name').value).toBe('Druga');
  });

  it('firma zwolniona z VAT: nowe pozycje ze stawką zw', async () => {
    await render(<InvoiceForm tenantId={TENANT} vatExempt />);
    expect(q<HTMLSelectElement>('#line-0-vat-rate').value).toBe('zw');
    await klik(przycisk('Dodaj pozycję'));
    expect(q<HTMLSelectElement>('#line-1-vat-rate').value).toBe('zw');
  });

  it('od 1360 px wiersze zamiast kart, ta sama suma', async () => {
    desktop = true;
    await render(<InvoiceForm tenantId={TENANT} />);
    expect(container.querySelector('#line-0-name')).toBeNull();
    await wpisz(q('input[aria-label="Ilość pozycji 1"]'), '2');
    await wpisz(q('input[aria-label="Cena netto pozycji 1"]'), '100');
    expect(container.innerHTML).toMatch(/Do zapłaty<\/span><span[^>]*>246,00 zł/);
    expect(container.textContent).toContain('netto 200,00 zł');
  });

  it('podpowiedź MPP: firma z Polski ponad 15 000 zł brutto, nie przy osobie prywatnej ani z zaznaczonym MPP', async () => {
    const mpp = 'Faktura dla firmy na ponad 15 000 zł brutto';
    await render(<InvoiceForm tenantId={TENANT} />);
    await wpisz(q('#line-0-unit-price'), '13000');
    expect(container.textContent).toContain(mpp);
    await klik(q('input[name="splitPayment"]'));
    expect(container.textContent).not.toContain(mpp);
    await klik(q('input[name="splitPayment"]'));
    await klik(q('#buyer-is-consumer'));
    expect(container.textContent).not.toContain(mpp);
  });
});

/** Pierwszy komunikat z drzewa błędów pustego formularza (stan przed podziałem). */
const PIERWSZY_BLAD = 'Numer faktury wymagany';
