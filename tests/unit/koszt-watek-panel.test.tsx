// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wątek przy koszcie na ekranie kosztu (plan kompletnej aplikacji, krok 6.2,
 * część 3, 00192): lista komentarzy i próśb o dokument (stan otwarta albo
 * załatwiona: kto i kiedy), formularz z dwoma przyciskami i „Oznacz jako
 * załatwioną”. Identyfikator wpisu powstaje w przeglądarce przy wysyłce i jest
 * ten sam przy ponowieniu tej samej treści, więc drugie kliknięcie po zerwanym
 * połączeniu nie dubluje wpisu (baza zwraca „exists”).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = vi.hoisted(() => ({
  add: vi.fn(),
  resolve: vi.fn(),
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/app/actions/expense-thread', () => ({
  addExpenseCommentAction: m.add,
  resolveDocumentRequestAction: m.resolve,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: m.refresh, push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: m.toastSuccess, error: m.toastError } }));

const { ExpenseThreadPanel } = await import('@/app/(dashboard)/expenses/[id]/_components/expense-thread-panel');
const T = await import('@/lib/expenses/expense-thread');
type Load = import('@/lib/expenses/expense-thread').ExpenseThreadLoad;

const EXPENSE = '11111111-1111-4111-8111-111111111111';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const THREAD: Load = {
  ok: true,
  truncated: false,
  entries: [
    {
      id: 'w1', kind: 'comment', body: 'Czy to koszt firmowy?\nPytam o fakturę.', createdAt: '2026-11-09T08:00:00Z',
      authorLabel: 'Olga Właścicielka', authorRoleLabel: 'właściciel', mine: false, resolvedAt: null, resolvedByLabel: null,
    },
    {
      id: 'w2', kind: 'document_request', body: 'Proszę o fakturę zamiast paragonu.', createdAt: '2026-11-10T09:00:00Z',
      authorLabel: 'Ty', authorRoleLabel: 'księgowy', mine: true, resolvedAt: null, resolvedByLabel: null,
    },
    {
      id: 'w3', kind: 'document_request', body: 'Proszę o paragon.', createdAt: '2026-11-10T10:00:00Z',
      authorLabel: 'Ty', authorRoleLabel: 'księgowy', mine: true, resolvedAt: '2026-11-11T09:15:00Z', resolvedByLabel: 'Marek Członek',
    },
  ],
};

let host: HTMLDivElement;
let root: Root;

async function render(thread: Load = THREAD, canWrite = true) {
  await act(async () => {
    root.render(<ExpenseThreadPanel expenseId={EXPENSE} thread={thread} canWrite={canWrite} />);
  });
}

const text = () => host.textContent ?? '';
const textarea = () => host.querySelector<HTMLTextAreaElement>('textarea');
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);

