// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D-A4-1b-3 PR B (decyzje Bartosza 07.10.2026: 2, 3, 9, 10; C15): przyciski
 * szkicu wycofanego — szkicu z wpisem `number_taken` (decyzja klienta albo
 * automatyczny „numer zajęty”).
 *  - „Wyślij do KSeF” znika dla każdego rodzaju (wysyłka = ponowne 440).
 *  - „Usuń szkic” tylko dla KOR i ROZ (`deletable`), z ostrzeżeniem o numerze;
 *    zwykła faktura i ZAL trzymają numer.
 *  - „Wyślij mailem” znika (decyzja 10): wycofany dokument nie jest fakturą
 *    dla nabywcy.
 *  - Po błędzie wysyłki i usunięcia `router.refresh()` (Realtime nie odświeża
 *    `ksef_retired_draft` — C15).
 * Do PR B szkic wycofany miał wszystkie przyciski zwykłego szkicu, a błąd
 * nie odświeżał strony.
 *
 * Prawdziwe: `DraftInvoiceActions`, `InvoiceActions`. Zastąpione: akcje
 * serwerowe, nawigacja, toasty, przycisk e-maila (znacznik), przyciski po błędzie.
 */

const m = vi.hoisted(() => ({
  send: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: m.refresh, push: m.push }) }));
vi.mock('sonner', () => ({ toast: { success: m.toastSuccess, error: m.toastError } }));
vi.mock('@/components/invoices/draft-actions', () => ({
  sendDraftInvoiceAction: m.send,
  deleteDraftInvoiceAction: m.remove,
}));
vi.mock('@/components/invoices/actions-detail', () => ({
  downloadInvoiceXmlAction: vi.fn(),
  resendInvoiceAction: vi.fn(),
  resetInvoiceToDraftAction: vi.fn(),
  emailInvoiceAction: vi.fn(),
}));
vi.mock('@/components/invoices/email-invoice-button', () => ({
  EmailInvoiceButton: () => <span data-testid="przycisk-maila">Wyślij mailem</span>,
}));
vi.mock('@/components/invoices/failed-invoice-actions', () => ({ FailedInvoiceActions: () => null }));
vi.mock('@/lib/download', () => ({ saveBlob: vi.fn() }));

