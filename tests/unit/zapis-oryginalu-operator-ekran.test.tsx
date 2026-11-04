// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OPERATOR_DUPLICATE_MESSAGES, gateProblemsText } from '@/lib/admin/ksef-operator-policy';
import { duplicateDecisionOptions, type DuplicateDecisionView } from '@/lib/ksef/duplicate-decision';

import {
  DUP_K,
  DUP_NR,
  DUP_SHA,
  faktflowFacts,
  faktflowReviewGate,
  type DuplicateFactsShape,
} from './helpers/ksef-duplicate-decision-cases';

/**
 * D-A4-1b-3 PR C (spec v3 6.6, T8): karta operatora w `/admin/ksef/<id>` przy powodzie `faktflow-original`.
 *  - okno „Zapisz decyzję klienta” (oferty `pair` / `record` / `released`) wysyła do akcji to, co pokazało — tryb, ofertę
 *    i środowisko (INV-8); oferta `record` ma jeden wybór i własne „Rozumiem skutki”;
 *  - przegląd pliku (widok `review`, I5R): „Zapisz fakturę z KSeF w FaktWay” (włączony tylko przy zapisywalnym pliku)
 *    i — tylko przy `review-pair` — „Oddaj decyzję klientowi (plik nie z FaktWay)”.
 *
 * Prawdziwe: komponent, polityka widoków (`duplicateDecisionOptions`, actor operator) i przycisków przeglądu.
 * Zastąpione: akcje serwerowe, `next/navigation`, `sonner` i dialog (bez portalu).
 */

const m = vi.hoisted(() => ({
  decide: vi.fn(),
  release: vi.fn(),
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/app/admin/ksef/actions', () => ({
  operatorDecideDuplicateAction: m.decide,
  operatorReleaseOriginalReviewAction: m.release,
}));
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

const M = OPERATOR_DUPLICATE_MESSAGES;
const NOW = new Date('2026-10-09T12:00:00.000Z');
const NOTE = 'e-mail od właściciela 09.10, Jan Kowalski';

type DecidableView = Extract<DuplicateDecisionView, { kind: 'decidable' }>;
type ReviewView = Extract<DuplicateDecisionView, { kind: 'review' }>;

/** Widok z prawdziwej polityki (actor operator, KSEF_ENV test). */
function viewOf(facts: DuplicateFactsShape): DuplicateDecisionView {
  return duplicateDecisionOptions({ facts, actor: 'operator', canManage: false, environment: 'test', now: NOW });
}
function decidable(facts: DuplicateFactsShape): DecidableView {
  const view = viewOf(facts);
  if (view.kind !== 'decidable') throw new Error(`fikstura: widok ${view.kind}, oczekiwano decidable`);
  return view;
}
function review(offer: 'review-pair' | 'review-record'): ReviewView {
  const view = viewOf(faktflowFacts({
    check: { importGate: faktflowReviewGate(['rates']), ...(offer === 'review-record' ? { ownHistory: true } : {}) },
    sqlBlocker: 'provenance-review',
  }));
  if (view.kind !== 'review') throw new Error(`fikstura: widok ${view.kind}, oczekiwano review`);
  return view;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  m.decide.mockResolvedValue({ success: true, message: 'Zapisano.' });
  m.release.mockResolvedValue({ success: true, message: 'Oddano.' });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(props: Partial<React.ComponentProps<typeof OperatorDuplicateDecision>> & { view: DecidableView | ReviewView }) {
  act(() => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<OperatorDuplicateDecision invoiceId="inv-1" internalNumber={DUP_NR} {...props} />));
}

const text = () => (host?.textContent ?? '').replace(/ /g, ' ');
const buttons = (label: string) => Array.from(host?.querySelectorAll('button') ?? []).filter((b) => (b.textContent ?? '').trim() === label);

