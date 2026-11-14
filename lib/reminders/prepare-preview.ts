import 'server-only';

import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { getGlobalFlagForExecution } from '@/lib/feature-flags/global-flags';
import { proposalApprovalVersion } from '@/lib/flo/approval-version';
import { floDb } from '@/lib/flo/db-types';
import { computeFingerprint } from '@/lib/flo/fingerprint';
import { isKindEnabledForTenant } from '@/lib/flo/kind-switch';
import { checkRateLimit } from '@/lib/rate-limit';
import { hasReminderDispatch } from '@/lib/reminders/delivery-consent';
import { isReminderInvoiceChaseable, reminderRefusalMessage } from '@/lib/reminders/delivery-schema';
import { buildReminderDelivery } from '@/lib/reminders/prepare-delivery';
import { decideNextReminder, type InvoiceForScheduling, type ReminderStage } from '@/lib/reminders/scheduler';
import type { Database } from '@/types/database';

/**
 * Podgląd przypomnienia o zapłacie przed zgodą (okno „Przygotuj przypomnienie”),
 * wspólny dla akcji strony (`prepareReminderAction`, sesja z ciasteczek)
 * i API telefonu (`POST /api/mobile/v1/faktury/{id}/przypomnienie`, sesja
 * z tokenu; plan aplikacji mobilnej 4.3, M10a). Logika przeniesiona z akcji
 * bez zmian. Przygotowanie nigdy nie wysyła poczty: zapisuje osobny,
 * niezmienny szkic propozycji `payment.chase`, który klient zatwierdza
 * dokładnie w tej wersji (`approveFloProposal`).
 *
 * Ponowienie: każde przygotowanie to nowy szkic z nowym id (limit 20 na
 * 10 minut na firmę); zatwierdzić można tylko ten, który klient obejrzał.
 */

type InvoiceRow = Database['public']['Tables']['invoices']['Row'];

export interface ReminderPreviewActor {
  /** Klient sesji klienta (RLS): odczyt faktury. */
  supabase: SupabaseClient<Database>;
  tenantId: string;
  userId: string;
}

export interface PrepareReminderInput {
  invoiceId: string;
  stage?: ReminderStage;
  recipientEmail?: string;
  sourceProposalId?: string;
  sourceVersion?: string;
}

export type PrepareReminderResult =
  | { success: true; proposalId: string; approvalVersion: string; expiresAt: string;
      preview: { from: string; to: string; replyTo: string | null; subject: string;
        body: string; attachment: { filename: string; contentBase64: string } | null } }
  | { success: false; error: string };

export const PREPARE_REMINDER_INVALID = 'Sprawdź adres i dane przypomnienia.';
export const PREPARE_REMINDER_FAILED = 'Nie udało się przygotować przypomnienia. Sprawdź adres, stan faktury i konfigurację nadawcy.';

export const prepareReminderSchema = z.object({
  invoiceId: z.string().uuid(),
  stage: z.enum(['stage_1', 'stage_2', 'stage_3', 'stage_4']).optional(),
  recipientEmail: z.string().trim().email().max(254).optional(),
  sourceProposalId: z.string().uuid().optional(),
  sourceVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine((v) => Boolean(v.sourceProposalId) === Boolean(v.sourceVersion));

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

/**
 * Dane już sprawdzone `prepareReminderSchema`. Rzuca przy nieoczekiwanym
 * błędzie (zapis szkicu, odczyt); wywołujący zamienia to na `PREPARE_REMINDER_FAILED`.
 */
export async function prepareReminderPreview(
  actor: ReminderPreviewActor,
  args: z.output<typeof prepareReminderSchema>,
): Promise<PrepareReminderResult> {
  const { supabase, tenantId, userId } = actor;
  const budget = await checkRateLimit({ bucket: 'reminder_preview', identifier: tenantId,
    limit: 20, windowSeconds: 600 });
  if (!budget.allowed || budget.fallback) return { success: false,
    error: 'Przygotowanie kolejnego podglądu jest chwilowo niedostępne. Spróbuj później.' };
  if (!(await isKindEnabledForTenant('payment.chase', tenantId, undefined,
    () => getGlobalFlagForExecution('killFloAgent'))).enabled) {
    return { success: false, error: 'Przypomnienia są obecnie wyłączone dla tej organizacji.' };
  }
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
  const payload = { invoiceId: args.invoiceId, stage, delivery, preparedBy: userId };
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
}
