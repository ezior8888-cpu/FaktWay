'use server';

import { revalidatePath } from 'next/cache';
import type { User } from '@supabase/supabase-js';
import { logAudit } from '@/lib/audit/log';
import { validatePassword } from '@/lib/auth/password';
import { reauthenticateWithPassword } from '@/lib/auth/reauth';
import { deleteAllRecoveryCodes } from '@/lib/auth/mfa-recovery';
import { checkMfaRateLimit } from '@/lib/rate-limit/mfa';
import { checkPasswordNonceSendRateLimit } from '@/lib/rate-limit/password';
import { readTurnstileToken } from '@/lib/security/bot-check';
import { createClient } from '@/lib/supabase/server';
import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';

type PasswordOperationError =
  | 'not_authenticated' | 'invalid_current' | 'weak_password' | 'password_breached'
  | 'update_failed' | 'mfa_required' | 'verification_unavailable'
  | 'reauthentication_needed' | 'invalid_nonce' | 'same_password' | 'rate_limited' | 'nonce_send_failed';

type PasswordOperationFailure = { ok: false; error: PasswordOperationError; retryAfter?: number };
export type PasswordChangeResult = { ok: true } | PasswordOperationFailure;
export type PasswordNonceResult = { ok: true } | PasswordOperationFailure;

function passwordAuthError(
  error: { code?: string; status?: number },
  fallback: 'update_failed' | 'nonce_send_failed',
): PasswordOperationFailure {
  switch (error.code) {
    case 'reauthentication_needed': return { ok: false, error: 'reauthentication_needed' };
    case 'reauthentication_not_valid':
    case 'otp_expired': return { ok: false, error: 'invalid_nonce' };
    case 'current_password_required':
    case 'current_password_mismatch': return { ok: false, error: 'invalid_current' };
    case 'same_password': return { ok: false, error: 'same_password' };
    case 'weak_password': return { ok: false, error: 'weak_password' };
    case 'insufficient_aal': return { ok: false, error: 'mfa_required' };
    case 'session_not_found':
    case 'session_expired':
    case 'bad_jwt': return { ok: false, error: 'not_authenticated' };
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
    case 'over_sms_send_rate_limit': return { ok: false, error: 'rate_limited' };
    default: return { ok: false, error: error.status === 429 ? 'rate_limited' : fallback };
  }
}

async function passwordSession(): Promise<
  PasswordOperationFailure |
  { ok: true; supabase: Awaited<ReturnType<typeof createClient>>; user: User }
> {
  const supabase = await createClient().catch(() => null);
  if (!supabase) return { ok: false, error: 'verification_unavailable' };
  const state = await getVerifiedMfaState(supabase).catch(() => null);
  if (!state) return { ok: false, error: 'verification_unavailable' };
  if (state.status === 'unauthenticated') return { ok: false, error: 'not_authenticated' };
  if (state.status === 'challenge_required') return { ok: false, error: 'mfa_required' };
  return { ok: true, supabase, user: state.user };
}

function readCurrentPassword(formData: FormData): string | null {
  const password = formData.get('current_password');
  // Older passwords need not satisfy today's creation policy; only bound the input.
  return typeof password === 'string' && password.length > 0 && password.length <= 1024 ? password : null;
}

async function checkCurrentPassword(
  currentPassword: string,
  captchaToken: string | undefined,
): Promise<PasswordOperationFailure | null> {
  const reauth = await reauthenticateWithPassword(currentPassword, captchaToken).catch(() => null);
  if (!reauth || (!reauth.ok && (reauth.error === 'unknown' || reauth.error === 'verification_unavailable'))) {
    return { ok: false, error: 'verification_unavailable' };
  }
  if (!reauth.ok && reauth.error === 'rate_limited') return { ok: false, error: 'rate_limited', retryAfter: reauth.retryAfter };
  if (!reauth.ok) return { ok: false, error: reauth.error === 'not_authenticated' ? 'not_authenticated' : 'invalid_current' };
  return null;
}

