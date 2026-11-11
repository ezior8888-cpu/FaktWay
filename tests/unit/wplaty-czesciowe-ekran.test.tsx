// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sekcja „Wpłaty” na szczegółach faktury (plan kompletnej aplikacji, krok 3.1):
 * historia wpłat z resztą do zapłaty, „Zapisz wpłatę” (kwota, data, notatka)
 * i „Cofnij wpłatę” z potwierdzeniem. Prawdziwe: komponent, schemat Zod
 * i teksty. Atrapy: akcje serwerowe, router, toast, okna bez portalu.
 */

const actions = vi.hoisted(() => ({ record: vi.fn(), void: vi.fn() }));
vi.mock('@/app/actions/invoice-payments', () => ({
  recordInvoicePaymentAction: actions.record,
  voidInvoicePaymentAction: actions.void,
  markInvoicePaidAction: vi.fn(),
  undoInvoicePaidAction: vi.fn(),
}));
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

// Okna bez portalu: treść tylko, gdy otwarte (jak w `decyzja-duplikatu-ekran.test.tsx`).
vi.mock('@/components/ui/dialog', async () => {
  const React = await import('react');
  const Ctx = React.createContext<{ open: boolean; setOpen: (v: boolean) => void }>({ open: false, setOpen: () => {} });
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, onOpenChange, children }: { open?: boolean; onOpenChange?: (v: boolean) => void; children?: ReactNode }) => (
      <Ctx.Provider value={{ open: Boolean(open), setOpen: (v) => onOpenChange?.(v) }}>{children}</Ctx.Provider>
    ),
    DialogContent: ({ children }: { children?: ReactNode }) => (React.useContext(Ctx).open ? <div role="dialog">{children}</div> : null),
    DialogHeader: Pass,
    DialogFooter: Pass,
    DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  };
});
vi.mock('@/components/ui/alert-dialog', async () => {
  const React = await import('react');
  const Ctx = React.createContext<{ open: boolean; setOpen: (v: boolean) => void }>({ open: false, setOpen: () => {} });
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    AlertDialog: ({ open, onOpenChange, children }: { open?: boolean; onOpenChange?: (v: boolean) => void; children?: ReactNode }) => (
      <Ctx.Provider value={{ open: Boolean(open), setOpen: (v) => onOpenChange?.(v) }}>{children}</Ctx.Provider>
    ),
    AlertDialogContent: ({ children }: { children?: ReactNode }) => (React.useContext(Ctx).open ? <div role="alertdialog">{children}</div> : null),
    AlertDialogHeader: Pass,
    AlertDialogFooter: Pass,
    AlertDialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    AlertDialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
    AlertDialogCancel: ({ children, disabled }: { children?: ReactNode; disabled?: boolean }) => {
      const ctx = React.useContext(Ctx);
      return <button type="button" disabled={disabled} onClick={() => ctx.setOpen(false)}>{children}</button>;
    },
  };
});

const { InvoicePaymentsSection } = await import('@/components/invoices/invoice-payments-section');
type Data = import('@/lib/invoices/invoice-payments').InvoicePaymentsData;
type Entry = import('@/lib/invoices/invoice-payments').InvoicePaymentEntry;

const ID = '11111111-1111-4111-8111-111111111111';
const P1 = '55555555-5555-4555-8555-555555555551';
const P2 = '55555555-5555-4555-8555-555555555552';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NBSP = /[  ]/g;
const invoice = { id: ID, number: 'FV/1/2026' };

function wplata(over: Partial<Entry> = {}): Entry {
  return {
    id: P1, amount: 300, paidOn: '2026-11-02', source: 'manual_entry', note: null,
    recordedAt: '2026-11-02T09:00:00Z', voidedAt: null, ...over,
  };
}

