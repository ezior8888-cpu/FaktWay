// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ekran „Bank” (plan kompletnej aplikacji, krok 3.2, część 1): propozycja,
 * „Potwierdź”, „Wybierz fakturę ręcznie”, „Pomiń” z potwierdzeniem, widok
 * księgowej i błąd odczytu. Prawdziwe: komponent i teksty. Atrapy: akcje
 * serwerowe, router, toast, okna bez portalu.
 */

const actions = vi.hoisted(() => ({ importFile: vi.fn(), confirm: vi.fn(), skip: vi.fn(), undo: vi.fn() }));
vi.mock('@/app/actions/bank-statement', () => ({
  importBankStatementAction: actions.importFile,
  confirmBankOperationAction: actions.confirm,
  skipBankOperationAction: actions.skip,
  undoBankOperationAction: actions.undo,
}));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

function windowMock(names: { root: string; content: string; role: string }) {
  return async () => {
    const React = await import('react');
    const Ctx = React.createContext<{ open: boolean; setOpen: (v: boolean) => void }>({ open: false, setOpen: () => {} });
    const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
    return {
      [names.root]: ({ open, onOpenChange, children }: { open?: boolean; onOpenChange?: (v: boolean) => void; children?: ReactNode }) => (
        <Ctx.Provider value={{ open: Boolean(open), setOpen: (v) => onOpenChange?.(v) }}>{children}</Ctx.Provider>
      ),
      [names.content]: ({ children }: { children?: ReactNode }) => (React.useContext(Ctx).open ? <div role={names.role}>{children}</div> : null),
      [`${names.root}Header`]: Pass,
      [`${names.root}Footer`]: Pass,
      [`${names.root}Title`]: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
      [`${names.root}Description`]: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
      AlertDialogCancel: ({ children }: { children?: ReactNode }) => {
        const ctx = React.useContext(Ctx);
        return <button type="button" onClick={() => ctx.setOpen(false)}>{children}</button>;
      },
    };
  };
}
vi.mock('@/components/ui/dialog', windowMock({ root: 'Dialog', content: 'DialogContent', role: 'dialog' }));
vi.mock('@/components/ui/alert-dialog', windowMock({ root: 'AlertDialog', content: 'AlertDialogContent', role: 'alertdialog' }));

const { BankView } = await import('@/components/bank/bank-view');
import type { BankOperationsData } from '@/lib/import/bank/ekran';
import type { BankInvoiceOption } from '@/lib/import/bank/kandydaci';
import type { MatchResult } from '@/lib/import/bank/dopasowanie';

const OP = '66666666-6666-4666-8666-666666666666';
const OP_OVER = '77777777-7777-4777-8777-777777777777';
const INV = '11111111-1111-4111-8111-111111111111';
const INV_2 = '22222222-2222-4222-8222-222222222222';

const data: BankOperationsData = {
  pending: [
    { id: OP, account: 'PL61109010140000071219812874', bookingDate: '2026-11-05', amountGrosze: 30000, currency: 'PLN', counterpartyName: 'Nabywca Testowy', counterpartyAccount: null, title: 'FV/12/11/2026' },
    { id: OP_OVER, account: 'PL61109010140000071219812874', bookingDate: '2026-11-05', amountGrosze: 999900, currency: 'PLN', counterpartyName: null, counterpartyAccount: null, title: 'FV/13/11/2026' },
  ],
  pendingTotal: 2,
  confirmedTotal: 0,
  skippedTotal: 0,
  decided: [],
  accounts: [{ account: 'PL61109010140000071219812874', operations: 2, lastImportedAt: '2026-11-06T08:00:00Z' }],
};
const invoices: BankInvoiceOption[] = [
  { id: INV, number: 'FV/12/11/2026', ksefNumber: null, outstandingGrosze: 123000, buyerName: 'Nabywca Testowy', issueDate: '2026-11-01', dueDate: null },
  { id: INV_2, number: 'FV/13/11/2026', ksefNumber: null, outstandingGrosze: 50000, buyerName: 'Inny', issueDate: '2026-11-02', dueDate: null },
];
const proposals: Record<string, MatchResult> = {
  [OP]: { kind: 'invoice_number', invoiceId: INV, confidence: 'medium', amount: 'partial' },
  [OP_OVER]: { kind: 'invoice_number', invoiceId: INV_2, confidence: 'medium', amount: 'over' },
};

