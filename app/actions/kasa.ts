'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { invalidateTenantDashboard } from '@/lib/cache/invalidation';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { canWriteCash, parseCashAmount } from '@/lib/kasa/model';
import {
  cashCorrectionSchema,
  cashDocumentSchema,
  cashOpeningSchema,
  type CashDocumentField,
  type CashOpeningFields,
  type CorrectCashDocumentInput,
  type CorrectCashDocumentResult,
  type IssueCashDocumentInput,
  type IssueCashDocumentResult,
  type OpenCashRegisterResult,
} from '@/lib/kasa/schemat';
import {
  CASH_CORRECT_FAILED,
  CASH_ISSUE_FAILED,
  CASH_OPEN_FAILED,
  CASH_ROLE_REFUSAL,
  correctionRefusalText,
  isCorrectionRefusal,
  isIssueRefusal,
  isOpeningRefusal,
  issueRefusalField,
  issueRefusalText,
  openingRefusalText,
} from '@/lib/kasa/teksty';
import { ActionAuthError, requireUserAndActiveOrg, type AuthContext } from '@/lib/supabase/auth-context';

/**
 * Kasa (plan kompletnej aplikacji, krok 3.7, 00194): akcje na kliencie sesji,
 * bez klucza serwisowego. Firmę, rolę, numer, stan kasy, fakturę i wpłatę
 * sprawdza jeszcze raz RPC w jednej transakcji z zapisem, a audyt
 * (`cash_document.*`, `cash_register.*`) zapisuje ten sam RPC, więc akcja go
 * nie dubluje.
 *
 * Firma formularza (UX-01): wystawienie i stan początkowy przyjmują firmę, dla
 * której strona wyrenderowała formularz; inna aktywna firma to odmowa przed
 * jakimkolwiek odczytem. Korekta działa na dowodzie wskazanym id, a RPC
 * filtruje firmę z sesji, więc dowód innej firmy to „nie znaleziono”.
 *
 * Ponowienie: klucz idempotencji przychodzi od klienta (jeden na otwarcie
 * formularza albo okna korekty). Drugie wysłanie zwraca `already_issued` z tym
 * samym dowodem, także gdy pierwsze się zapisało, a odpowiedź nie doszła.
 * Widoki odświeżamy przy obu wynikach (obie czynności są idempotentne).
 */

/** Funkcje z 00194: `types/database.ts` dostanie je po wgraniu migracji na produkcję. */
type RpcResult = PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
interface CashRpc {
  rpc(fn: string, args: Record<string, unknown>): RpcResult;
}

const uuid = z.string().uuid();

function rpcClient(ctx: AuthContext): CashRpc {
  return ctx.supabase as unknown as CashRpc;
}

