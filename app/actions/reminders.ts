'use server';

import { revalidatePath } from 'next/cache';
import { checkRateLimit } from '@/lib/rate-limit';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getGlobalFlagForExecution } from '@/lib/feature-flags/global-flags';
import { isKindEnabledForTenant } from '@/lib/flo/kind-switch';
import { floDb } from '@/lib/flo/db-types';
import { computeFingerprint } from '@/lib/flo/fingerprint';
import { proposalApprovalVersion } from '@/lib/flo/approval-version';
import { hasReminderDispatch } from '@/lib/reminders/delivery-consent';
import { isReminderInvoiceChaseable, reminderRefusalMessage } from '@/lib/reminders/delivery-schema';
import { buildReminderDelivery } from '@/lib/reminders/prepare-delivery';

import {
  ActionAuthError,
  requireOrgRole,
  requireUserAndTenant,
} from '@/lib/supabase/auth-context';
import {
  decideNextReminder,
  type InvoiceForScheduling,
  type ReminderStage,
} from '@/lib/reminders/scheduler';
import type { Database } from '@/types/database';

type InvoiceRow = Database['public']['Tables']['invoices']['Row'];

export type ReminderSettingsPayload = Partial<
  Pick<
    Database['public']['Tables']['reminder_settings']['Insert'],
    | 'enabled'
    | 'stage_1_enabled'
    | 'stage_1_days_after_due'
    | 'stage_2_enabled'
    | 'stage_2_days_after_due'
    | 'stage_3_enabled'
    | 'stage_3_days_after_due'
    | 'sender_name'
    | 'sender_email'
    | 'reply_to_email'
    | 'pause_on_reply'
    | 'pause_on_partial_payment'
    | 'send_on_weekdays_only'
    | 'send_hour'
    | 'max_reminders_per_invoice'
  >
>;

function toInvoiceForScheduling(row: InvoiceRow): InvoiceForScheduling {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    internal_number: row.internal_number,
    payment_due_date: row.payment_due_date,
    gross_total: row.gross_total,
    paid_amount: row.paid_amount,
    buyer_data: row.buyer_data,
    buyer_nip: row.buyer_nip,
    reminders_paused: row.reminders_paused,
    invoice_kind: row.invoice_kind,
    payment_data: row.payment_data,
  };
}

function pickDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

// ============================================================================
// Manual trigger reminder dla konkretnej faktury
// ============================================================================

/** Old clients must obtain a fresh preview. A random UUID is not consent. */
export async function triggerManualReminderAction(
  _invoiceId: string,
  _stage?: ReminderStage,
): Promise<{ success: false; error: string }> {
  void _invoiceId; void _stage;
  return { success: false, error: 'Odśwież stronę i sprawdź podgląd przed zleceniem wysyłki.' };
}

