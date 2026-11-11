// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ekrany Kasy (plan kompletnej aplikacji, krok 3.7): lista dowodów w raporcie
 * (stan po każdym dowodzie, korekty), korekta dowodu z przyczyną i stan
 * początkowy kasy. Prawdziwe: komponenty, schematy Zod i teksty. Atrapy:
 * akcje serwerowe, router, toast, okna bez portalu.
 */

const actions = vi.hoisted(() => ({ correct: vi.fn(), open: vi.fn(), issue: vi.fn() }));
vi.mock('@/app/actions/kasa', () => ({
  correctCashDocumentAction: actions.correct,
  openCashRegisterAction: actions.open,
  issueCashDocumentAction: actions.issue,
}));
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

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

import { CashCorrectionButton } from '@/app/(dashboard)/kasa/_components/cash-correction-button';
import { CashDocumentsList } from '@/app/(dashboard)/kasa/_components/cash-documents-list';
import { CashOpeningForm } from '@/app/(dashboard)/kasa/_components/cash-opening-form';
import { buildCashReport, type CashReportDocument } from '@/lib/kasa/model';

const DOC = '5d0e8a8c-7a3b-4f61-9d2e-1c4b5a6f7e80';
const TENANT = '22222222-2222-4222-8222-222222222222';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const plain = (text: string | null | undefined) => (text ?? '').replace(/[  ]/g, ' ');

let container: HTMLDivElement;
let root: Root;

async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

async function click(el: Element | null) {
  if (!el) throw new Error('brak elementu');
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function type(el: Element | null, value: string) {
  if (!el) throw new Error('brak pola');
  const input = el as HTMLInputElement | HTMLTextAreaElement;
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function button(text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll('button')].find((b) => plain(b.textContent).trim() === text) ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function dowod(over: Partial<CashReportDocument> = {}): CashReportDocument {
  return {
    id: DOC, kind: 'KP', number: 'KP/1/2026', operationDate: '2026-11-03', issueDate: '2026-11-03', amount: 200,
    title: 'Zapłata za fakturę FV/1/2026', counterpartyName: 'Jan Kowalski', invoiceNumber: 'FV/1/2026',
    correctsNumber: null, correctedByNumber: null, issuedAt: '2026-11-03T09:00:00.000Z', ...over,
  };
}

describe('lista dowodów w raporcie', () => {
  it('numer prowadzi do dowodu; wpłata, wypłata i stan po dowodzie; korekta i dowód skorygowany opisane', async () => {
    const report = buildCashReport({
      from: '2026-11-01', to: '2026-11-30', openingDate: '2026-10-01', balanceBefore: 100,
      documents: [
        dowod({ correctedByNumber: 'KP/2/2026' }),
        dowod({ id: 'k', number: 'KP/2/2026', amount: -200, correctsNumber: 'KP/1/2026', issuedAt: '2026-11-03T12:00:00.000Z' }),
        dowod({ id: 'w', kind: 'KW', number: 'KW/1/2026', amount: 40, operationDate: '2026-11-04', counterpartyName: 'Sklep ABC', title: 'Zakup materiałów', invoiceNumber: null }),
      ],
    });

    await render(<CashDocumentsList rows={report.rows} />);
    const text = plain(container.textContent);

    expect(container.querySelector(`a[href="/kasa/${DOC}"]`)?.textContent).toContain('KP/1/2026');
    expect(text).toContain('Skorygowany dowodem KP/2/2026');
    expect(text).toContain('Korekta dowodu KP/1/2026');
    expect(text).toContain('Sklep ABC');
    expect(text).toContain('-200,00');
    expect(text).toContain('60,00');
  });

  it('pusty okres: komunikat zamiast tabeli', async () => {
    await render(<CashDocumentsList rows={[]} />);
    expect(plain(container.textContent)).toContain('W tym okresie nie ma dowodów kasowych.');
  });
});

describe('korekta dowodu', () => {
  it('okno z przyczyną; zapis z kluczem i przyczyną; po sukcesie przejście do korekty', async () => {
    actions.correct.mockResolvedValue({
      success: true, status: 'issued', documentId: 'korekta-1', number: 'KP/2/2026', correctsNumber: 'KP/1/2026', paymentVoided: true, invoiceNumber: 'FV/1/2026',
    });
    await render(<CashCorrectionButton documentId={DOC} number="KP/1/2026" />);

    await click(button('Korekta dowodu'));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await type(container.querySelector('textarea'), 'Zła kwota');
    await click(button('Wystaw korektę'));

    expect(actions.correct).toHaveBeenCalledWith({ documentId: DOC, idempotencyKey: expect.stringMatching(UUID), reason: 'Zła kwota' });
    expect(router.push).toHaveBeenCalledWith('/kasa/korekta-1');
    expect(plain(toast.success.mock.calls[0]?.[0])).toBe('Wystawiono korektę KP/2/2026 do dowodu KP/1/2026. Wpłata do faktury FV/1/2026 została cofnięta.');
  });

  it('bez przyczyny: komunikat przy polu, bez akcji', async () => {
    await render(<CashCorrectionButton documentId={DOC} number="KP/1/2026" />);

    await click(button('Korekta dowodu'));
    await click(button('Wystaw korektę'));

    expect(actions.correct).not.toHaveBeenCalled();
    expect(plain(container.textContent)).toContain('Wpisz przyczynę korekty.');
  });

  it('odmowa: tekst w oknie; ponowienie idzie z tym samym kluczem', async () => {
    actions.correct.mockResolvedValueOnce({ success: false, error: 'Nie udało się wystawić korekty. Sprawdź połączenie i spróbuj ponownie.' });
    actions.correct.mockResolvedValueOnce({ success: true, status: 'already_issued', documentId: 'korekta-1', number: 'KP/2/2026', correctsNumber: 'KP/1/2026', paymentVoided: false, invoiceNumber: null });
    await render(<CashCorrectionButton documentId={DOC} number="KP/1/2026" />);

    await click(button('Korekta dowodu'));
    await type(container.querySelector('textarea'), 'Dubel');
    await click(button('Wystaw korektę'));
    expect(plain(container.textContent)).toContain('Nie udało się wystawić korekty.');
    await click(button('Wystaw korektę'));

    const keys = actions.correct.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(router.push).toHaveBeenCalledWith('/kasa/korekta-1');
  });
});

describe('stan początkowy kasy', () => {
  it('zapis daty i kwoty dla firmy formularza; po sukcesie odświeżenie', async () => {
    actions.open.mockResolvedValue({ success: true, status: 'opened' });
    await render(<CashOpeningForm tenantId={TENANT} today="2026-11-11" initial={null} />);

    await type(container.querySelector('input[name="openingBalance"]'), '150,50');
    await click(button('Otwórz kasę'));

    expect(actions.open).toHaveBeenCalledWith({ openingDate: '2026-11-11', openingBalance: '150,50' }, TENANT);
    expect(router.refresh).toHaveBeenCalled();
  });

  it('odmowa z bazy: tekst pod formularzem', async () => {
    actions.open.mockResolvedValue({ success: false, error: 'Stanu początkowego nie zmienia się po wystawieniu pierwszego dowodu.' });
    await render(<CashOpeningForm tenantId={TENANT} today="2026-11-11" initial={{ openingDate: '2026-11-01', openingBalance: 0 }} />);

    await click(button('Zapisz stan początkowy'));

    expect(plain(container.textContent)).toContain('Stanu początkowego nie zmienia się po wystawieniu pierwszego dowodu.');
  });
});
