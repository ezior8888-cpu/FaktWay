// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sekcja „Zapłaty do ZUS i urzędu skarbowego” na ekranie „Bank” (krok 3.2,
 * część 2): propozycja z „Potwierdź”, wybór rozliczenia, „Cofnij”, widok bez
 * uprawnień i ekran bez modułu. Prawdziwe: komponenty, propozycje i teksty
 * (`lib/import/bank/podatki.ts`). Atrapy: akcje serwerowe, router, toast,
 * okna bez portalu. Test dopisany po komponencie.
 */

const actions = vi.hoisted(() => ({
  importFile: vi.fn(),
  confirm: vi.fn(),
  skip: vi.fn(),
  undo: vi.fn(),
  confirmTax: vi.fn(),
  undoTax: vi.fn(),
}));
vi.mock('@/app/actions/bank-statement', () => ({
  importBankStatementAction: actions.importFile,
  confirmBankOperationAction: actions.confirm,
  skipBankOperationAction: actions.skip,
  undoBankOperationAction: actions.undo,
  confirmBankTaxPaymentAction: actions.confirmTax,
  undoBankTaxPaymentAction: actions.undoTax,
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
import {
  opisPropozycji,
  opisRozstrzygniecia,
  propozycjaZaplaty,
  type PrzelewCzekajacy,
  type PrzelewyPodatkoweEkranu,
  type RozliczenieZaplaty,
} from '@/lib/import/bank/podatki';

const OP_ZUS = '66666666-6666-4666-8666-666666666661';
const OP_US = '66666666-6666-4666-8666-666666666662';
const OP_DONE = '66666666-6666-4666-8666-666666666663';
const SP = '77777777-7777-4777-8777-777777777771';
const ZD = '77777777-7777-4777-8777-777777777772';
const RY = '77777777-7777-4777-8777-777777777773';
const RY_08 = '77777777-7777-4777-8777-777777777774';
const RACHUNEK = 'PL61109010140000071219812874';

const empty: BankOperationsData = { pending: [], pendingTotal: 0, confirmedTotal: 0, skippedTotal: 0, decided: [], accounts: [] };
const rozliczenia: RozliczenieZaplaty[] = [
  { id: SP, miesiac: '2026-09', rodzaj: 'zus_spoleczne', wersja: 1, kwotaGr: 150000, status: 'zatwierdzone', zaplaconeO: null },
  { id: ZD, miesiac: '2026-09', rodzaj: 'zdrowotna', wersja: 1, kwotaGr: 50000, status: 'zatwierdzone', zaplaconeO: null },
  { id: RY, miesiac: '2026-09', rodzaj: 'ryczalt', wersja: 1, kwotaGr: 120000, status: 'zatwierdzone', zaplaconeO: null },
  { id: RY_08, miesiac: '2026-08', rodzaj: 'ryczalt', wersja: 1, kwotaGr: 110000, status: 'zaplacone', zaplaconeO: '2026-09-18' },
];
const przelewy: PrzelewCzekajacy[] = [
  { id: OP_ZUS, rodzaj: 'zus', account: RACHUNEK, bookingDate: '2026-10-15', amountGrosze: -200000, title: 'SKLADKI', counterpartyName: 'ZUS', counterpartyAccount: null },
  { id: OP_US, rodzaj: 'us', account: RACHUNEK, bookingDate: '2026-10-16', amountGrosze: -120000, title: 'RYCZALT ZA WRZESIEN', counterpartyName: null, counterpartyAccount: null },
];

function tax(): PrzelewyPodatkoweEkranu {
  const poId = new Map(rozliczenia.map((r) => [r.id, r]));
  const done = { id: OP_DONE, rodzaj: 'us' as const, bookingDate: '2026-09-18', amountGrosze: -110000, state: 'confirmed' as const, decidedAt: '2026-09-19T08:00:00Z', settlementIds: [RY_08], markedIds: [RY_08], title: null };
  return {
    ok: true,
    pending: przelewy.map((op) => {
      const propozycja = propozycjaZaplaty(op, rozliczenia, new Map([[RY_08, OP_DONE]]));
      return { ...op, propozycja, opis: opisPropozycji(op, propozycja) };
    }),
    pendingTotal: 2,
    decided: [{ ...done, ...opisRozstrzygniecia(done, poId) }],
    bladRozliczen: false,
  };
}

let container: HTMLDivElement;
let root: Root;
const tekst = () => (container.textContent ?? '').replace(/[  ]/g, ' ');
const buttons = (label: string, scope: ParentNode = container) => [...scope.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);

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

describe('Bank: zapłaty do ZUS i urzędu skarbowego', () => {
  it('przelew do ZUS z kwotą równą składkom: „Potwierdź” zapisuje zapłatę obu rozliczeń miesiąca', async () => {
    actions.confirmTax.mockResolvedValue({ success: true, status: 'confirmed', message: 'Zapisano zapłatę ZUS za wrzesień 2026.' });
    await renderuj(<BankView data={empty} invoices={[]} proposals={{}} canWrite tax={tax()} canWriteTax />);

    expect(tekst()).toContain('Zapłaty do ZUS i urzędu skarbowego');
    expect(tekst()).toContain('Zapłata ZUS za wrzesień 2026 (składki społeczne i zdrowotna): kwota równa wyliczonym składkom.');
    expect(tekst()).toContain('oraz przelewy do ZUS i urzędu skarbowego; innych wypływów nie zapisujemy');
    // Przypisanie ma tylko ZUS; przelew do urzędu bez okresu w tytule czeka na wybór.
    expect(buttons('Potwierdź')).toHaveLength(1);
    await klik(buttons('Potwierdź')[0]);
    expect(actions.confirmTax).toHaveBeenCalledWith({ operationId: OP_ZUS, settlementIds: [SP, ZD], matchKind: 'amount' });
    expect(toast.success).toHaveBeenCalledWith('Zapisano zapłatę ZUS za wrzesień 2026.');
    expect(router.refresh).toHaveBeenCalled();
  });

  it('przelew do urzędu bez okresu: powód i wybór rozliczenia z różnicą; wybór zapisuje się jako ręczny', async () => {
    actions.confirmTax.mockResolvedValue({ success: true, status: 'confirmed', message: 'ok' });
    await renderuj(<BankView data={empty} invoices={[]} proposals={{}} canWrite tax={tax()} canWriteTax />);

    expect(tekst()).toContain('W tytule przelewu nie ma okresu w zapisie MF');
    await klik(buttons('Wybierz rozliczenie')[1]);
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Ryczałt za wrzesień 2026');
    // Rozliczenie potwierdzone już innym przelewem nie jest do wyboru.
    expect(dialog.textContent).not.toContain('sierpień 2026');
    await klik(buttons('Wybierz', dialog).find((b) => b.closest('li')?.textContent?.includes('Ryczałt za wrzesień 2026')));
    expect(actions.confirmTax).toHaveBeenCalledWith({ operationId: OP_US, settlementIds: [RY], matchKind: 'manual' });
  });

  it('„Cofnij” przy potwierdzonej zapłacie pyta o zgodę i woła cofnięcie', async () => {
    actions.undoTax.mockResolvedValue({ success: true, status: 'undone', message: 'Cofnięto potwierdzenie zapłaty z wyciągu.' });
    await renderuj(<BankView data={empty} invoices={[]} proposals={{}} canWrite tax={tax()} canWriteTax />);

    expect(tekst()).toContain('Zapłata ryczałtu za sierpień 2026: przelew');
    await klik(buttons('Cofnij')[0]);
    expect(actions.undoTax).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('wrócą do stanu „zatwierdzone”');
    await klik(buttons('Cofnij zapłatę')[0]);
    expect(actions.undoTax).toHaveBeenCalledWith(OP_DONE);
  });

  it('członek firmy widzi przelewy bez przycisków zapłat; bez modułu sekcji nie ma', async () => {
    await renderuj(<BankView data={empty} invoices={[]} proposals={{}} canWrite tax={tax()} canWriteTax={false} />);
    expect(tekst()).toContain('potwierdza właściciel albo administrator firmy');
    expect(buttons('Potwierdź')).toHaveLength(0);
    expect(buttons('Wybierz rozliczenie')).toHaveLength(0);
    expect(buttons('Cofnij')).toHaveLength(0);

    await renderuj(<BankView data={empty} invoices={[]} proposals={{}} canWrite />);
    expect(tekst()).not.toContain('Zapłaty do ZUS i urzędu skarbowego');
    expect(tekst()).toContain('Zapisujemy tylko wpływy w złotych potrzebne do dopasowania. Przy pominiętej');
  });

  it('błąd odczytu przelewów: komunikat zamiast pustej listy', async () => {
    await renderuj(<BankView data={empty} invoices={[]} proposals={{}} canWrite tax={{ ok: false, error: 'Nie udało się wczytać przelewów do ZUS i urzędu skarbowego.' }} canWriteTax />);
    expect(tekst()).toContain('Nie udało się wczytać przelewów do ZUS i urzędu skarbowego.');
    expect(buttons('Potwierdź')).toHaveLength(0);
  });
});
