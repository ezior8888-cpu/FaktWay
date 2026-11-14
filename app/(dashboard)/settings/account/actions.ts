'use server';

import { headers } from 'next/headers';
import { trustedClientIp } from '@/lib/auth/client-ip';
import { reauthenticateWithPassword } from '@/lib/auth/reauth';
import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';
import { cancelAccountDeletion, scheduleAccountDeletion } from '@/lib/gdpr/account-deletion';
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
  // Żądanie, mail z linkiem anulowania i audyt: `lib/gdpr/account-deletion.ts` (to samo dla telefonu).
  const scheduled = await scheduleAccountDeletion({
    userId: user.id, userEmail: user.email,
    ipAddress: trustedClientIp(requestHeaders) ?? undefined,
    userAgent: requestHeaders.get('user-agent') ?? undefined,
    origin,
  });
  if (!scheduled.ok) {
    return scheduled.error === 'active_subscription'
      ? { ok: false, error: 'active_subscription', organizations: scheduled.organizations }
      : { ok: false, error: 'request_failed' };
  }
  return { ok: true, scheduledFor: scheduled.scheduledFor, alreadyScheduled: scheduled.alreadyScheduled, emailSent: scheduled.emailSent };
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
  const canceled = await cancelAccountDeletion({ userId: user.id, method: 'authenticated_password_confirmation' });
  return canceled.ok ? { ok: true } : { ok: false, error: canceled.error };
}
