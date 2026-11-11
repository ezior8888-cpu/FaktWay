'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { invalidateTenantDashboard } from '@/lib/cache/invalidation';
import { parseBankFile } from '@/lib/import/bank';
import {
  BANK_ROLE_REFUSAL,
  DECISION_FAILED,
  FILE_EMPTY,
  FILE_TOO_BIG,
  FILE_TOO_MANY,
  IMPORT_FAILED,
  MAX_BANK_FILE_BYTES,
  MAX_BANK_OPERATIONS,
  NOT_CONFIRMED_TEXT,
  SKIPPED_TEXT,
  bankRefusalText,
  confirmedText,
  groszeZBazy,
  isMatchKind,
  parseErrorText,
  undoneText,
  type BankDecisionResult,
  type ImportBankStatementResult,
} from '@/lib/import/bank/ekran';
import { operationKeys } from '@/lib/import/bank/klucz';
import { kwotaZGroszy } from '@/lib/import/bank/kwoty';
import type { MatchKind } from '@/lib/import/bank/dopasowanie';
import { INVOICE_PAYMENT_ROLES } from '@/lib/invoices/manual-payment';
import { ActionAuthError, requireOrgRole, type AuthContext } from '@/lib/supabase/auth-context';

/**
 * Ekran „Bank” (plan kompletnej aplikacji, krok 3.2, część 1): wgranie wyciągu,
 * potwierdzenie, pominięcie i cofnięcie dopasowania. Akcje na kliencie sesji,
 * bez klucza serwisowego: `payment_imports` i `payments` są zamknięte dla sesji
 * (00074), więc jedyną drogą są RPC z 00180, które firmę i rolę biorą z sesji
 * i same zapisują audyt w transakcji ze zmianą.
 *
 * Wgranie: plik czyta parser po stronie serwera (czyste funkcje
 * `lib/import/bank/`), do bazy idą tylko wpływy w złotych z kluczem duplikatu.
 * Wypływów i innych walut nie zapisujemy (RODO: przechowujemy tylko operacje
 * potrzebne do dopasowania).
 *
 * Ponowienie od zera: ten sam plik wysłany drugi raz daje te same klucze, więc
 * `ON CONFLICT DO NOTHING` nie doda żadnej operacji (RPC zwraca liczbę
 * duplikatów). Potwierdzenie to jedna transakcja RPC z blokadą wiersza
 * operacji; drugie potwierdzenie zwraca `already_confirmed` bez drugiej wpłaty,
 * a klucz idempotencji wpłaty pochodzi z operacji. Pominięcie i cofnięcie są
 * idempotentne (`already_skipped`, `not_confirmed`). Pamięć i widoki odświeżamy
 * przy każdym sukcesie, bo pierwsza próba mogła paść po zapisie.
 */

type RpcResult = PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
/** Funkcje z 00180; do czasu typów z produkcji (`types/database.ts`) przez ten kształt. */
interface BankRpc {
  rpc(fn: 'import_bank_operations', args: { p_file_format: string; p_operations: BankOperationRow[] }): RpcResult;
  rpc(fn: 'confirm_bank_operation', args: { p_operation_id: string; p_invoice_id: string; p_match_kind: MatchKind }): RpcResult;
  rpc(fn: 'skip_bank_operation', args: { p_operation_id: string }): RpcResult;
  rpc(fn: 'undo_bank_operation', args: { p_operation_id: string }): RpcResult;
}

interface BankOperationRow {
  key: string;
  account: string;
  booking_date: string;
  /** Kwota w złotych jako napis z kropką, liczona z groszy (bez liczb zmiennoprzecinkowych). */
  amount: string;
  currency: string;
  counterparty_name: string | null;
  counterparty_account: string | null;
  title: string | null;
  reference: string | null;
}

const uuid = z.string().uuid();

