'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ANALYTICS_EVENTS } from '@/lib/analytics/events';
import { trackServer } from '@/lib/analytics/server';
import { logAudit } from '@/lib/audit/log';
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
import { ActionAuthError, requireOrgRole, type AuthContext } from '@/lib/supabase/auth-context';

/**
 * „Zapłacone” jednym dotknięciem (FaktWay 1.0 §3 pkt 3): akcje na kliencie
 * sesji, bez klucza serwisowego. Firmę, rolę i wszystkie warunki sprawdza
 * jeszcze raz RPC z 00158 w jednej transakcji z zapisem, a `payments` zostaje
 * zablokowana dla sesji (00074).
 *
 * Ponowienie: oba RPC są idempotentne (drugie oznaczenie zwraca `already_paid`,
 * drugie cofnięcie `nothing_to_undo`, oba bez zapisu), więc audyt i analityka
 * idą tylko po rzeczywistej zmianie.
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

async function authorized(): Promise<{ ctx: AuthContext } | { error: string }> {
  try {
    return { ctx: await requireOrgRole([...INVOICE_PAYMENT_ROLES]) };
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return {
        error: e.message === 'Niewystarczające uprawnienia'
          ? 'Zapłatę oznacza właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.'
          : e.message,
      };
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
  await logAudit({
    tenantId,
    userId: user.id,
    action: 'invoice.marked_paid',
    entityType: 'invoice',
    entityId: invoiceId,
    metadata: {
      amount,
      paidOn: day,
      customDate: paidOn !== undefined,
      paymentId: text(result.payment_id),
      remindersCancelled: Number(result.reminders_cancelled ?? 0),
    },
  });
  await invalidateTenantDashboard(tenantId);
  revalidatePaymentViews(invoiceId);
  await trackServer({
    distinctId: user.id,
    event: ANALYTICS_EVENTS.invoiceMarkedPaid,
    properties: { tenant_id: tenantId, source: 'manual', role },
  });
  return { success: true, status: 'marked', amount, paidOn: day, number };
}

export async function undoInvoicePaidAction(invoiceId: string): Promise<UndoInvoicePaidResult> {
  if (!invoiceIdSchema.safeParse(invoiceId).success) return { success: false, error: UNDO_PAID_FAILED };
  const auth = await authorized();
  if ('error' in auth) return { success: false, error: auth.error };
  const { supabase, tenantId, user } = auth.ctx;

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

  await logAudit({
    tenantId,
    userId: user.id,
    action: 'invoice.paid_undone',
    entityType: 'invoice',
    entityId: invoiceId,
    metadata: {
      amount: Number(result.amount),
      paidOn: String(result.paid_on),
      remindersRestored: Number(result.reminders_restored ?? 0),
    },
  });
  await invalidateTenantDashboard(tenantId);
  revalidatePaymentViews(invoiceId);
  return { success: true, status: 'undone' };
}
