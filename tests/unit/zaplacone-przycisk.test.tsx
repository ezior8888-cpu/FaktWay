// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * „Zapłacone” w interfejsie (FaktWay 1.0 §3 pkt 3): lista faktur (karta telefonu
 * i tabela), „Po terminie” i szczegóły faktury. Bez okna potwierdzenia, od razu
 * toast z „Cofnij”, stan optymistyczny z wycofaniem przy błędzie, pole dotyku co
 * najmniej 44×44 px. Prawdziwe: komponenty i hook. Atrapy: akcje serwerowe,
 * router, toast, Realtime.
 */

const actions = vi.hoisted(() => ({ mark: vi.fn(), undo: vi.fn() }));
vi.mock('@/app/actions/invoice-payments', () => ({
  markInvoicePaidAction: actions.mark,
  undoInvoicePaidAction: actions.undo,
}));
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/invoices' }));
const toast = vi.hoisted(() => ({ success: vi.fn(() => 'toast-1'), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const channel = { on: () => channel, subscribe: () => channel };
    return { channel: () => channel, removeChannel: vi.fn() };
  },
}));
vi.mock('@/components/invoices/actions-detail', () => ({ downloadInvoiceXmlAction: vi.fn() }));
vi.mock('@/components/invoices/draft-actions', () => ({ deleteDraftInvoiceAction: vi.fn() }));
vi.mock('@/app/actions/reminders', () => ({ toggleInvoiceRemindersAction: vi.fn() }));
vi.mock('@/components/reminders/reminder-consent-dialog', () => ({ ReminderConsentDialog: () => null }));
const render = vi.hoisted(() => ({ liczba: 0 }));
vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children }: { children?: React.ReactNode }) => {
    render.liczba += 1;
    if (render.liczba > 1000) throw new Error('Pętla renderów');
    return <span>{children}</span>;
  },
  AvatarFallback: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

const { InvoiceList } = await import('@/components/invoices/invoice-list');
const { OverdueDashboard, applyOverdueChange } = await import('@/components/reminders/overdue-dashboard');
const { stableOptimisticReducer } = await import('@/components/invoices/use-invoice-payment');
const { InvoicePaymentPanel } = await import('@/components/invoices/invoice-payment-panel');
type OverdueInvoice = import('@/components/reminders/overdue-dashboard').OverdueInvoice;
type InvoiceRow = import('@/components/invoices/invoice-list').InvoiceRow;
type Facts = import('@/lib/invoices/list-row-facts').InvoiceListRowFacts;

const ID = '11111111-1111-4111-8111-111111111111';

function wiersz(over: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: ID,
    internal_number: 'FV/1/2026',
    issue_date: '2026-10-01',
    buyer_data: { name: 'Klient Testowy', nip: '1234567890' },
    gross_total: 1230,
    ksef_status: 'accepted',
    ksef_number: 'K-1',
    created_at: '2026-10-01T10:00:00Z',
    payment_status: 'unpaid',
    payment_due_date: '2026-10-15',
    paid_amount: 0,
    currency: 'PLN',
    invoice_kind: 'regular',
    ...over,
  };
}

const fakty = (over: Partial<Facts> = {}): Facts => ({
  payment: 'overdue',
  outstanding: 1230,
  canCorrect: false,
  canMarkPaid: true,
  ...over,
});

const zaleglosc = (over: Partial<OverdueInvoice> = {}): OverdueInvoice => ({
  id: ID,
  internal_number: 'FV/1/2026',
  payment_due_date: '2026-10-15',
  gross_total: 1230,
  amount_due: 1230,
  days_overdue: 18,
  buyer_name: 'Klient Testowy',
  buyer_nip: '1234567890',
  buyer_email: 'klient@example.com',
  reminders_paused: false,
  reminders_sent_count: 0,
  reminder_status: 'none',
  latest_reminder: null,
  ...over,
});

const statystyki = {
  totalCount: 1, totalAmount: 1230, avgDaysOverdue: 18, pausedCount: 0, sentThisMonth: 0,
};

let container: HTMLDivElement;
let root: Root;

function odroczony<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function przyciski(tekst: string): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')].filter((b) => b.textContent?.includes(tekst));
}

