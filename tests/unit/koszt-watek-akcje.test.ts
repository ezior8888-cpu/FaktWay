import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Akcje wątku przy koszcie (plan kompletnej aplikacji, krok 6.2, część 3,
 * 00192): prawdziwe akcje serwerowe, atrapy tylko dla sesji i RPC. Akcja woła
 * funkcję bazy kluczem z sesji; komentarz, wpis w dzwonku i audyt prośby zapisuje
 * baza w jednej transakcji, więc akcja nie ma klucza serwisowego ani logAudit.
 * Funkcje, role i obce firmy na prawdziwej bazie: `tests/rls-komentarze-kosztow.test.ts`.
 */

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  requireOrgRole: vi.fn(),
  revalidate: vi.fn(),
  logAudit: vi.fn(),
  admin: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
vi.mock('@/lib/audit/log', () => ({ logAudit: m.logAudit }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: m.admin }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: m.admin, createClient: vi.fn() }));
vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  return { ActionAuthError, requireOrgRole: m.requireOrgRole };
});

const { addExpenseCommentAction, resolveDocumentRequestAction } = await import('@/app/actions/expense-thread');
const { ActionAuthError } = await import('@/lib/supabase/auth-context');
const T = await import('@/lib/expenses/expense-thread');

const EXPENSE = '11111111-1111-4111-8111-111111111111';
const COMMENT = '22222222-2222-4222-8222-222222222222';
const TENANT = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

const input = (over: Record<string, unknown> = {}) =>
  ({ expenseId: EXPENSE, commentId: COMMENT, kind: 'comment', body: 'Czy to koszt firmowy?', ...over }) as Parameters<
    typeof addExpenseCommentAction
  >[0];

beforeEach(() => {
  vi.clearAllMocks();
  m.requireOrgRole.mockResolvedValue({ supabase: { rpc: m.rpc }, tenantId: TENANT, user: { id: USER }, role: 'accountant' });
  m.rpc.mockResolvedValue({
    data: { status: 'created', comment_id: COMMENT, expense_id: EXPENSE, kind: 'comment', notified: 2 },
    error: null,
  });
});

describe('addExpenseCommentAction', () => {
  it('komentarz: funkcja bazy kluczem z sesji, identyfikator z przeglądarki, przycięta treść, odświeżenie kosztu', async () => {
    const result = await addExpenseCommentAction(input({ body: '  Czy to koszt firmowy?\n' }));

    expect(result).toEqual({ success: true, status: 'created' });
    expect(m.requireOrgRole).toHaveBeenCalledWith(['owner', 'admin', 'member', 'accountant']);
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith('expense_comment_add', {
      p_expense_id: EXPENSE,
      p_kind: 'comment',
      p_body: 'Czy to koszt firmowy?',
      p_comment_id: COMMENT,
    });
    expect(m.revalidate).toHaveBeenCalledWith(`/expenses/${EXPENSE}`);
    // Wpis w dzwonku i audyt robi baza w tej samej transakcji: bez klucza serwisowego i bez logAudit w akcji.
    expect(m.admin).not.toHaveBeenCalled();
    expect(m.logAudit).not.toHaveBeenCalled();
  });

  it('prośba o dokument: ta sama droga z rodzajem document_request', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'created', kind: 'document_request', notified: 1 }, error: null });

    await expect(addExpenseCommentAction(input({ kind: 'document_request', body: 'Proszę o fakturę.' }))).resolves.toEqual({
      success: true,
      status: 'created',
    });
    expect(m.rpc.mock.calls[0]![1]).toMatchObject({ p_kind: 'document_request', p_body: 'Proszę o fakturę.' });
  });

  it('ponowienie z tym samym identyfikatorem: baza zwraca exists, akcja to sukces i odświeża widok', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'exists', comment_id: COMMENT, notified: 0 }, error: null });

    await expect(addExpenseCommentAction(input())).resolves.toEqual({ success: true, status: 'exists' });
    expect(m.revalidate).toHaveBeenCalledWith(`/expenses/${EXPENSE}`);
  });

  it.each([
    ['pusta treść', { body: '  \n ' }, 'Wpisz treść wpisu.'],
    ['za długa treść', { body: 'x'.repeat(2001) }, 'Wpis może mieć najwyżej 2000 znaków. Skróć go i zapisz ponownie.'],
    ['zły identyfikator kosztu', { expenseId: 'nie-uuid' }, T.COMMENT_SAVE_ERROR],
    ['zły identyfikator wpisu', { commentId: '' }, T.COMMENT_SAVE_ERROR],
    ['zły rodzaj', { kind: 'notatka' }, T.COMMENT_SAVE_ERROR],
  ])('%s: odmowa bez sesji i bez bazy', async (_name, over, error) => {
    await expect(addExpenseCommentAction(input(over))).resolves.toEqual({ success: false, error });
    expect(m.requireOrgRole).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('2000 znaków przechodzi do bazy', async () => {
    await addExpenseCommentAction(input({ body: 'ą'.repeat(2000) }));
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not_found', 'Nie znaleziono tego kosztu w aktywnej firmie. Odśwież stronę albo przełącz firmę.'],
    ['empty_body', 'Wpisz treść wpisu.'],
    ['body_too_long', 'Wpis może mieć najwyżej 2000 znaków. Skróć go i zapisz ponownie.'],
    ['conflict', 'Ten wpis zapisał się już w innej wersji. Odśwież stronę i sprawdź komentarze.'],
    ['invalid_kind', T.COMMENT_SAVE_ERROR],
    ['cos_nowego', T.COMMENT_SAVE_ERROR],
  ])('odmowa bazy %s: komunikat z tym, co zrobić, bez odświeżenia', async (code, error) => {
    m.rpc.mockResolvedValue({ data: { status: 'refused', code }, error: null });

    await expect(addExpenseCommentAction(input())).resolves.toEqual({ success: false, error });
    expect(m.revalidate).not.toHaveBeenCalled();
  });

  it('bez dostępu: 42501 z bazy albo rola spoza listy dają komunikat o dostępie; brak sesji swój komunikat', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'No active organization' } });
    await expect(addExpenseCommentAction(input())).resolves.toEqual({ success: false, error: T.THREAD_NO_ACCESS });

    m.requireOrgRole.mockRejectedValueOnce(new ActionAuthError('Niewystarczające uprawnienia'));
    await expect(addExpenseCommentAction(input())).resolves.toEqual({ success: false, error: T.THREAD_NO_ACCESS });

    m.requireOrgRole.mockRejectedValueOnce(new ActionAuthError('Niezalogowany'));
    await expect(addExpenseCommentAction(input())).resolves.toEqual({ success: false, error: 'Niezalogowany' });
    expect(m.revalidate).not.toHaveBeenCalled();
  });

  it('błąd bazy (np. migracja niewgrana), dziwna odpowiedź albo wyjątek sieci: komunikat z ponowieniem, nie wyjątek', async () => {
    m.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    await expect(addExpenseCommentAction(input())).resolves.toEqual({ success: false, error: T.COMMENT_SAVE_ERROR });

    m.rpc.mockResolvedValueOnce({ data: 'ok', error: null });
    await expect(addExpenseCommentAction(input())).resolves.toEqual({ success: false, error: T.COMMENT_SAVE_ERROR });

    m.rpc.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(addExpenseCommentAction(input())).resolves.toEqual({ success: false, error: T.COMMENT_SAVE_ERROR });
    expect(m.revalidate).not.toHaveBeenCalled();
  });
});

