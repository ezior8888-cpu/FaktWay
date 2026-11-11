'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ANALYTICS_EVENTS } from '@/lib/analytics/events';
import { trackServer } from '@/lib/analytics/server';
import { sendJobEvent } from '@/lib/jobs/enqueue';
import { invoicePaymentReceived } from '@/lib/jobs/events';
import { invalidateTenantDashboard } from '@/lib/cache/invalidation';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import {
  PAYMENT_CURRENCY,
  RECORD_PAYMENT_FAILED,
  VOID_PAYMENT_FAILED,
  isRecordPaymentRefusal,
  isVoidPaymentRefusal,
  parsePaymentAmount,
  paymentEntrySchema,
  recordPaymentRefusalText,
  recordRefusalField,
  voidPaymentRefusalText,
  type PaymentEntryField,
  type RecordInvoicePaymentInput,
  type RecordInvoicePaymentResult,
  type VoidInvoicePaymentResult,
} from '@/lib/invoices/invoice-payments';
import {
  INVOICE_PAYMENT_ROLES,
  MARK_PAID_FAILED,
  markPaidRefusalText,
  UNDO_PAID_FAILED,
  type MarkInvoicePaidResult,
  type MarkPaidRefusal,
  type UndoInvoicePaidResult,
} from '@/lib/invoices/manual-payment';
import { ActionAuthError, requireOrgRole, type AuthContext } from '@/lib/supabase/auth-context';
import { emitWebhookEvent } from '@/lib/webhooks/emit';

/**
 * „Zapłacone” jednym dotknięciem (FaktWay 1.0 §3 pkt 3): akcje na kliencie
 * sesji, bez klucza serwisowego. Firmę, rolę i wszystkie warunki sprawdza
 * jeszcze raz RPC z 00158 w jednej transakcji z zapisem, a `payments` zostaje
 * zablokowana dla sesji (00074).
 *
 * Audyt (`invoice.marked_paid`, `invoice.paid_undone`) zapisują same RPC w tej
 * samej transakcji co wpłata, więc akcja go nie dubluje. Ponowienie: oba RPC są
 * idempotentne (drugie oznaczenie zwraca `already_paid`, drugie cofnięcie
 * `nothing_to_undo`, oba bez zapisu), więc pamięć podręczna i analityka idą tylko
 * po rzeczywistej zmianie.
 */

/**
 * Funkcje z 00158. `types/database.ts` generujemy z produkcji dopiero po wgraniu
 * migracji (AGENTS.md, „Typy bazy”), do tego czasu klient widzi je przez ten kształt.
 */
type RpcResult = PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
interface ManualPaymentRpc {
  rpc(fn: 'mark_invoice_paid', args: { p_invoice_id: string; p_paid_on: string | null }): RpcResult;
  rpc(fn: 'undo_invoice_paid', args: { p_invoice_id: string }): RpcResult;
}
/** Funkcje z 00176 (wpłaty częściowe), do czasu typów z produkcji przez ten kształt. */
interface PaymentEntryRpc {
  rpc(
    fn: 'record_invoice_payment',
    args: {
      p_invoice_id: string;
      p_amount: number;
      p_paid_on: string;
      p_idempotency_key: string;
      p_note: string | null;
      p_currency: string;
    },
  ): RpcResult;
  rpc(fn: 'void_invoice_payment', args: { p_payment_id: string }): RpcResult;
}

/**
 * Zdarzenie „wpłata zapisana” (krok 8.1): anulowanie przypomnień przy pełnej zapłacie
 * i push „Otrzymana płatność”. Wołane tylko po wyniku „zapisano”, nigdy po
 * `already_*` ani odmowie. Wpłata jest już w bazie, więc błąd kolejki nie psuje
 * akcji: logujemy i idziemy dalej (przypomnienia zdejmuje też RPC, a push to dodatek).
 */