async function dotknij(button: HTMLElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function renderuj(node: React.ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

const lista = (props: Partial<React.ComponentProps<typeof InvoiceList>> = {}) => (
  <InvoiceList
    tenantId="firma-a"
    initialInvoices={[wiersz()]}
    facts={{ [ID]: fakty() }}
    today="2026-11-02"
    canMarkPaid
    {...props}
  />
);

beforeEach(() => {
  vi.clearAllMocks();
  toast.success.mockReturnValue('toast-1');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  actions.mark.mockResolvedValue({ success: true, status: 'marked', amount: 1230, paidOn: '2026-11-02', number: 'FV/1/2026' });
  actions.undo.mockResolvedValue({ success: true, status: 'undone' });
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('lista faktur: wiersz i karta telefonu', () => {
  it('przycisk jest w karcie i w tabeli; tekst widać bez najechania', async () => {
    await renderuj(lista());
    expect(przyciski('Zapłacone')).toHaveLength(2);
  });

  it('pole dotyku co najmniej 44×44 px poniżej `lg`, w pikselach (`--spacing` aplikacji jest mniejszy niż 4 px)', async () => {
    await renderuj(lista());
    const klasy = przyciski('Zapłacone')[0]!.className.split(/\s+/);
    expect(klasy).toEqual(expect.arrayContaining(['max-lg:min-h-[44px]', 'max-lg:min-w-[44px]']));
    expect(klasy.some((k) => k.startsWith('hover:') && k.includes('opacity'))).toBe(false);
  });

  it('w karcie telefonu przycisk jest poza linkiem do faktury', async () => {
    await renderuj(lista());
    const karta = container.querySelector('.lg\\:hidden')!;
    const przycisk = [...karta.querySelectorAll('button')].find((b) => b.textContent?.includes('Zapłacone'))!;
    expect(przycisk.closest('a')).toBeNull();
  });

  it('bez prawa roli (księgowa) przycisku nie ma', async () => {
    await renderuj(lista({ canMarkPaid: false }));
    expect(przyciski('Zapłacone')).toHaveLength(0);
  });

  it('faktura bez reszty do oznaczenia nie ma przycisku', async () => {
    await renderuj(lista({ facts: { [ID]: fakty({ canMarkPaid: false }) } }));
    expect(przyciski('Zapłacone')).toHaveLength(0);
  });

  it('dotknięcie: bez okna, od razu „Opłacona” i toast z „Cofnij”, jeszcze przed odpowiedzią serwera', async () => {
    const serwer = odroczony<unknown>();
    actions.mark.mockReturnValue(serwer.promise);
    await renderuj(lista());

    await dotknij(przyciski('Zapłacone')[0]!);

    expect(actions.mark).toHaveBeenCalledWith(ID, undefined);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain('Opłacona');
    // Oba widoki wiersza naraz: karta i tabela są w DOM równocześnie.
    expect(przyciski('Zapłacone')).toHaveLength(0);
    expect(toast.success).toHaveBeenCalledTimes(1);
    const [tekst, opcje] = toast.success.mock.calls[0] as unknown as [string, { action: { label: string }; actionButtonStyle: { minHeight: number; minWidth: number } }];
    expect(tekst).toBe('Faktura FV/1/2026: zapłacona');
    expect(opcje.action.label).toBe('Cofnij');
    // Pole dotyku „Cofnij”: sonner rysuje je niższe niż 44 px, a styl czyta tylko z poziomu toastu.
    expect(opcje.actionButtonStyle).toEqual({ minHeight: 44, minWidth: 44 });

    await act(async () => {
      serwer.resolve({ success: true, status: 'marked', amount: 1230, paidOn: '2026-11-02', number: 'FV/1/2026' });
    });
    expect(router.refresh).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('błąd serwera: wiersz wraca do stanu sprzed dotknięcia, toast zmienia się w błąd bez „Cofnij”', async () => {
    actions.mark.mockResolvedValue({ success: false, error: 'Faktura FV/1/2026 nie jest jeszcze przyjęta w KSeF.' });
    await renderuj(lista());

    await dotknij(przyciski('Zapłacone')[0]!);

    expect(przyciski('Zapłacone')).toHaveLength(2);
    expect(toast.error).toHaveBeenCalledWith(
      'Faktura FV/1/2026 nie jest jeszcze przyjęta w KSeF.',
      expect.objectContaining({ id: 'toast-1', action: undefined }),
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('wyjątek akcji (brak sieci): też wycofanie i komunikat', async () => {
    actions.mark.mockRejectedValue(new TypeError('Failed to fetch'));
    await renderuj(lista());

    await dotknij(przyciski('Zapłacone')[0]!);

    expect(przyciski('Zapłacone')).toHaveLength(2);
    expect(toast.error).toHaveBeenCalledWith(
      'Nie udało się oznaczyć zapłaty. Sprawdź połączenie i spróbuj ponownie.',
      expect.objectContaining({ id: 'toast-1' }),
    );
  });

  it('„już zapłacona” (inna karta była pierwsza): toast bez „Cofnij”, odświeżenie', async () => {
    actions.mark.mockResolvedValue({ success: true, status: 'already_paid', number: 'FV/1/2026' });
    await renderuj(lista());

    await dotknij(przyciski('Zapłacone')[0]!);

    expect(toast.info).toHaveBeenCalledWith(
      'Faktura FV/1/2026 jest już zapłacona.',
      expect.objectContaining({ id: 'toast-1', action: undefined }),
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it('„Cofnij” z toastu: czeka na oznaczenie, cofa i odświeża', async () => {
    const serwer = odroczony<unknown>();
    actions.mark.mockReturnValue(serwer.promise);
    await renderuj(lista());
    await dotknij(przyciski('Zapłacone')[0]!);
    const opcje = (toast.success.mock.calls[0] as unknown as [string, { action: { onClick: () => void } }])[1];

    await act(async () => {
      opcje.action.onClick();
    });
    // Oznaczenie jeszcze w drodze: cofnięcie nie może go wyprzedzić.
    expect(actions.undo).not.toHaveBeenCalled();
    expect(przyciski('Zapłacone')).toHaveLength(2);

    await act(async () => {
      serwer.resolve({ success: true, status: 'marked', amount: 1230, paidOn: '2026-11-02', number: 'FV/1/2026' });
    });
    expect(actions.undo).toHaveBeenCalledWith(ID);
    expect(toast.success).toHaveBeenLastCalledWith('Faktura FV/1/2026: cofnięto zapłatę');
    expect(router.refresh).toHaveBeenCalled();
  });

  it('„Cofnij”, gdy oznaczenie się nie udało: nie woła cofnięcia', async () => {
    const serwer = odroczony<unknown>();
    actions.mark.mockReturnValue(serwer.promise);
    await renderuj(lista());
    await dotknij(przyciski('Zapłacone')[0]!);
    const opcje = (toast.success.mock.calls[0] as unknown as [string, { action: { onClick: () => void } }])[1];

    await act(async () => {
      opcje.action.onClick();
    });
    await act(async () => {
      serwer.resolve({ success: false, error: 'Nie.' });
    });

    expect(actions.undo).not.toHaveBeenCalled();
  });

  it('faktura z importu: bez stanu płatności („—”), a mimo to z przyciskiem; po dotknięciu „Opłacona”', async () => {
    const serwer = odroczony<unknown>();
    actions.mark.mockReturnValue(serwer.promise);
    await renderuj(lista({ facts: { [ID]: fakty({ payment: null, outstanding: null }) } }));
    expect(container.textContent).not.toContain('Opłacona');

    await dotknij(przyciski('Zapłacone')[0]!);
    expect(container.textContent).toContain('Opłacona');

    await act(async () => {
      serwer.resolve({ success: false, error: 'x' });
    });
    expect(container.textContent).not.toContain('Opłacona');
  });
});

describe('Po terminie', () => {
  const strona = (props: Partial<React.ComponentProps<typeof OverdueDashboard>> = {}) => (
    <OverdueDashboard overdueInvoices={[zaleglosc()]} stats={statystyki} canMarkPaid {...props} />
  );

  it('dotknięcie zdejmuje wiersz od razu i przelicza kafle, po błędzie wiersz wraca', async () => {
    const serwer = odroczony<unknown>();
    actions.mark.mockReturnValue(serwer.promise);
    await renderuj(strona());
    expect(container.textContent).toContain('Klient Testowy');

    await dotknij(przyciski('Zapłacone')[0]!);

    expect(actions.mark).toHaveBeenCalledWith(ID, undefined);
    expect(container.textContent).not.toContain('Klient Testowy');
    expect(toast.success).toHaveBeenCalled();

    await act(async () => {
      serwer.resolve({ success: false, error: 'Nie udało się.' });
    });
    expect(container.textContent).toContain('Klient Testowy');
    expect(toast.error).toHaveBeenCalled();
  });

  // Regresja znaleziona w przeglądarce: `useOptimistic` stosuje reducer przy każdym renderze, a tabela TanStack
  // nową tablicę bierze za nowe dane i zeruje stronę (stan → render → nowa tablica). Pętla głodziła przejście
  // i karta wisiała na 100% CPU, ale tylko gdy na liście coś zostawało: przy jednym wierszu tabeli już nie ma.
  it('dwa wiersze: po dotknięciu reszta listy nie renderuje się w pętli, a przejście się kończy', async () => {
    const serwer = odroczony<unknown>();
    actions.mark.mockReturnValue(serwer.promise);
    const proste = (a: readonly number[], b: { id: string }) => a.filter((x) => String(x) !== b.id);
    const stabilny = stableOptimisticReducer(proste);
    const akcja = { id: '1' };
    const wejscie = [1, 2];
    expect(stabilny(wejscie, akcja)).toBe(stabilny(wejscie, akcja));
    expect(stabilny([2, 3], akcja)).toEqual([2, 3]);

    render.liczba = 0;
    await renderuj(strona({
      overdueInvoices: [zaleglosc(), zaleglosc({ id: '22222222-2222-4222-8222-222222222222', internal_number: 'FV/2/2026', buyer_name: 'Drugi Klient' })],
    }));
    const poStarcie = render.liczba;

    await dotknij(przyciski('Zapłacone')[0]!);
    expect(container.textContent).toContain('Drugi Klient');
    expect(container.textContent).not.toContain('Klient Testowy');
    await act(async () => {
      serwer.resolve({ success: true, status: 'marked', amount: 1230, paidOn: '2026-11-02', number: 'FV/1/2026' });
    });

    // Pułap: `Avatar` w atrapie rzuca po 1000 renderach, więc pętla to czerwony test, a nie zawieszony przebieg.
    expect(render.liczba - poStarcie).toBeLessThan(100);
  });

  it('księgowa nie ma przycisku, reszta akcji zostaje', async () => {
    await renderuj(strona({ canMarkPaid: false }));
    expect(przyciski('Zapłacone')).toHaveLength(0);
    expect(container.querySelector('button[aria-label="Przygotuj przypomnienie"]')).not.toBeNull();
  });

  it('pole dotyku co najmniej 44×44 px', async () => {
    await renderuj(strona());
    expect(przyciski('Zapłacone')[0]!.className.split(/\s+/)).toEqual(expect.arrayContaining(['max-lg:min-h-[44px]', 'max-lg:min-w-[44px]']));
  });

  it('„Cofnij” zwraca wiersz na miejsce: ta sama kolejność co na serwerze', () => {
    const a = zaleglosc({ id: 'a', days_overdue: 30 });
    const b = zaleglosc({ id: 'b', days_overdue: 20 });
    const c = zaleglosc({ id: 'c', days_overdue: 10 });
    expect(applyOverdueChange([a, c], { type: 'show', invoice: b }).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(applyOverdueChange([a, b, c], { type: 'hide', id: 'b' }).map((i) => i.id)).toEqual(['a', 'c']);
    // Serwer zdążył pokazać wiersz: bez dubla.
    expect(applyOverdueChange([a, b], { type: 'show', invoice: b }).map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('szczegóły faktury', () => {
  const invoice = { id: ID, number: 'FV/1/2026' };
  const otwarta = { canMark: true, canUndo: false, paidOn: null, paidOnFromDocument: false, today: '2026-11-02' };

  it('otwarta: „Zapłacone” i „Zapłacono innego dnia”; bez wyboru daty oznacza na dziś', async () => {
    const serwer = odroczony<unknown>();
    actions.mark.mockReturnValue(serwer.promise);
    await renderuj(<InvoicePaymentPanel invoice={invoice} data={otwarta} />);
    expect(przyciski('Zapłacono innego dnia')).toHaveLength(1);

    await dotknij(przyciski('Zapłacone')[0]!);

    expect(actions.mark).toHaveBeenCalledWith(ID, undefined);
    expect(container.textContent).toContain('Zapłacona 02.11.2026');
    expect(przyciski('Cofnij zapłatę')).toHaveLength(1);

    await act(async () => {
      serwer.resolve({ success: true, status: 'marked', amount: 1230, paidOn: '2026-11-02', number: 'FV/1/2026' });
    });
    expect(router.refresh).toHaveBeenCalled();
  });

  it('inna data: pole nie pozwala na przyszłość, wybrany dzień idzie do akcji', async () => {
    const serwer = odroczony<unknown>();
    actions.mark.mockReturnValue(serwer.promise);
    await renderuj(<InvoicePaymentPanel invoice={invoice} data={otwarta} />);
    await dotknij(przyciski('Zapłacono innego dnia')[0]!);

    const pole = container.querySelector('input[type="date"]') as HTMLInputElement;
    expect(pole.max).toBe('2026-11-02');
    expect(pole.className.split(/\s+/)).toContain('max-lg:min-h-[44px]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(pole, '2026-10-20');
      pole.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(actions.mark).toHaveBeenCalledWith(ID, '2026-10-20');
    expect(container.textContent).toContain('Zapłacona 20.10.2026');

    // Błąd serwera: wraca przycisk, jakby nic się nie stało.
    await act(async () => {
      serwer.resolve({ success: false, error: 'Data zapłaty nie może być z przyszłości.' });
    });
    expect(przyciski('Zapłacone')).toHaveLength(1);
    expect(toast.error).toHaveBeenCalled();
  });

  it('wpłata ręczna: „Cofnij zapłatę” także po czasie, bez okna', async () => {
    const serwer = odroczony<unknown>();
    actions.undo.mockReturnValue(serwer.promise);
    await renderuj(
      <InvoicePaymentPanel
        invoice={invoice}
        data={{ canMark: false, canUndo: true, paidOn: '2026-10-20', paidOnFromDocument: false, today: '2026-11-02' }}
      />,
    );
    expect(container.textContent).toContain('Zapłacona 20.10.2026');
    const cofnij = przyciski('Cofnij zapłatę')[0]!;
    expect(cofnij.className.split(/\s+/)).toContain('max-lg:min-h-[44px]');

    await dotknij(cofnij);

    expect(actions.undo).toHaveBeenCalledWith(ID);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(przyciski('Zapłacone')).toHaveLength(1);

    await act(async () => {
      serwer.resolve({ success: true, status: 'undone' });
    });
    expect(toast.success).toHaveBeenLastCalledWith('Faktura FV/1/2026: cofnięto zapłatę');
    expect(router.refresh).toHaveBeenCalled();
  });

  it('błąd cofnięcia: wraca stan „zapłacona”', async () => {
    actions.undo.mockResolvedValue({ success: false, error: 'Nie udało się cofnąć.' });
    await renderuj(
      <InvoicePaymentPanel
        invoice={invoice}
        data={{ canMark: false, canUndo: true, paidOn: '2026-10-20', paidOnFromDocument: false, today: '2026-11-02' }}
      />,
    );

    await dotknij(przyciski('Cofnij zapłatę')[0]!);

    expect(container.textContent).toContain('Zapłacona 20.10.2026');
    expect(toast.error).toHaveBeenCalledWith('Nie udało się cofnąć.');
  });

  it('wpłata z banku albo FLO: zapłacona, bez „Cofnij zapłatę”', async () => {
    await renderuj(
      <InvoicePaymentPanel
        invoice={invoice}
        data={{ canMark: false, canUndo: false, paidOn: '2026-10-20', paidOnFromDocument: false, today: '2026-11-02' }}
      />,
    );
    expect(container.textContent).toContain('Zapłacona 20.10.2026');
    expect(przyciski('Cofnij zapłatę')).toHaveLength(0);
  });

  it('data z FA(3): mówi, skąd jest', async () => {
    await renderuj(
      <InvoicePaymentPanel
        invoice={invoice}
        data={{ canMark: false, canUndo: false, paidOn: '2026-09-20', paidOnFromDocument: true, today: '2026-11-02' }}
      />,
    );
    expect(container.textContent).toContain('Zapłacona 20.09.2026 (data z faktury)');
  });

  it('rola bez prawa albo faktura bez reszty: panelu nie ma', async () => {
    await renderuj(
      <InvoicePaymentPanel
        invoice={invoice}
        data={{ canMark: false, canUndo: false, paidOn: null, paidOnFromDocument: false, today: '2026-11-02' }}
      />,
    );
    expect(container.querySelector('[data-testid="platnosc-faktury"]')).toBeNull();
  });
});
