// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D-A4-1b-3 PR B (2.5, 2.11.B): panel decyzji klienta na karcie faktury —
 * tabela porównania „W KSeF / Ten dokument” ze znacznikiem „różni się”,
 * linia treści, dwa przyciski („To ta sama sprzedaż” / „To inna sprzedaż”)
 * i dialog z czterema skutkami. Przy tarciu (decyzja 7) potwierdzenie
 * wymaga zaznaczenia „Rozumiem skutki: …” (C5). Po decyzji toast
 * i `router.refresh()` — także po błędzie (stan mógł się zmienić).
 *
 * Do PR B komponentu nie było: karta pokazywała tylko dane oryginału i notę
 * „Zajmujemy się tym”.
 *
 * Prawdziwe: `KsefDuplicateDecision`, checkbox. Zastąpione: akcja
 * serwerowa, `next/navigation`, `next/link`, `sonner` i dialog (bez portalu).
 */

const m = vi.hoisted(() => ({
  decide: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/components/invoices/actions-detail', () => ({ decideKsefDuplicateAction: m.decide }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: m.refresh, push: m.push }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('sonner', () => ({ toast: { success: m.toastSuccess, error: m.toastError } }));
// Dialog bez portalu: kontrolowany (`open`) albo przez `DialogTrigger`; treść tylko, gdy otwarty.
vi.mock('@/components/ui/dialog', async () => {
  const React = await import('react');
  type Ctx = { open: boolean; setOpen: (v: boolean) => void };
  const DialogCtx = React.createContext<Ctx>({ open: false, setOpen: () => {} });
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  function Dialog({ open, onOpenChange, children }: { open?: boolean; onOpenChange?: (v: boolean) => void; children?: ReactNode }) {
    const [inner, setInner] = React.useState(false);
    const setOpen = (v: boolean) => {
      setInner(v);
      onOpenChange?.(v);
    };
    return <DialogCtx.Provider value={{ open: open ?? inner, setOpen }}>{children}</DialogCtx.Provider>;
  }
  const toggle = (target: boolean) =>
    function Toggle({ children, asChild }: { children?: ReactNode; asChild?: boolean }) {
      const ctx = React.useContext(DialogCtx);
      if (asChild && React.isValidElement(children)) {
        const child = children as React.ReactElement<{ onClick?: (e: unknown) => void }>;
        return React.cloneElement(child, {
          onClick: (e: unknown) => {
            child.props.onClick?.(e);
            ctx.setOpen(target);
          },
        });
      }
      return <button type="button" onClick={() => ctx.setOpen(target)}>{children}</button>;
    };
  function DialogContent({ children }: { children?: ReactNode }) {
    const ctx = React.useContext(DialogCtx);
    return ctx.open ? <div role="dialog">{children}</div> : null;
  }
  return {
    Dialog,
    DialogTrigger: toggle(true),
    DialogClose: toggle(false),
    DialogContent,
    DialogPortal: Pass,
    DialogOverlay: () => null,
    DialogHeader: Pass,
    DialogFooter: Pass,
    DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  };
});

import {
  CLIENT,
  K,
  PANEL,
  SHA_K,
  VIEW_NR,
  Y_ID,
  Y_NR,
  decidableView,
  knownNumberView,
  type DecidableViewFixture,
} from './helpers/decyzja-klienta';

/**
 * Widok panelu: fixture z 2.2.1 plus `markedDifference` (#2 przeglądu PR B —
 * czy któryś wiersz tabeli ma „różni się”; od niego zależy etykieta pola
 * „Rozumiem skutki” przy „ta sama sprzedaż”).
 */
type PanelView = DecidableViewFixture & { markedDifference?: boolean };
type PanelProps = { invoiceId: string; view: PanelView };

/** Etykieta pola „ta sama sprzedaż”, gdy tabela nie zaznacza różnic (NIP nieznany, B2C, waluta nieznana). */
const SAME_CHECKBOX_UNCOMPARABLE = (k: string, nr: string) =>
  `Rozumiem skutki: faktura ${k} w KSeF dokumentuje tę samą sprzedaż co dokument ${nr}, choć części danych w tabeli nie da się porównać.`;
type PanelComponent = (props: PanelProps) => ReactNode;

/**
 * Ścieżka w zmiennej: na main (f49e687) komponentu nie ma — test ma paść na
 * asercjach (brak tabeli, przycisków, dialogu), a nie na imporcie, który
 * wywróciłby cały plik. Inny błąd modułu (np. składnia) przechodzi dalej.
 */
const COMPONENT_PATH = '@/components/invoices/ksef-duplicate-decision';
async function loadPanel(): Promise<PanelComponent> {
  try {
    const mod = (await import(/* @vite-ignore */ COMPONENT_PATH)) as { KsefDuplicateDecision?: PanelComponent };
    if (mod.KsefDuplicateDecision) return mod.KsefDuplicateDecision;
  } catch (err) {
    if (!/Cannot find|Failed to (load|resolve)|does not exist/i.test(String(err))) throw err;
  }
  return () => null;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  m.decide.mockResolvedValue({ success: true, message: CLIENT.toastOther });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function renderPanel(view: PanelView): Promise<HTMLDivElement> {
  const Panel = await loadPanel();
  act(() => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // Domyślnie z tabeli, jak w polityce (`markedDifference` = któryś wiersz „różni się”) —
  // fixture bez pola nie pokaże etykiety sprzecznej z własną tabelą.
  const v = { ...view, markedDifference: view.markedDifference ?? view.comparison.some((r) => r.same === false) };
  act(() => root!.render(<Panel invoiceId="inv-1" view={v} />));
  return host;
}

const text = () => (host?.textContent ?? '').replace(/ /g, ' ');

function buttonsLabelled(label: string): HTMLButtonElement[] {
  return Array.from(host?.querySelectorAll('button') ?? []).filter((b) => (b.textContent ?? '').trim() === label);
}

function button(label: string): HTMLButtonElement {
  const found = buttonsLabelled(label);
  expect(found.length, `brak przycisku „${label}”`).toBeGreaterThan(0);
  return found.at(-1)!;
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

function checkbox(): HTMLElement | null {
  return host?.querySelector<HTMLElement>('[role="checkbox"], input[type="checkbox"]') ?? null;
}

/** Wiersz tabeli porównania z daną etykietą. */
function comparisonRow(label: string): HTMLTableRowElement | undefined {
  return Array.from(host?.querySelectorAll('tr') ?? []).find((tr) => (tr.textContent ?? '').includes(label));
}

describe('KsefDuplicateDecision — panel decyzji klienta (D-A4-1b-3 PR B)', () => {
  it('U8a: tabela „W KSeF / Ten dokument” ze znacznikiem „różni się”, linia treści, wstęp, oba przyciski i pomoc', async () => {
    await renderPanel(decidableView());

    const t = text();
    expect(t).toContain(PANEL.intro(VIEW_NR, K, 'Inny Program 1.0'));
    for (const column of PANEL.columns) expect(t).toContain(column);
    for (const label of ['Numer faktury', 'Data wystawienia', 'Nabywca', 'NIP nabywcy', 'Kwota brutto', 'Program']) {
      expect(comparisonRow(label), `wiersz „${label}”`).toBeDefined();
    }
    expect(comparisonRow('Data wystawienia')!.textContent).toContain(PANEL.differs);
    expect(comparisonRow('Data wystawienia')!.textContent).toContain('2026-10-01');
    expect(comparisonRow('Data wystawienia')!.textContent).toContain('2026-10-02');
    expect(comparisonRow('Numer faktury')!.textContent).not.toContain(PANEL.differs);
    expect(t).toContain(PANEL.noOwnFile);
    expect(buttonsLabelled(PANEL.buttonSame)).toHaveLength(1);
    expect(buttonsLabelled(PANEL.buttonOther)).toHaveLength(1);
    expect(t).toContain(PANEL.support(VIEW_NR));
    // Dialog zamknięty: skutków jeszcze nie widać.
    expect(t).not.toContain(PANEL.same.line4);
  });

  it('U8a: treść zgodna / różna (known-number) — CONTENT_SAME / CONTENT_DIFFERENT; program nieznany — „poza FaktWay”', async () => {
    await renderPanel(knownNumberView({ sameContent: true }));
    expect(text()).toContain(PANEL.contentSame);

    await renderPanel(knownNumberView({ sameContent: false }));
    expect(text()).toContain(PANEL.contentDifferent);

    await renderPanel(decidableView({ program: null }));
    expect(text()).toContain(PANEL.intro(VIEW_NR, K, null));
  });

  it('U8b: dialog „To ta sama sprzedaż?” — cztery skutki (no-own-file)', async () => {
    await renderPanel(decidableView());
    await click(button(PANEL.buttonSame));

    const t = text();
    expect(t).toContain(PANEL.same.line1(VIEW_NR, K, 'Inny Program 1.0'));
    expect(t).toContain(PANEL.same.line2(VIEW_NR));
    expect(t).toContain(PANEL.same.line3(K));
    expect(t).toContain(PANEL.same.line4);
    expect(buttonsLabelled(PANEL.same.confirm)).toHaveLength(1);
  });

  it('U8b: dialog „To inna sprzedaż?” — cztery skutki; zdanie o wstrzymanych korektach tylko przy `heldCorrections`', async () => {
    await renderPanel(decidableView());
    await click(button(PANEL.buttonOther));

    let t = text();
    expect(t).toContain(PANEL.other.line1(VIEW_NR, K));
    expect(t).toContain(PANEL.other.line2);
    expect(t).toContain(PANEL.other.line3);
    expect(t).not.toContain(PANEL.other.line3HeldClause.trim());
    expect(t).toContain(PANEL.other.line4(K, 'Inny Program 1.0'));
    expect(buttonsLabelled(PANEL.other.confirm)).toHaveLength(1);

    await renderPanel(decidableView({ heldCorrections: true, program: null }));
    await click(button(PANEL.buttonOther));
    t = text();
    expect(t).toContain(PANEL.other.line3 + PANEL.other.line3HeldClause);
    expect(t).toContain(PANEL.other.line4(K, null));
  });

  it('U8b (C16): known-number — linia o dokumencie Y z odnośnikiem, warianty skutków 1 i 3 („ta sama”) oraz 4 („inna”)', async () => {
    await renderPanel(knownNumberView());

    expect(text()).toContain(PANEL.knownNumberLine(K, Y_NR, VIEW_NR));
    const links = Array.from(host!.querySelectorAll('a')).filter((a) => a.getAttribute('href') === `/invoices/${Y_ID}`);
    expect(links).toHaveLength(1);
    expect(links[0]!.textContent).toBe(PANEL.knownLink(Y_NR));

    await click(button(PANEL.buttonSame));
    let t = text();
    expect(t).toContain(PANEL.same.line1Known(VIEW_NR, K, Y_NR));
    expect(t).toContain(PANEL.same.line2(VIEW_NR));
    expect(t).toContain(PANEL.same.line3Known(VIEW_NR, K, Y_NR));
    expect(t).not.toContain(PANEL.same.line3(K));

    await renderPanel(knownNumberView());
    await click(button(PANEL.buttonOther));
    t = text();
    expect(t).toContain(PANEL.other.line1(VIEW_NR, K));
    expect(t).toContain(PANEL.other.line4Known(K, Y_NR));
  });

  it('U8c (C5, decyzja 7): przy tarciu „Rozumiem skutki: …” jest wymagane; akcja raz, z `confirmed: true`', async () => {
    await renderPanel(decidableView());
    await click(button(PANEL.buttonOther));

    expect(text()).toContain(PANEL.other.checkbox(K, VIEW_NR));
    const box = checkbox();
    expect(box, 'brak pola „Rozumiem skutki”').not.toBeNull();

    // Bez zaznaczenia potwierdzenie nic nie wysyła.
    await click(button(PANEL.other.confirm));
    expect(m.decide).not.toHaveBeenCalled();

    await click(box!);
    await click(button(PANEL.other.confirm));
    expect(m.decide).toHaveBeenCalledTimes(1);
    expect(m.decide).toHaveBeenCalledWith({
      invoiceId: 'inv-1',
      choice: 'other_sale',
      originalKsefNumber: K,
      originalSha256: SHA_K,
      confirmed: true,
    });
  });

  it('U8c: „ta sama sprzedaż” przy różnicach (tarcie) — pole z etykietą wariantu „ta sama”', async () => {
    // Fixture ma w tabeli „różni się” przy dacie — `markedDifference` jak z polityki.
    await renderPanel({ ...decidableView({ needsConfirmation: { same_sale: true, other_sale: false } }), markedDifference: true });
    await click(button(PANEL.buttonSame));

    expect(text()).toContain(PANEL.same.checkbox(K, VIEW_NR));
    expect(text()).not.toContain(SAME_CHECKBOX_UNCOMPARABLE(K, VIEW_NR));
    await click(button(PANEL.same.confirm));
    expect(m.decide).not.toHaveBeenCalled();
  });

  it('U8c (#2): „ta sama sprzedaż” bez różnic zaznaczonych w tabeli (B2C: NIP nieznany) — etykieta „choć części danych w tabeli nie da się porównać”', async () => {
    const b2c = decidableView({
      comparison: [
        { label: 'Numer faktury', ksef: VIEW_NR, ours: VIEW_NR, same: true },
        { label: 'Data wystawienia', ksef: '2026-10-01', ours: '2026-10-01', same: true },
        { label: 'Nabywca', ksef: 'Jan Konsument', ours: 'Jan Konsument', same: true },
        { label: 'NIP nabywcy', ksef: null, ours: null, same: null },
        { label: 'Kwota brutto', ksef: '123.00 PLN', ours: '123.00 PLN', same: true },
        { label: 'Program', ksef: 'Inny Program 1.0', ours: 'FaktWay', same: null },
      ],
      needsConfirmation: { same_sale: true, other_sale: true },
    });
    await renderPanel({ ...b2c, markedDifference: false });
    expect(text()).not.toContain(PANEL.differs);
    await click(button(PANEL.buttonSame));

    expect(text()).toContain(SAME_CHECKBOX_UNCOMPARABLE(K, VIEW_NR));
    expect(text()).not.toContain('mimo różnic zaznaczonych w tabeli');
    // Pole nadal wymagane: bez zaznaczenia nic nie idzie, po zaznaczeniu — z `confirmed: true`.
    await click(button(PANEL.same.confirm));
    expect(m.decide).not.toHaveBeenCalled();
    await click(checkbox()!);
    await click(button(PANEL.same.confirm));
    expect(m.decide).toHaveBeenCalledTimes(1);
    expect(m.decide.mock.calls[0]![0]).toMatchObject({ choice: 'same_sale', confirmed: true });

    // Etykieta „inna sprzedaż” bez zmian.
    await renderPanel({ ...b2c, markedDifference: false });
    await click(button(PANEL.buttonOther));
    expect(text()).toContain(PANEL.other.checkbox(K, VIEW_NR));
  });

  it('U8c: bez tarcia — bez pola „Rozumiem skutki”, decyzja od razu', async () => {
    await renderPanel(decidableView());
    await click(button(PANEL.buttonSame));

    expect(text()).not.toContain('Rozumiem skutki');
    await click(button(PANEL.same.confirm));
    expect(m.decide).toHaveBeenCalledTimes(1);
    expect(m.decide.mock.calls[0]![0]).toMatchObject({
      invoiceId: 'inv-1',
      choice: 'same_sale',
      originalKsefNumber: K,
      originalSha256: SHA_K,
    });
  });

  it('U8d: sukces — toast z komunikatem akcji i `router.refresh()`', async () => {
    m.decide.mockResolvedValue({ success: true, message: CLIENT.toastSame(VIEW_NR) });
    await renderPanel(decidableView());
    await click(button(PANEL.buttonSame));
    await click(button(PANEL.same.confirm));

    expect(m.toastSuccess).toHaveBeenCalledWith(CLIENT.toastSame(VIEW_NR));
    expect(m.refresh).toHaveBeenCalled();
    expect(m.toastError).not.toHaveBeenCalled();
  });

  it('U8d: błąd — toast z odmową i `router.refresh()` (stan faktury mógł się zmienić)', async () => {
    m.decide.mockResolvedValue({ success: false, error: CLIENT.stale });
    await renderPanel(decidableView());
    await click(button(PANEL.buttonSame));
    await click(button(PANEL.same.confirm));

    expect(m.toastError).toHaveBeenCalledWith(CLIENT.stale);
    expect(m.refresh).toHaveBeenCalled();
    expect(m.toastSuccess).not.toHaveBeenCalled();
  });

  it('U8d: w trakcie wywołania przyciski są wyłączone (drugie kliknięcie nic nie wysyła)', async () => {
    m.decide.mockReturnValue(new Promise(() => {}));
    await renderPanel(decidableView());
    await click(button(PANEL.buttonSame));
    await click(button(PANEL.same.confirm));

    expect(m.decide).toHaveBeenCalledTimes(1);
    // Przyciski wyboru są zawsze na karcie; potwierdzenie — jeśli dialog został otwarty.
    for (const label of [PANEL.buttonSame, PANEL.buttonOther]) {
      expect(buttonsLabelled(label).length, `brak przycisku „${label}”`).toBeGreaterThan(0);
    }
    for (const label of [PANEL.same.confirm, PANEL.buttonSame, PANEL.buttonOther]) {
      for (const b of buttonsLabelled(label)) expect(b.disabled, `„${label}” w trakcie wywołania`).toBe(true);
    }
    for (const b of buttonsLabelled(PANEL.same.confirm)) await click(b);
    await click(button(PANEL.buttonSame));
    for (const b of buttonsLabelled(PANEL.same.confirm)) await click(b);
    expect(m.decide).toHaveBeenCalledTimes(1);
  });
});