/**
 * Keep the original MFA session. Isolated password verification does not satisfy
 * GoTrue's separate reauthentication requirement for an old session.
 */
export async function changePasswordAction(formData: FormData): Promise<PasswordChangeResult> {
  const currentPassword = readCurrentPassword(formData);
  if (!currentPassword) return { ok: false, error: 'invalid_current' };
  const newPassword = formData.get('new_password');
  if (typeof newPassword !== 'string' || !newPassword || newPassword.length > 128) {
    return { ok: false, error: 'weak_password' };
  }
  const rawNonce = formData.get('nonce');
  if (rawNonce !== null && (typeof rawNonce !== 'string' || (rawNonce !== '' && !/^[0-9]{6,10}$/.test(rawNonce)))) {
    return { ok: false, error: 'invalid_nonce' };
  }
  const nonce = typeof rawNonce === 'string' ? rawNonce : '';

  const session = await passwordSession();
  if (!session.ok) return session;
  const { supabase, user } = session;
  const reauthError = await checkCurrentPassword(currentPassword, readTurnstileToken(formData));
  if (reauthError) return reauthError;

  const pw = await validatePassword(newPassword).catch(() => null);
  if (!pw) return { ok: false, error: 'verification_unavailable' };
  if (!pw.valid) return { ok: false, error: pw.reason === 'breached' ? 'password_breached' : 'weak_password' };

  // Keep isolated reauth: the server's current-password requirement may be disabled.
  const result = await supabase.auth.updateUser({
    password: newPassword, current_password: currentPassword, ...(nonce ? { nonce } : {}),
  }).catch(() => null);
  if (!result) return { ok: false, error: 'verification_unavailable' };
  if (result.error) return passwordAuthError(result.error, 'update_failed');
  if (result.data?.user?.id !== user.id) return { ok: false, error: 'verification_unavailable' };

  await logAudit({
    action: 'auth.password_changed',
    tenantId: null,
    userId: user.id,
  });
  revalidatePath('/settings/security');
  return { ok: true };
}

/** Sends a code only after the user explicitly requests it; no password change. */
export async function requestPasswordChangeNonceAction(formData: FormData): Promise<PasswordNonceResult> {
  const currentPassword = readCurrentPassword(formData);
  if (!currentPassword) return { ok: false, error: 'invalid_current' };
  const session = await passwordSession();
  if (!session.ok) return session;
  const { supabase, user } = session;
  const sendLimit = await checkPasswordNonceSendRateLimit(user.id);
  if (sendLimit.unavailable) return { ok: false, error: 'verification_unavailable' };
  if (!sendLimit.allowed) return { ok: false, error: 'rate_limited', retryAfter: sendLimit.retryAfter };
  const reauthError = await checkCurrentPassword(currentPassword, readTurnstileToken(formData));
  if (reauthError) return reauthError;

  const result = await supabase.auth.reauthenticate().catch(() => null);
  if (!result) return { ok: false, error: 'verification_unavailable' };
  if (result.error) return passwordAuthError(result.error, 'nonce_send_failed');
  // reauthenticate() only sends the nonce; it never upgrades AAL or changes a password.
  return { ok: true };
}

export interface EnrollTotpResult {
  ok: boolean;
  factorId?: string;
  qrCode?: string;
  secret?: string;
  error?: 'not_authenticated' | 'enroll_failed' | 'already_enrolled' | 'mfa_required' | 'rate_limited' | 'verification_unavailable';
}

/**
 * Start enrollment TOTP factora. Zwraca QR + secret do pokazania w UI.
 * Factor jest w stanie `unverified` aż do `verifyTotpEnrollmentAction`.
 */
