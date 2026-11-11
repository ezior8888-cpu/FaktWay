// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sekcja „Zapłaty kosztów z wyciągu” na ekranie „Bank” (krok 3.2, część 3):
 * wgranie pliku daje propozycje bez zapisu, „Potwierdź” tylko przy pewnym
 * dopasowaniu, wybór kosztów z sumą, „Pomiń” z ostrzeżeniem, „Cofnij” przy
 * ostatnich decyzjach, widok księgowej i błędy odczytu. Prawdziwe: komponenty,
 * dopasowanie i teksty (`lib/import/bank/koszty.ts`). Atrapy: akcje serwerowe,
 * router, toast, okna bez portalu i pole wyboru. Test dopisany po komponencie.
 */

const actions = vi.hoisted(() => ({
  importFile: vi.fn(),
  confirm: vi.fn(),
  skip: vi.fn(),
  undo: vi.fn(),
  confirmTax: vi.fn(),
  undoTax: vi.fn(),
  propose: vi.fn(),
  confirmExpense: vi.fn(),
  skipExpense: vi.fn(),
  undoExpense: vi.fn(),
}));
vi.mock('@/app/actions/bank-statement', () => ({
  importBankStatementAction: actions.importFile,
  confirmBankOperationAction: actions.confirm,
  skipBankOperationAction: actions.skip,
  undoBankOperationAction: actions.undo,
  confirmBankTaxPaymentAction: actions.confirmTax,
  undoBankTaxPaymentAction: actions.undoTax,
  proposeBankExpensePaymentsAction: actions.propose,
  confirmBankExpensePaymentAction: actions.confirmExpense,
  skipBankExpenseOperationAction: actions.skipExpense,
  undoBankExpensePaymentAction: actions.undoExpense,
}));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({ checked, onCheckedChange, ...rest }: { checked?: boolean; onCheckedChange?: (v: boolean) => void; 'aria-label'?: string }) => (
    <input type="checkbox" checked={Boolean(checked)} onChange={(e) => onCheckedChange?.(e.target.checked)} aria-label={rest['aria-label']} />
  ),
}));

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
const { dopasujKoszty } = await import('@/lib/import/bank/koszty');
import type { BankOperationsData } from '@/lib/import/bank/ekran';
import type { KosztDoPrzelewu, ProposeBankExpensesResult, ZaplatyKosztowEkranu } from '@/lib/import/bank/koszty';

const A = '11111111-1111-4111-8111-111111111111';
const B = '33333333-3333-4333-8333-333333333333';
const OP_DONE = '66666666-6666-4666-8666-666666666666';
const RACHUNEK = 'PL61109010140000071219812874';
const DOSTAWCA = 'PL27114020040000300201355387';
const KSEF_A = '1234567890-20261101-0A1B2C3D4E01-7A';
const KEY_A = `v1:${'a'.repeat(64)}`;
const KEY_B = `v1:${'b'.repeat(64)}`;

const empty: BankOperationsData = { pending: [], pendingTotal: 0, confirmedTotal: 0, skippedTotal: 0, decided: [], accounts: [] };
const koszty: KosztDoPrzelewu[] = [
  { id: A, sprzedawca: 'Dostawca Testowy', numerFaktury: 'FV/7/11/2026', numerKsef: KSEF_A, kwotaGr: 123000, rachunek: DOSTAWCA.slice(2), termin: '2026-11-20' },
  { id: B, sprzedawca: 'Dostawca Testowy', numerFaktury: 'FV/8/11/2026', numerKsef: null, kwotaGr: 50000, rachunek: DOSTAWCA.slice(2), termin: '2026-11-25' },
];

function przelew(key: string, amountGrosze: number, title: string) {
  const base = { key, account: RACHUNEK, bookingDate: '2026-11-05', amountGrosze, counterpartyName: 'DOSTAWCA TESTOWY', counterpartyAccount: DOSTAWCA, title, reference: `R-${key.slice(3, 5)}` };
  return { ...base, ...dopasujKoszty(base, koszty)! };
}

const propozycje: ProposeBankExpensesResult = {
  success: true,
  fileFormat: 'camt053',
  przelewy: [przelew(KEY_A, -123000, `${KSEF_A} FV/7/11/2026`), przelew(KEY_B, -50000, 'ZA LISTOPAD')],
  koszty,
  znane: 0,
};