async function emitPaymentReceived(invoiceId: string, paymentId: string): Promise<void> {
  try {
    await sendJobEvent({
      ...invoicePaymentReceived.create({ invoiceId, paymentId }),
      singletonKey: `payment:${paymentId}`,
    });
  } catch (e) {
    console.error('[invoice-payments] invoice/payment.received', e instanceof Error ? e.message : e);
  }
}

const invoiceIdSchema = z.string().uuid();
/** Sam kształt daty: czy nie jest z przyszłości, sprawdza RPC na dzień w Warszawie. */
const paidOnSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});

/** Strony, na których zmienia się stan płatności albo suma wpływów. */
function revalidatePaymentViews(invoiceId: string): void {
  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/payments/overdue');
  revalidatePath('/dashboard');
  revalidatePath('/przeplywy');
  revalidatePath('/analizy/sprzedaz');
}

const ROLE_REFUSAL = {
  mark: 'Zapłatę oznacza właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.',
  record: 'Wpłaty zapisuje właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.',
  void: 'Wpłaty cofa właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.',
} as const;

async function authorized(kind: keyof typeof ROLE_REFUSAL = 'mark'): Promise<{ ctx: AuthContext } | { error: string }> {
  try {
    return { ctx: await requireOrgRole([...INVOICE_PAYMENT_ROLES]) };
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { error: e.message === 'Niewystarczające uprawnienia' ? ROLE_REFUSAL[kind] : e.message };
    }
    throw e;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export async function markInvoicePaidAction(invoiceId: string, paidOn?: string): Promise<MarkInvoicePaidResult> {
  if (!invoiceIdSchema.safeParse(invoiceId).success) return { success: false, error: MARK_PAID_FAILED };
  if (paidOn !== undefined && !paidOnSchema.safeParse(paidOn).success) {
    return { success: false, error: markPaidRefusalText('invalid_date') };
  }
  const auth = await authorized();
  if ('error' in auth) return { success: false, error: auth.error };
  const { supabase, tenantId, user, role } = auth.ctx;

  const { data, error } = await (supabase as unknown as ManualPaymentRpc).rpc('mark_invoice_paid', {
    p_invoice_id: invoiceId,
    p_paid_on: paidOn ?? null,
  });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[invoice-payments] mark_invoice_paid', error?.code);
    return { success: false, error: MARK_PAID_FAILED };
  }
  const result = data as Record<string, unknown>;
  const number = text(result.internal_number);

  if (result.status === 'refused') {
    return { success: false, error: markPaidRefusalText(result.code as MarkPaidRefusal, number) };
  }
  if (result.status === 'already_paid') return { success: true, status: 'already_paid', number };
  if (result.status !== 'marked') return { success: false, error: MARK_PAID_FAILED };

  const amount = Number(result.amount);
  const day = String(result.paid_on);
  await invalidateTenantDashboard(tenantId);
  revalidatePaymentViews(invoiceId);
  const markedPaymentId = text(result.payment_id);
  if (markedPaymentId) await emitPaymentReceived(invoiceId, markedPaymentId);
  await trackServer({
    userId: user.id,
    tenantId,
    event: ANALYTICS_EVENTS.invoiceMarkedPaid,
    properties: { source: 'manual', role },
  });
  // Webhook „wpłata zapisana” (krok 7.1, część 3) dla nowej wpłaty z RPC. Fail-open:
  // wpłata jest już zapisana; przy wyłączonej fladze `publicApiEnabled` nic się nie zleca.
  const paymentId = text(result.payment_id);
  if (paymentId) await emitWebhookEvent({ tenantId, type: 'payment.recorded', entityId: paymentId });
  return { success: true, status: 'marked', amount, paidOn: day, number };
}

