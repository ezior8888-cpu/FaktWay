// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D-A4-1b-3 PR C (00149, decyzje Bartosza 08.10.2026 C1–C8; spec v3 6.1, 6.2,
 * 6.4, 6.5, 5.12): ekran klienta przy powodzie `faktflow-original`.
 *
 * 1. Panel decyzji na karcie X (`KsefDuplicateDecision`, widok `decidable`
 *    z polami PR C: `offer`, `mode`, `choices`, `original`, `correctionForPerson`):
 *      - FO-PARA (`pair`): dwa przyciski, `LEDGER`, `NOT_RECORDED`, oznaczenia
 *        faktury, pozycje z `LINES_MORE`, dialogi „ta sama” / „inna” z tekstami
 *        `FAKTFLOW.*` (`DATA_FROM_KSEF`, `BUYER_DIFFERS`, `REISSUED`, `ZERO`,
 *        `HELD_CORRECTIONS` na KSeF PROD, `CORRECTION_PERSON`, `PAST_PERIOD`);
 *      - FO-WŁASNA i FO-TA-SAMA-TREŚĆ (`record`): jeden przycisk „Zapisz fakturę
 *        z KSeF w FaktFlow”, dialog `DIALOG_RECORD` (`LINE_DIFF`, `REISSUED`);
 *      - FO-ODDANA (`released`, tryb `no-import`): panel i dialogi PR B z programem
 *        `null`, `RELEASED_NOTE`, wiersz „Program” = `PROGRAM_RELEASED`;
 *      - wysyłane do akcji: `mode`, `offer`, `env` (to, co pokazał panel — wiązanie
 *        STALE po stronie serwera, INV-8).
 *    FO-PRZEGLĄD / FO-PONOWNIE / FO-INNA-FIRMA to odmowy (`refused`) z notą —
 *    strona nie renderuje wtedy panelu (przyciski w ogóle nie istnieją), więc
 *    ich teksty sprawdza polityka (`ksef-decyzja-duplikatu.test.ts`).
 * 2. Baner szkicu wycofanego po zapisie (`RetiredDraftBanner` z widokiem z
 *    PRAWDZIWEGO `retiredDraftView` na wpisie `number_taken`): trzy warianty
 *    (`BANNER_SAME` / `BANNER_OTHER` / `BANNER_RECORD`), odnośnik do faktury K,
 *    przycisk „Wystaw nową fakturę” tylko przy „innej sprzedaży”, `CORRECTION_PERSON`
 *    przy nabywcy bez NIP i bez VAT-UE.
 * 3. Notatka na karcie faktury K (`ImportedOriginalNote`, nowy komponent
 *    `components/invoices/imported-original-note.tsx`, props `{ provenance }`):
 *    `IMPORTED_CARD` z etykietą `record` przy ofercie `record` i `review-record`.
 * 4. Pasek akcji szkicu wycofanego (5.12): „Pobierz PDF” zastąpiony odnośnikiem
 *    `RETIRED_PDF_LINK` do PDF faktury K; odmowa serwera 409 z `link` — toast
 *    z przyciskiem prowadzącym do PDF K.
 *
 * 5. Strona karty X (`app/(dashboard)/invoices/[id]/page.tsx`): przy znaczniku
 *    `faktflow-original` czyta blokadę SQL SESJĄ klienta (4.9), pokazuje podgląd
 *    pliku z `importGate.preview` (bez archiwum, bez klucza serwisowego, bez alarmów
 *    — INV-13) i dla odmów (FO-PRZEGLĄD, FO-PONOWNIE, FO-INNA-FIRMA, FO-ZNANY-TERAZ,
 *    odczyt blokady nieudany, członek firmy) przekazuje widoczną notę z tekstem
 *    odmowy zamiast panelu — bez przycisków.
 *
 * Do PR C komponentów PR C nie było: panel znał tylko `no-own-file` i `known-number`,
 * baner nie umiał wskazać faktury K, a karta K nie mówiła, skąd się wzięła.
 *
 * Prawdziwe: panel, baner, pasek akcji, polityka banera, checkbox (radix).
 * Zastąpione: akcja serwerowa, `next/navigation`, `next/link`, `sonner` i dialog (bez portalu).
 */

const m = vi.hoisted(() => ({
  decide: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  // Strona karty: klient sesji (baza w pamięci), blokada SQL sesji, ślady użycia klucza serwisowego i archiwum.
  pageClient: null as null | (() => unknown),
  sessionRpc: vi.fn(),
  adminCreated: vi.fn(),
  archiveRead: vi.fn(),
}));

vi.mock('@/components/invoices/actions-detail', () => ({
  decideKsefDuplicateAction: m.decide,
  downloadInvoiceXmlAction: vi.fn(),
  resendInvoiceAction: vi.fn(),
  resetInvoiceToDraftAction: vi.fn(),
  emailInvoiceAction: vi.fn(),
}));
vi.mock('@/components/invoices/draft-actions', () => ({ sendDraftInvoiceAction: vi.fn(), deleteDraftInvoiceAction: vi.fn() }));
vi.mock('@/components/invoices/email-invoice-button', () => ({ EmailInvoiceButton: () => <span data-testid="przycisk-maila">Wyślij mailem</span> }));
vi.mock('@/components/invoices/failed-invoice-actions', () => ({ FailedInvoiceActions: () => null }));
vi.mock('@/lib/download', () => ({ saveBlob: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: m.refresh, push: m.push }),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => m.pageClient!() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    m.adminCreated();
    throw new Error('strona klienta nie używa klucza serwisowego');
  },
}));
vi.mock('@/lib/storage/r2', () => ({ downloadFromR2: m.archiveRead, downloadInvoiceXml: vi.fn() }));
vi.mock('@/components/invoices/invoice-detail-view', () => ({ InvoiceDetailView: () => null }));
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
  function DialogContent({ children }: { children?: ReactNode }) {
    const ctx = React.useContext(DialogCtx);
    return ctx.open ? <div role="dialog">{children}</div> : null;
  }
  return {
    Dialog,
    DialogTrigger: Pass,
    DialogClose: Pass,
    DialogContent,
    DialogPortal: Pass,
    DialogOverlay: () => null,
    DialogHeader: Pass,
    DialogFooter: Pass,
    DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  };
});