async function authorized(): Promise<{ ctx: AuthContext } | { error: string }> {
  try {
    return { ctx: await requireOrgRole([...INVOICE_PAYMENT_ROLES]) };
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { error: e.message === 'Niewystarczające uprawnienia' ? BANK_ROLE_REFUSAL : e.message };
    }
    throw e;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function money(value: unknown): number | null {
  const grosze = groszeZBazy(value);
  return grosze === null ? null : grosze / 100;
}

/** Strony, na których zmienia się stan płatności faktury albo lista operacji. */
function revalidateBankViews(invoiceId: string | null): void {
  revalidatePath('/bank');
  revalidatePath('/invoices');
  if (invoiceId) revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/payments/overdue');
  revalidatePath('/dashboard');
  revalidatePath('/przeplywy');
  revalidatePath('/analizy/sprzedaz');
}

export async function importBankStatementAction(formData: FormData): Promise<ImportBankStatementResult> {
  const file = formData.get('file');
  if (!(file instanceof File)) return { success: false, error: FILE_EMPTY };
  if (file.size === 0) return { success: false, error: FILE_EMPTY };
  if (file.size > MAX_BANK_FILE_BYTES) return { success: false, error: FILE_TOO_BIG };

  const auth = await authorized();
  if ('error' in auth) return { success: false, error: auth.error };
  const { supabase } = auth.ctx;

  const parsed = parseBankFile(new Uint8Array(await file.arrayBuffer()));
  if (!parsed.ok) return { success: false, error: parseErrorText(parsed.code) };

  const credits = parsed.operations.filter((op) => op.amountGrosze > 0 && op.currency === 'PLN');
  const debitsSkipped = parsed.operations.filter((op) => op.amountGrosze < 0).length;
  const otherCurrencySkipped = parsed.operations.filter((op) => op.amountGrosze > 0 && op.currency !== 'PLN').length;
  const summary = { success: true as const, format: parsed.format, debitsSkipped, otherCurrencySkipped };
  if (credits.length === 0) return { ...summary, inserted: 0, duplicates: 0 };
  if (credits.length > MAX_BANK_OPERATIONS) return { success: false, error: FILE_TOO_MANY };

  const keys = operationKeys(credits);
  const operations: BankOperationRow[] = credits.map((op, i) => ({
    key: keys[i]!,
    account: op.account,
    booking_date: op.bookingDate,
    amount: kwotaZGroszy(op.amountGrosze),
    currency: op.currency,
    counterparty_name: op.counterpartyName,
    counterparty_account: op.counterpartyAccount,
    title: op.title,
    reference: op.bankReference,
  }));

  const { data, error } = await (supabase as unknown as BankRpc).rpc('import_bank_operations', {
    p_file_format: parsed.format,
    p_operations: operations,
  });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[bank-statement] import_bank_operations', error?.code);
    return { success: false, error: IMPORT_FAILED };
  }
  const result = data as Record<string, unknown>;
  if (result.status !== 'imported' || typeof result.inserted !== 'number' || typeof result.duplicates !== 'number') {
    console.error('[bank-statement] import_bank_operations odmowa', text(result.code));
    return { success: false, error: IMPORT_FAILED };
  }
  revalidatePath('/bank');
  return { ...summary, inserted: result.inserted, duplicates: result.duplicates };
}

export async function confirmBankOperationAction(input: {
  operationId: string;
  invoiceId: string;
  matchKind: MatchKind;
}): Promise<BankDecisionResult> {
  if (!uuid.safeParse(input?.operationId).success || !uuid.safeParse(input?.invoiceId).success || !isMatchKind(input?.matchKind)) {
    return { success: false, error: DECISION_FAILED };
  }
  const auth = await authorized();
  if ('error' in auth) return { success: false, error: auth.error };
  const { supabase, tenantId } = auth.ctx;

  const { data, error } = await (supabase as unknown as BankRpc).rpc('confirm_bank_operation', {
    p_operation_id: input.operationId,
    p_invoice_id: input.invoiceId,
    p_match_kind: input.matchKind,
  });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[bank-statement] confirm_bank_operation', error?.code);
    return { success: false, error: DECISION_FAILED };
  }
  const result = data as Record<string, unknown>;
  const number = text(result.internal_number);
  if (result.status === 'refused') {
    return {
      success: false,
      error: bankRefusalText(result.code, { number, remaining: money(result.remaining), currency: text(result.currency) }),
    };
  }
  if (result.status !== 'confirmed' && result.status !== 'already_confirmed') return { success: false, error: DECISION_FAILED };

  await invalidateTenantDashboard(tenantId);
  revalidateBankViews(input.invoiceId);
  return {
    success: true,
    status: result.status,
    message: confirmedText(result.status, money(result.amount), number, result.payment_status === 'paid'),
  };
}

export async function skipBankOperationAction(operationId: string): Promise<BankDecisionResult> {
  if (!uuid.safeParse(operationId).success) return { success: false, error: DECISION_FAILED };
  const auth = await authorized();
  if ('error' in auth) return { success: false, error: auth.error };

  const { data, error } = await (auth.ctx.supabase as unknown as BankRpc).rpc('skip_bank_operation', { p_operation_id: operationId });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[bank-statement] skip_bank_operation', error?.code);
    return { success: false, error: DECISION_FAILED };
  }
  const result = data as Record<string, unknown>;
  if (result.status === 'refused') {
    return { success: false, error: bankRefusalText(result.code, { number: text(result.internal_number) }) };
  }
  if (result.status !== 'skipped' && result.status !== 'already_skipped') return { success: false, error: DECISION_FAILED };
  revalidatePath('/bank');
  return { success: true, status: result.status, message: SKIPPED_TEXT };
}

export async function undoBankOperationAction(operationId: string): Promise<BankDecisionResult> {
  if (!uuid.safeParse(operationId).success) return { success: false, error: DECISION_FAILED };
  const auth = await authorized();
  if ('error' in auth) return { success: false, error: auth.error };
  const { supabase, tenantId } = auth.ctx;

  const { data, error } = await (supabase as unknown as BankRpc).rpc('undo_bank_operation', { p_operation_id: operationId });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[bank-statement] undo_bank_operation', error?.code);
    return { success: false, error: DECISION_FAILED };
  }
  const result = data as Record<string, unknown>;
  if (result.status === 'refused') {
    return {
      success: false,
      error: bankRefusalText(result.code, {
        number: text(result.internal_number),
        manualPaidOn: text(result.manual_paid_on),
        manualAmount: money(result.manual_amount),
      }),
    };
  }
  if (result.status === 'not_confirmed') {
    revalidatePath('/bank');
    return { success: true, status: 'not_confirmed', message: NOT_CONFIRMED_TEXT };
  }
  if (result.status !== 'undone') return { success: false, error: DECISION_FAILED };

  await invalidateTenantDashboard(tenantId);
  revalidateBankViews(text(result.invoice_id));
  return { success: true, status: 'undone', message: undoneText(money(result.amount)) };
}