export async function undoInvoicePaidAction(invoiceId: string): Promise<UndoInvoicePaidResult> {
  if (!invoiceIdSchema.safeParse(invoiceId).success) return { success: false, error: UNDO_PAID_FAILED };
  const auth = await authorized();
  if ('error' in auth) return { success: false, error: auth.error };
  const { supabase, tenantId } = auth.ctx;

  const { data, error } = await (supabase as unknown as ManualPaymentRpc).rpc('undo_invoice_paid', {
    p_invoice_id: invoiceId,
  });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[invoice-payments] undo_invoice_paid', error?.code);
    return { success: false, error: UNDO_PAID_FAILED };
  }
  const result = data as Record<string, unknown>;

  if (result.status === 'refused') {
    return { success: false, error: markPaidRefusalText('not_found') };
  }
  if (result.status === 'nothing_to_undo') return { success: true, status: 'nothing_to_undo' };
  if (result.status !== 'undone') return { success: false, error: UNDO_PAID_FAILED };

  await invalidateTenantDashboard(tenantId);
  revalidatePaymentViews(invoiceId);
  return { success: true, status: 'undone' };
}

// ─── Wpłaty częściowe i historia wpłat (plan kompletnej aplikacji, krok 3.1, 00176) ───
//
// Ta sama księga co „Zapłacone”: RPC `record_invoice_payment` i `void_invoice_payment`
// na kliencie sesji, bez klucza serwisowego. Firmę, rolę, kwotę, datę, walutę i resztę
// do zapłaty sprawdza jeszcze raz RPC na zablokowanym wierszu faktury, a audyt
// (`invoice.payment_recorded`, `invoice.payment_voided`) zapisuje w tej samej
// transakcji co wpłata, więc akcja go nie dubluje.
//
// Ponowienie: klucz idempotencji przychodzi od klienta (jeden na otwarcie okna
// „Zapisz wpłatę”), więc drugie wysłanie tej samej wpłaty zwraca `already_recorded`
// bez drugiego wiersza, także gdy pierwsze wysłanie zapisało wpłatę, a odpowiedź nie
// doszła. Pamięć podręczną i widoki odświeżamy przy obu wynikach (pierwsza akcja mogła
// paść między RPC a odświeżeniem); obie czynności są idempotentne. Drugie cofnięcie
// zwraca `already_voided` bez zmian.

const paymentKeySchema = z.string().uuid();

