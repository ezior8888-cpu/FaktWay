// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E3 / C9 (przegląd e3-review): kod QR (KOD I) i link „Korekta” liczy WYŁĄCZNIE serwer
 * (`app/(dashboard)/invoices/[id]/page.tsx`: `loadQr`, `loadCanCorrect`). Faktura przyjęta
 * przez worker docierała do widoku tylko przez Realtime, który scalał status, numer KSeF
 * i ścieżkę XML, ale zostawiał stare `qr` i `can_correct` — numer KSeF pojawiał się na żywo,
 * a kodu QR i linku „Korekta” brakowało do ręcznego odświeżenia strony.
 *
 * Naprawa (tak jak lista faktur z `PAYMENT_FACT_FIELDS`): UPDATE zmieniający `ksef_status`,
 * `ksef_number` albo `xml_storage_path` względem bieżącego stanu woła `router.refresh()`,
 * a nowe `initial` z serwera przyjmuje istniejące zerowanie `seenInitial`.
 *
 * Prawdziwe: `InvoiceDetailView`, `InvoiceQr`. Zastąpione: Realtime (przechwycone uchwyty
 * `postgres_changes`), `useRouter` (szpieg `refresh`), `qrcode` (obraz), pasek akcji
 * (zapis propsów), karty błędu/UPO/panel decyzji.
 */

type Payload = { new: Record<string, unknown> };
type Handler = (payload: Payload) => void;

const realtime = vi.hoisted(() => ({
  registered: [] as Array<{ table: string; cb: (payload: { new: Record<string, unknown> }) => void }>,
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const ch = {
      on: (_e: unknown, filter: { table: string }, cb: (payload: { new: Record<string, unknown> }) => void) => {
        realtime.registered.push({ table: filter.table, cb });
        return ch;
      },
      subscribe: () => ch,
    };
    return { channel: () => ch, removeChannel: vi.fn() };
  },
}));
// Stabilny obiekt routera (jak w Next): `refresh` jako szpieg.
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const m = vi.hoisted(() => ({
  toDataURL: vi.fn(async (text: string) => `data:image/png;base64,${Buffer.from(text).toString('base64')}`),
}));
vi.mock('qrcode', () => ({ default: { toDataURL: m.toDataURL } }));
const actions = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock('@/components/invoices/invoice-actions', () => ({
  InvoiceActions: (props: Record<string, unknown>) => {
    actions.props.push(props);
    return null;
  },
}));
vi.mock('@/components/invoices/upo-download', () => ({ UpoDownload: () => null }));
vi.mock('@/components/invoices/error-display', () => ({
  InvoiceErrorDisplay: ({ errorMessage }: { errorMessage: string }) => <div data-testid="karta-bledu">{errorMessage}</div>,
}));
vi.mock('@/components/invoices/ksef-duplicate-decision', () => ({
  KsefDuplicateDecision: () => <div data-testid="panel-decyzji">panel decyzji</div>,
}));

