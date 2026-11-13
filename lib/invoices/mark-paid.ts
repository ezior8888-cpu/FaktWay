import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ANALYTICS_EVENTS } from '@/lib/analytics/events';
import { trackServer } from '@/lib/analytics/server';
import { invalidateTenantDashboard } from '@/lib/cache/invalidation';
import {
  INVOICE_PAYMENT_ROLES,
  MARK_PAID_FAILED,
  markPaidRefusalText,
  UNDO_PAID_FAILED,
  type MarkInvoicePaidResult,
  type MarkPaidRefusal,
  type UndoInvoicePaidResult,
} from '@/lib/invoices/manual-payment';
import { sendJobEvent } from '@/lib/jobs/enqueue';
import { invoicePaymentReceived } from '@/lib/jobs/events';
import type { UserRole } from '@/lib/supabase/auth-context';
import { emitWebhookEvent } from '@/lib/webhooks/emit';

/**
 * „Zapłacone” i „Cofnij” jednym dotknięciem (FaktWay 1.0 §3 pkt 3), wspólne
 * dla akcji strony (`app/actions/invoice-payments.ts`, sesja z ciasteczek)
 * i API telefonu (`lib/api/mobile/naleznosci.ts`, sesja z tokenu; plan
 * aplikacji mobilnej 4.3, M10a). Logika przeniesiona z akcji bez zmian.
 *
 * Klient bazy to zawsze klient sesji klienta (RLS), nigdy klucz serwisowy.
 * Firmę, rolę i wszystkie warunki sprawdza jeszcze raz RPC z 00158 w jednej
 * transakcji z zapisem, a `payments` zostaje zablokowana dla sesji (00074).
 * Audyt (`invoice.marked_paid`, `invoice.paid_undone`) zapisują same RPC.
 *
 * Ponowienie: oba RPC są idempotentne (drugie oznaczenie zwraca
 * `already_paid`, drugie cofnięcie `nothing_to_undo`, oba bez zapisu), więc
 * pamięć podręczna, zdarzenie wpłaty, analityka i webhook idą tylko po
 * rzeczywistej zmianie.
 */

export interface PaymentActor {
  supabase: SupabaseClient;
  tenantId: string;
  userId: string;
  role: UserRole;
}

/**
 * Funkcje z 00158. `types/database.ts` generujemy z produkcji dopiero po wgraniu
 * migracji (AGENTS.md, „Typy bazy”), do tego czasu klient widzi je przez ten kształt.
 */
type RpcResult = PromiseLike<{ data: unknown; error: { code?: string; message: string; hint?: string | null } | null }>;
interface ManualPaymentRpc {
  rpc(fn: 'mark_invoice_paid', args: { p_invoice_id: string; p_paid_on: string | null }): RpcResult;
  rpc(fn: 'undo_invoice_paid', args: { p_invoice_id: string }): RpcResult;
}

export const PAYMENT_ROLE_REFUSAL = {
  mark: 'Zapłatę oznacza właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.',
  record: 'Wpłaty zapisuje właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.',
  void: 'Wpłaty cofa właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.',
} as const;

export function mayChangePayment(role: string): boolean {
  return (INVOICE_PAYMENT_ROLES as readonly string[]).includes(role);
}

const invoiceIdSchema = z.string().uuid();
/** Sam kształt daty: czy nie jest z przyszłości, sprawdza RPC na dzień w Warszawie. */
const paidOnSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});

/** Odmowa przed bazą (zły identyfikator albo dzień); `null`, gdy dane mają poprawny kształt. */
export function markPaidInputRefusal(invoiceId: string, paidOn?: string): Extract<MarkInvoicePaidResult, { success: false }> | null {
  if (!invoiceIdSchema.safeParse(invoiceId).success) return { success: false, error: MARK_PAID_FAILED };
  if (paidOn !== undefined && !paidOnSchema.safeParse(paidOn).success) {
    return { success: false, error: markPaidRefusalText('invalid_date') };
  }
  return null;
}

export function undoPaidInputRefusal(invoiceId: string): Extract<UndoInvoicePaidResult, { success: false }> | null {
  return invoiceIdSchema.safeParse(invoiceId).success ? null : { success: false, error: UNDO_PAID_FAILED };
}

/**
 * Zdarzenie „wpłata zapisana” (krok 8.1): anulowanie przypomnień przy pełnej zapłacie
 * i push „Otrzymana płatność”. Wołane tylko po wyniku „zapisano”, nigdy po
 * `already_*` ani odmowie. Wpłata jest już w bazie, więc błąd kolejki nie psuje
 * akcji: logujemy i idziemy dalej (przypomnienia zdejmuje też RPC, a push to dodatek).
 */
export async function emitPaymentReceived(invoiceId: string, paymentId: string): Promise<void> {
  try {
    await sendJobEvent({
      ...invoicePaymentReceived.create({ invoiceId, paymentId }),
      singletonKey: `payment:${paymentId}`,
    });
  } catch (e) {
    console.error('[invoice-payments] invoice/payment.received', e instanceof Error ? e.message : e);
  }
}

/** Strony, na których zmienia się stan płatności albo suma wpływów. */
export function revalidatePaymentViews(invoiceId: string): void {
  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/payments/overdue');
  revalidatePath('/dashboard');
  revalidatePath('/przeplywy');
  revalidatePath('/analizy/sprzedaz');
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Oznaczenie zapłaty; rola klienta już sprawdzona (akcja: `requireOrgRole`, telefon: `mayChangePayment`). */
export async function markInvoicePaid(actor: PaymentActor, invoiceId: string, paidOn?: string): Promise<MarkInvoicePaidResult> {
  const refused = markPaidInputRefusal(invoiceId, paidOn);
  if (refused) return refused;
  const { supabase, tenantId, userId, role } = actor;

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
    userId,
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

/** Cofnięcie zapłaty oznaczonej „Zapłacone”; rola klienta już sprawdzona. */
export async function undoInvoicePaid(actor: Pick<PaymentActor, 'supabase' | 'tenantId'>, invoiceId: string): Promise<UndoInvoicePaidResult> {
  const refused = undoPaidInputRefusal(invoiceId);
  if (refused) return refused;
  const { supabase, tenantId } = actor;

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