async function authorized(expectedTenantId?: string): Promise<{ ctx: AuthContext } | { error: string }> {
  try {
    const ctx = await requireUserAndActiveOrg(expectedTenantId === undefined ? undefined : { expectedTenantId });
    if (!canWriteCash(ctx.role)) return { error: CASH_ROLE_REFUSAL };
    return { ctx };
  } catch (e) {
    if (e instanceof ActionAuthError) return { error: e.message };
    throw e;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/** Strony, na których zmienia się stan płatności faktury (jak w akcjach wpłat z 3.1). */
async function refreshInvoiceViews(tenantId: string, invoiceId: string): Promise<void> {
  await invalidateTenantDashboard(tenantId);
  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/payments/overdue');
  revalidatePath('/dashboard');
  revalidatePath('/przeplywy');
  revalidatePath('/analizy/sprzedaz');
}

const DOCUMENT_FIELDS: ReadonlySet<string> = new Set<CashDocumentField>([
  'kind', 'source', 'invoiceId', 'paymentId', 'operationDate', 'amount', 'title', 'counterpartyName', 'counterpartyNip',
  'counterpartyAddressLine1', 'counterpartyAddressLine2', 'relatedDocument',
]);

export async function issueCashDocumentAction(input: IssueCashDocumentInput, expectedTenantId: string): Promise<IssueCashDocumentResult> {
  if (!uuid.safeParse(input?.idempotencyKey).success) return { success: false, error: CASH_ISSUE_FAILED };
  const parsed = cashDocumentSchema({ today: todayInWarsaw() }).safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0];
    return {
      success: false,
      error: issue?.message ?? CASH_ISSUE_FAILED,
      ...(typeof field === 'string' && DOCUMENT_FIELDS.has(field) ? { field: field as CashDocumentField } : {}),
    };
  }
  const values = parsed.data;
  const amount = parseCashAmount(values.amount);
  if (amount === null) return { success: false, error: issueRefusalText('invalid_amount'), field: 'amount' };

  const auth = await authorized(expectedTenantId);
  if ('error' in auth) return { success: false, error: auth.error };
  const { tenantId } = auth.ctx;

  const { data, error } = await rpcClient(auth.ctx).rpc('issue_cash_document', {
    p_kind: values.kind,
    p_idempotency_key: input.idempotencyKey,
    p_operation_date: values.operationDate,
    p_amount: amount,
    p_title: values.title,
    p_counterparty: {
      name: values.counterpartyName,
      nip: values.counterpartyNip === '' ? null : values.counterpartyNip,
      addressLine1: values.counterpartyAddressLine1,
      addressLine2: values.counterpartyAddressLine2,
    },
    p_related_document: values.relatedDocument === '' ? null : values.relatedDocument,
    p_invoice_id: values.source === 'invoice' ? values.invoiceId : null,
    p_payment_id: values.source === 'payment' ? values.paymentId : null,
  });
  const result = record(data);
  if (error || !result) {
    console.error('[kasa] issue_cash_document', error?.code);
    return { success: false, error: CASH_ISSUE_FAILED };
  }

  if (result.status === 'refused') {
    const code = result.code;
    // Kod nieznany tej wersji: ogólny komunikat.
    if (!isIssueRefusal(code)) return { success: false, error: CASH_ISSUE_FAILED };
    const field = issueRefusalField(code);
    return {
      success: false,
      error: issueRefusalText(code, {
        available: num(result.available),
        availableOn: text(result.available_on),
        amount: num(result.amount),
        openingDate: text(result.opening_date),
        documentNumber: text(result.document_number),
        invoiceNumber: text(result.invoice_number) ?? text(result.internal_number),
        source: text(result.source),
        invoiceCode: text(result.invoice_code),
        remaining: num(result.remaining),
        currency: text(result.currency),
        paidOn: text(result.paid_on),
      }),
      ...(field ? { field } : {}),
    };
  }
  if (result.status !== 'issued' && result.status !== 'already_issued') return { success: false, error: CASH_ISSUE_FAILED };
  const documentId = text(result.document_id);
  const number = text(result.number);
  if (!documentId || !number) return { success: false, error: CASH_ISSUE_FAILED };

  revalidatePath('/kasa');
  revalidatePath(`/kasa/${documentId}`);
  // KP do faktury zapisał wpłatę (albo zapisał ją pierwszy, niepotwierdzony przebieg).
  const invoiceId = text(result.invoice_id);
  if (invoiceId) await refreshInvoiceViews(tenantId, invoiceId);
  return {
    success: true,
    status: result.status,
    documentId,
    number,
    paymentRecorded: result.payment_recorded === true,
    invoiceNumber: text(result.invoice_number),
  };
}