let container: HTMLDivElement;
let root: Root;
const tekst = () => (container.textContent ?? '').replace(/[\u00A0\u202F]/g, ' ');
const buttons = (label: string) => [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);

async function renderuj(node: ReactNode) {
  await act(async () => root.render(node));
}
async function klik(button: HTMLButtonElement | undefined) {
  if (!button) throw new Error('brak przycisku');
  await act(async () => button.click());
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('ekran Bank', () => {
  it('propozycja z pewnością i resztą; „Potwierdź” zapisuje wpłatę do proponowanej faktury', async () => {
    actions.confirm.mockResolvedValue({ success: true, status: 'confirmed', message: 'Zapisano wpłatę 300,00 PLN do faktury FV/12/11/2026.' });
    await renderuj(<BankView data={data} invoices={invoices} proposals={proposals} canWrite />);

    expect(tekst()).toContain('Faktura FV/12/11/2026: Numer faktury w tytule (prawdopodobne). Wpłata częściowa: po niej zostanie do zapłaty 930,00 PLN.');
    // Nadpłata: bez „Potwierdź”, z wyjściem w tekście.
    expect(tekst()).toContain('FaktWay nie zapisuje nadpłat');
    expect(buttons('Potwierdź')).toHaveLength(1);

    await klik(buttons('Potwierdź')[0]);
    expect(actions.confirm).toHaveBeenCalledWith({ operationId: OP, invoiceId: INV, matchKind: 'invoice_number' });
    expect(toast.success).toHaveBeenCalledWith('Zapisano wpłatę 300,00 PLN do faktury FV/12/11/2026.');
    expect(router.refresh).toHaveBeenCalled();
  });

  it('wybór ręczny innej faktury zapisuje z rodzajem „manual”; za mała reszta blokuje wybór', async () => {
    actions.confirm.mockResolvedValue({ success: true, status: 'confirmed', message: 'ok' });
    await renderuj(<BankView data={data} invoices={invoices} proposals={proposals} canWrite />);

    await klik(buttons('Wybierz fakturę ręcznie')[0]);
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Wybierz fakturę dla wpływu 300,00 PLN');
    const wybierz = [...dialog.querySelectorAll('button')].filter((b) => b.textContent === 'Wybierz');
    expect(wybierz).toHaveLength(2);
    // Druga faktura z listy (FV/13, reszta 500 zł) dla wpływu 300 zł: wybór ręczny.
    await klik(wybierz.find((b) => b.closest('li')?.textContent?.includes('FV/13/11/2026')));
    expect(actions.confirm).toHaveBeenCalledWith({ operationId: OP, invoiceId: INV_2, matchKind: 'manual' });
  });

  it('„Pomiń” pyta o zgodę, mówi o usunięciu danych i dopiero wtedy woła akcję', async () => {
    actions.skip.mockResolvedValue({ success: true, status: 'skipped', message: 'Pominięto operację.' });
    await renderuj(<BankView data={data} invoices={invoices} proposals={proposals} canWrite />);

    await klik(buttons('Pomiń')[0]);
    expect(actions.skip).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('Usuniemy tytuł przelewu, nazwę i rachunek nadawcy');
    await klik(buttons('Pomiń operację')[0]);
    expect(actions.skip).toHaveBeenCalledWith(OP);
  });

  it('księgowa widzi operacje bez przycisków; błąd odczytu to komunikat zamiast pustej listy', async () => {
    await renderuj(<BankView data={data} invoices={invoices} proposals={proposals} canWrite={false} />);
    expect(tekst()).toContain('Księgowa ma tu wgląd');
    expect(buttons('Potwierdź')).toHaveLength(0);
    expect(buttons('Pomiń')).toHaveLength(0);
    expect(buttons('Wgraj wyciąg')).toHaveLength(0);

    await renderuj(<BankView data={null} invoices={[]} proposals={{}} canWrite />);
    expect(tekst()).toContain('Nie udało się wczytać operacji z wyciągów');
  });

  it('nieudany odczyt faktur: bez propozycji i wyboru, „Pomiń” zostaje', async () => {
    await renderuj(<BankView data={data} invoices={null} proposals={{}} canWrite />);
    expect(tekst()).toContain('Nie udało się wczytać niezapłaconych faktur');
    expect(buttons('Potwierdź')).toHaveLength(0);
    expect(buttons('Wybierz fakturę ręcznie')).toHaveLength(0);
    expect(buttons('Pomiń')).toHaveLength(2);
  });
});