import InvoiceDetailPage from '@/app/(dashboard)/invoices/[id]/page';
import { InvoiceActions } from '@/components/invoices/invoice-actions';
import { RetiredDraftBanner } from '@/components/invoices/retired-draft-banner';
import type { KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';
import type { OriginalPreview } from '@/lib/ksef/duplicate-check';
import {
  DUPLICATE_DECISION_SQL_TEXTS,
  DUPLICATE_DECISION_TEXTS,
  fillSqlText,
  retiredDraftView,
  type DuplicateDecisionView,
  type ImportedOriginalProvenance,
} from '@/lib/ksef/duplicate-decision';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';

import { DECIDED_AT, K, SHA_K, duplicateCheck, markerRow, numberTakenRow } from './helpers/decyzja-klienta';
import { memoryDb, type Row } from './helpers/ponowienie-specjalne-baza';

const T = DUPLICATE_DECISION_TEXTS;
const F = DUPLICATE_DECISION_TEXTS.FAKTFLOW;

const NR = 'FV/12/10/2026';
const X_ID = '22222222-2222-4222-8222-222222222221';
const K_ID = '33333333-3333-4333-8333-333333333331';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** Okres z podglądu pliku (P_1 = 2026-10-01). */
const PERIOD = '10.2026';
const ASSIGNED_DAY = '2026-09-30';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Ładowanie komponentów, które mogą nie istnieć ──────────────────────────

type DecidableView = Extract<DuplicateDecisionView, { kind: 'decidable' }>;
/** Panel PR C: `env` = środowisko KSeF serwera pokazane klientowi (wiązanie w akcji, INV-8). */
type PanelProps = { invoiceId: string; view: DecidableView; env: 'test' | 'production' | 'demo' | null };
type PanelComponent = (props: PanelProps) => ReactNode;
type NoteComponent = (props: { provenance: ImportedOriginalProvenance }) => ReactNode;

/**
 * Panel istnieje (PR B), ale jego props PR C (`env`) nie — ładujemy go przez
 * ścieżkę w zmiennej, żeby test kompilował się przed zmianą typu. Nowy komponent
 * karty K ładujemy tak samo: brak modułu = pusty komponent, test pada na
 * asercjach (brak noty), a nie na imporcie, który wywróciłby cały plik.
 */
const PANEL_PATH = '@/components/invoices/ksef-duplicate-decision';
const NOTE_PATH = '@/components/invoices/imported-original-note';

async function load<C>(path: string, name: string): Promise<C> {
  try {
    const mod = (await import(/* @vite-ignore */ path)) as Record<string, unknown>;
    if (typeof mod[name] === 'function') return mod[name] as C;
  } catch (err) {
    if (!/Cannot find|Failed to (load|resolve)|does not exist/i.test(String(err))) throw err;
  }
  return (() => null) as C;
}

// ─── Render ─────────────────────────────────────────────────────────────────

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  m.decide.mockResolvedValue({ success: true, message: F.TOAST_SAME(NR) });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
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

async function renderPanel(view: DecidableView, env: PanelProps['env'] = 'test'): Promise<void> {
  const Panel = await load<PanelComponent>(PANEL_PATH, 'KsefDuplicateDecision');
  mount(<Panel invoiceId="inv-1" view={view} env={env} />);
}

const text = (): string => (host?.textContent ?? '').replace(/ /g, ' ');
/** Tekst wyłącznie otwartego dialogu (`role="dialog"`); pusty, gdy dialog jest zamknięty. */
const dialogText = (): string => host?.querySelector('[role="dialog"]')?.textContent ?? '';
/** Tekst panelu bez dialogu (wstęp, tabela, przyciski) — do zdań, które stoją i w panelu, i w dialogu. */
const outsideDialogText = (): string => {
  const clone = host?.cloneNode(true) as HTMLElement | undefined;
  clone?.querySelectorAll('[role="dialog"]').forEach((dlg) => dlg.remove());
  return clone?.textContent ?? '';
};

function buttonsLabelled(label: string): HTMLButtonElement[] {
  return Array.from(host?.querySelectorAll('button') ?? []).filter((b) => (b.textContent ?? '').trim() === label);
}

function button(label: string): HTMLButtonElement {
  const found = buttonsLabelled(label);
  expect(found.length, `brak przycisku „${label}”`).toBeGreaterThan(0);
  return found.at(-1)!;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

function checkbox(): HTMLElement | null {
  return host?.querySelector<HTMLElement>('[role="checkbox"], input[type="checkbox"]') ?? null;
}

function comparisonRow(label: string): HTMLTableRowElement | undefined {
  return Array.from(host?.querySelectorAll('tr') ?? []).find((tr) => (tr.textContent ?? '').includes(label));
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

// ─── Widoki panelu (kształt `DuplicateDecisionView` z PR C) ─────────────────

const PREVIEW: OriginalPreview = {
  issueDate: '2026-10-01',
  saleDate: '2026-10-01',
  period: PERIOD,
  buyerIdKind: 'nip',
  annotations: [],
  exemptionBasis: null,
  lineCount: 1,
  lines: [{ ordinal: 1, name: 'Usługa programistyczna', quantity: '1.0000', unit: 'usł.', unitPriceNet: '100.0000', vatRate: '23', gross: '123.00' }],
  totals: { net: '100.00', vat: '23.00', gross: '123.00' },
};

const ROWS = (patch: { nip?: boolean | null; date?: boolean | null } = {}): DecidableView['comparison'] => [
  { label: T.ROW_LABELS.number, ksef: NR, ours: NR, same: true },
  { label: T.ROW_LABELS.issueDate, ksef: '2026-10-01', ours: '2026-10-02', same: patch.date ?? false },
  { label: F.ROW_SALE_DATE, ksef: '2026-10-01', ours: F.SALE_DATE_AS_ISSUE, same: null },
  { label: T.ROW_LABELS.buyer, ksef: 'Nabywca testowy', ours: 'Nabywca testowy', same: true },
  { label: T.ROW_LABELS.buyerNip, ksef: '5252241585', ours: '5252241585', same: patch.nip ?? true },
  { label: T.ROW_LABELS.gross, ksef: '123.00 PLN', ours: '123.00 PLN', same: true },
  { label: T.ROW_LABELS.program, ksef: 'FaktWay', ours: 'FaktWay', same: null },
];

/** FO-PARA: oferta `pair`, tryb `import`, oba wybory. */
function pairView(patch: Partial<DecidableView> = {}): DecidableView {
  return {
    kind: 'decidable',
    reason: 'faktflow-original',
    invoiceNumber: NR,
    originalKsefNumber: K,
    originalSha256: SHA_K,
    comparison: ROWS(),
    markedDifference: true,
    sameContent: false,
    needsConfirmation: { same_sale: false, other_sale: true },
    program: 'FaktWay',
    knownInvoice: null,
    heldCorrections: false,
    offer: 'pair',
    mode: 'import',
    choices: ['same_sale', 'other_sale'],
    original: { preview: PREVIEW, assignedDay: ASSIGNED_DAY, pastPeriod: false },
    correctionForPerson: false,
    ...patch,
  };
}

/** FO-WŁASNA: oferta `record` (własna historia / `ownHistory`), jeden wybór, treść inna niż plik oryginału. */
const ownView = (patch: Partial<DecidableView> = {}): DecidableView =>
  pairView({
    offer: 'record',
    choices: ['same_sale'],
    needsConfirmation: { same_sale: true, other_sale: false },
    recordIntro: 'own',
    ...patch,
  });

/** FO-TA-SAMA-TREŚĆ: oferta `record`, `sameContentExceptHeader=true` bez własnej historii — bez „Rozumiem skutki”. */
const sameContentView = (patch: Partial<DecidableView> = {}): DecidableView =>
  ownView({ sameContent: true, recordIntro: 'same', needsConfirmation: { same_sale: false, other_sale: false }, ...patch });

/** FO-ODDANA: operator oddał decyzję klientowi — tryb `no-import`, program „nieznany” (`null`). */
const releasedView = (patch: Partial<DecidableView> = {}): DecidableView =>
  pairView({
    offer: 'released',
    mode: 'no-import',
    program: null,
    comparison: ROWS().map((row) => (row.label === T.ROW_LABELS.program ? { ...row, ksef: F.PROGRAM_RELEASED } : row)),
    ...patch,
  });

describe('KsefDuplicateDecision — FO-PARA, oferta pair (D-A4-1b-3 PR C)', () => {
  it('ZE1: wstęp INTRO_PAIR, NOT_RECORDED, LEDGER z okresem, tabela z wierszem „Data sprzedaży”, linia treści, SUPPORT i dwa przyciski', async () => {
    await renderPanel(pairView());

    const t = text();
    expect(t).toContain(F.INTRO_PAIR(NR, K));
    expect(t).toContain(F.NOT_RECORDED);
    expect(t).toContain(F.LEDGER(K, PERIOD));
    expect(comparisonRow(F.ROW_SALE_DATE)?.textContent).toContain(F.SALE_DATE_AS_ISSUE);
    expect(t).toContain(T.CONTENT_DIFFERENT);
    expect(t).toContain(T.SUPPORT(NR));
    expect(buttonsLabelled(T.BUTTON_SAME)).toHaveLength(1);
    expect(buttonsLabelled(T.BUTTON_OTHER)).toHaveLength(1);
    expect(buttonsLabelled(F.BUTTON_RECORD)).toHaveLength(0);
    // Wstęp PR B (program w bierniku) zastąpiony wstępem pary.
    expect(t).not.toContain(T.INTRO(NR, K, 'FaktWay'));
    // Dialog zamknięty: skutków jeszcze nie widać.
    expect(t).not.toContain(F.DIALOG_SAME.LINE_2(NR));
  });

  it.each([
    ['treść pozycji inna niż plik oryginału (sameContent=false)', false, T.CONTENT_DIFFERENT, T.NO_OWN_FILE],
    ['FaktWay nie ma pliku tej próby (sameContent=null)', null, T.NO_OWN_FILE, T.CONTENT_DIFFERENT],
  ])('ZE1: %s — linia treści pod tabelą obok wstępu pary', async (_label, sameContent, shown, hidden) => {
    await renderPanel(pairView({ sameContent }));

    expect(text()).toContain(F.INTRO_PAIR(NR, K));
    expect(text()).toContain(shown);
    expect(text()).not.toContain(hidden);
  });

  it('ZE2: pozycje pliku z KSeF — rozwijana lista LINES_TOGGLE(n) z kolumnami i wartościami pierwszej pozycji; bez LINES_MORE przy komplecie', async () => {
    await renderPanel(pairView());

    const t = text();
    expect(t).toContain(F.LINES_TOGGLE(1));
    // Lista może być `<details>` (treść w DOM) albo przełącznikiem — rozwijamy, gdy trzeba.
    if (!t.includes(PREVIEW.lines[0]!.name)) {
      const toggle = Array.from(host!.querySelectorAll('summary, button')).find((el) => (el.textContent ?? '').includes(F.LINES_TOGGLE(1)));
      expect(toggle, 'brak przełącznika listy pozycji').toBeDefined();
      await click(toggle!);
    }
    const expanded = text();
    for (const column of Object.values(F.LINES_COLUMNS)) expect(expanded).toContain(column);
    expect(expanded).toContain('Usługa programistyczna');
    expect(expanded).toContain('123.00');
    expect(expanded).not.toMatch(/…i jeszcze \d+/);
  });

  it('ZE2: więcej pozycji niż pokazuje podgląd (25, w podglądzie 20) — LINES_MORE(5) odsyła do pliku w KSeF', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({ ...PREVIEW.lines[0]!, ordinal: i + 1, name: `Pozycja ${i + 1}` }));
    await renderPanel(pairView({ original: { preview: { ...PREVIEW, lineCount: 25, lines }, assignedDay: ASSIGNED_DAY, pastPeriod: false } }));

    const t = text();
    expect(t).toContain(F.LINES_TOGGLE(25));
    expect(t).toContain(F.LINES_MORE(5));
    expect(t).not.toContain('Pozycja 21');
  });

  it('ZE3: oznaczenia faktury w KSeF (metoda kasowa, MPP, odwrotne obciążenie, zwolnienie z podstawą) — ANNOTATIONS z etykietami; bez oznaczeń linii nie ma', async () => {
    const annotations: OriginalPreview['annotations'] = ['cashMethod', 'splitPayment', 'reverseCharge', 'exemption'];
    await renderPanel(pairView({
      original: { preview: { ...PREVIEW, annotations, exemptionBasis: 'art. 43 ust. 1 pkt 37' }, assignedDay: ASSIGNED_DAY, pastPeriod: false },
    }));

    const labels = [
      F.ANNOTATION_LABELS.cashMethod,
      F.ANNOTATION_LABELS.splitPayment,
      F.ANNOTATION_LABELS.reverseCharge,
      F.ANNOTATION_LABELS.exemption('art. 43 ust. 1 pkt 37'),
    ];
    expect(text()).toContain(F.ANNOTATIONS(labels.join(', ')));

    await renderPanel(pairView());
    expect(text()).not.toContain(F.ANNOTATIONS('').replace(/\.$/, ''));
  });

  it('ZE4: dialog „ta sama sprzedaż” — LINE_1 z okresem, LINE_2, DATA_FROM_KSEF (różnice w tabeli), REISSUED, PR B LINE_4; bez PAST_PERIOD, HELD i CORRECTION_PERSON', async () => {
    await renderPanel(pairView());
    await click(button(T.BUTTON_SAME));

    const t = text();
    expect(t).toContain(T.DIALOG_SAME.TITLE);
    expect(t).toContain(F.DIALOG_SAME.LINE_1(NR, K, PERIOD));
    expect(t).toContain(F.DIALOG_SAME.LINE_2(NR));
    expect(t).toContain(F.DATA_FROM_KSEF(NR));
    expect(t).toContain(F.REISSUED);
    expect(t).toContain(T.DIALOG_SAME.LINE_4);
    expect(t).not.toContain(F.BUYER_DIFFERS(NR));
    expect(t).not.toContain(F.PAST_PERIOD(PERIOD));
    expect(t).not.toContain(F.HELD_CORRECTIONS.trim());
    expect(t).not.toContain(F.CORRECTION_PERSON.trim());
    expect(buttonsLabelled(T.DIALOG_SAME.CONFIRM_BUTTON)).toHaveLength(1);
    // Bez tarcia (NIP i kwota zgodne): pola „Rozumiem skutki” nie ma, decyzja od razu.
    expect(checkbox()).toBeNull();
  });

  it('ZE4: dialog „ta sama” bez różnic w tabeli i przy sameContent=true — bez DATA_FROM_KSEF', async () => {
    await renderPanel(pairView({ markedDifference: false, sameContent: true, comparison: ROWS({ date: true }) }));
    await click(button(T.BUTTON_SAME));

    expect(text()).not.toContain(F.DATA_FROM_KSEF(NR));
    expect(text()).toContain(F.REISSUED);
  });

  it('ZE4 (C7): dialog „ta sama” na KSeF PROD (heldCorrections) — HELD_CORRECTIONS za DATA_FROM_KSEF, BUYER_DIFFERS (NIP różny) i REISSUED', async () => {
    await renderPanel(pairView({
      heldCorrections: true,
      comparison: ROWS({ nip: false }),
      needsConfirmation: { same_sale: true, other_sale: false },
    }));
    await click(button(T.BUTTON_SAME));

    const t = text();
    expect(t).toContain(F.DATA_FROM_KSEF(NR) + F.HELD_CORRECTIONS);
    expect(t).toContain(F.BUYER_DIFFERS(NR) + F.HELD_CORRECTIONS);
    expect(t).toContain(F.REISSUED + F.HELD_CORRECTIONS);
  });

  it('ZE4: dialog „ta sama” bez heldCorrections — BUYER_DIFFERS przy innym NIP, ale bez HELD_CORRECTIONS', async () => {
    await renderPanel(pairView({ comparison: ROWS({ nip: false }), needsConfirmation: { same_sale: true, other_sale: false } }));
    await click(button(T.BUTTON_SAME));

    expect(text()).toContain(F.BUYER_DIFFERS(NR));
    expect(text()).not.toContain(F.HELD_CORRECTIONS.trim());
  });

  it('ZE5: dialog „inna sprzedaż” — LINE_1 z okresem, LINE_2, ALREADY_REISSUED, ZERO, PR B LINE_3; pole „Rozumiem skutki” i przycisk z PR B', async () => {
    await renderPanel(pairView());
    await click(button(T.BUTTON_OTHER));

    const t = text();
    expect(t).toContain(T.DIALOG_OTHER.TITLE);
    expect(t).toContain(F.DIALOG_OTHER.LINE_1(NR, K, PERIOD));
    expect(t).toContain(F.DIALOG_OTHER.LINE_2(NR));
    expect(t).toContain(F.DIALOG_OTHER.ALREADY_REISSUED);
    expect(t).toContain(F.DIALOG_OTHER.ZERO(NR));
    expect(t).toContain(T.DIALOG_OTHER.LINE_3);
    expect(t).not.toContain(F.HELD_CORRECTIONS.trim());
    expect(t).not.toContain(T.DIALOG_OTHER.LINE_3_HELD.trim());
    expect(t).toContain(T.DIALOG_OTHER.CHECKBOX(K, NR));
    expect(buttonsLabelled(T.DIALOG_OTHER.CONFIRM_BUTTON)).toHaveLength(1);
  });

  it('ZE5 (C7): dialog „inna sprzedaż” na KSeF PROD — HELD_CORRECTIONS za ZERO i LINE_3_HELD za LINE_3', async () => {
    await renderPanel(pairView({ heldCorrections: true }));
    await click(button(T.BUTTON_OTHER));

    const t = text();
    expect(t).toContain(F.DIALOG_OTHER.ZERO(NR) + F.HELD_CORRECTIONS);
    expect(t).toContain(T.DIALOG_OTHER.LINE_3 + T.DIALOG_OTHER.LINE_3_HELD);
  });

  it.each([
    ['ta sama sprzedaż', 'same_sale' as const],
    ['inna sprzedaż', 'other_sale' as const],
  ])('ZE6 (F44): nabywca bez NIP i bez VAT-UE (PESEL) — CORRECTION_PERSON w dialogu „%s” dokładnie raz; przy nabywcy z NIP nie ma', async (_label, choice) => {
    const open = async (view: DecidableView) => {
      await renderPanel(view);
      await click(button(choice === 'same_sale' ? T.BUTTON_SAME : T.BUTTON_OTHER));
    };

    await open(pairView({
      correctionForPerson: true,
      original: { preview: { ...PREVIEW, buyerIdKind: 'pesel' }, assignedDay: ASSIGNED_DAY, pastPeriod: false },
    }));
    // B1: liczymy w samym dialogu — zdanie może stać i w panelu (FO-WŁASNA), ale w dialogu jest raz.
    expect(occurrences(dialogText(), F.CORRECTION_PERSON.trim())).toBe(1);

    await open(pairView());
    expect(dialogText()).not.toContain(F.CORRECTION_PERSON.trim());
    expect(text()).not.toContain(F.CORRECTION_PERSON.trim());
  });

  it.each([
    ['ta sama sprzedaż', 'same_sale' as const],
    ['inna sprzedaż', 'other_sale' as const],
  ])('ZE6 (KORZW): K z pozycją zw albo stawką spoza FaktWay — CORRECTION_RATE w dialogu „%s” dokładnie raz, nie ma w panelu; przy K bez takiej pozycji nie ma', async (_label, choice) => {
    const open = async (view: DecidableView) => {
      await renderPanel(view);
      await click(button(choice === 'same_sale' ? T.BUTTON_SAME : T.BUTTON_OTHER));
    };

    await open(pairView({ correctionForRate: true }));
    expect(occurrences(dialogText(), F.CORRECTION_RATE(NR).trim())).toBe(1);
    expect(occurrences(outsideDialogText(), F.CORRECTION_RATE(NR).trim())).toBe(0);
    expect(dialogText()).not.toContain(F.CORRECTION_PERSON.trim());

    await open(pairView());
    expect(text()).not.toContain(F.CORRECTION_RATE(NR).trim());
  });

  it('ZE6 (KORZW): nabywca bez NIP i pozycja zw — w dialogu oba zdania po jednym razie', async () => {
    await renderPanel(pairView({
      correctionForPerson: true,
      correctionForRate: true,
      original: { preview: { ...PREVIEW, buyerIdKind: 'pesel' }, assignedDay: ASSIGNED_DAY, pastPeriod: false },
    }));
    await click(button(T.BUTTON_SAME));

    expect(occurrences(dialogText(), F.CORRECTION_PERSON.trim())).toBe(1);
    expect(occurrences(dialogText(), F.CORRECTION_RATE(NR).trim())).toBe(1);
  });

  it('ZG3 (KORZW): dialog „zapisz” (record) z pozycją zw — CORRECTION_RATE raz w dialogu i raz w panelu, za REISSUED i HELD_CORRECTIONS', async () => {
    await renderPanel(ownView({ heldCorrections: true, correctionForRate: true }));
    await click(button(F.BUTTON_RECORD));

    const dlg = dialogText();
    expect(dlg).toContain(F.REISSUED + F.HELD_CORRECTIONS + F.CORRECTION_RATE(NR));
    expect(occurrences(dlg, F.CORRECTION_RATE(NR).trim())).toBe(1);
    expect(occurrences(outsideDialogText(), F.CORRECTION_RATE(NR).trim())).toBe(1);
  });

  it.each([
    ['ta sama sprzedaż', T.BUTTON_SAME],
    ['inna sprzedaż', T.BUTTON_OTHER],
  ])('ZE7: okres już minął (pastPeriod) — dialog „%s” ma PAST_PERIOD z okresem JPK; bez pastPeriod go nie ma', async (_label, trigger) => {
    await renderPanel(pairView({ original: { preview: PREVIEW, assignedDay: ASSIGNED_DAY, pastPeriod: true } }));
    await click(button(trigger));
    expect(text()).toContain(F.PAST_PERIOD(PERIOD));

    await renderPanel(pairView());
    await click(button(trigger));
    expect(text()).not.toContain(F.PAST_PERIOD(PERIOD));
  });

  it('ZE8 (INV-8): akcja dostaje to, co pokazał panel — tryb, ofertę i środowisko serwera obok numeru KSeF i SHA-256', async () => {
    await renderPanel(pairView(), 'test');
    await click(button(T.BUTTON_SAME));
    await click(button(T.DIALOG_SAME.CONFIRM_BUTTON));

    expect(m.decide).toHaveBeenCalledTimes(1);
    expect(m.decide).toHaveBeenCalledWith({
      invoiceId: 'inv-1',
      choice: 'same_sale',
      originalKsefNumber: K,
      originalSha256: SHA_K,
      confirmed: false,
      mode: 'import',
      offer: 'pair',
      env: 'test',
    });
    expect(m.toastSuccess).toHaveBeenCalledWith(F.TOAST_SAME(NR));
    expect(m.refresh).toHaveBeenCalled();
  });

  it('ZE8: „inna sprzedaż” z „Rozumiem skutki” na KSeF PROD — confirmed=true, env=production', async () => {
    m.decide.mockResolvedValue({ success: true, message: F.TOAST_OTHER(NR) });
    await renderPanel(pairView({ heldCorrections: true }), 'production');
    await click(button(T.BUTTON_OTHER));

    // Bez zaznaczenia potwierdzenie nic nie wysyła.
    await click(button(T.DIALOG_OTHER.CONFIRM_BUTTON));
    expect(m.decide).not.toHaveBeenCalled();

    await click(checkbox()!);
    await click(button(T.DIALOG_OTHER.CONFIRM_BUTTON));

    expect(m.decide).toHaveBeenCalledWith(expect.objectContaining({
      choice: 'other_sale', confirmed: true, mode: 'import', offer: 'pair', env: 'production',
    }));
    expect(m.toastSuccess).toHaveBeenCalledWith(F.TOAST_OTHER(NR));
  });

  it('ZE8: odmowa serwera (STALE / RECHECK) — toast z tekstem i router.refresh() (stan faktury mógł się zmienić)', async () => {
    m.decide.mockResolvedValue({ success: false, error: F.RECHECK(NR) });
    await renderPanel(pairView());
    await click(button(T.BUTTON_SAME));
    await click(button(T.DIALOG_SAME.CONFIRM_BUTTON));

    expect(m.decide).toHaveBeenCalledWith(expect.objectContaining({ mode: 'import', offer: 'pair', env: 'test' }));
    expect(m.toastError).toHaveBeenCalledWith(F.RECHECK(NR));
    expect(m.toastSuccess).not.toHaveBeenCalled();
    expect(m.refresh).toHaveBeenCalled();
  });
});

describe('KsefDuplicateDecision — FO-WŁASNA i FO-TA-SAMA-TREŚĆ, oferta record', () => {
  it('ZG1 (FO-WŁASNA): wstęp INTRO_RECORD_OWN z dniem nadania numeru, LEDGER, jeden przycisk „Zapisz fakturę z KSeF w FaktWay”, bez przycisków pary i bez NOT_RECORDED', async () => {
    await renderPanel(ownView());

    const t = text();
    expect(t).toContain(F.INTRO_RECORD_OWN(NR, K, ASSIGNED_DAY, NR));
    expect(t).toContain(F.LEDGER(K, PERIOD));
    expect(t).toContain(T.SUPPORT(NR));
    expect(buttonsLabelled(F.BUTTON_RECORD)).toHaveLength(1);
    expect(buttonsLabelled(T.BUTTON_SAME)).toHaveLength(0);
    expect(buttonsLabelled(T.BUTTON_OTHER)).toHaveLength(0);
    expect(t).not.toContain(F.NOT_RECORDED);
    expect(t).not.toContain(F.INTRO_PAIR(NR, K));
  });

  it('ZG1: nieznany dzień nadania numeru (assignedDay=null) — wstęp bez „numer nadany …”', async () => {
    await renderPanel(ownView({ original: { preview: PREVIEW, assignedDay: null, pastPeriod: false } }));

    expect(text()).toContain(F.INTRO_RECORD_OWN(NR, K, null, NR));
  });

  it('ZG1 (F44): FO-WŁASNA, nabywca bez NIP i bez VAT-UE — CORRECTION_PERSON doklejone raz, zaraz po INTRO_RECORD_OWN', async () => {
    await renderPanel(ownView({
      correctionForPerson: true,
      original: { preview: { ...PREVIEW, buyerIdKind: 'pesel' }, assignedDay: ASSIGNED_DAY, pastPeriod: false },
    }));

    const t = text();
    expect(t).toContain(F.INTRO_RECORD_OWN(NR, K, ASSIGNED_DAY, NR) + F.CORRECTION_PERSON);
    expect(occurrences(t, F.CORRECTION_PERSON.trim())).toBe(1);
  });

  it('ZG1 (KORZW): FO-WŁASNA, K z pozycją zw albo stawką spoza FaktWay — CORRECTION_RATE doklejone raz, zaraz po INTRO_RECORD_OWN; bez CORRECTION_PERSON', async () => {
    await renderPanel(ownView({ correctionForRate: true }));

    const t = text();
    expect(t).toContain(F.INTRO_RECORD_OWN(NR, K, ASSIGNED_DAY, NR) + F.CORRECTION_RATE(NR));
    expect(occurrences(t, F.CORRECTION_RATE(NR).trim())).toBe(1);
    expect(t).not.toContain(F.CORRECTION_PERSON.trim());
  });

  it('ZG1 (KORZW): nabywca bez NIP i pozycja zw — oba zdania po jednym razie, osoba przed stawką', async () => {
    await renderPanel(ownView({
      correctionForPerson: true,
      correctionForRate: true,
      original: { preview: { ...PREVIEW, buyerIdKind: 'pesel' }, assignedDay: ASSIGNED_DAY, pastPeriod: false },
    }));

    const t = text();
    expect(t).toContain(F.INTRO_RECORD_OWN(NR, K, ASSIGNED_DAY, NR) + F.CORRECTION_PERSON + F.CORRECTION_RATE(NR));
    expect(occurrences(t, F.CORRECTION_PERSON.trim())).toBe(1);
    expect(occurrences(t, F.CORRECTION_RATE(NR).trim())).toBe(1);
  });

  // Wstęp wybiera pole widoku `recordIntro` (I1, kontrakt commitu 2): 'own' ma pierwszeństwo przed 'same' (spec 5.5),
  // bo sam `sameContent` nie odróżnia „własna historia + ta sama treść” od „sama ta sama treść”.
  it('ZG2 (FO-TA-SAMA-TREŚĆ): wstęp INTRO_RECORD_SAME (ta sama treść, bez własnej historii), LEDGER, jeden przycisk, bez wstępu OWN', async () => {
    await renderPanel(sameContentView());

    const t = text();
    expect(t).toContain(F.INTRO_RECORD_SAME(NR, K, ASSIGNED_DAY));
    expect(t).toContain(F.LEDGER(K, PERIOD));
    expect(buttonsLabelled(F.BUTTON_RECORD)).toHaveLength(1);
    expect(buttonsLabelled(T.BUTTON_SAME)).toHaveLength(0);
    expect(t).not.toContain(F.INTRO_RECORD_OWN(NR, K, ASSIGNED_DAY, NR));
  });

  it('ZG2 (I1): własna historia ORAZ ta sama treść (sameContent=true, recordIntro "own") — INTRO_RECORD_OWN, nie INTRO_RECORD_SAME', async () => {
    await renderPanel(sameContentView({ recordIntro: 'own' }));

    const t = text();
    expect(t).toContain(F.INTRO_RECORD_OWN(NR, K, ASSIGNED_DAY, NR));
    expect(t).not.toContain(F.INTRO_RECORD_SAME(NR, K, ASSIGNED_DAY));
    expect(buttonsLabelled(F.BUTTON_RECORD)).toHaveLength(1);
  });

  it('ZG3: dialog „zapisz” przy treści innej niż plik (FO-WŁASNA) — tytuł z numerem faktury, LINE_1/LINE_2, LINE_DIFF, REISSUED, pole „Rozumiem skutki: obowiązują dane faktury …”', async () => {
    await renderPanel(ownView());
    await click(button(F.BUTTON_RECORD));

    const t = text();
    expect(t).toContain(F.DIALOG_RECORD.TITLE(NR));
    expect(t).toContain(F.DIALOG_RECORD.LINE_1(NR, PERIOD));
    expect(t).toContain(F.DIALOG_RECORD.LINE_2(NR));
    expect(t).toContain(F.DIALOG_RECORD.LINE_DIFF(NR));
    expect(t).toContain(F.REISSUED);
    expect(t).toContain(F.DIALOG_RECORD.CHECKBOX(K, NR));
    expect(buttonsLabelled(F.DIALOG_RECORD.CONFIRM_BUTTON)).toHaveLength(1);
    expect(t).not.toContain(F.PAST_PERIOD(PERIOD));
  });

  it('ZG3: dialog „zapisz” przy tej samej treści (FO-TA-SAMA-TREŚĆ) — bez LINE_DIFF i bez pola „Rozumiem skutki”; decyzja od razu', async () => {
    await renderPanel(sameContentView());
    await click(button(F.BUTTON_RECORD));

    const t = text();
    expect(t).toContain(F.DIALOG_RECORD.LINE_1(NR, PERIOD));
    expect(t).toContain(F.REISSUED);
    expect(t).not.toContain(F.DIALOG_RECORD.LINE_DIFF(NR));
    expect(checkbox()).toBeNull();
  });

  it('ZG3 (C7): dialog „zapisz” na KSeF PROD — HELD_CORRECTIONS za LINE_DIFF i za REISSUED; PAST_PERIOD i CORRECTION_PERSON, gdy dotyczą', async () => {
    await renderPanel(ownView({
      heldCorrections: true,
      correctionForPerson: true,
      original: { preview: { ...PREVIEW, buyerIdKind: 'nr-inny' }, assignedDay: ASSIGNED_DAY, pastPeriod: true },
    }));
    await click(button(F.BUTTON_RECORD));

    // B1: zdanie CORRECTION_PERSON stoi w panelu (po INTRO_RECORD_OWN, ZG1) i w dialogu (6.1/6.2) —
    // w każdym z nich dokładnie raz; liczymy osobno, nie na całym hoście.
    const dlg = dialogText();
    expect(dlg).toContain(F.DIALOG_RECORD.LINE_DIFF(NR) + F.HELD_CORRECTIONS);
    expect(dlg).toContain(F.REISSUED + F.HELD_CORRECTIONS);
    expect(dlg).toContain(F.PAST_PERIOD(PERIOD));
    expect(occurrences(dlg, F.CORRECTION_PERSON.trim())).toBe(1);
    expect(occurrences(outsideDialogText(), F.CORRECTION_PERSON.trim())).toBe(1);
  });

  it('ZG4 (INV-8): zapis z „Rozumiem skutki” (treść inna) — akcja dostaje choice=same_sale, confirmed=true, mode=import, offer=record, env; toast z wyniku', async () => {
    m.decide.mockResolvedValue({ success: true, message: F.TOAST_RECORD(NR) });
    await renderPanel(ownView(), 'test');
    await click(button(F.BUTTON_RECORD));

    await click(button(F.DIALOG_RECORD.CONFIRM_BUTTON));
    expect(m.decide).not.toHaveBeenCalled();

    await click(checkbox()!);
    await click(button(F.DIALOG_RECORD.CONFIRM_BUTTON));

    expect(m.decide).toHaveBeenCalledTimes(1);
    expect(m.decide).toHaveBeenCalledWith({
      invoiceId: 'inv-1',
      choice: 'same_sale',
      originalKsefNumber: K,
      originalSha256: SHA_K,
      confirmed: true,
      mode: 'import',
      offer: 'record',
      env: 'test',
    });
    expect(m.toastSuccess).toHaveBeenCalledWith(F.TOAST_RECORD(NR));
  });

  it('ZG4: zapis przy tej samej treści — bez pola, akcja od razu z confirmed=false i ofertą record', async () => {
    await renderPanel(sameContentView());
    await click(button(F.BUTTON_RECORD));
    await click(button(F.DIALOG_RECORD.CONFIRM_BUTTON));

    expect(m.decide).toHaveBeenCalledWith(expect.objectContaining({ choice: 'same_sale', confirmed: false, mode: 'import', offer: 'record' }));
  });
});

describe('KsefDuplicateDecision — FO-ODDANA, oferta released (tryb no-import)', () => {
  it('ZH1: wstęp PR B z programem „nieznany”, RELEASED_NOTE, wiersz „Program” = PROGRAM_RELEASED, dwa przyciski PR B; bez LEDGER, bez NOT_RECORDED i bez listy pozycji', async () => {
    await renderPanel(releasedView());

    const t = text();
    expect(t).toContain(T.INTRO(NR, K, null));
    expect(t).toContain(F.RELEASED_NOTE);
    expect(comparisonRow(T.ROW_LABELS.program)?.textContent).toContain(F.PROGRAM_RELEASED);
    expect(t).toContain(T.SUPPORT(NR));
    expect(buttonsLabelled(T.BUTTON_SAME)).toHaveLength(1);
    expect(buttonsLabelled(T.BUTTON_OTHER)).toHaveLength(1);
    expect(buttonsLabelled(F.BUTTON_RECORD)).toHaveLength(0);
    expect(t).not.toContain(F.LEDGER(K, PERIOD));
    expect(t).not.toContain(F.NOT_RECORDED);
    expect(t).not.toContain(F.LINES_TOGGLE(1));
  });

  it('ZH2: dialogi PR B z programem null („ta sama” LINE_1, „inna” LINE_4) — bez tekstów FAKTFLOW o zapisie faktury', async () => {
    await renderPanel(releasedView());
    await click(button(T.BUTTON_SAME));
    let t = text();
    expect(t).toContain(F.RELEASED_NOTE);
    expect(t).toContain(T.DIALOG_SAME.LINE_1(NR, K, null));
    expect(t).toContain(T.DIALOG_SAME.LINE_2(NR));
    expect(t).not.toContain(F.DIALOG_SAME.LINE_1(NR, K, PERIOD));

    await renderPanel(releasedView());
    await click(button(T.BUTTON_OTHER));
    t = text();
    expect(t).toContain(T.DIALOG_OTHER.LINE_1(NR, K));
    expect(t).toContain(T.DIALOG_OTHER.LINE_4_UNKNOWN_PROGRAM(K));
    expect(t).not.toContain(F.DIALOG_OTHER.LINE_1(NR, K, PERIOD));
  });

  it('ZH3 (INV-8): akcja dostaje mode=no-import i offer=released', async () => {
    await renderPanel(releasedView({ needsConfirmation: { same_sale: false, other_sale: false } }), 'test');
    await click(button(T.BUTTON_SAME));
    await click(button(T.DIALOG_SAME.CONFIRM_BUTTON));

    expect(m.decide).toHaveBeenCalledWith({
      invoiceId: 'inv-1',
      choice: 'same_sale',
      originalKsefNumber: K,
      originalSha256: SHA_K,
      confirmed: false,
      mode: 'no-import',
      offer: 'released',
      env: 'test',
    });
  });
});

// ─── Baner szkicu wycofanego po zapisie (karta X) ───────────────────────────

/** Widok banera z PRAWDZIWEGO `retiredDraftView` dla wpisu `number_taken` z decyzją, która zapisała K. */
function importedBanner(decision: Record<string, unknown> = {}, buyerIdKind: string | null = 'nip', extraCheck: Record<string, unknown> = {}) {
  const row = numberTakenRow(TENANT, X_ID, 'automatic', {
    original_check: {
      ...extraCheck,
      v: 1,
      env: 'test',
      reason: 'faktflow-original',
      summary: { systemInfo: 'KSeF SaaS v1.0', number: NR, issueDate: '2026-10-01', buyerNip: '5252241585', buyerName: 'Nabywca testowy', gross: '123.00', currency: 'PLN' },
      decision: {
        choice: 'same_sale', via: 'client', at: DECIDED_AT, reason: 'faktflow-original', env: 'test',
        mode: 'import', offer: 'pair', actorUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', note: null,
        original: { sha256: SHA_K, archivePath: `${TENANT}/ksef-import/${K}.xml`, sizeBytes: 2048, acquiredAt: null, session: null, gateRules: 1, gateProblems: [], buyerIdKind },
        importedInvoiceId: K_ID, retiredInternalNumber: NR, ...decision,
      },
    },
  });
  type TakenRows = Parameters<typeof retiredDraftView>[0]['submissions'];
  const view = retiredDraftView({ invoiceNumber: null, invoiceKind: 'regular', submissions: [row] as unknown as TakenRows, kindHeld: false });
  expect(view, 'brak widoku banera dla wpisu number_taken').not.toBeNull();
  return view!;
}

const DATA = formatWarsawDateTime(DECIDED_AT);

describe('RetiredDraftBanner — szkic wycofany po zapisie oryginału (karta X, 6.4)', () => {
  it.each([
    ['„ta sama sprzedaż” (pair)', { choice: 'same_sale', offer: 'pair' }, F.BANNER_SAME(DATA, '', NR, K), false],
    ['„inna sprzedaż” (pair)', { choice: 'other_sale', offer: 'pair' }, F.BANNER_OTHER(DATA, '', NR, K), true],
    ['zapis faktury z KSeF (record)', { choice: 'same_sale', offer: 'record' }, F.BANNER_RECORD(DATA, '', NR, K), false],
    ['zapis operatora w przeglądzie (review-record)', { choice: 'same_sale', offer: 'review-record' }, F.BANNER_RECORD(DATA, '', NR, K), false],
    ['zapis operatora w przeglądzie (review-pair, inna sprzedaż)', { choice: 'other_sale', offer: 'review-pair' }, F.BANNER_OTHER(DATA, '', NR, K), true],
  ])('ZB1: %s — tytuł z dawnym numerem, treść banera, odnośnik do faktury K; przycisk „Wystaw nową fakturę” tylko przy innej sprzedaży', (_label, decision, body, cta) => {
    mount(<RetiredDraftBanner view={importedBanner(decision)} />);

    const t = text();
    expect(t).toContain(F.BANNER_TITLE(NR));
    expect(t).toContain(body);
    const link = Array.from(host!.querySelectorAll('a')).find((a) => a.getAttribute('href') === `/invoices/${K_ID}`);
    expect(link?.textContent).toBe(F.IMPORTED_LINK(NR));
    const newInvoice = Array.from(host!.querySelectorAll('a')).find((a) => a.getAttribute('href') === T.CTA_REGULAR.href);
    expect(Boolean(newInvoice)).toBe(cta);
    if (cta) expect(newInvoice?.textContent).toBe(T.CTA_REGULAR.label);
    // Tytuł i treść PR B („numer … jest zajęty w KSeF”) nie dotyczą dokumentu, którego numer przeszedł na K.
    expect(t).not.toContain(T.BANNER_TITLE(NR));
  });

  it('ZB2: decyzja zapisana przez operatora — {via} = BANNER_VIA_OPERATOR w treści banera', () => {
    mount(<RetiredDraftBanner view={importedBanner({ via: 'operator', note: 'Rozmowa z klientem 08.10, osoba: J. Kowalski' })} />);

    expect(text()).toContain(F.BANNER_SAME(DATA, T.BANNER_VIA_OPERATOR, NR, K));
  });

  it.each(['pesel', 'nr-inny', 'brak-id'])('ZB3 (F44): nabywca K z identyfikatorem „%s” (decision.original.buyerIdKind) — CORRECTION_PERSON w banerze dokładnie raz', (kind) => {
    mount(<RetiredDraftBanner view={importedBanner({}, kind)} />);

    expect(occurrences(text(), F.CORRECTION_PERSON.trim())).toBe(1);
  });

  const WITH_ZW = { importGate: { v: 1, rules: 1, kind: 'importable', problems: [], preview: { ...PREVIEW, lineCount: 1, lines: [{ ...PREVIEW.lines[0], vatRate: 'zw' }] } } };

  it.each([
    ['sama sprzedaż', { choice: 'same_sale', offer: 'pair' }],
    ['inna sprzedaż', { choice: 'other_sale', offer: 'pair' }],
    ['zapis operatora (review-record)', { choice: 'same_sale', offer: 'review-record' }],
  ])('ZB3 (KORZW): %s, K z pozycją zw w pliku — CORRECTION_RATE w banerze dokładnie raz, bez CORRECTION_PERSON (nabywca z NIP)', (_label, decision) => {
    mount(<RetiredDraftBanner view={importedBanner(decision, 'nip', WITH_ZW)} />);

    expect(occurrences(text(), F.CORRECTION_RATE(NR).trim())).toBe(1);
    expect(text()).not.toContain(F.CORRECTION_PERSON.trim());
  });

  it('ZB3 (KORZW): K z 23% i nabywca z NIP — baner bez zdań o korekcie; nabywca bez NIP i zw — oba po jednym razie', () => {
    mount(<RetiredDraftBanner view={importedBanner({}, 'nip', { importGate: { v: 1, rules: 1, kind: 'importable', problems: [], preview: PREVIEW } })} />);
    expect(text()).not.toContain(F.CORRECTION_RATE(NR).trim());
    expect(text()).not.toContain(F.CORRECTION_PERSON.trim());

    mount(<RetiredDraftBanner view={importedBanner({}, 'pesel', WITH_ZW)} />);
    expect(occurrences(text(), F.CORRECTION_PERSON.trim())).toBe(1);
    expect(occurrences(text(), F.CORRECTION_RATE(NR).trim())).toBe(1);
  });

  it.each(['nip', 'vat-ue'])('ZB3: nabywca K z identyfikatorem „%s” — baner bez CORRECTION_PERSON (korekta K istnieje)', (kind) => {
    mount(<RetiredDraftBanner view={importedBanner({}, kind)} />);

    expect(text()).toContain(F.BANNER_TITLE(NR));
    expect(text()).not.toContain(F.CORRECTION_PERSON.trim());
  });
});

// ─── Notatka na karcie faktury K ────────────────────────────────────────────

async function renderNote(provenance: ImportedOriginalProvenance): Promise<void> {
  const Note = await load<NoteComponent>(NOTE_PATH, 'ImportedOriginalNote');
  mount(<Note provenance={provenance} />);
}

const provenance = (patch: Partial<ImportedOriginalProvenance> = {}): ImportedOriginalProvenance => ({
  decidedAt: DECIDED_AT,
  choice: 'same_sale',
  offer: 'pair',
  via: 'client',
  retiredInvoiceId: X_ID,
  retiredInternalNumber: NR,
  ...patch,
});

describe('ImportedOriginalNote — karta faktury K zapisanej z KSeF (6.5)', () => {
  it.each([
    ['pair + „ta sama sprzedaż”', { offer: 'pair', choice: 'same_sale' }, F.IMPORTED_CARD_CHOICE.same_sale],
    ['pair + „inna sprzedaż”', { offer: 'pair', choice: 'other_sale' }, F.IMPORTED_CARD_CHOICE.other_sale],
    ['record', { offer: 'record', choice: 'same_sale' }, F.IMPORTED_CARD_CHOICE.record],
    ['review-pair + „inna sprzedaż”', { offer: 'review-pair', choice: 'other_sale' }, F.IMPORTED_CARD_CHOICE.other_sale],
    ['review-record', { offer: 'review-record', choice: 'same_sale' }, F.IMPORTED_CARD_CHOICE.record],
  ] as const)('ZK1: oferta/wybór %s — IMPORTED_CARD z etykietą decyzji (record także przy review-record), odnośnik do wycofanego dokumentu, uwagi o przypomnieniach i wpłatach', async (_label, patch, label) => {
    await renderNote(provenance(patch));

    const t = text();
    expect(t).toContain(F.IMPORTED_CARD(DATA, '', NR, label));
    const link = Array.from(host!.querySelectorAll('a')).find((a) => a.getAttribute('href') === `/invoices/${X_ID}`);
    expect(link?.textContent).toBe(F.IMPORTED_CARD_RETIRED_LINK);
    expect(t).toContain(F.IMPORTED_CARD_REMINDERS);
    expect(t).toContain(F.IMPORTED_CARD_PAYMENTS);
  });

  it('ZK2: decyzja zapisana przez operatora — {via} = BANNER_VIA_OPERATOR', async () => {
    await renderNote(provenance({ via: 'operator' }));

    expect(text()).toContain(F.IMPORTED_CARD(DATA, T.BANNER_VIA_OPERATOR, NR, F.IMPORTED_CARD_CHOICE.same_sale));
  });
});

// ─── Pasek akcji szkicu wycofanego: PDF (5.12) ──────────────────────────────

const STORED: KsefResendFacts = { sendData: 'stored', kindHeld: false, issueDatePassed: false };

type InvoiceProp = Parameters<typeof InvoiceActions>[0]['invoice'];

/** Szkic wycofany w pasku akcji: `ksef_retired` z PR C niesie też `imported` (K z dawnym numerem). */
function draftInvoice(retired: Record<string, unknown> | null): InvoiceProp {
  return {
    id: X_ID,
    ksef_status: 'draft',
    xml_storage_path: null,
    invoice_type: 'VAT',
    invoice_kind: 'regular',
    last_error_code: null,
    ksef_resend_facts: STORED,
    ksef_environment_known: true,
    ksef_retired: retired,
    ksef_duplicate_panel: false,
  } as unknown as InvoiceProp;
}

describe('InvoiceActions — PDF wycofanego dokumentu po zapisie oryginału (5.12)', () => {
  it('ZP1: szkic wycofany z zapisanym K — przycisk „Pobierz PDF” zastąpiony odnośnikiem RETIRED_PDF_LINK do PDF faktury K', () => {
    mount(<InvoiceActions invoice={draftInvoice({ deletable: false, imported: { id: K_ID, internalNumber: NR } })} canManageSend />);

    expect(buttonsLabelled('Pobierz PDF')).toHaveLength(0);
    const link = Array.from(host!.querySelectorAll('a')).find((a) => (a.textContent ?? '').includes(F.RETIRED_PDF_LINK(NR)));
    expect(link, 'brak odnośnika do PDF faktury K').toBeDefined();
    expect(link!.getAttribute('href')).toBe(`/api/invoices/${K_ID}/pdf`);
  });

  it('ZP2: odmowa serwera 409 z `link` (stara karta, przycisk jeszcze był) — toast z tekstem odmowy i przyciskiem prowadzącym do PDF faktury K', async () => {
    const link = { href: `/api/invoices/${K_ID}/pdf`, label: F.RETIRED_PDF_LINK(NR) };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      headers: new Headers(),
      json: async () => ({ error: F.RETIRED_DOCUMENT_REFUSAL(NR), link }),
    }));
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    mount(<InvoiceActions invoice={draftInvoice(null)} canManageSend />);

    await click(button('Pobierz PDF'));
    // Odpowiedź (fetch → json) kończy się po kilku mikrozadaniach: dajemy transition dojść do toastu.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(m.toastError).toHaveBeenCalledTimes(1);
    expect(m.toastError).toHaveBeenCalledWith(
      F.RETIRED_DOCUMENT_REFUSAL(NR),
      { action: { label: link.label, onClick: expect.any(Function) } },
    );
    const options = m.toastError.mock.calls[0]![1] as { action: { onClick: () => void } };
    options.action.onClick();
    expect(assign).toHaveBeenCalledWith(link.href);
  });
});