export async function correctCashDocumentAction(input: CorrectCashDocumentInput): Promise<CorrectCashDocumentResult> {
  if (!uuid.safeParse(input?.documentId).success || !uuid.safeParse(input?.idempotencyKey).success) {
    return { success: false, error: CASH_CORRECT_FAILED };
  }
  const parsed = cashCorrectionSchema.safeParse({ reason: input.reason ?? '' });
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? CASH_CORRECT_FAILED, field: 'reason' };
  }

  const auth = await authorized();
  if ('error' in auth) return { success: false, error: auth.error };
  const { tenantId } = auth.ctx;

  const { data, error } = await rpcClient(auth.ctx).rpc('correct_cash_document', {
    p_document_id: input.documentId,
    p_reason: parsed.data.reason,
    p_idempotency_key: input.idempotencyKey,
  });
  const result = record(data);
  if (error || !result) {
    console.error('[kasa] correct_cash_document', error?.code);
    return { success: false, error: CASH_CORRECT_FAILED };
  }

  if (result.status === 'refused') {
    const code = result.code;
    if (!isCorrectionRefusal(code)) return { success: false, error: CASH_CORRECT_FAILED };
    return {
      success: false,
      error: correctionRefusalText(code, {
        number: text(result.number),
        correctionNumber: text(result.correction_number),
        available: num(result.available),
        availableOn: text(result.available_on),
        amount: num(result.amount),
        paymentCode: text(result.payment_code),
        invoiceNumber: text(result.internal_number) ?? text(result.invoice_number),
        manualPaidOn: text(result.manual_paid_on),
        manualAmount: num(result.manual_amount),
      }),
      ...(code === 'reason_required' ? { field: 'reason' as const } : {}),
    };
  }
  if (result.status !== 'issued' && result.status !== 'already_issued') return { success: false, error: CASH_CORRECT_FAILED };
  const documentId = text(result.document_id);
  const number = text(result.number);
  if (!documentId || !number) return { success: false, error: CASH_CORRECT_FAILED };

  revalidatePath('/kasa');
  revalidatePath(`/kasa/${input.documentId}`);
  revalidatePath(`/kasa/${documentId}`);
  const invoiceId = text(result.invoice_id);
  if (invoiceId) await refreshInvoiceViews(tenantId, invoiceId);
  return {
    success: true,
    status: result.status,
    documentId,
    number,
    correctsNumber: text(result.corrects_number) ?? '',
    paymentVoided: result.payment_voided === true,
    invoiceNumber: text(result.invoice_number),
  };
}

const OPENING_FIELDS: ReadonlySet<string> = new Set<keyof CashOpeningFields>(['openingDate', 'openingBalance']);

export async function openCashRegisterAction(input: CashOpeningFields, expectedTenantId: string): Promise<OpenCashRegisterResult> {
  const parsed = cashOpeningSchema({ today: todayInWarsaw() }).safeParse(input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0];
    return {
      success: false,
      error: issue?.message ?? CASH_OPEN_FAILED,
      ...(typeof field === 'string' && OPENING_FIELDS.has(field) ? { field: field as keyof CashOpeningFields } : {}),
    };
  }
  const balance = parseCashAmount(parsed.data.openingBalance, { allowZero: true });
  if (balance === null) return { success: false, error: openingRefusalText('invalid_amount'), field: 'openingBalance' };

  const auth = await authorized(expectedTenantId);
  if ('error' in auth) return { success: false, error: auth.error };

  const { data, error } = await rpcClient(auth.ctx).rpc('open_cash_register', {
    p_opening_date: parsed.data.openingDate,
    p_opening_balance: balance,
  });
  const result = record(data);
  if (error || !result) {
    console.error('[kasa] open_cash_register', error?.code);
    return { success: false, error: CASH_OPEN_FAILED };
  }
  if (result.status === 'refused') {
    const code = result.code;
    if (!isOpeningRefusal(code)) return { success: false, error: CASH_OPEN_FAILED };
    const field = code === 'invalid_amount' ? 'openingBalance' : code === 'documents_exist' ? undefined : 'openingDate';
    return {
      success: false,
      error: openingRefusalText(code, { openingBalance: num(result.opening_balance), openingDate: text(result.opening_date) }),
      ...(field ? { field } : {}),
    };
  }
  if (result.status !== 'opened' && result.status !== 'updated' && result.status !== 'unchanged') {
    return { success: false, error: CASH_OPEN_FAILED };
  }
  revalidatePath('/kasa');
  return { success: true, status: result.status };
}