const prepareSchema = z.object({
  invoiceId: z.string().uuid(),
  stage: z.enum(['stage_1', 'stage_2', 'stage_3', 'stage_4']).optional(),
  recipientEmail: z.string().trim().email().max(254).optional(),
  sourceProposalId: z.string().uuid().optional(),
  sourceVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine((v) => Boolean(v.sourceProposalId) === Boolean(v.sourceVersion));

export async function prepareReminderAction(input: {
  invoiceId: string; stage?: ReminderStage; recipientEmail?: string;
  sourceProposalId?: string; sourceVersion?: string;
}): Promise<
  | { success: true; proposalId: string; approvalVersion: string; expiresAt: string;
      preview: { from: string; to: string; replyTo: string | null; subject: string;
        body: string; attachment: { filename: string; contentBase64: string } | null } }
  | { success: false; error: string }
> {
  const parsed = prepareSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: 'Sprawdź adres i dane przypomnienia.' };
  try {
    const { supabase, tenantId, user } = await requireUserAndTenant();
    const budget = await checkRateLimit({ bucket: 'reminder_preview', identifier: tenantId,
      limit: 20, windowSeconds: 600 });
    if (!budget.allowed || budget.fallback) return { success: false,
      error: 'Przygotowanie kolejnego podglądu jest chwilowo niedostępne. Spróbuj później.' };
    if (!(await isKindEnabledForTenant('payment.chase', tenantId, undefined,
      () => getGlobalFlagForExecution('killFloAgent'))).enabled) {
      return { success: false, error: 'Przypomnienia są obecnie wyłączone dla tej organizacji.' };
    }
    const args = parsed.data;
    const db = floDb();
    if (args.sourceProposalId) {
      const source = await db.from('flo_proposals').select('*')
        .eq('id', args.sourceProposalId).eq('tenant_id', tenantId).maybeSingle();
      if (source.error || !source.data || source.data.kind !== 'payment.chase' ||
          source.data.payload.invoiceId !== args.invoiceId || source.data.payload.stage !== args.stage ||
          !['open', 'approved'].includes(source.data.status) ||
          !Number.isFinite(Date.parse(source.data.expires_at)) || Date.parse(source.data.expires_at) <= Date.now() ||
          proposalApprovalVersion(source.data) !== args.sourceVersion) {
        return { success: false, error: 'Propozycja zmieniła się. Odśwież ją przed przygotowaniem wiadomości.' };
      }
    }
    const { data: invoice, error } = await supabase.from('invoices').select('*')
      .eq('id', args.invoiceId).eq('tenant_id', tenantId).maybeSingle();
    if (error || !invoice) return { success: false, error: 'Faktura nie znaleziona.' };
    if (!isReminderInvoiceChaseable(invoice)) return { success: false, error: reminderRefusalMessage(invoice) };
    let stage = args.stage;
    if (!stage) {
      const buyer = invoice.buyer_data && typeof invoice.buyer_data === 'object' && !Array.isArray(invoice.buyer_data)
        ? invoice.buyer_data : {};
      const decision = await decideNextReminder(toInvoiceForScheduling({ ...invoice,
        buyer_data: args.recipientEmail ? { ...buyer, email: args.recipientEmail } : invoice.buyer_data,
      }));
      if (!decision.shouldSend || !decision.stage) return { success: false, error: decision.skipReason ?? 'Nie ma co wysłać.' };
      stage = decision.stage;
    }
    if (await hasReminderDispatch(tenantId, args.invoiceId, stage)) {
      return { success: false, error: 'Ten etap już zlecono. Nie ponawiaj wysyłki; status musi sprawdzić administrator.' };
    }
    const delivery = await buildReminderDelivery(tenantId, args.invoiceId, stage, args.recipientEmail);
    const payload = { invoiceId: args.invoiceId, stage, delivery, preparedBy: user.id };
    const { fingerprint, state } = await computeFingerprint('payment.chase', payload, tenantId);
    // A separate immutable draft avoids overwriting a card another tab is approving.
    const id = randomUUID();
    const inserted = await db.from('flo_proposals').insert({
      id, tenant_id: tenantId, kind: 'payment.chase', topic_key: 'reminder-preview:' + id,
      status: 'open', title: 'Sprawdź przypomnienie przed wysyłką', body: delivery.text,
      payload: { ...payload, facts: state.facts }, fingerprint,
      expires_at: delivery.expiresAt, priority: 10,
    }).select('*').single();
    if (inserted.error || !inserted.data) throw new Error('Nie udało się zapisać podglądu.');
    return { success: true, proposalId: id, approvalVersion: proposalApprovalVersion(inserted.data),
      expiresAt: delivery.expiresAt, preview: { from: delivery.from, to: delivery.to,
        replyTo: delivery.replyTo, subject: delivery.subject, body: delivery.text, attachment: delivery.attachment } };
  } catch (error) {
    if (error instanceof ActionAuthError) return { success: false, error: error.message };
    return { success: false, error: 'Nie udało się przygotować przypomnienia. Sprawdź adres, stan faktury i konfigurację nadawcy.' };
  }
}

// ============================================================================
// Pause/resume przypomnienia dla faktury
// ============================================================================

export async function toggleInvoiceRemindersAction(
  invoiceId: string,
  paused: boolean,
  reason?: string,
): Promise<{ success: boolean; error?: string }> {
  if (!z.string().uuid().safeParse(invoiceId).success ||
      typeof paused !== 'boolean' ||
      (reason !== undefined && (typeof reason !== 'string' || reason.length > 500))) {
    return { success: false, error: 'Nieprawidłowe dane przypomnienia.' };
  }
  let ctx;
  try {
    ctx = await requireUserAndTenant();
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { success: false, error: e.message };
    }
    throw e;
  }

  // The RPC checks the active organization again and changes the invoice plus
  // pending reminders atomically. Direct client writes are removed in 00074.
  const { data, error } = await ctx.supabase.rpc('set_invoice_reminders_paused', {
    p_invoice_id: invoiceId,
    p_paused: paused,
    p_reason: paused ? (reason ?? null) : null,
  });
  if (error || data !== true) {
    return { success: false, error: 'Nie udało się zmienić stanu przypomnień. Spróbuj ponownie.' };
  }

  revalidatePath('/invoices/' + invoiceId);
  revalidatePath('/payments/overdue');
  return { success: true };
}

// ============================================================================
// Update settings Wkurzacza
// ============================================================================

export async function updateReminderSettingsAction(
  settings: ReminderSettingsPayload,
): Promise<{ success: boolean; error?: string }> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { success: false, error: e.message };
    }
    throw e;
  }
  const { supabase, tenantId } = ctx;

  const patch = pickDefined(settings as Record<string, unknown>);

  const { error } = await supabase.from('reminder_settings').upsert(
    {
      tenant_id: tenantId,
      ...patch,
    },
    { onConflict: 'tenant_id' },
  );

  if (error) return { success: false, error: error.message };

  revalidatePath('/settings/reminders');
  return { success: true };
}

// ============================================================================
// Mark contractor as excluded
// ============================================================================

export async function toggleContractorRemindersAction(
  contractorId: string,
  excluded: boolean,
  reason?: string,
): Promise<{ success: boolean; error?: string }> {
  let ctx;
  try {
    ctx = await requireUserAndTenant();
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { success: false, error: e.message };
    }
    throw e;
  }
  const { supabase, tenantId } = ctx;

  const { error } = await supabase
    .from('contractors')
    .update({
      reminder_excluded: excluded,
      reminder_exclusion_reason: excluded ? (reason ?? null) : null,
    })
    .eq('id', contractorId)
    .eq('tenant_id', tenantId);

  if (error) return { success: false, error: error.message };

  revalidatePath('/contractors');
  return { success: true };
}