describe('resolveDocumentRequestAction', () => {
  it('załatwienie: funkcja bazy z identyfikatorem prośby; koszt do odświeżenia z odpowiedzi bazy, nie z przeglądarki', async () => {
    m.rpc.mockResolvedValue({
      data: { status: 'resolved', expense_id: EXPENSE, resolved_at: '2026-11-11T09:00:00Z', resolved_by: USER },
      error: null,
    });

    await expect(resolveDocumentRequestAction(COMMENT)).resolves.toEqual({ success: true, status: 'resolved' });
    expect(m.requireOrgRole).toHaveBeenCalledWith(['owner', 'admin', 'member', 'accountant']);
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith('expense_document_request_resolve', { p_comment_id: COMMENT });
    expect(m.revalidate).toHaveBeenCalledWith(`/expenses/${EXPENSE}`);
    expect(m.admin).not.toHaveBeenCalled();
    expect(m.logAudit).not.toHaveBeenCalled();
  });

  it('powtórka: already_resolved to sukces z odświeżeniem (ktoś inny zdążył wcześniej)', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'already_resolved', expense_id: EXPENSE }, error: null });

    await expect(resolveDocumentRequestAction(COMMENT)).resolves.toEqual({ success: true, status: 'already_resolved' });
    expect(m.revalidate).toHaveBeenCalledWith(`/expenses/${EXPENSE}`);
  });

  it('odpowiedź bez poprawnego identyfikatora kosztu: sukces bez odświeżenia złej ścieżki', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'resolved', expense_id: '../admin' }, error: null });

    await expect(resolveDocumentRequestAction(COMMENT)).resolves.toEqual({ success: true, status: 'resolved' });
    expect(m.revalidate).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 'Nie znaleziono tej prośby o dokument w aktywnej firmie. Odśwież stronę albo przełącz firmę.'],
    ['not_request', 'Jako załatwioną można oznaczyć tylko prośbę o dokument.'],
    ['cos_nowego', T.REQUEST_RESOLVE_ERROR],
  ])('odmowa bazy %s: komunikat', async (code, error) => {
    m.rpc.mockResolvedValue({ data: { status: 'refused', code }, error: null });
    await expect(resolveDocumentRequestAction(COMMENT)).resolves.toEqual({ success: false, error });
    expect(m.revalidate).not.toHaveBeenCalled();
  });

  it('zły identyfikator: odmowa bez sesji i bez bazy; błąd bazy i 42501: komunikat', async () => {
    await expect(resolveDocumentRequestAction('nie-uuid')).resolves.toEqual({ success: false, error: T.REQUEST_RESOLVE_ERROR });
    expect(m.requireOrgRole).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();

    m.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'Insufficient role' } });
    await expect(resolveDocumentRequestAction(COMMENT)).resolves.toEqual({ success: false, error: T.THREAD_NO_ACCESS });

    m.rpc.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(resolveDocumentRequestAction(COMMENT)).resolves.toEqual({ success: false, error: T.REQUEST_RESOLVE_ERROR });
  });
});