function dane(over: Partial<Data> = {}): Data {
  return {
    entries: [wplata()],
    status: 'partial',
    due: 1230,
    paid: 300,
    remaining: 930,
    currency: 'PLN',
    canRecord: true,
    canVoid: true,
    today: '2026-11-09',
    loadError: false,
    mismatch: false,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

const tekst = () => (container.textContent ?? '').replace(NBSP, ' ');
const przyciski = (napis: string) => [...container.querySelectorAll('button')].filter((b) => b.textContent?.includes(napis));

async function renderuj(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

async function dotknij(button: HTMLElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function wpisz(selector: string, value: string) {
  const pole = container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  const proto = pole instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(pole, value);
    pole.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function wyslij() {
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  actions.record.mockResolvedValue({
    success: true, status: 'recorded', paymentId: P2, amount: 200, paidOn: '2026-11-09', remaining: 730, paidInFull: false, number: 'FV/1/2026',
  });
  actions.void.mockResolvedValue({ success: true, status: 'voided', amount: 300, number: 'FV/1/2026' });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('historia wpłat', () => {
  it('wpłaty z dniem i kwotą, stan płatności, zapłacono i reszta do zapłaty', async () => {
    await renderuj(<InvoicePaymentsSection invoice={invoice} data={dane()} />);

    expect(tekst()).toContain('Wpłaty');
    expect(tekst()).toContain('częściowo opłacona');
    expect(tekst()).toContain('Zapłacono 300,00 PLN z 1230,00 PLN. Pozostało do zapłaty: 930,00 PLN.');
    const wiersz = container.querySelector('[data-testid="wplata"]')!;
    expect(wiersz.textContent!.replace(NBSP, ' ')).toContain('02.11.2026');
    expect(wiersz.textContent!.replace(NBSP, ' ')).toContain('300,00 PLN');
    expect(tekst()).not.toMatch(/[—–]/);
  });

  it('notatka i podpis źródła; wpłata z „Zapłacone” mówi, skąd jest', async () => {
    await renderuj(<InvoicePaymentsSection invoice={invoice} data={dane({
      entries: [wplata({ note: 'przelew z mBanku' }), wplata({ id: P2, amount: 930, paidOn: '2026-11-05', source: 'manual' })],
      status: 'paid', paid: 1230, remaining: 0, canRecord: false,
    })} />);

    expect(tekst()).toContain('przelew z mBanku');
    expect(tekst()).toContain('Oznaczona przyciskiem „Zapłacone” (cała reszta)');
    expect(tekst()).toContain('opłacona');
    expect(tekst()).not.toContain('Pozostało do zapłaty');
    expect(przyciski('Zapisz wpłatę')).toHaveLength(0);
    expect(przyciski('Cofnij wpłatę')).toHaveLength(2);
  });

  it('wpłata cofnięta zostaje w historii z dniem cofnięcia, bez przycisku cofnięcia', async () => {
    await renderuj(<InvoicePaymentsSection invoice={invoice} data={dane({
      entries: [wplata({ voidedAt: '2026-11-03T08:00:00Z' })], status: 'overdue', paid: 0, remaining: 1230,
    })} />);

    expect(tekst()).toContain('Cofnięta 03.11.2026');
    expect(przyciski('Cofnij wpłatę')).toHaveLength(0);
    expect(tekst()).toContain('nieopłacona, po terminie');
  });

  it('księgowa (bez prawa zmiany): historia bez „Zapisz wpłatę” i bez „Cofnij wpłatę”', async () => {
    await renderuj(<InvoicePaymentsSection invoice={invoice} data={dane({ canRecord: false, canVoid: false })} />);

    expect(container.querySelector('[data-testid="wplata"]')).not.toBeNull();
    expect(przyciski('Zapisz wpłatę')).toHaveLength(0);
    expect(przyciski('Cofnij wpłatę')).toHaveLength(0);
  });

  it('wpłaty z wyciągu nie cofa się tutaj', async () => {
    await renderuj(<InvoicePaymentsSection invoice={invoice} data={dane({ entries: [wplata({ source: 'bank_import' })] })} />);

    expect(tekst()).toContain('Z wyciągu bankowego');
    expect(przyciski('Cofnij wpłatę')).toHaveLength(0);
  });

  it('błąd odczytu historii: komunikat z wyjściem, bez zapisu', async () => {
    await renderuj(<InvoicePaymentsSection invoice={invoice} data={dane({ entries: [], loadError: true, canRecord: false })} />);

    expect(tekst()).toContain('Nie udało się wczytać historii wpłat. Odśwież stronę.');
    expect(przyciski('Zapisz wpłatę')).toHaveLength(0);
  });

  it('suma historii niezgodna z fakturą: ostrzeżenie z drogą przez Pomoc, bez zapisu', async () => {
    await renderuj(<InvoicePaymentsSection invoice={invoice} data={dane({ mismatch: true, canRecord: false })} />);

    expect(tekst()).toContain('Suma wpłat w historii nie zgadza się z kwotą zapłaconą na fakturze.');
    expect(tekst()).toContain('Pomoc');
    expect(przyciski('Zapisz wpłatę')).toHaveLength(0);
  });
});

describe('„Zapisz wpłatę”', () => {
  async function otworz(data: Data = dane()) {
    await renderuj(<InvoicePaymentsSection invoice={invoice} data={data} />);
    await dotknij(przyciski('Zapisz wpłatę')[0]!);
  }

  it('okno: kwota, data domyślnie dziś (bez przyszłości), notatka; reszta do zapłaty w opisie; pola dotyku 44 px', async () => {
    await otworz();

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(tekst()).toContain('Pozostało do zapłaty: 930,00 PLN');
    const data = container.querySelector('input[type="date"]') as HTMLInputElement;
    expect(data.value).toBe('2026-11-09');
    expect(data.max).toBe('2026-11-09');
    const kwota = container.querySelector('input[inputmode="decimal"]') as HTMLInputElement;
    expect(kwota.value).toBe('');
    expect(container.querySelector('textarea')).not.toBeNull();
    for (const przycisk of przyciski('Zapisz wpłatę')) {
      expect(przycisk.className.split(/\s+/)).toEqual(expect.arrayContaining(['max-lg:min-h-[44px]']));
    }
  });

  it('zapis: akcja dostaje fakturę, kwotę, dzień, notatkę i klucz idempotencji; potem toast i odświeżenie', async () => {
    await otworz();
    await wpisz('input[inputmode="decimal"]', '200,00');
    await wpisz('input[type="date"]', '2026-11-07');
    await wpisz('textarea', 'druga rata');

    await wyslij();

    expect(actions.record).toHaveBeenCalledTimes(1);
    const [arg] = actions.record.mock.calls[0]!;
    expect(arg).toEqual({ invoiceId: ID, amount: '200,00', paidOn: '2026-11-07', note: 'druga rata', idempotencyKey: expect.stringMatching(UUID) });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Zapisano wpłatę'));
    expect(router.refresh).toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('błąd sieci: komunikat, okno zostaje, a druga próba idzie z TYM SAMYM kluczem (wpłata zapisze się raz)', async () => {
    actions.record.mockRejectedValueOnce(new Error('offline'));
    await otworz();
    await wpisz('input[inputmode="decimal"]', '200');

    await wyslij();
    expect(toast.error).toHaveBeenCalledWith('Nie udało się zapisać wpłaty. Sprawdź połączenie i spróbuj ponownie.');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await wyslij();
    expect(actions.record).toHaveBeenCalledTimes(2);
    expect(actions.record.mock.calls[1]![0].idempotencyKey).toBe(actions.record.mock.calls[0]![0].idempotencyKey);
  });

  it('nowe okno to nowa wpłata: nowy klucz', async () => {
    await otworz();
    await wpisz('input[inputmode="decimal"]', '200');
    await wyslij();
    await dotknij(przyciski('Zapisz wpłatę')[0]!);
    await wpisz('input[inputmode="decimal"]', '100');
    await wyslij();

    expect(actions.record).toHaveBeenCalledTimes(2);
    expect(actions.record.mock.calls[1]![0].idempotencyKey).not.toBe(actions.record.mock.calls[0]![0].idempotencyKey);
  });

  it('kwota ponad resztę: komunikat przy polu, bez wołania akcji', async () => {
    await otworz();
    await wpisz('input[inputmode="decimal"]', '930,01');

    await wyslij();

    expect(actions.record).not.toHaveBeenCalled();
    expect(tekst()).toContain('Kwota jest większa niż pozostało do zapłaty (930,00 PLN).');
    expect(container.querySelector('input[inputmode="decimal"]')!.getAttribute('aria-invalid')).toBe('true');
  });

  it('data z przyszłości: komunikat przy polu, bez wołania akcji', async () => {
    await otworz();
    await wpisz('input[inputmode="decimal"]', '10');
    await wpisz('input[type="date"]', '2026-11-10');

    await wyslij();

    expect(actions.record).not.toHaveBeenCalled();
    expect(tekst()).toContain('Data wpłaty nie może być z przyszłości.');
  });

  it('odmowa serwera przy polu (np. reszta zmieniła się w innej karcie): komunikat przy kwocie', async () => {
    actions.record.mockResolvedValue({ success: false, error: 'Kwota jest większa niż pozostało do zapłaty na fakturze FV/1/2026 (100,00 PLN).', field: 'amount' });
    await otworz();
    await wpisz('input[inputmode="decimal"]', '200');

    await wyslij();

    expect(tekst()).toContain('(100,00 PLN)');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('„już zapisana” (ponowienie): informacja, odświeżenie, okno zamknięte', async () => {
    actions.record.mockResolvedValue({
      success: true, status: 'already_recorded', paymentId: P2, amount: 200, paidOn: '2026-11-09', remaining: 730, paidInFull: false, number: 'FV/1/2026',
    });
    await otworz();
    await wpisz('input[inputmode="decimal"]', '200');

    await wyslij();

    expect(toast.info).toHaveBeenCalledWith('Ta wpłata jest już zapisana.');
    expect(router.refresh).toHaveBeenCalled();
  });
});

describe('„Cofnij wpłatę”', () => {
  it('potwierdzenie z kwotą i dniem; „Anuluj” nic nie cofa', async () => {
    await renderuj(<InvoicePaymentsSection invoice={invoice} data={dane()} />);

    await dotknij(przyciski('Cofnij wpłatę')[0]!);
    expect(container.querySelector('[role="alertdialog"]')!.textContent!.replace(NBSP, ' ')).toContain('Cofnąć wpłatę 300,00 PLN z 02.11.2026?');

    await dotknij(przyciski('Anuluj')[0]!);
    expect(actions.void).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('potwierdzone: akcja z identyfikatorem wpłaty, toast i odświeżenie', async () => {
    await renderuj(<InvoicePaymentsSection invoice={invoice} data={dane()} />);
    await dotknij(przyciski('Cofnij wpłatę')[0]!);

    const potwierdz = [...container.querySelector('[role="alertdialog"]')!.querySelectorAll('button')].find((b) => b.textContent === 'Cofnij wpłatę')!;
    await dotknij(potwierdz);

    expect(actions.void).toHaveBeenCalledWith(P1);
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Cofnięto wpłatę 300,00'));
    expect(router.refresh).toHaveBeenCalled();
  });

  it('odmowa (np. najpierw cofnij „Zapłacone”): komunikat, bez odświeżenia', async () => {
    actions.void.mockResolvedValue({ success: false, error: 'Najpierw cofnij to oznaczenie, potem tę wpłatę.' });
    await renderuj(<InvoicePaymentsSection invoice={invoice} data={dane()} />);
    await dotknij(przyciski('Cofnij wpłatę')[0]!);

    const potwierdz = [...container.querySelector('[role="alertdialog"]')!.querySelectorAll('button')].find((b) => b.textContent === 'Cofnij wpłatę')!;
    await dotknij(potwierdz);

    expect(toast.error).toHaveBeenCalledWith('Najpierw cofnij to oznaczenie, potem tę wpłatę.');
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