async function type(value: string) {
  const el = textarea()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(label: string) {
  const el = button(label);
  expect(el, label).toBeDefined();
  await act(async () => {
    el!.click();
  });
  // Walidacja formularza i akcja to obietnice: dajemy im się rozstrzygnąć.
  for (let i = 0; i < 3; i += 1) await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  m.add.mockResolvedValue({ success: true, status: 'created' });
  m.resolve.mockResolvedValue({ success: true, status: 'resolved' });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('wątek przy koszcie', () => {
  it('lista: autor, rola, data, treść z nowymi liniami; prośba ze stanem, „Załatwiona: kto, kiedy” i liczba otwartych', async () => {
    await render();

    expect(text()).toContain('Komentarze i prośby o dokument');
    expect(text()).toContain('1 otwarta prośba');
    const items = [...host.querySelectorAll('li')];
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain('Olga Właścicielka');
    expect(items[0]!.textContent).toContain('właściciel');
    expect(items[0]!.textContent).toContain('09.11.2026, 09:00');
    expect(items[0]!.querySelector('.whitespace-pre-wrap')?.textContent).toBe('Czy to koszt firmowy?\nPytam o fakturę.');
    expect(items[0]!.textContent).not.toContain('Prośba o dokument');
    expect(items[1]!.textContent).toContain('Prośba o dokument');
    expect(items[1]!.textContent).toContain('Otwarta');
    expect(items[1]!.querySelector('button')?.textContent).toContain('Oznacz jako załatwioną');
    expect(items[2]!.textContent).toContain('Załatwiona');
    expect(items[2]!.textContent).toContain('Załatwiona: Marek Członek, 11.11.2026, 10:15');
    expect(items[2]!.querySelector('button')).toBeNull();
    // Kotwica linku z dzwonka jest na sekcji strony, nie tutaj; panel ma nagłówek dla czytników ekranu.
    expect(text()).not.toMatch(/—/);
  });

  it('„Dodaj komentarz”: akcja z identyfikatorem wpisu, rodzajem i przyciętą treścią; po sukcesie pusty formularz', async () => {
    await render();
    await type('  Dołączę zdjęcie paragonu.  ');
    await click('Dodaj komentarz');

    expect(m.add).toHaveBeenCalledTimes(1);
    const [arg] = m.add.mock.calls[0]!;
    expect(arg).toMatchObject({ expenseId: EXPENSE, kind: 'comment', body: 'Dołączę zdjęcie paragonu.' });
    expect(arg.commentId).toMatch(UUID);
    expect(textarea()!.value).toBe('');
    expect(m.toastSuccess).toHaveBeenCalledWith(T.COMMENT_ADDED);

    // Następny wpis dostaje nowy identyfikator.
    await type('Drugi wpis');
    await click('Dodaj komentarz');
    expect(m.add.mock.calls[1]![0].commentId).toMatch(UUID);
    expect(m.add.mock.calls[1]![0].commentId).not.toBe(arg.commentId);
  });

  it('„Poproś o dokument”: ta sama treść jako prośba', async () => {
    await render();
    await type('Proszę o fakturę VAT.');
    await click('Poproś o dokument');

    expect(m.add).toHaveBeenCalledTimes(1);
    expect(m.add.mock.calls[0]![0]).toMatchObject({ expenseId: EXPENSE, kind: 'document_request', body: 'Proszę o fakturę VAT.' });
    expect(m.toastSuccess).toHaveBeenCalledWith(T.REQUEST_ADDED);
  });

  it('ponowienie po błędzie: ta sama treść ma ten sam identyfikator, zmieniona treść nowy; komunikat błędu przy formularzu', async () => {
    m.add.mockResolvedValueOnce({ success: false, error: T.COMMENT_SAVE_ERROR });
    m.add.mockRejectedValueOnce(new Error('Failed to fetch'));
    await render();
    await type('Czy to koszt firmowy?');
    await click('Dodaj komentarz');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(T.COMMENT_SAVE_ERROR);
    expect(textarea()!.value).toBe('Czy to koszt firmowy?');

    await click('Dodaj komentarz');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(T.COMMENT_SAVE_ERROR);
    const [first, second] = m.add.mock.calls.map((c) => c[0].commentId);
    expect(second).toBe(first);

    await type('Czy to koszt firmowy? Tak pytam.');
    await click('Dodaj komentarz');
    expect(m.add.mock.calls[2]![0].commentId).not.toBe(first);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(textarea()!.value).toBe('');
  });

  it('pusta treść: komunikat przy polu, bez akcji', async () => {
    await render();
    await type('   ');
    await click('Poproś o dokument');

    expect(m.add).not.toHaveBeenCalled();
    expect(text()).toContain('Wpisz treść wpisu.');
  });

  it('„Oznacz jako załatwioną”: akcja z identyfikatorem prośby i komunikat; błąd z wyjściem', async () => {
    await render();
    await click('Oznacz jako załatwioną');
    expect(m.resolve).toHaveBeenCalledExactlyOnceWith('w2');
    expect(m.toastSuccess).toHaveBeenCalledWith(T.REQUEST_RESOLVED);

    m.resolve.mockResolvedValueOnce({ success: true, status: 'already_resolved' });
    await click('Oznacz jako załatwioną');
    expect(m.toastSuccess).toHaveBeenCalledWith(T.REQUEST_ALREADY_RESOLVED);

    m.resolve.mockResolvedValueOnce({ success: false, error: T.REQUEST_RESOLVE_ERROR });
    await click('Oznacz jako załatwioną');
    expect(m.toastError).toHaveBeenCalledWith(T.REQUEST_RESOLVE_ERROR);

    m.resolve.mockRejectedValueOnce(new Error('Failed to fetch'));
    await click('Oznacz jako załatwioną');
    expect(m.toastError).toHaveBeenLastCalledWith(T.REQUEST_RESOLVE_ERROR);
  });

  it('błąd odczytu: komunikat i „Spróbuj ponownie” odświeża stronę; bez formularza', async () => {
    await render({ ok: false, error: T.THREAD_LOAD_ERROR });

    expect(text()).toContain(T.THREAD_LOAD_ERROR);
    expect(textarea()).toBeNull();
    await click('Spróbuj ponownie');
    expect(m.refresh).toHaveBeenCalledTimes(1);
  });

  it('bez wpisów: zachęta i formularz; tylko wgląd: bez formularza i bez „Oznacz jako załatwioną”', async () => {
    await render({ ok: true, entries: [], truncated: false });
    expect(text()).toContain('Nie ma jeszcze wpisów.');
    expect(textarea()).not.toBeNull();
    expect(text()).not.toMatch(/otwart/);

    await render(THREAD, false);
    expect(textarea()).toBeNull();
    expect(button('Oznacz jako załatwioną')).toBeUndefined();
    expect(text()).toContain('Masz tu tylko wgląd.');
  });

  it('pełny limit: informacja, że widać ostatnie wpisy', async () => {
    await render({ ...THREAD, truncated: true });
    expect(text()).toContain('Widać 100 ostatnich wpisów.');
  });
});

describe('teksty wątku', () => {
  it('liczba otwartych próśb po polsku', () => {
    expect([1, 2, 4, 5, 12, 22, 25].map(T.openRequestsLabel)).toEqual([
      '1 otwarta prośba',
      '2 otwarte prośby',
      '4 otwarte prośby',
      '5 otwartych próśb',
      '12 otwartych próśb',
      '22 otwarte prośby',
      '25 otwartych próśb',
    ]);
  });

  it('identyfikator wpisu z przeglądarki ma kształt UUID', () => {
    expect(T.newCommentId()).toMatch(UUID);
    expect(T.newCommentId()).not.toBe(T.newCommentId());
  });
});
