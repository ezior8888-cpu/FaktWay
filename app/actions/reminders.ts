'use server';

import { revalidatePath } from 'next/cache';

import {
  ActionAuthError,
  requireOrgRole,
  requireUserAndTenant,
} from '@/lib/supabase/auth-context';
import type { ReminderStage } from '@/lib/reminders/scheduler';
import {
  PREPARE_REMINDER_FAILED,
  PREPARE_REMINDER_INVALID,
  prepareReminderPreview,
  prepareReminderSchema,
  type PrepareReminderInput,
  type PrepareReminderResult,
} from '@/lib/reminders/prepare-preview';
import { reminderPauseInputRefusal, setInvoiceRemindersPaused } from '@/lib/reminders/pause';
import type { Database } from '@/types/database';

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

export async function prepareReminderAction(input: PrepareReminderInput): Promise<PrepareReminderResult> {
  const parsed = prepareReminderSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: PREPARE_REMINDER_INVALID };
  try {
    const { supabase, tenantId, user } = await requireUserAndTenant();
    // Podgląd i jego zapis: `lib/reminders/prepare-preview.ts` (ten sam dla telefonu).
    return await prepareReminderPreview({ supabase, tenantId, userId: user.id }, parsed.data);
  } catch (error) {
    if (error instanceof ActionAuthError) return { success: false, error: error.message };
    return { success: false, error: PREPARE_REMINDER_FAILED };
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
  const invalid = reminderPauseInputRefusal(invoiceId, paused, reason);
  if (invalid) return invalid;
  let ctx;
  try {
    ctx = await requireUserAndTenant();
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { success: false, error: e.message };
    }
    throw e;
  }
  // RPC i odświeżenie widoków: `lib/reminders/pause.ts` (to samo dla telefonu).
  return setInvoiceRemindersPaused(ctx.supabase, invoiceId, paused, reason);
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