const decyzje: ZaplatyKosztowEkranu = {
  ok: true,
  confirmedTotal: 1,
  decided: [
    {
      id: OP_DONE, bookingDate: '2026-10-05', amountGrosze: -99000, state: 'confirmed', decidedAt: '2026-10-06T08:00:00Z', counterpartyName: 'Dostawca', title: 'FV/1/10/2026',
      koszty: [{ id: 'k1', numer: 'FV/1/10/2026', sprzedawca: 'Dostawca Testowy', zaplaconoO: '2026-10-05' }],
    },
    { id: 'op-skip', bookingDate: '2026-10-04', amountGrosze: -1000, state: 'skipped', decidedAt: '2026-10-06T08:00:00Z', counterpartyName: null, title: null, koszty: [] },
  ],
};

let container: HTMLDivElement;
let root: Root;
const tekst = () => (container.textContent ?? '').replace(/[  ]/g, ' ');
const buttons = (label: string, scope: ParentNode = container) => [...scope.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);

async function renderuj(node: ReactNode) {
  await act(async () => root.render(node));
}
async function klik(element: HTMLElement | undefined) {
  if (!element) throw new Error('brak elementu');
  await act(async () => element.click());
}

/** Wgranie pliku przez kartę „Wgraj wyciąg”: import (wpływy, ZUS i urząd), potem propozycje kosztów. */
async function wgraj() {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [new File(['<Document/>'], 'wyciag.xml')], configurable: true });
  await klik(buttons('Wgraj wyciąg')[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  actions.importFile.mockResolvedValue({ success: true, format: 'camt053', inserted: 0, duplicates: 0, debitsSkipped: 3, otherCurrencySkipped: 0 });
  actions.propose.mockResolvedValue(propozycje);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('Bank: zapłaty kosztów z wyciągu', () => {
  it('po wgraniu: propozycje bez zapisu, „Potwierdź” tylko przy pewnym dopasowaniu; po zapisie przelew znika, a koszt z wyboru przy innych', async () => {
    actions.confirmExpense.mockResolvedValue({ success: true, status: 'confirmed', message: 'Zapisano zapłatę kosztu FV/7/11/2026.' });
    await renderuj(<BankView data={empty} invoices={[]} proposals={{}} canWrite expenses={{ ok: true, confirmedTotal: 0, decided: [] }} canWriteExpenses />);

    await wgraj();

    expect(actions.propose).toHaveBeenCalledTimes(1);
    expect(tekst()).toContain('Przelewy do dostawców z listy „Do zapłaty” (2) czekają niżej na decyzję');
    expect(tekst()).toContain('Faktura FV/7/11/2026 (Dostawca Testowy): numer KSeF w tytule, kwota i rachunek jak na fakturze.');
    expect(tekst()).toContain('ale tytuł przelewu nie wskazuje faktury');
    expect(tekst()).toContain('Przelew do dostawcy zapisujemy dopiero wtedy, gdy potwierdzisz go jako zapłatę kosztu');
    expect(buttons('Potwierdź')).toHaveLength(1);

    await klik(buttons('Potwierdź')[0]);

    expect(actions.confirmExpense).toHaveBeenCalledWith({
      fileFormat: 'camt053',
      przelew: {
        key: KEY_A, account: RACHUNEK, bookingDate: '2026-11-05', amountGrosze: -123000, counterpartyName: 'DOSTAWCA TESTOWY',
        counterpartyAccount: DOSTAWCA, title: `${KSEF_A} FV/7/11/2026`, reference: 'R-aa',
      },
      expenseIds: [A],
      matchKind: 'ksef_number',
    });
    expect(toast.success).toHaveBeenCalledWith('Zapisano zapłatę kosztu FV/7/11/2026.');
    expect(router.refresh).toHaveBeenCalled();
    expect(tekst()).not.toContain('numer KSeF w tytule, kwota i rachunek');
    await klik(buttons('Wybierz koszt')[0]);
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('FV/8/11/2026');
    expect(dialog.textContent).not.toContain('FV/7/11/2026');
  });

  it('wybór kosztu: propozycja po kwocie zaznaczona, zapis tylko przy sumie równej przelewowi', async () => {
    actions.confirmExpense.mockResolvedValue({ success: true, status: 'confirmed', message: 'ok' });
    await renderuj(<BankView data={empty} invoices={[]} proposals={{}} canWrite expenses={{ ok: true, confirmedTotal: 0, decided: [] }} canWriteExpenses />);
    await wgraj();

    await klik(buttons('Wybierz koszt')[1]);
    const dialog = container.querySelector('[role="dialog"]')!;
    const zapisz = buttons('Zapisz zapłatę', dialog)[0]!;
    expect(dialog.textContent).toContain('tyle co przelew');
    expect(zapisz.disabled).toBe(false);

    await klik(dialog.querySelector<HTMLInputElement>('input[aria-label^="Koszt FV/7/11/2026"]')!);
    expect(dialog.textContent).toContain('przelew o');
    expect(buttons('Zapisz zapłatę', dialog)[0]!.disabled).toBe(true);
    await klik(dialog.querySelector<HTMLInputElement>('input[aria-label^="Koszt FV/7/11/2026"]')!);

    await klik(buttons('Zapisz zapłatę', dialog)[0]);
    expect(actions.confirmExpense).toHaveBeenCalledWith(expect.objectContaining({ expenseIds: [B], matchKind: 'amount' }));
  });

  it('„Pomiń” pyta o zgodę, mówi, czego nie zapiszemy, i woła pominięcie z samym przelewem', async () => {
    actions.skipExpense.mockResolvedValue({ success: true, status: 'skipped', message: 'Pominięto przelew.' });
    await renderuj(<BankView data={empty} invoices={[]} proposals={{}} canWrite expenses={{ ok: true, confirmedTotal: 0, decided: [] }} canWriteExpenses />);
    await wgraj();

    await klik(buttons('Pomiń')[1]);
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('Tytułu przelewu, nazwy ani rachunku odbiorcy nie zapiszemy');
    expect(actions.skipExpense).not.toHaveBeenCalled();
    await klik(buttons('Pomiń przelew')[0]);
    expect(actions.skipExpense).toHaveBeenCalledWith({ fileFormat: 'camt053', przelew: expect.objectContaining({ key: KEY_B, amountGrosze: -50000 }) });
    expect(tekst()).not.toContain('ZA LISTOPAD');
  });

  it('ostatnie decyzje: „Cofnij” z ostrzeżeniem przy zapłacie, pominięty bez danych; księgowa bez przycisków', async () => {
    actions.undoExpense.mockResolvedValue({ success: true, status: 'undone', message: 'Cofnięto zapłatę z przelewu.' });
    await renderuj(<BankView data={empty} invoices={[]} proposals={{}} canWrite expenses={decyzje} canWriteExpenses />);

    expect(tekst()).toContain('Zapłata kosztu FV/1/10/2026 (Dostawca Testowy)');
    expect(tekst()).toContain('Pominięty, tytułu i danych odbiorcy nie zapisaliśmy');
    await klik(buttons('Cofnij')[0]);
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('wgraj wyciąg jeszcze raz');
    await klik(buttons('Cofnij zapłatę')[0]);
    expect(actions.undoExpense).toHaveBeenCalledWith(OP_DONE);

    await renderuj(<BankView data={empty} invoices={[]} proposals={{}} canWrite={false} expenses={decyzje} canWriteExpenses={false} />);
    expect(tekst()).toContain('Księgowa ma tu wgląd');
    expect(buttons('Cofnij')).toHaveLength(0);
    expect(buttons('Wgraj wyciąg')).toHaveLength(0);
  });

  it('błędy: propozycji nie udało się policzyć, decyzji nie udało się wczytać; bez długich myślników', async () => {
    actions.propose.mockResolvedValue({ success: false, error: 'Nie udało się sprawdzić przelewów do dostawców z listy „Do zapłaty”, więc nie pokazujemy propozycji.' });
    await renderuj(<BankView data={empty} invoices={[]} proposals={{}} canWrite expenses={{ ok: false, error: 'Nie udało się wczytać ostatnich zapłat kosztów z wyciągu.' }} canWriteExpenses />);
    expect(tekst()).toContain('Nie udało się wczytać ostatnich zapłat kosztów z wyciągu.');

    await wgraj();

    expect(tekst()).toContain('Nie udało się sprawdzić przelewów do dostawców');
    expect(tekst()).not.toMatch(/[—–]/);
  });

  it('wgranie bez wypływów do sprawdzenia nie pyta o propozycje kosztów', async () => {
    actions.importFile.mockResolvedValue({ success: true, format: 'camt053', inserted: 1, duplicates: 0, debitsSkipped: 0, otherCurrencySkipped: 0 });
    await renderuj(<BankView data={empty} invoices={[]} proposals={{}} canWrite expenses={{ ok: true, confirmedTotal: 0, decided: [] }} canWriteExpenses />);
    await wgraj();
    expect(actions.propose).not.toHaveBeenCalled();
    expect(tekst()).toContain('Po wgraniu wyciągu pojawią się tu przelewy na rachunki dostawców');
  });
});
