'use server';

import { revalidatePath } from 'next/cache';

import {
  COMMENT_SAVE_ERROR,
  EXPENSE_THREAD_ROLES,
  REQUEST_RESOLVE_ERROR,
  THREAD_NO_ACCESS,
  addCommentRefusalText,
  expenseCommentInputSchema,
  isThreadUuid,
  resolveRefusalText,
  type AddExpenseCommentResult,
  type ExpenseCommentInput,
  type ResolveDocumentRequestResult,
} from '@/lib/expenses/expense-thread';
import { ActionAuthError, requireOrgRole, type AuthContext } from '@/lib/supabase/auth-context';

/**
 * Wątek przy koszcie (plan kompletnej aplikacji, krok 6.2, część 3, 00192):
 * akcje na kliencie sesji, bez klucza serwisowego. Firmę, rolę, koszt i treść
 * sprawdza jeszcze raz funkcja bazy, która w jednej transakcji zapisuje wpis,
 * wpisy w dzwonku pozostałych członków firmy (bez autora) i audyt prośby albo
 * jej załatwienia. Akcja nie dubluje więc ani dzwonka, ani `logAudit`.
 *
 * Ponowienie: `expense_comment_add` z tym samym identyfikatorem wpisu i tą samą
 * treścią zwraca `exists` bez zapisu, a `expense_document_request_resolve`
 * powtórzone zwraca `already_resolved` bez zmiany „kto i kiedy”. Oba wyniki to
 * sukces dla przeglądarki.
 */

/**
 * Funkcje z 00192. `types/database.ts` generujemy z produkcji dopiero po wgraniu
 * migracji (AGENTS.md, „Typy bazy”), do tego czasu klient widzi je przez ten kształt.
 */
type RpcResult = PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
interface ExpenseThreadRpc {
  rpc(
    fn: 'expense_comment_add',
    args: { p_expense_id: string; p_kind: string; p_body: string; p_comment_id: string },
  ): RpcResult;
  rpc(fn: 'expense_document_request_resolve', args: { p_comment_id: string }): RpcResult;
}

async function authorized(): Promise<{ ctx: AuthContext } | { error: string }> {
  try {
    return { ctx: await requireOrgRole([...EXPENSE_THREAD_ROLES]) };
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { error: e.message === 'Niewystarczające uprawnienia' ? THREAD_NO_ACCESS : e.message };
    }
    throw e;
  }
}

function field(data: unknown, key: string): unknown {
  return data !== null && typeof data === 'object' ? (data as Record<string, unknown>)[key] : undefined;
}

export async function addExpenseCommentAction(input: ExpenseCommentInput): Promise<AddExpenseCommentResult> {
  const parsed = expenseCommentInputSchema.safeParse(input);
  if (!parsed.success) {
    const bodyIssue = parsed.error.issues.find((issue) => issue.path[0] === 'body');
    return { success: false, error: bodyIssue?.message ?? COMMENT_SAVE_ERROR };
  }
  const { expenseId, commentId, kind, body } = parsed.data;

  const auth = await authorized();
  if ('error' in auth) return { success: false, error: auth.error };
  const db = auth.ctx.supabase as unknown as ExpenseThreadRpc;

  try {
    const { data, error } = await db.rpc('expense_comment_add', {
      p_expense_id: expenseId,
      p_kind: kind,
      p_body: body,
      p_comment_id: commentId,
    });
    if (error) return { success: false, error: error.code === '42501' ? THREAD_NO_ACCESS : COMMENT_SAVE_ERROR };

    const status = field(data, 'status');
    if (status === 'created' || status === 'exists') {
      revalidatePath(`/expenses/${expenseId}`);
      return { success: true, status };
    }
    if (status === 'refused') return { success: false, error: addCommentRefusalText(field(data, 'code')) };
    return { success: false, error: COMMENT_SAVE_ERROR };
  } catch {
    return { success: false, error: COMMENT_SAVE_ERROR };
  }
}

export async function resolveDocumentRequestAction(commentId: string): Promise<ResolveDocumentRequestResult> {
  if (!isThreadUuid(commentId)) return { success: false, error: REQUEST_RESOLVE_ERROR };

  const auth = await authorized();
  if ('error' in auth) return { success: false, error: auth.error };
  const db = auth.ctx.supabase as unknown as ExpenseThreadRpc;

  try {
    const { data, error } = await db.rpc('expense_document_request_resolve', { p_comment_id: commentId });
    if (error) return { success: false, error: error.code === '42501' ? THREAD_NO_ACCESS : REQUEST_RESOLVE_ERROR };

    const status = field(data, 'status');
    if (status === 'resolved' || status === 'already_resolved') {
      // Koszt do odświeżenia z odpowiedzi bazy (prośba tej firmy), nie z przeglądarki.
      const expenseId = field(data, 'expense_id');
      if (isThreadUuid(expenseId)) revalidatePath(`/expenses/${expenseId}`);
      return { success: true, status };
    }
    if (status === 'refused') return { success: false, error: resolveRefusalText(field(data, 'code')) };
    return { success: false, error: REQUEST_RESOLVE_ERROR };
  } catch {
    return { success: false, error: REQUEST_RESOLVE_ERROR };
  }
}