import { DraftInvoiceActions } from '@/components/invoices/draft-invoice-actions';
import { InvoiceActions } from '@/components/invoices/invoice-actions';
import type { KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';

import { CLIENT } from './helpers/decyzja-klienta';

const STORED: KsefResendFacts = { sendData: 'stored', kindHeld: false, issueDatePassed: false };
const PLAIN_DELETE_CONFIRM = 'Usunąć szkic? Numer faktury będzie można użyć ponownie.';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  m.send.mockResolvedValue({ success: true, offline: false });
  m.remove.mockResolvedValue({ success: true });
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

function mount(node: ReactNode): HTMLDivElement {
  act(() => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

type DraftProps = ComponentProps<typeof DraftInvoiceActions>;
type InvoiceProp = ComponentProps<typeof InvoiceActions>['invoice'];

/** Props szkicu z `retired` (2.5) — przez rzutowanie, żeby test kompilował się przed zmianą typu. */
function draftProps(invoiceType: string, retired: { deletable: boolean } | null): DraftProps {
  return { invoiceId: 'inv-1', invoiceType, retired } as DraftProps;
}

/** Faktura w pasku akcji z `ksef_retired` i `ksef_duplicate_panel` (2.5). */
function draftInvoice(invoiceType: string, invoiceKind: string, retired: { deletable: boolean } | null): InvoiceProp {
  return {
    id: 'inv-1',
    ksef_status: 'draft',
    xml_storage_path: null,
    invoice_type: invoiceType,
    invoice_kind: invoiceKind,
    last_error_code: null,
    ksef_resend_facts: STORED,
    ksef_environment_known: true,
    ksef_retired: retired,
    ksef_duplicate_panel: false,
  } as InvoiceProp;
}

function buttonLabels(): string[] {
  return Array.from(host?.querySelectorAll('button') ?? []).map((b) => (b.textContent ?? '').trim());
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(host?.querySelectorAll('button') ?? []).find((b) => (b.textContent ?? '').includes(label));
  expect(found, `brak przycisku „${label}”`).toBeDefined();
  return found!;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

const emailMarker = () => host?.querySelector('[data-testid="przycisk-maila"]') ?? null;

describe('szkic wycofany — przyciski (D-A4-1b-3 PR B)', () => {
  it.each([
    ['zwykła faktura (VAT)', 'VAT', 'regular'],
    ['zaliczka (ZAL)', 'ZAL', 'advance'],
  ])('U11a: %s, `retired {deletable:false}` — ani „Wyślij do KSeF”, ani „Usuń szkic”', (_label, type, kind) => {
    mount(<DraftInvoiceActions {...draftProps(type, { deletable: false })} />);
    expect(buttonLabels()).toEqual([]);

    // Ta sama reguła przez pasek akcji faktury (`invoice.ksef_retired`).
    mount(<InvoiceActions invoice={draftInvoice(type, kind, { deletable: false })} canManageSend />);
    expect(buttonLabels()).not.toContain('Wyślij do KSeF');
    expect(buttonLabels()).not.toContain('Usuń szkic');
  });

  it.each([
    ['korekta (KOR)', 'KOR', 'correction'],
    ['faktura rozliczeniowa (ROZ)', 'ROZ', 'final'],
  ])('U11b (decyzja 9): %s, `retired {deletable:true}` — tylko „Usuń szkic”, z ostrzeżeniem o zajętym numerze', async (_label, type, kind) => {
    mount(<InvoiceActions invoice={draftInvoice(type, kind, { deletable: true })} canManageSend />);
    expect(buttonLabels()).toContain('Usuń szkic');
    expect(buttonLabels()).not.toContain('Wyślij do KSeF');

    await click(button('Usuń szkic'));
    expect(confirmSpy).toHaveBeenCalledWith(CLIENT.retiredDeleteConfirm);
    expect(m.remove).toHaveBeenCalledWith('inv-1');
  });

  it('U11b: `retired {deletable:true}` przy typie VAT — mimo to bez „Wyślij do KSeF” (wysyłka zakazana dla każdego rodzaju)', () => {
    mount(<DraftInvoiceActions {...draftProps('VAT', { deletable: true })} />);
    expect(buttonLabels()).toEqual(['Usuń szkic']);
  });

  it('U11c: błąd wysyłki szkicu — toast z odmową i `router.refresh()`', async () => {
    m.send.mockResolvedValue({ success: false, error: 'Dokument FV 5/10/2026 jest wycofany…' });
    mount(<DraftInvoiceActions {...draftProps('VAT', null)} />);

    await click(button('Wyślij do KSeF'));

    expect(m.toastError).toHaveBeenCalledWith('Dokument FV 5/10/2026 jest wycofany…');
    expect(m.refresh).toHaveBeenCalled();
  });

  it('U11d (C15): błąd usunięcia szkicu — toast z odmową i `router.refresh()`, bez przejścia do listy', async () => {
    m.remove.mockResolvedValue({ success: false, error: 'Wycofanego dokumentu FV 5/10/2026 nie usuniesz…' });
    mount(<DraftInvoiceActions {...draftProps('VAT', null)} />);

    await click(button('Usuń szkic'));

    expect(m.toastError).toHaveBeenCalledWith('Wycofanego dokumentu FV 5/10/2026 nie usuniesz…');
    expect(m.refresh).toHaveBeenCalled();
    expect(m.push).not.toHaveBeenCalled();
  });

  it('U11e (decyzja 10): szkic wycofany — bez „Wyślij mailem”; strażnik: zwykły szkic ma przycisk e-maila', () => {
    mount(<InvoiceActions invoice={draftInvoice('VAT', 'regular', null)} canManageSend />);
    expect(emailMarker()).not.toBeNull();

    for (const [type, kind, deletable] of [['VAT', 'regular', false], ['ZAL', 'advance', false], ['KOR', 'correction', true]] as const) {
      mount(<InvoiceActions invoice={draftInvoice(type, kind, { deletable })} canManageSend />);
      expect(emailMarker(), `${type}: przycisk e-maila przy szkicu wycofanym`).toBeNull();
    }
  });

  it('U11f strażnik: zwykły szkic — oba przyciski, dotychczasowe potwierdzenie usunięcia i przejście do listy', async () => {
    mount(<DraftInvoiceActions {...draftProps('VAT', null)} />);
    expect(buttonLabels()).toEqual(['Wyślij do KSeF', 'Usuń szkic']);

    await click(button('Usuń szkic'));

    expect(confirmSpy).toHaveBeenCalledWith(PLAIN_DELETE_CONFIRM);
    expect(m.toastSuccess).toHaveBeenCalledWith('Szkic usunięty.');
    expect(m.push).toHaveBeenCalledWith('/invoices');
  });

  it('U11f strażnik: zwykły szkic w pasku akcji — „Wyślij do KSeF” i „Usuń szkic”', () => {
    mount(<InvoiceActions invoice={draftInvoice('VAT', 'regular', null)} canManageSend />);
    expect(buttonLabels()).toEqual(expect.arrayContaining(['Wyślij do KSeF', 'Usuń szkic']));
  });
});