export async function enrollTotpAction(): Promise<EnrollTotpResult> {
  const supabase = await createClient();
  const state = await getVerifiedMfaState(supabase).catch(() => null);
  if (!state) return { ok: false, error: 'verification_unavailable' };
  if (state.status === 'unauthenticated') return { ok: false, error: 'not_authenticated' };
  if (state.status === 'challenge_required') return { ok: false, error: 'mfa_required' };
  if (state.status === 'verified') return { ok: false, error: 'already_enrolled' };

  const limit = await checkMfaRateLimit(state.user.id);
  if (limit.unavailable) return { ok: false, error: 'verification_unavailable' };
  if (!limit.allowed) return { ok: false, error: 'rate_limited' };

  // Auth supplied these factors for this user; stop at any failed cleanup.
  const stale = state.user.factors?.filter(
    (factor) => factor.factor_type === 'totp' && factor.status === 'unverified',
  ) ?? [];
  for (const factor of stale) {
    const result = await supabase.auth.mfa.unenroll({ factorId: factor.id }).catch(() => null);
    if (!result || result.error) return { ok: false, error: 'enroll_failed' };
  }

  const result = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: `FaktWay ${new Date().toISOString().slice(0, 10)}`,
  }).catch(() => null);
  if (!result || result.error || !result.data) return { ok: false, error: 'enroll_failed' };
  return {
    ok: true,
    factorId: result.data.id,
    qrCode: result.data.totp.qr_code,
    secret: result.data.totp.secret,
  };
}

export type VerifyTotpEnrollmentResult =
  | { ok: true }
  | { ok: false; error: 'not_authenticated' | 'verify_failed' | 'mfa_required' | 'rate_limited' | 'verification_unavailable' };

/** Verify this user's pending TOTP factor and confirm the issued AAL2 session. */
export async function verifyTotpEnrollmentAction(
  factorId: string,
  code: string,
): Promise<VerifyTotpEnrollmentResult> {
  const supabase = await createClient();
  const state = await getVerifiedMfaState(supabase).catch(() => null);
  if (!state) return { ok: false, error: 'verification_unavailable' };
  if (state.status === 'unauthenticated') return { ok: false, error: 'not_authenticated' };
  if (state.status === 'challenge_required') return { ok: false, error: 'mfa_required' };
  if (state.status !== 'enrollment_required' || typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) {
    return { ok: false, error: 'verify_failed' };
  }
  const { user } = state;
  const factor = user.factors?.find(
    (item) => item.id === factorId && item.factor_type === 'totp' && item.status === 'unverified',
  );
  if (!factor) return { ok: false, error: 'verify_failed' };

  const limit = await checkMfaRateLimit(user.id);
  if (limit.unavailable) return { ok: false, error: 'verification_unavailable' };
  if (!limit.allowed) return { ok: false, error: 'rate_limited' };

  const challenge = await supabase.auth.mfa.challenge({ factorId }).catch(() => null);
  if (!challenge || challenge.error || !challenge.data) return { ok: false, error: 'verify_failed' };
  const verified = await supabase.auth.mfa.verify({
    factorId, challengeId: challenge.data.id, code,
  }).catch(() => null);
  if (!verified || verified.error) return { ok: false, error: 'verify_failed' };

  const finalState = await getVerifiedMfaState(supabase).catch(() => null);
  if (!finalState || finalState.status !== 'verified' || finalState.user.id !== user.id ||
      !finalState.user.factors?.some((item) => item.id === factorId && item.status === 'verified' && item.factor_type === 'totp')) {
    return { ok: false, error: 'verification_unavailable' };
  }

  await logAudit({
    action: 'auth.mfa_enrolled', tenantId: null, userId: user.id,
    metadata: { factor_id: factorId },
  });
  revalidatePath('/settings/security');
  revalidatePath('/login/two-factor/setup');
  return { ok: true };
}

