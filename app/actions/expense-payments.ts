'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  EXPENSE_PAYMENT_ROLES,
  EXPENSE_ROLE_REFUSAL,
  expensePaidRefusalText,
  MARK_EXPENSE_PAID_FAILED,
  UNDO_EXPENSE_PAID_FAILED,
  type ExpensePaidRefusal,
  type MarkExpensePaidResult,
  type UndoExpensePaidResult,
} from '@/lib/expenses/zaplata-kosztu';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { ActionAuthError, requireOrgRole, type AuthContext } from '@/lib/supabase/auth-context';

/**
 * „Oznacz jako zapłacone” przy koszcie (krok 3.4, część 1). Akcje na kliencie
 * sesji, bez klucza serwisowego: firmę, rolę, dzień (nie z przyszłości
 * w Warszawie) i stan sprawdza jeszcze raz RPC z 00177 w jednej transakcji
 * z zapisem i wpisem audytu (`expense.marked_paid`, `expense.paid_undone`),
 * więc akcja audytu nie dubluje.
 *
 * Ponowienie: oba RPC są idempotentne (drugie oznaczenie zwraca
 * `already_paid`, drugie cofnięcie `nothing_to_undo`, oba bez zapisu), więc
 * odświeżenie stron idzie tylko po rzeczywistej zmianie.
 */

/** Funkcje z 00177: `types/database.ts` generujemy z produkcji po wgraniu migracji (AGENTS.md). */
type RpcResult = PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
interface ExpensePaymentRpc {
  rpc(fn: 'mark_expense_paid', args: { p_expense_id: string; p_paid_on: string | null }): RpcResult;
  rpc(fn: 'undo_expense_paid', args: { p_expense_id: string }): RpcResult;
}

const expenseIdSchema = z.string().uuid();
const paidOnSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T12:00:00Z`);
  // filtr-wyjatek: data-warszawa sprawdzenie dnia kalendarzowego na dacie w UTC, nie dzisiejsza data
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});

function revalidateExpenseViews(expenseId: string): void {
  revalidatePath('/expenses');
  revalidatePath(`/expenses/${expenseId}`);
}

async function authorized(): Promise<{ ctx: AuthContext } | { error: string }> {
  try {
    return { ctx: await requireOrgRole([...EXPENSE_PAYMENT_ROLES]) };
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { error: e.message === 'Niewystarczające uprawnienia' ? EXPENSE_ROLE_REFUSAL : e.message };
    }
    throw e;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

const REFUSALS = new Set<string>(['not_found', 'future_date', 'invalid_date', 'nothing_to_pay']);

export async function markExpensePaidAction(expenseId: string, paidOn?: string): Promise<MarkExpensePaidResult> {
  if (!expenseIdSchema.safeParse(expenseId).success) return { success: false, error: MARK_EXPENSE_PAID_FAILED };
  if (paidOn !== undefined) {
    if (!paidOnSchema.safeParse(paidOn).success) return { success: false, error: expensePaidRefusalText('invalid_date') };
    if (paidOn > todayInWarsaw()) return { success: false, error: expensePaidRefusalText('future_date') };
  }
  const auth = await authorized();
  if ('error' in auth) return { success: false, error: auth.error };

  const { data, error } = await (auth.ctx.supabase as unknown as ExpensePaymentRpc).rpc('mark_expense_paid', {
    p_expense_id: expenseId,
    p_paid_on: paidOn ?? null,
  });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[expense-payments] mark_expense_paid', error?.code);
    return { success: false, error: MARK_EXPENSE_PAID_FAILED };
  }
  const result = data as Record<string, unknown>;

  if (result.status === 'refused') {
    const code = String(result.code);
    return {
      success: false,
      error: REFUSALS.has(code)
        ? expensePaidRefusalText(code as ExpensePaidRefusal, text(result.document_number))
        : MARK_EXPENSE_PAID_FAILED,
    };
  }
  if (result.status === 'already_paid') return { success: true, status: 'already_paid', paidOn: text(result.paid_on) };
  if (result.status !== 'marked') return { success: false, error: MARK_EXPENSE_PAID_FAILED };

  revalidateExpenseViews(expenseId);
  return { success: true, status: 'marked', paidOn: String(result.paid_on) };
}

export async function undoExpensePaidAction(expenseId: string): Promise<UndoExpensePaidResult> {
  if (!expenseIdSchema.safeParse(expenseId).success) return { success: false, error: UNDO_EXPENSE_PAID_FAILED };
  const auth = await authorized();
  if ('error' in auth) return { success: false, error: auth.error };

  const { data, error } = await (auth.ctx.supabase as unknown as ExpensePaymentRpc).rpc('undo_expense_paid', {
    p_expense_id: expenseId,
  });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[expense-payments] undo_expense_paid', error?.code);
    return { success: false, error: UNDO_EXPENSE_PAID_FAILED };
  }
  const result = data as Record<string, unknown>;

  if (result.status === 'refused') return { success: false, error: expensePaidRefusalText('not_found') };
  if (result.status === 'nothing_to_undo') return { success: true, status: 'nothing_to_undo' };
  if (result.status !== 'undone') return { success: false, error: UNDO_EXPENSE_PAID_FAILED };

  revalidateExpenseViews(expenseId);
  return { success: true, status: 'undone' };
}