import { InvoiceDetailView, type InvoiceDetailInitial } from '@/components/invoices/invoice-detail-view';
import type { KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';

const STORED: KsefResendFacts = { sendData: 'stored', kindHeld: false, issueDatePassed: false };
const KSEF_NR = '1234567890-20261002-0100A0B0C0D0-1A';
const XML_PATH = 'firma/xml/FV-7.xml';
const QR_URL = 'https://qr-test.ksef.mf.gov.pl/invoice/1234567890/02-10-2026/q80';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  realtime.registered.length = 0;
  actions.props.length = 0;
  router.refresh.mockClear();
  m.toDataURL.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** Faktura w kolejce: serwer nie ma jeszcze numeru KSeF, pliku XML, kodu QR ani prawa do korekty. */
const queued: InvoiceDetailInitial = {
  id: 'inv-1',
  internal_number: 'FV/7/10/2026',
  invoice_type: 'VAT',
  invoice_kind: 'regular',
  issue_date: '2026-10-02',
  sale_date: '2026-10-01',
  ksef_status: 'queued',
  ksef_number: null,
  ksef_accepted_at: null,
  xml_storage_path: null,
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
  payment_data: null,
  lines: [
    { ordinal: 1, name: 'Usługa A', unit: 'szt.', quantity: '1', unit_price_net: '1150', vat_rate: '23', net_amount: '1150', vat_amount: '257', gross_amount: '1407' },
  ],
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

/** Ten sam wiersz po przyjęciu w KSeF — tak, jak liczy go serwer przy `router.refresh()`. */
const acceptedFromServer: InvoiceDetailInitial = {
  ...queued,
  ksef_status: 'accepted',
  ksef_number: KSEF_NR,
  ksef_accepted_at: '2026-10-02T05:12:33.123+00:00',
  xml_storage_path: XML_PATH,
  can_correct: true,
  qr: { url: QR_URL, label: KSEF_NR },
};

function mount(initial: InvoiceDetailInitial, strict = false) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const view = <InvoiceDetailView initial={initial} />;
  act(() => root!.render(strict ? <StrictMode>{view}</StrictMode> : view));
  return host;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Ostatnio zarejestrowany uchwyt UPDATE tabeli `invoices` (StrictMode montuje efekt dwa razy). */
function invoiceUpdate(): Handler {
  const entry = [...realtime.registered].reverse().find((r) => r.table === 'invoices');
  if (!entry) throw new Error('brak uchwytu Realtime dla tabeli invoices');
  return entry.cb;
}

function emit(row: Record<string, unknown>) {
  const handler = invoiceUpdate();
  act(() => handler({ new: row }));
}

/** Props paska akcji z ostatniego renderu (`can_correct` przekazywane przyciskom). */
const lastActionsInvoice = () => actions.props.at(-1)!.invoice as { can_correct: boolean; ksef_status: string };

describe('C9: Realtime zmieniający fakty liczone na serwerze odświeża stronę', () => {
  it('kolejka → przyjęta (status, numer KSeF, ścieżka XML): jedno `router.refresh()`', () => {
    mount(queued);
    expect(router.refresh).not.toHaveBeenCalled();

    emit({ ksef_status: 'accepted', ksef_number: KSEF_NR, xml_storage_path: XML_PATH });

    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['ksef_status', { ksef_status: 'sending' }],
    ['ksef_number', { ksef_number: KSEF_NR }],
    ['xml_storage_path', { xml_storage_path: XML_PATH }],
  ])('zmiana samego pola %s też odświeża', (_field, row) => {
    mount(queued);
    emit(row);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('zmiana tylko podpowiedzi błędu (`last_error_suggestion`) NIE odświeża strony', () => {
    mount(queued);
    emit({ last_error_suggestion: 'Spróbuj ponownie za chwilę.' });
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('pola faktów bez zmiany względem stanu (te same wartości, null = brak) nie odświeżają', () => {
    mount(queued);
    // Wiersz niesie wszystkie kolumny, ale ani status, ani numer, ani XML się nie zmieniły.
    emit({
      ksef_status: 'queued',
      ksef_number: null,
      xml_storage_path: null,
      last_error: 'chwilowy błąd',
      last_error_suggestion: 'Spróbuj ponownie.',
    });
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('kolejne zdarzenia: odświeżenie przy każdej realnej zmianie faktów, nie przy powtórce', () => {
    mount(queued);
    emit({ ksef_status: 'sending' });
    expect(router.refresh).toHaveBeenCalledTimes(1);

    // Powtórka tego samego stanu po przerenderowaniu (stan lokalny już ma „sending”).
    emit({ ksef_status: 'sending', last_error_suggestion: 'x' });
    expect(router.refresh).toHaveBeenCalledTimes(1);

    emit({ ksef_status: 'accepted', ksef_number: KSEF_NR, xml_storage_path: XML_PATH });
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it('wywołanie jest poza aktualizatorem stanu: pod StrictMode (aktualizatory 2×) jedno zdarzenie = jedno odświeżenie', () => {
    mount(queued, true);
    emit({ ksef_status: 'accepted', ksef_number: KSEF_NR, xml_storage_path: XML_PATH });
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('C9: nowe `initial` po odświeżeniu przynosi `qr` i `can_correct`, bez pętli', () => {
  it('po odświeżeniu widok pokazuje kod QR i przekazuje `can_correct` paskowi akcji; kolejne zdarzenia nie odświeżają ponownie', async () => {
    const el = mount(queued);
    await settle();
    expect(el.querySelector('[data-testid="kod-qr"]')).toBeNull();
    expect(lastActionsInvoice().can_correct).toBe(false);

    // 1. Worker przyjął fakturę: Realtime pokazuje numer, ale QR i „Korekta” liczy tylko serwer.
    emit({ ksef_status: 'accepted', ksef_number: KSEF_NR, xml_storage_path: XML_PATH });
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain(KSEF_NR);
    expect(el.querySelector('[data-testid="kod-qr"]')).toBeNull();

    // 2. Serwer odpowiada nowym `initial` (nowa referencja, `qr` i `can_correct` przeliczone).
    act(() => root!.render(<InvoiceDetailView initial={{ ...acceptedFromServer }} />));
    await settle();
    expect(m.toDataURL).toHaveBeenCalledWith(QR_URL, expect.anything());
    expect(el.querySelector('[data-testid="kod-qr"] img')).not.toBeNull();
    expect(lastActionsInvoice().can_correct).toBe(true);
    expect(lastActionsInvoice().ksef_status).toBe('accepted');

    // 3. Przyjęcie nowego `initial` nie rodzi zdarzenia ani odświeżenia (brak pętli).
    expect(router.refresh).toHaveBeenCalledTimes(1);

    // 4. Zdarzenie z tym samym stanem faktów (np. dopisane UPO) nie odświeża, bo stan = serwer.
    emit({ ksef_status: 'accepted', ksef_number: KSEF_NR, xml_storage_path: XML_PATH, last_error_suggestion: null });
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});