// ─── Strona karty X: odmowy bez przycisków i blokada z sesji (6.1, INV-13) ───

const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sqlText = (key: keyof typeof DUPLICATE_DECISION_SQL_TEXTS, ...args: string[]): string =>
  fillSqlText(DUPLICATE_DECISION_SQL_TEXTS[key].template, ...args);

const PAGE_GATE = {
  v: 1,
  rules: 1,
  kind: 'importable',
  problems: [],
  // Okres daleko w przeszłości: `pastPeriod` nie zależy od zegara testu.
  preview: { ...PREVIEW, issueDate: '2000-01-15', period: '01.2000' },
};

function pageCheck(patch: Row = {}): Row {
  return duplicateCheck({
    reason: 'faktflow-original',
    sha256: SHA_K,
    archivePath: `${TENANT}/ksef-import/${K}.xml`,
    sizeBytes: 2048,
    summary: { systemInfo: 'KSeF SaaS v1.0', number: NR, issueDate: '2000-01-15', buyerNip: '5252241585', buyerName: 'Nabywca testowy', gross: '123.00', currency: 'PLN' },
    sameContentExceptHeader: false,
    ownHistory: false,
    importGate: PAGE_GATE,
    ...patch,
  });
}

function pageInvoice(patch: Row = {}): Row {
  return {
    id: X_ID,
    tenant_id: TENANT,
    internal_number: NR,
    invoice_type: 'VAT',
    invoice_kind: 'regular',
    issue_date: '2026-10-02',
    sale_date: null,
    fa3_data: null,
    special_data: null,
    direction: 'outgoing',
    ksef_status: 'failed',
    ksef_number: null,
    ksef_accepted_at: null,
    xml_storage_path: null,
    net_total: 100,
    vat_total: 23,
    gross_total: 123,
    currency: 'PLN',
    paid_amount: 0,
    stripe_invoice_id: null,
    offline_idempotency_key: null,
    offline_qr_offline: null,
    offline_qr_certyfikat: null,
    notes: null,
    last_error: 'KSeF ma już fakturę o tym numerze',
    last_error_code: 'KSEF_DUPLICATE_RECONCILE',
    last_error_field: null,
    last_error_suggestion: null,
    seller_data: { nip: '5260001246', name: 'ACME' },
    buyer_nip: '5252241585',
    buyer_data: { nip: '5252241585', name: 'Nabywca testowy' },
    payment_data: null,
    invoice_line_items: [],
    ...patch,
  };
}