export type UnenrollTotpResult =
  | { ok: true }
  | { ok: false; error: 'not_authenticated' | 'invalid_password' | 'mfa_required' | 'unenroll_failed' | 'unenroll_incomplete' | 'verification_unavailable' | 'rate_limited'; retryAfter?: number };

/**
 * Removes this user's TOTP factors after MFA and rate-limited password reauth.
 * Auth deletions are separate operations; a partial failure is not a rollback.
 */
export async function unenrollTotpAction(
  currentPassword: string,
  captchaToken?: string,
): Promise<UnenrollTotpResult> {
  if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 1024) {
    return { ok: false, error: 'invalid_password' };
  }
  const supabase = await createClient().catch(() => null);
  if (!supabase) return { ok: false, error: 'verification_unavailable' };
  // Check the original MFA session before verifying the password.
  const state = await getVerifiedMfaState(supabase).catch(() => null);
  if (state?.status === 'unauthenticated') return { ok: false, error: 'not_authenticated' };
  if (!state) return { ok: false, error: 'verification_unavailable' };
  if (state.status !== 'verified') return { ok: false, error: 'mfa_required' };
  const { user } = state;

  // The reauth helper consumes the same budget as password changes and GDPR.
  const reauth = await reauthenticateWithPassword(currentPassword, captchaToken).catch(() => null);
  if (!reauth || (!reauth.ok && (reauth.error === 'unknown' || reauth.error === 'verification_unavailable'))) {
    return { ok: false, error: 'verification_unavailable' };
  }
  if (!reauth.ok && reauth.error === 'rate_limited') return { ok: false, error: 'rate_limited', retryAfter: reauth.retryAfter };
  if (!reauth.ok) return { ok: false, error: reauth.error === 'not_authenticated' ? 'not_authenticated' : 'invalid_password' };

  const factors = await supabase.auth.mfa.listFactors().catch(() => null);
  if (!factors || factors.error || !Array.isArray(factors.data?.all)) return { ok: false, error: 'unenroll_failed' };
  // Auth supplies factors for the original session; never remove phone/WebAuthn.
  const totp = factors.data.all.filter((factor) => factor.factor_type === 'totp');
  if (!totp.some((factor) => factor.status === 'verified')) return { ok: false, error: 'unenroll_failed' };

  // A failed cleanup must not silently leave old codes behind after disabling TOTP.
  // Recovery stays unavailable; clearing legacy codes does not restore access.
  const cleaned = await deleteAllRecoveryCodes(user.id).then(() => true, () => false);
  if (!cleaned) return { ok: false, error: 'unenroll_failed' };

  let removed = 0;
  for (const factor of totp) {
    const result = await supabase.auth.mfa.unenroll({ factorId: factor.id }).catch(() => null);
    if (!result || result.error) {
      if (removed > 0) revalidatePath('/settings/security');
      return { ok: false, error: removed > 0 ? 'unenroll_incomplete' : 'unenroll_failed' };
    }
    removed += 1;
  }

  await logAudit({
    action: 'auth.mfa_unenrolled',
    tenantId: null,
    userId: user.id,
    metadata: { factor_type: 'totp', removed_count: removed },
  });

  revalidatePath('/settings/security');
  return { ok: true };
}

export type RegenerateRecoveryCodesResult =
  | { ok: false; error: 'not_authenticated' | 'mfa_required' | 'recovery_unavailable' };

/** Keep old clients fail-closed until a complete recovery flow is implemented. */
export async function regenerateRecoveryCodesAction(
  currentPassword: string,
): Promise<RegenerateRecoveryCodesResult> {
  void currentPassword; // Legacy action argument; disabled recovery never verifies or stores it.
  const state = await getVerifiedMfaState(await createClient()).catch(() => null);
  if (state?.status === 'unauthenticated') return { ok: false, error: 'not_authenticated' };
  if (!state || state.status !== 'verified') return { ok: false, error: 'mfa_required' };
  return { ok: false, error: 'recovery_unavailable' };
}
