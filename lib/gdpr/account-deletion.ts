import 'server-only';

import { revalidatePath } from 'next/cache';

import { logAudit } from '@/lib/audit/log';
import { sendGdprDeletionScheduledEmail } from '@/lib/email/send';
import { cancelOwnGdprRequest, createGdprRequest } from '@/lib/gdpr/deletion';
import { GdprDeletionBlockedError } from '@/lib/gdpr/deletion-blockers';

/**
 * Żądanie usunięcia konta (RODO, 14 dni na rezygnację, ADR 0006) i jego
 * anulowanie, wspólne dla akcji strony (`requestGdprDeletionAction`,
 * `cancelOwnGdprDeletionAction`) i telefonu (`POST /api/mobile/v1/konto/usuniecie`,
 * M10b). Logika przeniesiona z akcji bez zmian. Tożsamość, 2FA i hasło
 * (albo świeże logowanie na telefonie) sprawdza wywołujący, zanim tu przyjdzie.
 *
 * Ponowienie: istniejące żądanie oddaje `alreadyScheduled` bez nowego tokenu
 * anulowania, maila ani wpisu w audycie (UNIQUE aktywnego żądania łapie
 * wyścig, `createGdprRequest`); drugie anulowanie to `not_pending` bez zmian.
 */

export type ScheduledAccountDeletion =
  | { ok: true; scheduledAt: Date; scheduledFor: string; alreadyScheduled: boolean; emailSent: boolean }
  | { ok: false; error: 'request_failed' }
  | { ok: false; error: 'active_subscription'; organizations: string[] };

export async function scheduleAccountDeletion(input: {
  userId: string;
  userEmail: string;
  ipAddress?: string;
  userAgent?: string;
  /** Adres strony do linku anulowania w mailu. */
  origin: string;
  /** Dodatki do wpisu `gdpr.deletion_requested` (np. `client: 'mobile'`). */
  auditMetadata?: Record<string, unknown>;
}): Promise<ScheduledAccountDeletion> {
  try {
    const created = await createGdprRequest({
      userId: input.userId, userEmail: input.userEmail,
      ipAddress: input.ipAddress, userAgent: input.userAgent,
    });
    const scheduledFor = created.scheduledFor.toLocaleDateString('pl-PL', {
      year: 'numeric', month: 'long', day: 'numeric',
    });
    let emailSent = false;
    if (created.cancelToken) {
      try {
        const delivery = await sendGdprDeletionScheduledEmail({
          userEmail: input.userEmail, scheduledFor,
          cancelUrl: `${input.origin}/gdpr/cancel?token=${created.cancelToken}`,
        });
        emailSent = delivery.sent;
      } catch {
        // Żądanie już istnieje. Pokazujemy prawdziwy stan i możliwość anulowania hasłem.
        emailSent = false;
      }
    }
    if (!created.alreadyScheduled) {
      await logAudit({
        action: 'gdpr.deletion_requested', tenantId: null, userId: input.userId,
        metadata: { request_id: created.id, scheduled_for: created.scheduledFor.toISOString(), ...input.auditMetadata },
      });
    }
    revalidatePath('/settings/account');
    return { ok: true, scheduledAt: created.scheduledFor, scheduledFor, alreadyScheduled: created.alreadyScheduled, emailSent };
  } catch (err) {
    if (err instanceof GdprDeletionBlockedError) {
      return { ok: false, error: 'active_subscription', organizations: err.organizations };
    }
    return { ok: false, error: 'request_failed' };
  }
}

export type CanceledAccountDeletion = { ok: true } | { ok: false; error: 'not_pending' | 'request_failed' };

export async function cancelAccountDeletion(input: {
  userId: string;
  /** Jak potwierdzono tożsamość (wpis `gdpr.deletion_canceled`, `metadata.method`). */
  method: string;
  auditMetadata?: Record<string, unknown>;
}): Promise<CanceledAccountDeletion> {
  try {
    const result = await cancelOwnGdprRequest(input.userId);
    if (!result.ok) return { ok: false, error: 'not_pending' };
    await logAudit({
      action: 'gdpr.deletion_canceled', tenantId: null, userId: input.userId,
      metadata: { method: input.method, request_id: result.requestId, ...input.auditMetadata },
    });
    revalidatePath('/settings/account');
    return { ok: true };
  } catch {
    return { ok: false, error: 'request_failed' };
  }
}