function button(label: string): HTMLButtonElement {
  const found = buttons(label);
  expect(found.length, `brak przycisku „${label}”`).toBeGreaterThan(0);
  // Pierwszy = przycisk karty, ostatni = przycisk w stopce otwartego okna.
  return found.at(-1)!;
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

/** Wpisanie tekstu w kontrolowane pole Reacta (natywny setter + zdarzenie `input`). */
async function typeNote(selector: string, value: string) {
  const area = host!.querySelector<HTMLTextAreaElement>(selector);
  expect(area, `brak pola ${selector}`).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value);
    area!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const checkbox = () => host?.querySelector<HTMLElement>('[role="checkbox"]') ?? null;

describe('PR C: „Zapisz decyzję klienta” przy faktflow-original — karta wysyła tryb, ofertę i środowisko (INV-8)', () => {
  it('oferta pair: oba wybory; akcja dostaje mode "import", offer "pair" i env serwera obok pięciu pól PR B', async () => {
    const view = decidable(faktflowFacts());
    expect(view).toMatchObject({ offer: 'pair', mode: 'import' });
    render({ view, env: 'test' });

    await click(button(M.decideButton));
    expect(text()).toContain(M.choiceSame);
    expect(text()).toContain(M.choiceOther);
    await click(button(M.choiceSame));
    await typeNote('#operator-duplicate-note', NOTE);
    // „ta sama sprzedaż” przy zaznaczonej różnicy w tabeli — potwierdzenie klienta wymagane.
    if (view.needsConfirmation.same_sale) await click(checkbox()!);
    await click(button(M.decideButton));

    expect(m.decide).toHaveBeenCalledTimes(1);
    expect(m.decide).toHaveBeenCalledWith('inv-1', {
      choice: 'same_sale',
      note: NOTE,
      originalKsefNumber: DUP_K,
      originalSha256: DUP_SHA,
      confirmed: view.needsConfirmation.same_sale,
      mode: 'import',
      offer: 'pair',
      env: 'test',
    });
    expect(m.toastSuccess).toHaveBeenCalledWith('Zapisano.');
  });

  it('oferta record (własna historia): jeden wybór „zapisać fakturę z KSeF”, bez „inna sprzedaż”; potwierdzenie confirmRecord', async () => {
    const view = decidable(faktflowFacts({ check: { ownHistory: true } }));
    expect(view).toMatchObject({ offer: 'record', choices: ['same_sale'] });
    render({ view, env: 'test' });

    await click(button(M.decideButton));
    expect(text()).toContain(M.choiceRecord);
    expect(text()).not.toContain(M.choiceOther);
    await click(button(M.choiceRecord));
    expect(text()).toContain(M.noteStoredHint);
    await typeNote('#operator-duplicate-note', NOTE);
    if (view.needsConfirmation.same_sale) {
      expect(text()).toContain(M.confirmRecord(DUP_K, DUP_NR));
      await click(checkbox()!);
    }
    await click(button(M.decideButton));

    expect(m.decide).toHaveBeenCalledWith('inv-1', expect.objectContaining({ choice: 'same_sale', mode: 'import', offer: 'record', env: 'test' }));
  });

  it('oferta released: tryb "no-import" i oferta "released" idą do akcji (decyzja bez zapisu faktury z KSeF)', async () => {
    const view = decidable(faktflowFacts({ check: { importGate: { ...faktflowReviewGate(['rates']), release: { at: '2026-10-09T08:00:00.000Z', via: 'operator', actorUserId: null, note: 'Plik sprawdzony ręcznie.' } } } }));
    expect(view).toMatchObject({ offer: 'released', mode: 'no-import' });
    render({ view, env: 'test' });

    await click(button(M.decideButton));
    await click(button(M.choiceOther));
    await typeNote('#operator-duplicate-note', NOTE);
    if (view.needsConfirmation.other_sale) await click(checkbox()!);
    await click(button(M.decideButton));

    expect(m.decide).toHaveBeenCalledWith('inv-1', expect.objectContaining({ choice: 'other_sale', mode: 'no-import', offer: 'released', env: 'test' }));
  });

  it('KSEF_ENV nieznane po stronie karty (env bez wartości) → akcja dostaje env null i odpowie STALE (fail-closed)', async () => {
    const view = decidable(faktflowFacts());
    render({ view });

    await click(button(M.decideButton));
    await click(button(M.choiceOther));
    await typeNote('#operator-duplicate-note', NOTE);
    if (view.needsConfirmation.other_sale) await click(checkbox()!);
    await click(button(M.decideButton));

    expect(m.decide.mock.calls[0]![1]).toMatchObject({ mode: 'import', offer: 'pair', env: null });
  });
});

describe('PR C: przegląd pliku (widok review, I5R) — „Zapisz fakturę z KSeF w FaktWay” i „Oddaj decyzję klientowi”', () => {
  it('reviewRecordHint (D-A4-1b-3-KORZW): mówi też o korektach (zw do C3, stawka spoza FaktWay, brak ceny netto) i odsyła do pomocy FaktWay, bez adresu w treści', () => {
    const hint = M.reviewRecordHint;
    expect(hint).toContain('Korekty faktury z pozycją zw');
    expect(hint).toContain('ze stawką spoza FaktWay');
    expect(hint).toContain('bez ceny netto');
    expect(hint).toContain('przez pomoc FaktWay');
    expect(hint).not.toMatch(/@/);
    // Zdanie o JPK zostaje (ten sam tekst co wcześniej).
    expect(hint).toContain('wstrzymają JPK za ten miesiąc');
  });

  it('review-pair, plik zapisywalny: oba przyciski włączone; zapis wysyła ofertę review-pair z trybem import i środowiskiem', async () => {
    const view = review('review-pair');
    render({ view, env: 'test', recordable: { ok: true } });

    expect(buttons(M.recordButton)[0]!.disabled).toBe(false);
    expect(buttons(M.releaseButton)[0]!.disabled).toBe(false);
    expect(text()).not.toContain(M.decideButton);

    await click(button(M.recordButton));
    expect(text()).toContain(gateProblemsText(['rates']));
    expect(text()).toContain(M.reviewRecordHint);
    expect(text()).toContain(M.choiceSameRecord);
    expect(text()).toContain(M.choiceOtherRecord);
    await click(button(M.choiceOtherRecord));
    await typeNote('#operator-duplicate-note', NOTE);
    if (view.needsConfirmation.other_sale) await click(checkbox()!);
    await click(button(M.recordButton));

    expect(m.decide).toHaveBeenCalledTimes(1);
    expect(m.decide).toHaveBeenCalledWith('inv-1', {
      choice: 'other_sale',
      note: NOTE,
      originalKsefNumber: DUP_K,
      originalSha256: DUP_SHA,
      confirmed: view.needsConfirmation.other_sale,
      mode: 'import',
      offer: 'review-pair',
      env: 'test',
    });
    expect(m.release).not.toHaveBeenCalled();
  });

  it('review-pair, pliku nie da się zapisać: zapis wyłączony z powodem notBuildable, oddanie nadal dostępne', () => {
    render({ view: review('review-pair'), env: 'test', recordable: { ok: false, detail: 'currency' } });

    const record = buttons(M.recordButton)[0]!;
    expect(record.disabled).toBe(true);
    expect(record.title).toBe(M.notBuildable('currency'));
    expect(buttons(M.releaseButton)[0]!.disabled).toBe(false);
  });

  it('review-record: tylko zapis (jeden wybór); oddanie wyłączone z reviewRecordOnly', async () => {
    const view = review('review-record');
    expect(view.choices).toEqual(['same_sale']);
    render({ view, env: 'test', recordable: { ok: true } });

    const release = buttons(M.releaseButton)[0]!;
    expect(release.disabled).toBe(true);
    expect(release.title).toBe(M.reviewRecordOnly);

    await click(button(M.recordButton));
    expect(text()).toContain(M.choiceRecord);
    expect(text()).not.toContain(M.choiceOtherRecord);
    await click(button(M.choiceRecord));
    await typeNote('#operator-duplicate-note', NOTE);
    if (view.needsConfirmation.same_sale) await click(checkbox()!);
    await click(button(M.recordButton));

    expect(m.decide).toHaveBeenCalledWith('inv-1', expect.objectContaining({ choice: 'same_sale', mode: 'import', offer: 'review-record', env: 'test' }));
  });

  it('bez wyniku suchego przebiegu zapis jest wyłączony (fail-closed)', () => {
    render({ view: review('review-pair'), env: 'test' });

    expect(buttons(M.recordButton)[0]!.disabled).toBe(true);
  });

  it('oddanie: notatka liczona w znakach — za krótka zatrzymuje akcję; poprawna idzie z K i skrótem pliku, bez wyboru i trybu', async () => {
    render({ view: review('review-pair'), env: 'test', recordable: { ok: false, detail: 'currency' } });

    await click(button(M.releaseButton));
    expect(text()).toContain(M.releaseLead);
    expect(text()).toContain(M.releaseNoteLabel);
    await typeNote('#operator-release-note', '📧📞 Jan K');
    await click(button(M.releaseButton));
    expect(m.release).not.toHaveBeenCalled();
    expect(text()).toContain(M.noteError);

    await typeNote('#operator-release-note', 'Plik z cenami brutto z innego generatora.');
    await click(button(M.releaseButton));

    expect(m.release).toHaveBeenCalledTimes(1);
    expect(m.release).toHaveBeenCalledWith('inv-1', {
      originalKsefNumber: DUP_K,
      originalSha256: DUP_SHA,
      note: 'Plik z cenami brutto z innego generatora.',
    });
    expect(m.decide).not.toHaveBeenCalled();
    expect(m.toastSuccess).toHaveBeenCalledWith('Oddano.');
    expect(m.refresh).toHaveBeenCalled();
  });

  it('odmowa akcji oddania → toast z błędem i odświeżenie karty (stan mógł się zmienić)', async () => {
    m.release.mockResolvedValue({ success: false, error: M.releaseStale });
    render({ view: review('review-pair'), env: 'test' });

    await click(button(M.releaseButton));
    await typeNote('#operator-release-note', 'Plik z cenami brutto z innego generatora.');
    await click(button(M.releaseButton));

    expect(m.toastError).toHaveBeenCalledWith(M.releaseStale);
    expect(m.refresh).toHaveBeenCalled();
    expect(m.toastSuccess).not.toHaveBeenCalled();
  });
});