function amountOf(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function firstIssue(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): { error: string; field?: PaymentEntryField } {
  const issue = issues[0];
  const field = issue?.path[0];
  return {
    error: issue?.message ?? RECORD_PAYMENT_FAILED,
    ...(field === 'amount' || field === 'paidOn' || field === 'note' ? { field } : {}),
  };
}

export async function recordInvoicePaymentAction(input: RecordInvoicePaymentInput): Promise<RecordInvoicePaymentResult> {
  if (!invoiceIdSchema.safeParse(input?.invoiceId).success || !paymentKeySchema.safeParse(input?.idempotencyKey).success) {
    return { success: false, error: RECORD_PAYMENT_FAILED };
  }
  // Faktury walutowe dojdą w kroku 2.1: dziś każda wpłata jest w złotych.
  if (input.currency !== undefined && input.currency.trim().toUpperCase() !== PAYMENT_CURRENCY) {
    return { success: false, error: recordPaymentRefusalText('payment_currency'), field: 'amount' };
  }
  const parsed = paymentEntrySchema({ today: todayInWarsaw() }).safeParse({
    amount: input.amount ?? '',
    paidOn: input.paidOn ?? '',
    note: input.note ?? '',
  });
  if (!parsed.success) return { success: false, ...firstIssue(parsed.error.issues) };
  const amount = parsePaymentAmount(parsed.data.amount);
  if (amount === null) return { success: false, error: recordPaymentRefusalText('invalid_amount'), field: 'amount' };

  const auth = await authorized('record');
  if ('error' in auth) return { success: false, error: auth.error };
  const { supabase, tenantId, user, role } = auth.ctx;

  const { data, error } = await (supabase as unknown as PaymentEntryRpc).rpc('record_invoice_payment', {
    p_invoice_id: input.invoiceId,
    p_amount: amount,
    p_paid_on: parsed.data.paidOn,
    p_idempotency_key: input.idempotencyKey,
    p_note: parsed.data.note === '' ? null : parsed.data.note,
    p_currency: PAYMENT_CURRENCY,
  });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[invoice-payments] record_invoice_payment', error?.code);
    return { success: false, error: RECORD_PAYMENT_FAILED };
  }
  const result = data as Record<string, unknown>;
  const number = text(result.internal_number);

  if (result.status === 'refused') {
    const code = result.code;
    // `invalid_request` (brak klucza) i kod nieznany tej wersji: ogólny komunikat.
    if (!isRecordPaymentRefusal(code)) return { success: false, error: RECORD_PAYMENT_FAILED };
    const field = recordRefusalField(code);
    return {
      success: false,
      error: recordPaymentRefusalText(code, {
        number,
        remaining: typeof result.remaining === 'number' ? result.remaining : null,
        currency: text(result.currency),
      }),
      ...(field ? { field } : {}),
    };
  }
  if (result.status !== 'recorded' && result.status !== 'already_recorded') {
    return { success: false, error: RECORD_PAYMENT_FAILED };
  }
  const paymentId = text(result.payment_id);
  if (!paymentId) return { success: false, error: RECORD_PAYMENT_FAILED };

  const paidInFull = result.payment_status === 'paid';
  await invalidateTenantDashboard(tenantId);
  revalidatePaymentViews(input.invoiceId);
  if (result.status === 'recorded') await emitPaymentReceived(input.invoiceId, paymentId);
  if (result.status === 'recorded' && paidInFull) {
    // Wpłata zamknęła fakturę: ten sam fakt co „Zapłacone”, z innym źródłem.
    await trackServer({
      userId: user.id,
      tenantId,
      event: ANALYTICS_EVENTS.invoiceMarkedPaid,
      properties: { source: 'payment_entry', role },
    });
  }
  return {
    success: true,
    status: result.status,
    paymentId,
    amount: amountOf(result.amount),
    paidOn: String(result.paid_on),
    remaining: amountOf(result.remaining),
    paidInFull,
    number,
  };
}

export async function voidInvoicePaymentAction(paymentId: string): Promise<VoidInvoicePaymentResult> {
  if (!paymentKeySchema.safeParse(paymentId).success) return { success: false, error: VOID_PAYMENT_FAILED };
  const auth = await authorized('void');
  if ('error' in auth) return { success: false, error: auth.error };
  const { supabase, tenantId } = auth.ctx;

  const { data, error } = await (supabase as unknown as PaymentEntryRpc).rpc('void_invoice_payment', {
    p_payment_id: paymentId,
  });
  if (error || typeof data !== 'object' || data === null) {
    console.error('[invoice-payments] void_invoice_payment', error?.code);
    return { success: false, error: VOID_PAYMENT_FAILED };
  }
  const result = data as Record<string, unknown>;
  const number = text(result.internal_number);

  if (result.status === 'refused') {
    if (!isVoidPaymentRefusal(result.code)) return { success: false, error: VOID_PAYMENT_FAILED };
    return {
      success: false,
      error: voidPaymentRefusalText(result.code, {
        number,
        manualPaidOn: text(result.manual_paid_on),
        manualAmount: typeof result.manual_amount === 'number' ? result.manual_amount : null,
      }),
    };
  }
  if (result.status === 'already_voided') return { success: true, status: 'already_voided', amount: null, number };
  if (result.status !== 'voided') return { success: false, error: VOID_PAYMENT_FAILED };

  const invoiceId = text(result.invoice_id);
  await invalidateTenantDashboard(tenantId);
  if (invoiceId) revalidatePaymentViews(invoiceId);
  else revalidatePath('/invoices');
  return { success: true, status: 'voided', amount: amountOf(result.amount), number };
}
