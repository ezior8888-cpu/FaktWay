'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { logAudit } from '@/lib/audit/log';
import { reauthenticateWithPassword } from '@/lib/auth/reauth';
import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';
import { sendGdprDeletionScheduledEmail } from '@/lib/email/send';
import { cancelOwnGdprRequest, createGdprRequest } from '@/lib/gdpr/deletion';
import { GdprDeletionBlockedError } from '@/lib/gdpr/deletion-blockers';
import { readTurnstileToken } from '@/lib/security/bot-check';
import { createClient } from '@/lib/supabase/server';

type GdprActionError = 'not_authenticated' | 'mfa_required' | 'session_verification_failed' | 'invalid_password' | 'no_email' | 'request_failed' | 'not_pending' | 'rate_limited' | 'verification_unavailable' | 'active_subscription';
export type GdprDeletionResult =
  | { ok: true; scheduledFor: string; alreadyScheduled: boolean; emailSent: boolean }
  | { ok: false; error: GdprActionError; retryAfter?: number; organizations?: string[] };
export type GdprCancellationResult = { ok: true } | { ok: false; error: GdprActionError; retryAfter?: number };

async function confirmGdprPassword(formData: FormData): Promise<Exclude<GdprCancellationResult, { ok: true }> | null> {
  const password = formData.get('current_password');
  if (typeof password !== 'string' || !password || password.length > 1024) {
    return { ok: false, error: 'invalid_password' };
  }
  const reauth = await reauthenticateWithPassword(password, readTurnstileToken(formData)).catch(() => null);
  if (!reauth || (!reauth.ok && (reauth.error === 'unknown' || reauth.error === 'verification_unavailable'))) {
    return { ok: false, error: 'verification_unavailable' };
  }
  if (!reauth.ok && reauth.error === 'rate_limited') {
    return { ok: false, error: 'rate_limited', retryAfter: reauth.retryAfter };
  }
  if (!reauth.ok) return { ok: false, error: reauth.error === 'not_authenticated' ? 'not_authenticated' : 'invalid_password' };
  return null;
}

export async function requestGdprDeletionAction(formData: FormData): Promise<GdprDeletionResult> {
  const supabase = await createClient();
  const state = await getVerifiedMfaState(supabase).catch(() => null);
  if (!state) return { ok: false, error: 'session_verification_failed' };
  if (state.status === 'unauthenticated') return { ok: false, error: 'not_authenticated' };
  if (state.status === 'challenge_required') return { ok: false, error: 'mfa_required' };
  const { user } = state;
  if (!user.email) return { ok: false, error: 'no_email' };
  const passwordError = await confirmGdprPassword(formData);
  if (passwordError) return passwordError;

  const requestHeaders = await headers();
  const origin = requestHeaders.get('origin') ?? process.env.NEXT_PUBLIC_APP_URL ?? '';
  try {
    const created = await createGdprRequest({
      userId: user.id, userEmail: user.email,
      ipAddress: requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim()
        ?? requestHeaders.get('x-real-ip') ?? undefined,
      userAgent: requestHeaders.get('user-agent') ?? undefined,
    });
    const scheduledFor = created.scheduledFor.toLocaleDateString('pl-PL', {
      year: 'numeric', month: 'long', day: 'numeric',
    });
    let emailSent = false;
    if (created.cancelToken) {
      try {
        const delivery = await sendGdprDeletionScheduledEmail({
          userEmail: user.email, scheduledFor,
          cancelUrl: `${origin}/gdpr/cancel?token=${created.cancelToken}`,
        });
        emailSent = delivery.sent;
      } catch {
        // Żądanie już istnieje. Pokazujemy prawdziwy stan i możliwość anulowania hasłem.
        emailSent = false;
      }
    }
    if (!created.alreadyScheduled) {
      await logAudit({
        action: 'gdpr.deletion_requested', tenantId: null, userId: user.id,
        metadata: { request_id: created.id, scheduled_for: created.scheduledFor.toISOString() },
      });
    }
    revalidatePath('/settings/account');
    return { ok: true, scheduledFor, alreadyScheduled: created.alreadyScheduled, emailSent };
  } catch (err) {
    if (err instanceof GdprDeletionBlockedError) {
      return { ok: false, error: 'active_subscription', organizations: err.organizations };
    }
    return { ok: false, error: 'request_failed' };
  }
}

/** Awaryjna droga anulowania, gdy mail nie dotarł: sesja + aktualne hasło. */
export async function cancelOwnGdprDeletionAction(formData: FormData): Promise<GdprCancellationResult> {
  const supabase = await createClient();
  const state = await getVerifiedMfaState(supabase).catch(() => null);
  if (!state) return { ok: false, error: 'session_verification_failed' };
  if (state.status === 'unauthenticated') return { ok: false, error: 'not_authenticated' };
  if (state.status === 'challenge_required') return { ok: false, error: 'mfa_required' };
  const { user } = state;
  const passwordError = await confirmGdprPassword(formData);
  if (passwordError) return passwordError;
  try {
    const result = await cancelOwnGdprRequest(user.id);
    if (!result.ok) return { ok: false, error: 'not_pending' };
    await logAudit({
      action: 'gdpr.deletion_canceled', tenantId: null, userId: user.id,
      metadata: { method: 'authenticated_password_confirmation', request_id: result.requestId },
    });
    revalidatePath('/settings/account');
    return { ok: true };
  } catch {
    return { ok: false, error: 'request_failed' };
  }
}
