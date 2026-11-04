// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DuplicateDecisionView } from '@/lib/ksef/duplicate-decision';

/**
 * D-A4-1b-3 PR B (2.6.5, 2.11.D): „Zapisz decyzję klienta” w `/admin/ksef` —
 * dialog operatora z tabelą porównania, wyborem klienta, notatką (kanał,
 * data, osoba) i potwierdzeniem „Rozumiem skutki” klienta.
 *
 * Przegląd PR B:
 *  - #2: przy „ta sama sprzedaż” etykieta potwierdzenia mówiła o „różnicach
 *    w tabeli” także wtedy, gdy tabela żadnej nie zaznacza (NIP nieznany —
 *    B2C, waluta nieznana). Wariant wybiera `view.markedDifference`.
 *  - #3 (część komponentu): długość notatki liczona w jednostkach UTF-16,
 *    a RPC liczy znaki (`length(btrim(p_note))` w 00148) — notatka
 *    „📧📞 Jan K” (10 jednostek, 8 znaków) przechodziła w przeglądarce
 *    i padała w bazie z tekstem resetu szkicu.
 *
 * Prawdziwe: `OperatorDuplicateDecision`, checkbox, teksty operatora.
 * Zastąpione: akcja serwerowa, `next/navigation`, `sonner` i dialog (bez portalu).
 */

