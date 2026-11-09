import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 3.4, część 1: „Oznacz jako zapłacone” przy koszcie. Akcja woła RPC
 * `mark_expense_paid` / `undo_expense_paid` (00177) kluczem sesji; RPC
 * w jednej transakcji sprawdza firmę i rolę, zapisuje dzień zapłaty
 * z warunkiem (`paid_at IS NULL`) i dopisuje audyt. Zachowanie na bazie:
 * `tests/rls-koszty-do-zaplaty.test.ts` (CI).
 *
 * Prawdziwe: akcje `markExpensePaidAction`, `undoExpensePaidAction`, teksty.
 * Zastąpione: sesja i RPC (atrapa klienta), `revalidatePath`.
 */

const s = vi.hoisted(() => ({
  rpc: vi.fn(),
  revalidate: vi.fn(),
  auth: null as null | Error,
}));

vi.mock('next/cache', () => ({ revalidatePath: s.revalidate }));
vi.mock('@/lib/supabase/auth-context', async () => {
  class ActionAuthError extends Error {}
  return {
    ActionAuthError,
    requireOrgRole: vi.fn(async () => {
      if (s.auth) throw new ActionAuthError(s.auth.message);
      return { supabase: { rpc: s.rpc }, tenantId: 'org-a', user: { id: 'u-1' }, role: 'owner' };
    }),
  };
});

const ID = '0a0b0c0d-0000-4000-8000-000000000001';

beforeEach(() => {
  s.rpc.mockReset();
  s.revalidate.mockReset();
  s.auth = null;
});

describe('oznaczenie zapłaty kosztu', () => {
  it('pierwsze oznaczenie zapisuje dzień (domyślnie dziś w RPC) i odświeża Wydatki', async () => {
    s.rpc.mockResolvedValue({ data: { status: 'marked', paid_on: '2026-11-09', document_number: 'FV/1' }, error: null });
    const { markExpensePaidAction } = await import('@/app/actions/expense-payments');

    await expect(markExpensePaidAction(ID)).resolves.toEqual({ success: true, status: 'marked', paidOn: '2026-11-09' });
    expect(s.rpc).toHaveBeenCalledWith('mark_expense_paid', { p_expense_id: ID, p_paid_on: null });
    expect(s.revalidate).toHaveBeenCalledWith('/expenses');
    expect(s.revalidate).toHaveBeenCalledWith(`/expenses/${ID}`);
  });

  it('drugie wywołanie: „już zapłacony” bez zmian i bez odświeżania', async () => {
    s.rpc.mockResolvedValue({ data: { status: 'already_paid', paid_on: '2026-11-08' }, error: null });
    const { markExpensePaidAction } = await import('@/app/actions/expense-payments');

    await expect(markExpensePaidAction(ID, '2026-11-09')).resolves.toEqual({ success: true, status: 'already_paid', paidOn: '2026-11-08' });
    expect(s.rpc).toHaveBeenCalledWith('mark_expense_paid', { p_expense_id: ID, p_paid_on: '2026-11-09' });
    expect(s.revalidate).not.toHaveBeenCalled();
  });

  it('data z przyszłości albo zła: odmowa z tekstem, bez RPC', async () => {
    const { markExpensePaidAction } = await import('@/app/actions/expense-payments');
    const przyszla = await markExpensePaidAction(ID, '2999-01-01');
    expect(przyszla).toMatchObject({ success: false, error: expect.stringMatching(/z przyszłości/) });
    const zla = await markExpensePaidAction(ID, '2026-02-30');
    expect(zla).toMatchObject({ success: false, error: expect.stringMatching(/datę/) });
    expect(s.rpc).not.toHaveBeenCalled();
  });

  it('odmowa RPC nazywa dokument i mówi, co zrobić; błąd bazy to „nie udało się”', async () => {
    s.rpc.mockResolvedValueOnce({ data: { status: 'refused', code: 'nothing_to_pay', document_number: 'KOR/1' }, error: null });
    s.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'x' } });
    const { markExpensePaidAction } = await import('@/app/actions/expense-payments');

    expect(await markExpensePaidAction(ID)).toMatchObject({ success: false, error: expect.stringMatching(/KOR\/1/) });
    expect(await markExpensePaidAction(ID)).toMatchObject({ success: false, error: expect.stringMatching(/Nie udało się oznaczyć zapłaty/) });
  });

  it('księgowa: odmowa z rolą w tekście, bez RPC', async () => {
    s.auth = new Error('Niewystarczające uprawnienia');
    const { markExpensePaidAction, undoExpensePaidAction } = await import('@/app/actions/expense-payments');
    expect(await markExpensePaidAction(ID)).toMatchObject({ success: false, error: expect.stringMatching(/Księgowa ma tu wgląd/) });
    expect(await undoExpensePaidAction(ID)).toMatchObject({ success: false, error: expect.stringMatching(/Księgowa ma tu wgląd/) });
    expect(s.rpc).not.toHaveBeenCalled();
  });

  it('identyfikator spoza UUID: odmowa bez RPC', async () => {
    const { markExpensePaidAction } = await import('@/app/actions/expense-payments');
    expect(await markExpensePaidAction('1 or 1=1')).toMatchObject({ success: false });
    expect(s.rpc).not.toHaveBeenCalled();
  });
});

describe('cofnięcie zapłaty kosztu', () => {
  it('cofnięcie, a drugie cofnięcie: „nie ma czego cofać” bez zmian', async () => {
    s.rpc.mockResolvedValueOnce({ data: { status: 'undone', paid_on: '2026-11-09' }, error: null });
    s.rpc.mockResolvedValueOnce({ data: { status: 'nothing_to_undo' }, error: null });
    const { undoExpensePaidAction } = await import('@/app/actions/expense-payments');

    await expect(undoExpensePaidAction(ID)).resolves.toEqual({ success: true, status: 'undone' });
    expect(s.revalidate).toHaveBeenCalledWith('/expenses');
    s.revalidate.mockReset();
    await expect(undoExpensePaidAction(ID)).resolves.toEqual({ success: true, status: 'nothing_to_undo' });
    expect(s.rpc).toHaveBeenLastCalledWith('undo_expense_paid', { p_expense_id: ID });
    expect(s.revalidate).not.toHaveBeenCalled();
  });
});
