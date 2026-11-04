// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E3 / P4 (PLAN-FINORA §5): podgląd faktury `/invoices/[id]` w układzie Finory.
 *
 *  - lewa kolumna to dokument (nagłówek ze sprzedawcą, nabywca, płatność,
 *    pozycje, podsumowanie VAT per stawka, uwagi, numer KSeF z kodem QR);
 *  - prawa kolumna to dwie karty: „Status” (plakietka, UPO, błąd, panel 440,
 *    baner szkicu wycofanego, główna akcja) i „Dokument” (e-mail, PDF, Drukuj,
 *    XML, Korekta);
 *  - na telefonie karta statusu stoi PRZED dokumentem;
 *  - każdy przycisk akcji występuje w DOM dokładnie raz;
 *  - „Drukuj” otwiera PDF w nowej karcie (fetch + blob), nie `window.print()`,
 *    bo dokumentem jest PDF, a `window.print()` wydrukowałby szkielet panelu.
 *
 * Do E3 podsumowanie VAT było tylko „Razem” z nagłówka faktury z napisem
 * „PLN” na sztywno (faktura w EUR pokazywała PLN), a kod QR i link „Korekta”
 * nie istniały w widoku.
 *
 * Prawdziwe: `InvoiceDetailView`, `InvoiceActions`, `InvoiceQr`, `vatSummaryByRate`.
 * Zastąpione: Realtime, akcje serwerowe, przyciski szkicu/błędu/e-maila,
 * `qrcode` (obraz), pobieranie (`saveBlob`).
 */

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const ch = { on: () => ch, subscribe: () => ch };
    return { channel: () => ch, removeChannel: vi.fn() };
  },
}));
const m = vi.hoisted(() => ({
  toastError: vi.fn(),
  saveBlob: vi.fn(),
  toDataURL: vi.fn(async (text: string) => `data:image/png;base64,${Buffer.from(text).toString('base64')}`),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: m.toastError } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/download', () => ({ saveBlob: m.saveBlob }));
vi.mock('qrcode', () => ({ default: { toDataURL: m.toDataURL } }));
vi.mock('@/components/invoices/actions-detail', () => ({
  downloadInvoiceXmlAction: vi.fn(),
  emailInvoiceAction: vi.fn(),
  resendInvoiceAction: vi.fn(),
  resetInvoiceToDraftAction: vi.fn(),
}));
vi.mock('@/components/invoices/email-invoice-button', () => ({
  EmailInvoiceButton: () => <button type="button" data-testid="przycisk-maila">Wyślij mailem</button>,
}));
vi.mock('@/components/invoices/draft-invoice-actions', () => ({
  DraftInvoiceActions: () => <button type="button" data-testid="akcje-szkicu">Wyślij do KSeF</button>,
}));
vi.mock('@/components/invoices/failed-invoice-actions', () => ({
  FailedInvoiceActions: () => <button type="button" data-testid="akcje-bledu">Wyślij ponownie</button>,
}));
vi.mock('@/components/invoices/upo-download', () => ({
  UpoDownload: () => <div data-testid="upo">UPO</div>,
}));
vi.mock('@/components/invoices/error-display', () => ({
  InvoiceErrorDisplay: ({ errorMessage }: { errorMessage: string }) => <div data-testid="karta-bledu">{errorMessage}</div>,
}));
vi.mock('@/components/invoices/ksef-duplicate-decision', () => ({
  KsefDuplicateDecision: () => <div data-testid="panel-decyzji">panel decyzji</div>,
}));

import { InvoiceDetailView, type InvoiceDetailInitial } from '@/components/invoices/invoice-detail-view';
import { vatSummaryAgreesWithGross, vatSummaryByRate } from '@/lib/invoices/vat-summary';
import type { KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';

const STORED: KsefResendFacts = { sendData: 'stored', kindHeld: false, issueDatePassed: false };
const KSEF_NR = '1234567890-20261002-0100A0B0C0D0-1A';
const QR_URL = 'https://qr-test.ksef.mf.gov.pl/invoice/1234567890/02-10-2026/q80';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Dwie stawki: 23% (1100 + 253) i 8% (50 + 4); razem 1150 / 257 / 1407. */
const TWO_RATE_LINES: InvoiceDetailInitial['lines'] = [
  { ordinal: 1, name: 'Usługa A', unit: 'szt.', quantity: '2', unit_price_net: '50', vat_rate: '23', net_amount: '100', vat_amount: '23', gross_amount: '123' },
  { ordinal: 2, name: 'Towar B', unit: 'kg', quantity: '1', unit_price_net: '50', vat_rate: '8', net_amount: '50', vat_amount: '4', gross_amount: '54' },
  { ordinal: 3, name: 'Usługa C', unit: 'szt.', quantity: '1', unit_price_net: '1000', vat_rate: '23', net_amount: '1000', vat_amount: '230', gross_amount: '1230' },
];

const base: InvoiceDetailInitial = {
  id: 'inv-1',
  internal_number: 'FV/7/10/2026',
  invoice_type: 'VAT',
  invoice_kind: 'regular',
  issue_date: '2026-10-02',
  sale_date: '2026-10-01',
  ksef_status: 'accepted',
  ksef_number: KSEF_NR,
  ksef_accepted_at: '2026-10-02T05:12:33.123+00:00',
  xml_storage_path: 'firma/xml/FV-7.xml',
  net_total: '1150',
  vat_total: '257',
  gross_total: '1407',
  notes: null,
  last_error: null,
  last_error_code: null,
  last_error_field: null,
  last_error_suggestion: null,
  seller_data: { nip: '5260001246', name: 'Moja Firma', address: { addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
  buyer_data: { nip: '5252241585', name: 'Klient Sp. z o.o.', address: { addressLine1: 'ul. B 2', addressLine2: '02-001 Warszawa' } },
  payment_data: { method: 'transfer', dueDate: '2026-10-16', bankAccount: 'PL61109010140000071219812874', currency: 'PLN', amountDue: 1407 },
  lines: TWO_RATE_LINES,
  currency: 'PLN',
  split_payment: false,
  amount_due: 1407,
  can_correct: false,
  qr: null,
  upo_status: null,
  can_manage_send: true,
  ksef_duplicate_original: null,
  ksef_resend_facts: STORED,
  ksef_environment_known: true,
  ksef_duplicate_decision: null,
  ksef_retired_draft: null,
};

/** Tekst z `textContent`: spacje nierozdzielające i typograficzny minus ujednolicone. */
const norm = (text: string | null | undefined) => (text ?? '').replace(/[  ]/g, ' ').replace(/−/g, '-');

function mount(initial: InvoiceDetailInitial) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<InvoiceDetailView initial={initial} />));
  return host;
}

async function mountAndSettle(initial: InvoiceDetailInitial) {
  const el = mount(initial);
  await act(async () => {
    await Promise.resolve();
  });
  return el;
}

const byTestId = (id: string) => host?.querySelectorAll(`[data-testid="${id}"]`) ?? [];
const buttonsLabelled = (label: string) =>
  Array.from(host?.querySelectorAll('button, a') ?? []).filter((n) => norm(n.textContent).trim() === label);

describe('lib/invoices/vat-summary: podsumowanie VAT per stawka z kwot pozycji', () => {
  it('dwie stawki: sumy netto/VAT/brutto per stawka, kolejność pierwszego wystąpienia (jak `drawVatSummary` w PDF)', () => {
    const rows = vatSummaryByRate(TWO_RATE_LINES);
    expect(rows).toEqual([
      { rate: '23', net: 1100, vat: 253, gross: 1353 },
      { rate: '8', net: 50, vat: 4, gross: 54 },
    ]);
  });

  it('sumy zaokrąglone do groszy (bez 0,1 + 0,2 = 0,30000000000000004)', () => {
    const rows = vatSummaryByRate([
      { vat_rate: '23', net_amount: 0.1, vat_amount: 0.02, gross_amount: 0.12 },
      { vat_rate: '23', net_amount: 0.2, vat_amount: 0.05, gross_amount: 0.25 },
    ]);
    expect(rows).toEqual([{ rate: '23', net: 0.3, vat: 0.07, gross: 0.37 }]);
  });

  it('korekta: kwoty ujemne zostają ujemne (różnice), nie wartość bezwzględna', () => {
    const rows = vatSummaryByRate([
      { vat_rate: '23', net_amount: -100, vat_amount: -23, gross_amount: -123 },
      { vat_rate: '8', net_amount: 10, vat_amount: 0.8, gross_amount: 10.8 },
    ]);
    expect(rows).toEqual([
      { rate: '23', net: -100, vat: -23, gross: -123 },
      { rate: '8', net: 10, vat: 0.8, gross: 10.8 },
    ]);
  });

  it('stawki zw / np / np_ii są osobnymi grupami', () => {
    const rows = vatSummaryByRate([
      { vat_rate: 'zw', net_amount: 10, vat_amount: 0, gross_amount: 10 },
      { vat_rate: 'np_ii', net_amount: 20, vat_amount: 0, gross_amount: 20 },
      { vat_rate: 'zw', net_amount: 5, vat_amount: 0, gross_amount: 5 },
    ]);
    expect(rows?.map((r) => [r.rate, r.net])).toEqual([['zw', 15], ['np_ii', 20]]);
  });

  it('brak kwoty netto/VAT/brutto albo stawki w którejkolwiek pozycji → null (nie zgadujemy), puste pozycje → pusta lista', () => {
    expect(vatSummaryByRate([{ vat_rate: '23', net_amount: null, vat_amount: 23, gross_amount: 123 }])).toBeNull();
    expect(vatSummaryByRate([{ vat_rate: '23', net_amount: 100, vat_amount: undefined, gross_amount: 123 }])).toBeNull();
    expect(vatSummaryByRate([{ vat_rate: null, net_amount: 100, vat_amount: 23, gross_amount: 123 }])).toBeNull();
    expect(vatSummaryByRate([{ vat_rate: '23', net_amount: 'abc', vat_amount: 23, gross_amount: 123 }])).toBeNull();
    expect(vatSummaryByRate([])).toEqual([]);
  });

  it('zgodność z nagłówkiem: suma brutto stawek vs `gross_total` (tolerancja kilku groszy na zaokrąglenia)', () => {
    const rows = vatSummaryByRate(TWO_RATE_LINES)!;
    expect(vatSummaryAgreesWithGross(rows, '1407')).toBe(true);
    expect(vatSummaryAgreesWithGross(rows, 1407.04)).toBe(true);
    expect(vatSummaryAgreesWithGross(rows, 1500)).toBe(false);
    expect(vatSummaryAgreesWithGross(rows, null)).toBe(false);
  });
});

describe('P4: dokument faktury', () => {
  it('nagłówek: tytuł wg rodzaju, numer, sprzedawca, daty; „Termin płatności” tylko z terminem', () => {
    const t = norm(mount(base).textContent);
    expect(t).toContain('Faktura VAT nr FV/7/10/2026');
    expect(t).toContain('Moja Firma');
    expect(t).toContain('NIP: 5260001246');
    expect(t).toContain('Data wystawienia: 02.10.2026');
    expect(t).toContain('Data sprzedaży: 01.10.2026');
    expect(t).toContain('Termin płatności: 16.10.2026');
    act(() => root?.unmount());
    host?.remove();
    expect(norm(mount({ ...base, payment_data: null }).textContent)).not.toContain('Termin płatności');
  });

  it.each([
    ['ZAL', 'advance', 'Faktura zaliczkowa nr'],
    ['KOR', 'correction', 'Faktura korygująca nr'],
    ['ROZ', 'final', 'Faktura rozliczeniowa nr'],
  ])('tytuł dokumentu dla %s', (type, kind, title) => {
    expect(norm(mount({ ...base, invoice_type: type, invoice_kind: kind }).textContent)).toContain(title);
  });

  it('nabywca (nazwa, adres, NIP) i płatność: „Do zapłaty”, forma, rachunek', () => {
    const t = norm(mount(base).textContent);
    expect(t).toContain('Nabywca');
    expect(t).toContain('Klient Sp. z o.o.');
    expect(t).toContain('ul. B 2');
    expect(t).toContain('NIP: 5252241585');
    expect(t).toContain('Do zapłaty');
    expect(t).toContain('1407,00 PLN');
    expect(t).toContain('Przelew');
    expect(t).toContain('PL61109010140000071219812874');
  });

  it('ROZ: „Do zapłaty” to `amount_due` (reszta po zaliczkach), nie brutto zamówienia', () => {
    const t = norm(mount({ ...base, invoice_type: 'ROZ', invoice_kind: 'final', gross_total: '4000', amount_due: 1000 }).textContent);
    expect(t).toMatch(/Do zapłaty:\s*1000,00 PLN/);
    expect(t).not.toMatch(/Do zapłaty:?\s*4000,00/);
  });

  it('MPP tylko przy `split_payment`; SWIFT tylko dla waluty obcej i tylko gdy dane go mają', () => {
    expect(norm(mount(base).textContent)).not.toContain('podzielonej płatności');
    act(() => root?.unmount());
    host?.remove();
    expect(norm(mount({ ...base, split_payment: true }).textContent)).toContain('Mechanizm podzielonej płatności');
    act(() => root?.unmount());
    host?.remove();

    const withSwift = { method: 'transfer', dueDate: '2026-10-16', bankAccount: 'DE89370400440532013000', swift: 'COBADEFFXXX', currency: 'EUR', amountDue: 1407 };
    expect(norm(mount({ ...base, currency: 'EUR', payment_data: withSwift }).textContent)).toContain('COBADEFFXXX');
    act(() => root?.unmount());
    host?.remove();
    expect(norm(mount({ ...base, currency: 'EUR', payment_data: { ...withSwift, swift: undefined } }).textContent)).not.toContain('SWIFT');
    act(() => root?.unmount());
    host?.remove();
    expect(norm(mount({ ...base, currency: 'PLN', payment_data: withSwift }).textContent)).not.toContain('COBADEFFXXX');
  });

  it('tabela pozycji przewija się w poziomie na telefonie (kontener `overflow-x-auto`)', () => {
    const el = mount(base);
    const table = el.querySelector('table')!;
    expect(table.closest('.overflow-x-auto')).not.toBeNull();
    expect(Array.from(table.querySelectorAll('th')).map((th) => norm(th.textContent).trim())).toEqual([
      'Lp.', 'Nazwa', 'Ilość', 'J.m.', 'Cena netto', 'VAT', 'Netto', 'Brutto',
    ]);
  });

  it('uwagi tylko, gdy są', () => {
    expect(norm(mount(base).textContent)).not.toContain('Uwagi');
    act(() => root?.unmount());
    host?.remove();
    const t = norm(mount({ ...base, notes: 'Zapłata w 14 dni' }).textContent);
    expect(t).toContain('Uwagi');
    expect(t).toContain('Zapłata w 14 dni');
  });
});

describe('P4: podsumowanie VAT per stawka i waluta', () => {
  const summaryRows = () =>
    Array.from(host?.querySelectorAll('[data-testid="podsumowanie-vat"] tbody tr') ?? []).map((tr) =>
      Array.from(tr.querySelectorAll('td, th')).map((c) => norm(c.textContent).trim()),
    );

  it('dwie stawki: wiersz na stawkę (netto, VAT, brutto) i Razem netto / VAT / brutto z nagłówka faktury', () => {
    mount(base);
    expect(summaryRows()).toEqual([
      ['23%', '1100,00', '253,00', '1353,00'],
      ['8%', '50,00', '4,00', '54,00'],
    ]);
    const t = norm(host?.textContent);
    expect(t).toMatch(/Razem netto:\s*1150,00 PLN/);
    expect(t).toMatch(/VAT:\s*257,00 PLN/);
    expect(t).toMatch(/Razem brutto:\s*1407,00 PLN/);
  });

  it('korekta pokazuje różnice: ujemne stawki i ujemne Razem (nagłówek korekty to różnica, 00200)', () => {
    mount({
      ...base,
      invoice_type: 'KOR',
      invoice_kind: 'correction',
      lines: [
        { ordinal: 1, name: 'Usługa A', unit: 'szt.', quantity: '-1', unit_price_net: '100', vat_rate: '23', net_amount: '-100', vat_amount: '-23', gross_amount: '-123' },
        { ordinal: 2, name: 'Towar B', unit: 'kg', quantity: '-1', unit_price_net: '50', vat_rate: '8', net_amount: '-50', vat_amount: '-4', gross_amount: '-54' },
      ],
      net_total: '-150',
      vat_total: '-27',
      gross_total: '-177',
      amount_due: -177,
    });
    expect(summaryRows()).toEqual([
      ['23%', '-100,00', '-23,00', '-123,00'],
      ['8%', '-50,00', '-4,00', '-54,00'],
    ]);
    const t = norm(host?.textContent);
    expect(t).toMatch(/Razem brutto:\s*-177,00 PLN/);
  });

  it('kwoty pozycji niezgodne z nagłówkiem (np. stan PO w korekcie before_after): bez wierszy stawek, samo Razem — nie pokazujemy złych liczb', () => {
    mount({ ...base, gross_total: '9999', net_total: '8000', vat_total: '1999' });
    expect(host?.querySelector('[data-testid="podsumowanie-vat"]')).toBeNull();
    expect(norm(host?.textContent)).toMatch(/Razem brutto:\s*9999,00 PLN/);
  });

  it('pozycje bez kwot netto/VAT (stare rekordy): bez wierszy stawek, samo Razem', () => {
    mount({ ...base, lines: base.lines.map((l) => ({ ...l, net_amount: null, vat_amount: null })) });
    expect(host?.querySelector('[data-testid="podsumowanie-vat"]')).toBeNull();
    expect(norm(host?.textContent)).toMatch(/Razem brutto:\s*1407,00 PLN/);
  });

  it('waluta z faktury: EUR jako EUR w podsumowaniu i „Do zapłaty”, bez „PLN” na sztywno', () => {
    mount({
      ...base,
      currency: 'EUR',
      payment_data: { method: 'transfer', dueDate: '2026-10-16', bankAccount: 'DE89370400440532013000', currency: 'EUR', amountDue: 1407 },
    });
    const t = norm(host?.textContent);
    expect(t).toMatch(/Razem brutto:\s*1407,00 EUR/);
    expect(t).toMatch(/Razem netto:\s*1150,00 EUR/);
    expect(t).toMatch(/Do zapłaty:\s*1407,00 EUR/);
    expect(t).not.toContain('PLN');
  });
});

describe('P4: kod QR (KOD I) i numer KSeF', () => {
  it('z `qr`: obraz z linku i podpis (numer KSeF) pod nim; numer i czas przyjęcia w dokumencie', async () => {
    const el = await mountAndSettle({ ...base, qr: { url: QR_URL, label: KSEF_NR } });
    expect(m.toDataURL).toHaveBeenCalledTimes(1);
    expect(m.toDataURL.mock.calls[0]![0]).toBe(QR_URL);
    const img = el.querySelector<HTMLImageElement>('[data-testid="kod-qr"] img');
    expect(img, 'brak obrazu QR').not.toBeNull();
    expect(img!.getAttribute('src')).toBe(`data:image/png;base64,${Buffer.from(QR_URL).toString('base64')}`);
    expect(img!.getAttribute('alt')).toMatch(/kod QR/i);
    expect(norm(el.querySelector('[data-testid="kod-qr"]')?.textContent)).toContain(KSEF_NR);
    const t = norm(el.textContent);
    expect(t).toContain('Numer KSeF');
    expect(t).toContain('02.10.2026, 07:12');
  });

  it('bez `qr` (brak XML, import, szkic): ani obrazu, ani podpisu kodu — ale numer KSeF zostaje', async () => {
    const el = await mountAndSettle({ ...base, qr: null });
    expect(m.toDataURL).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid="kod-qr"]')).toBeNull();
    expect(el.querySelector('img')).toBeNull();
    expect(norm(el.textContent)).toContain(KSEF_NR);
  });

  it('szkic bez numeru KSeF: sekcja „Numer KSeF” nie istnieje', async () => {
    const el = await mountAndSettle({ ...base, ksef_status: 'draft', ksef_number: null, ksef_accepted_at: null, qr: null });
    expect(norm(el.textContent)).not.toContain('Numer KSeF');
  });

  it('błąd generowania obrazu nie psuje widoku: bez obrazu, dokument stoi', async () => {
    m.toDataURL.mockRejectedValueOnce(new Error('qr'));
    const el = await mountAndSettle({ ...base, qr: { url: QR_URL, label: KSEF_NR } });
    expect(el.querySelector('[data-testid="kod-qr"] img')).toBeNull();
    expect(norm(el.textContent)).toContain('Faktura VAT nr FV/7/10/2026');
  });
});

describe('P4: akcje — każda raz w DOM, link „Korekta” tylko z `can_correct`', () => {
  it('przyjęta faktura: PDF, e-mail, Drukuj, XML po jednym; w karcie „Dokument”, nie w karcie „Status”', () => {
    mount(base);
    for (const label of ['Pobierz PDF', 'Drukuj', 'Pobierz XML']) {
      expect(buttonsLabelled(label), label).toHaveLength(1);
    }
    expect(byTestId('przycisk-maila')).toHaveLength(1);
    const status = host!.querySelector('[data-testid="karta-statusu"]')!;
    const doc = host!.querySelector('[data-testid="karta-dokumentu"]')!;
    expect(doc.textContent).toContain('Pobierz PDF');
    expect(doc.querySelector('[data-testid="przycisk-maila"]')).not.toBeNull();
    expect(status.textContent).not.toContain('Pobierz PDF');
    expect(status.querySelector('[data-testid="upo"]')).not.toBeNull();
  });

  it('szkic: „Wyślij do KSeF” raz, w karcie „Status”; błąd wysyłki: akcje błędu raz, w karcie „Status”', () => {
    mount({ ...base, ksef_status: 'draft', ksef_number: null, ksef_accepted_at: null, xml_storage_path: null });
    expect(byTestId('akcje-szkicu')).toHaveLength(1);
    expect(host!.querySelector('[data-testid="karta-statusu"] [data-testid="akcje-szkicu"]')).not.toBeNull();
    expect(host!.querySelector('[data-testid="karta-dokumentu"] [data-testid="akcje-szkicu"]')).toBeNull();
    expect(buttonsLabelled('Pobierz XML')).toHaveLength(0);
    act(() => root?.unmount());
    host?.remove();

    mount({ ...base, ksef_status: 'failed', ksef_number: null, ksef_accepted_at: null, last_error_code: 'KSEF_UNAVAILABLE', last_error: 'KSeF chwilowo niedostępny.' });
    expect(byTestId('akcje-bledu')).toHaveLength(1);
    expect(host!.querySelector('[data-testid="karta-statusu"] [data-testid="akcje-bledu"]')).not.toBeNull();
    expect(byTestId('karta-bledu')).toHaveLength(1);
  });

  it('szkic wycofany: bez „Wyślij mailem” (decyzja 10), baner raz w karcie „Status”', () => {
    const retired = {
      title: 'Numer FV/7/10/2026 jest zajęty w KSeF',
      body: 'Ten szkic jest wycofany.',
      cta: null,
      knownInvoice: null,
      sendRefusal: 'x',
      deletable: false,
      deleteRefusal: 'y',
    } as unknown as InvoiceDetailInitial['ksef_retired_draft'];
    mount({ ...base, ksef_status: 'draft', ksef_number: null, ksef_accepted_at: null, ksef_retired_draft: retired });
    expect(byTestId('przycisk-maila')).toHaveLength(0);
    const status = host!.querySelector('[data-testid="karta-statusu"]')!;
    expect(status.textContent).toContain('Ten szkic jest wycofany.');
    expect(host!.textContent!.split('Ten szkic jest wycofany.').length - 1).toBe(1);
  });

  it('link „Korekta” tylko z `can_correct`, do formularza z `parentId`', () => {
    mount(base);
    expect(Array.from(host!.querySelectorAll('a')).filter((a) => (a.getAttribute('href') ?? '').includes('/invoices/new/correction'))).toHaveLength(0);
    act(() => root?.unmount());
    host?.remove();

    mount({ ...base, can_correct: true });
    const links = Array.from(host!.querySelectorAll('a')).filter((a) => (a.getAttribute('href') ?? '').includes('/invoices/new/correction'));
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('/invoices/new/correction?parentId=inv-1');
    expect(norm(links[0]!.textContent)).toContain('Korekta');
    expect(host!.querySelector('[data-testid="karta-dokumentu"]')!.contains(links[0]!)).toBe(true);
  });

  it('przyciski nie używają wariantu „glass” (tylko default / outline Finory)', () => {
    mount({ ...base, can_correct: true });
    const glass = Array.from(host!.querySelectorAll('[data-variant]')).filter((n) => (n.getAttribute('data-variant') ?? '').startsWith('glass'));
    expect(glass).toEqual([]);
  });
});

describe('P4: „Drukuj” otwiera PDF w nowej karcie (fetch + blob), nie `window.print()`', () => {
  function stubBrowser(response: Partial<Response> & { ok: boolean }) {
    const tab = { location: { href: '' }, close: vi.fn(), opener: {} as unknown };
    const open = vi.fn(() => tab);
    const print = vi.fn();
    const fetchMock = vi.fn(async () => response as Response);
    const createObjectURL = vi.fn(() => 'blob:pdf-1');
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'open').mockImplementation(open as unknown as typeof window.open);
    vi.spyOn(window, 'print').mockImplementation(print);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() });
    return { tab, open, print, fetchMock, createObjectURL };
  }

  async function clickPrint() {
    const button = buttonsLabelled('Drukuj')[0] as HTMLButtonElement;
    expect(button, 'brak przycisku Drukuj').toBeDefined();
    await act(async () => {
      button.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('sukces: nowa karta, PDF z /api/invoices/[id]/pdf przez blob URL, window.print nietknięte', async () => {
    const blob = new Blob(['%PDF'], { type: 'application/pdf' });
    const s = stubBrowser({ ok: true, blob: async () => blob, headers: new Headers() });
    mount(base);
    await clickPrint();

    expect(s.print).not.toHaveBeenCalled();
    expect(s.open).toHaveBeenCalledTimes(1);
    expect((s.open.mock.calls as unknown[][])[0]![1]).toBe('_blank');
    expect(s.fetchMock).toHaveBeenCalledWith('/api/invoices/inv-1/pdf');
    expect(s.createObjectURL).toHaveBeenCalledWith(blob);
    expect(s.tab.location.href).toBe('blob:pdf-1');
    expect(s.tab.opener).toBeNull();
    expect(m.toastError).not.toHaveBeenCalled();
    expect(m.saveBlob).not.toHaveBeenCalled();
  });

  it('błąd HTTP: ten sam komunikat co „Pobierz PDF” (409 faktury offline), karta zamknięta, nic nie drukuje', async () => {
    const s = stubBrowser({
      ok: false,
      status: 409,
      json: async () => ({ error: 'PDF faktury offline wymaga certyfikatu.' }),
    });
    mount(base);
    await clickPrint();

    expect(s.print).not.toHaveBeenCalled();
    expect(s.tab.close).toHaveBeenCalledTimes(1);
    expect(s.tab.location.href).toBe('');
    expect(m.toastError).toHaveBeenCalledWith('PDF faktury offline wymaga certyfikatu.');
  });

  it('pdf_generation_failed i błąd sieci mają komunikaty jak przy pobieraniu', async () => {
    let s = stubBrowser({ ok: false, status: 500, json: async () => ({ error: 'pdf_generation_failed' }) });
    mount(base);
    await clickPrint();
    expect(m.toastError).toHaveBeenLastCalledWith('Nie udało się wygenerować PDF. Spróbuj ponownie.');
    expect(s.tab.close).toHaveBeenCalled();
    act(() => root?.unmount());
    host?.remove();

    s = stubBrowser({ ok: true });
    s.fetchMock.mockRejectedValueOnce(new Error('offline'));
    mount(base);
    await clickPrint();
    expect(m.toastError).toHaveBeenLastCalledWith('Błąd połączenia przy pobieraniu PDF.');
    expect(s.tab.close).toHaveBeenCalled();
  });

  it('przeglądarka zablokowała nową kartę: komunikat, bez pobierania PDF', async () => {
    const s = stubBrowser({ ok: true });
    s.open.mockReturnValueOnce(null as never);
    mount(base);
    await clickPrint();
    expect(s.fetchMock).not.toHaveBeenCalled();
    expect(s.print).not.toHaveBeenCalled();
    expect(m.toastError).toHaveBeenCalledWith(expect.stringContaining('zablokowała'));
  });
});

describe('P4: układ — karta statusu przed dokumentem na telefonie, aside po prawej od `lg`', () => {
  const html = () => renderToStaticMarkup(<InvoiceDetailView initial={{ ...base, can_correct: true }} />);
  const indexOfTestId = (markup: string, id: string) => markup.indexOf(`data-testid="${id}"`);

  it('kolejność w DOM: karta „Status”, dokument, karta „Dokument”', () => {
    const markup = html();
    const status = indexOfTestId(markup, 'karta-statusu');
    const document_ = indexOfTestId(markup, 'dokument-faktury');
    const actions = indexOfTestId(markup, 'karta-dokumentu');
    expect(status).toBeGreaterThan(-1);
    expect(status).toBeLessThan(document_);
    expect(document_).toBeLessThan(actions);
  });

  it('siatka jak w Finorze: jedna kolumna na telefonie, `1fr` + 18rem od `lg`, druk jako blok', () => {
    const el = mount(base);
    const grid = el.querySelector('[data-testid="karta-statusu"]')!.parentElement!;
    const tokens = grid.className.split(/\s+/);
    for (const token of ['grid', 'grid-cols-1', 'gap-6', 'lg:grid-cols-[1fr_18rem]', 'print:block']) {
      expect(tokens, token).toContain(token);
    }
  });

  it('dokument zajmuje lewą kolumnę, obie karty prawą (jawne pozycje od `lg`); karty bez druku', () => {
    const el = mount({ ...base, can_correct: true });
    const status = el.querySelector('[data-testid="karta-statusu"]')!;
    const doc = el.querySelector('[data-testid="dokument-faktury"]')!;
    const actions = el.querySelector('[data-testid="karta-dokumentu"]')!;
    expect(doc.className).toContain('lg:col-start-1');
    expect(status.className).toContain('lg:col-start-2');
    expect(actions.className).toContain('lg:col-start-2');
    expect(status.className).toContain('print:hidden');
    expect(actions.className).toContain('print:hidden');
    expect(doc.className).toContain('print:ring-0');
  });

  it('karta „Status” zawiera plakietkę statusu KSeF i UPO przyjętej faktury', () => {
    const el = mount(base);
    const status = el.querySelector('[data-testid="karta-statusu"]')!;
    expect(norm(status.textContent)).toContain('Zaakceptowana');
    expect(status.querySelector('[data-testid="upo"]')).not.toBeNull();
  });
});