type PageSeed = { invoice?: Row; submissions?: Row[]; role?: string };

function seedPage(o: PageSeed = {}): void {
  const tables: Record<string, Row[]> = {
    invoices: [o.invoice ?? pageInvoice()],
    ksef_submissions: o.submissions ?? [markerRow(TENANT, X_ID, { original_check: pageCheck() })],
    upo_receipts: [],
    memberships: [{ user_id: USER, organization_id: TENANT, status: 'active', role: o.role ?? 'owner' }],
  };
  m.pageClient = () => {
    const db = memoryDb(tables, (fn, args) => m.sessionRpc(fn, args));
    return { from: db.from, rpc: db.rpc, auth: { getUser: async () => ({ data: { user: { id: USER } } }) } };
  };
}

interface PageInitial {
  ksef_duplicate_decision: (Record<string, unknown> & { kind: string }) | null;
  ksef_duplicate_original: { note: string; rows: Array<{ label: string; value: string }> } | null;
  ksef_retired_draft: Record<string, unknown> | null;
}

async function pageInitial(): Promise<PageInitial> {
  const element = (await InvoiceDetailPage({ params: Promise.resolve({ id: X_ID }) })) as unknown as { props: { initial: PageInitial } };
  return element.props.initial;
}

describe('strona karty X — faktflow-original (6.1, INV-13)', () => {
  beforeEach(() => {
    m.sessionRpc.mockReset();
    m.sessionRpc.mockReturnValue({ data: null, error: null });
    seedPage();
  });

  it('ZS1 (FO-PARA): blokada czytana sesją klienta, widok decidable z ofertą pair, trybem import, obiema decyzjami i podglądem pliku; bez archiwum i bez klucza serwisowego', async () => {
    const initial = await pageInitial();

    expect(m.sessionRpc).toHaveBeenCalledWith('ksef_duplicate_decision_blocker_for_session', { p_invoice_id: X_ID });
    expect(initial.ksef_duplicate_decision).toMatchObject({
      kind: 'decidable',
      reason: 'faktflow-original',
      offer: 'pair',
      mode: 'import',
      choices: ['same_sale', 'other_sale'],
      program: 'FaktWay',
      original: { preview: PAGE_GATE.preview, pastPeriod: true },
    });
    expect(m.archiveRead).not.toHaveBeenCalled();
    expect(m.adminCreated).not.toHaveBeenCalled();
  });

  const withoutGate = (): Row => Object.fromEntries(Object.entries(pageCheck()).filter(([key]) => key !== 'importGate'));
  const markerWith = (check: Row): PageSeed => ({ submissions: [markerRow(TENANT, X_ID, { original_check: check })] });

  it.each([
    ['FO-PRZEGLĄD: poprawna brama review (przegląd operatora)', 'provenance-review', sqlText('provenance-review', NR),
      () => seedPage(markerWith(pageCheck({ importGate: { ...PAGE_GATE, kind: 'review', problems: ['gross-prices'] } })))],
    ['FO-PONOWNIE: znacznik bez oceny pliku', 'recheck-needed', sqlText('recheck-needed', NR),
      () => seedPage(markerWith(withoutGate()))],
    ['FO-PONOWNIE: znacznik z recheckNeeded', 'recheck-needed', sqlText('recheck-needed', NR),
      () => seedPage(markerWith(pageCheck({ recheckNeeded: { kind: 'gate-drift', at: '2026-10-05T10:00:00.000Z' } })))],
    ['FO-INNA-FIRMA: blokada cross-tenant z bazy', 'cross-tenant', sqlText('cross-tenant', NR, NR),
      () => m.sessionRpc.mockReturnValue({ data: 'cross-tenant', error: null })],
    ['FO-ZNANY-TERAZ: blokada known-now z bazy', 'known-now', sqlText('known-now', K, NR),
      () => m.sessionRpc.mockReturnValue({ data: 'known-now', error: null })],
    ['odczyt blokady nieudany (błąd bazy)', 'state-unknown', F.READ_FAILED(NR),
      () => m.sessionRpc.mockReturnValue({ data: null, error: { code: 'XX000', message: 'PRIVATE-DB-DIAGNOSTIC' } })],
    ['członek firmy (nie właściciel ani administrator)', 'role', T.ROLE,
      () => seedPage({ role: 'member' })],
  ])('ZS2: %s — odmowa „%s” z tekstem, który jest też notą karty; panel decyzji nie powstaje (brak przycisków)', async (_label, refusal, message, arrange) => {
    arrange();

    const initial = await pageInitial();

    expect(initial.ksef_duplicate_decision).toMatchObject({ kind: 'refused', refusal, message });
    expect(initial.ksef_duplicate_original?.note).toBe(message);
    expect(m.archiveRead).not.toHaveBeenCalled();
    expect(m.adminCreated).not.toHaveBeenCalled();
  });

  it('ZS3: szkic wycofany po zapisie oryginału — baner z dawnym numerem i fakturą K (imported), blokady nie czytamy (brak znacznika 440)', async () => {
    const taken = numberTakenRow(TENANT, X_ID, 'automatic', {
      original_check: {
        v: 1, env: 'test', reason: 'faktflow-original',
        summary: { systemInfo: 'KSeF SaaS v1.0', number: NR },
        decision: {
          choice: 'same_sale', via: 'client', at: DECIDED_AT, reason: 'faktflow-original', env: 'test', mode: 'import', offer: 'pair',
          importedInvoiceId: K_ID, retiredInternalNumber: NR,
        },
      },
    });
    seedPage({ invoice: pageInvoice({ ksef_status: 'draft', last_error_code: null, last_error: null, internal_number: null }), submissions: [taken] });

    const initial = await pageInitial();

    expect(initial.ksef_retired_draft).toMatchObject({ title: F.BANNER_TITLE(NR), imported: { id: K_ID, internalNumber: NR } });
    expect(m.sessionRpc).not.toHaveBeenCalled();
  });
});