const m = vi.hoisted(() => ({
  decide: vi.fn(),
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/app/admin/ksef/actions', () => ({ operatorDecideDuplicateAction: m.decide }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: m.refresh, push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: m.toastSuccess, error: m.toastError } }));
// Dialog bez portalu: kontrolowany (`open`); treść tylko, gdy otwarty.
vi.mock('@/components/ui/dialog', async () => {
  const React = await import('react');
  const DialogCtx = React.createContext<boolean>(false);
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  function Dialog({ open, children }: { open?: boolean; children?: ReactNode }) {
    return <DialogCtx.Provider value={open ?? false}>{children}</DialogCtx.Provider>;
  }
  function DialogContent({ children }: { children?: ReactNode }) {
    return React.useContext(DialogCtx) ? <div role="dialog">{children}</div> : null;
  }
  return {
    Dialog,
    DialogContent,
    DialogPortal: Pass,
    DialogOverlay: () => null,
    DialogHeader: Pass,
    DialogFooter: Pass,
    DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  };
});

import { OperatorDuplicateDecision } from '@/app/admin/ksef/_components/operator-duplicate-decision';

type DecidableView = Extract<DuplicateDecisionView, { kind: 'decidable' }>;

/** Numer KSeF oryginału (fikcyjny NIP 1234567890). */
const K = '1234567890-20261001-0100A0B0C0D0-1A';
const NR = 'FV/12/10/2026';
const SHA_K = 'bb'.repeat(32);

/** Teksty 2.11.D słowo w słowo. */
const OP = {
  decide: 'Zapisz decyzję klienta',
  choiceSame: 'Klient: to ta sama sprzedaż',
  choiceOther: 'Klient: to inna sprzedaż',
  noteError: 'Notatka: co najmniej 10 znaków — kanał, data, osoba.',
  confirmSame: (k: string, nr: string) =>
    `Klient potwierdził „Rozumiem skutki”: faktura ${k} w KSeF dokumentuje tę samą sprzedaż co dokument ${nr}, mimo różnic w tabeli.`,
  confirmSameUncomparable: (k: string, nr: string) =>
    `Klient potwierdził „Rozumiem skutki”: faktura ${k} w KSeF dokumentuje tę samą sprzedaż co dokument ${nr}, choć części danych w tabeli nie da się porównać.`,
  confirmOther: (k: string, nr: string) =>
    `Klient potwierdził „Rozumiem skutki”: faktura ${k} w KSeF dokumentuje inną sprzedaż niż dokument ${nr}.`,
} as const;

/** Widok „do decyzji” jak z `duplicateDecisionOptions` (actor operator): data różna — „różni się”. */
function view(patch: Partial<DecidableView> = {}): DecidableView {
  return {
    kind: 'decidable',
    reason: 'no-own-file',
    invoiceNumber: NR,
    originalKsefNumber: K,
    originalSha256: SHA_K,
    comparison: [
      { label: 'Numer faktury', ksef: NR, ours: NR, same: true },
      { label: 'Data wystawienia', ksef: '2026-10-01', ours: '2026-10-02', same: false },
      { label: 'Nabywca', ksef: 'Nabywca testowy', ours: 'Nabywca testowy', same: true },
      { label: 'NIP nabywcy', ksef: '1234567890', ours: '9876543210', same: false },
      { label: 'Kwota brutto', ksef: '123.00 PLN', ours: '123.00 PLN', same: true },
      { label: 'Program', ksef: 'Inny Program 1.0', ours: 'FaktWay', same: null },
    ],
    sameContent: null,
    needsConfirmation: { same_sale: true, other_sale: false },
    markedDifference: true,
    program: 'Inny Program 1.0',
    knownInvoice: null,
    heldCorrections: false,
    ...patch,
  };
}

/** B2C (nabywca bez NIP): NIP nieznany po obu stronach, reszta zgodna — w tabeli nic nie jest zaznaczone. */
function b2cView(): DecidableView {
  return view({
    comparison: [
      { label: 'Numer faktury', ksef: NR, ours: NR, same: true },
      { label: 'Data wystawienia', ksef: '2026-10-01', ours: '2026-10-01', same: true },
      { label: 'Nabywca', ksef: 'Jan Konsument', ours: 'Jan Konsument', same: true },
      { label: 'NIP nabywcy', ksef: null, ours: null, same: null },
      { label: 'Kwota brutto', ksef: '123.00 PLN', ours: '123.00 PLN', same: true },
      { label: 'Program', ksef: 'Inny Program 1.0', ours: 'FaktWay', same: null },
    ],
    needsConfirmation: { same_sale: true, other_sale: true },
    markedDifference: false,
  });
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  m.decide.mockResolvedValue({ success: true, message: 'Zapisano decyzję klienta (ta sama sprzedaż). Dokument wrócił do szkicu jako wycofany.' });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(v: DecidableView) {
  act(() => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<OperatorDuplicateDecision invoiceId="inv-1" internalNumber={NR} view={v} />));
}

const text = () => (host?.textContent ?? '').replace(/ /g, ' ');

function button(label: string): HTMLButtonElement {
  const found = Array.from(host?.querySelectorAll('button') ?? []).filter((b) => (b.textContent ?? '').trim() === label);
  expect(found.length, `brak przycisku „${label}”`).toBeGreaterThan(0);
  // „Zapisz decyzję klienta” — otwiera dialog i zapisuje (stopka); ostatni = w dialogu.
  return found.at(-1)!;
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

/** Wpisanie tekstu w kontrolowane pole Reacta (natywny setter + zdarzenie `input`). */
async function typeNote(value: string) {
  const area = host!.querySelector<HTMLTextAreaElement>('#operator-duplicate-note');
  expect(area, 'brak pola notatki').not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value);
    area!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function checkbox(): HTMLElement | null {
  return host?.querySelector<HTMLElement>('[role="checkbox"]') ?? null;
}

/** Otwiera dialog i wybiera decyzję klienta. */
async function openAndChoose(label: string) {
  await click(button(OP.decide));
  await click(button(label));
}

describe('OperatorDuplicateDecision — „Zapisz decyzję klienta” (D-A4-1b-3 PR B)', () => {
  it('#2: „ta sama sprzedaż” przy różnicach zaznaczonych w tabeli — „…mimo różnic w tabeli.”', async () => {
    render(view());
    await openAndChoose(OP.choiceSame);

    expect(text()).toContain(OP.confirmSame(K, NR));
    expect(text()).not.toContain(OP.confirmSameUncomparable(K, NR));
  });

  it('#2: „ta sama sprzedaż” bez różnic zaznaczonych (B2C: NIP nieznany) — „…choć części danych w tabeli nie da się porównać.”', async () => {
    render(b2cView());
    await click(button(OP.decide));
    expect(text()).not.toContain('różni się');
    await click(button(OP.choiceSame));

    expect(text()).toContain(OP.confirmSameUncomparable(K, NR));
    expect(text()).not.toContain('mimo różnic w tabeli');
    // „Inna sprzedaż” — etykieta bez zmian.
    await click(button(OP.choiceOther));
    expect(text()).toContain(OP.confirmOther(K, NR));
  });

  it('#2: potwierdzenie nadal wymagane w wariancie „nie da się porównać” — zapis z `confirmed: true`', async () => {
    render(b2cView());
    await openAndChoose(OP.choiceSame);
    await typeNote('e-mail od właściciela 05.10, Jan Kowalski');

    expect(button(OP.decide).disabled).toBe(true);
    await click(checkbox()!);
    await click(button(OP.decide));
    expect(m.decide).toHaveBeenCalledTimes(1);
    expect(m.decide).toHaveBeenCalledWith('inv-1', {
      choice: 'same_sale',
      note: 'e-mail od właściciela 05.10, Jan Kowalski',
      originalKsefNumber: K,
      originalSha256: SHA_K,
      confirmed: true,
    });
  });

  it('#3: notatka liczona w znakach jak `length(btrim())` w RPC — „📧📞 Jan K” (10 jednostek UTF-16, 8 znaków) odrzucona bez wywołania akcji', async () => {
    const note = '📧📞 Jan K';
    expect(note.length).toBe(10);
    expect([...note].length).toBe(8);

    render(view({ needsConfirmation: { same_sale: false, other_sale: false } }));
    await openAndChoose(OP.choiceOther);
    await typeNote(`  ${note}  `);
    await click(button(OP.decide));

    expect(m.decide).not.toHaveBeenCalled();
    expect(text()).toContain(OP.noteError);
  });

  it('#3: 10 znaków z emoji (12 jednostek UTF-16) — przechodzi; notatka po przycięciu', async () => {
    const note = '📧📞 Jan Kow';
    expect([...note].length).toBe(10);

    render(view({ needsConfirmation: { same_sale: false, other_sale: false } }));
    await openAndChoose(OP.choiceOther);
    await typeNote(` ${note} `);
    await click(button(OP.decide));

    expect(text()).not.toContain(OP.noteError);
    expect(m.decide).toHaveBeenCalledTimes(1);
    expect(m.decide.mock.calls[0]![1]).toMatchObject({ choice: 'other_sale', note, confirmed: false });
  });
});
