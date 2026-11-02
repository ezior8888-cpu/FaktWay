'use server';

import { revalidatePath } from 'next/cache';
import { logAudit } from '@/lib/audit/log';
import { validatePassword } from '@/lib/auth/password';
import { getVerifiedPasswordRecoveryState } from '@/lib/auth/password-recovery';
import { clearDeviceLoginCookies } from '@/lib/auth/sign-out';
import { checkPasswordOperationRateLimit, claimPasswordRecoverySession } from '@/lib/rate-limit/password';
import { createClient } from '@/lib/supabase/server';

export type ResetPasswordResult =
  | { ok: true; localSessionCleared: boolean; globalSignOutConfirmed: boolean }
  | { ok: false; error: 'invalid_link' | 'mfa_required' | 'weak_password' | 'password_breached'
      | 'password_mismatch' | 'rate_limited' | 'verification_unavailable' | 'restart_required';
      retryAfter?: number };

export async function resetPasswordAction(
  _previous: ResetPasswordResult | null,
  formData: FormData,
): Promise<ResetPasswordResult> {
  const password = formData.get('new_password');
  if (typeof password !== 'string' || !password || password.length > 128) {
    return { ok: false, error: 'weak_password' };
  }
  if (formData.get('confirm_password') !== password) return { ok: false, error: 'password_mismatch' };

  const supabase = await createClient().catch(() => null);
  if (!supabase) return { ok: false, error: 'verification_unavailable' };
  const state = await getVerifiedPasswordRecoveryState(supabase);
  if (state.status === 'challenge_required') return { ok: false, error: 'mfa_required' };
  if (state.status !== 'verified') return { ok: false, error: 'invalid_link' };

  const limit = await checkPasswordOperationRateLimit(state.user.id).catch(() => null);
  if (!limit || limit.unavailable) return { ok: false, error: 'verification_unavailable' };
  if (!limit.allowed) return { ok: false, error: 'rate_limited', retryAfter: limit.retryAfter };
  const strength = await validatePassword(password).catch(() => null);
  if (!strength) return { ok: false, error: 'verification_unavailable' };
  if (!strength.valid) {
    return { ok: false, error: strength.reason === 'breached' ? 'password_breached' : 'weak_password' };
  }

  // Password validation may perform I/O. Recheck proof freshness and MFA before writing.
  const current = await getVerifiedPasswordRecoveryState(supabase);
  if (current.status === 'challenge_required') return { ok: false, error: 'mfa_required' };
  if (current.status !== 'verified' || current.user.id !== state.user.id || current.sessionId !== state.sessionId) {
    return { ok: false, error: 'invalid_link' };
  }

  // Consume before I/O: concurrent or uncertain requests must never update twice.
  // Keep the claim even on Auth failure; the user can request a fresh email.
  const claim = await claimPasswordRecoverySession(state.sessionId).catch(() => null);
  if (!claim || claim.unavailable) return { ok: false, error: 'verification_unavailable' };
  if (!claim.allowed) return { ok: false, error: 'restart_required' };
  const result = await supabase.auth.updateUser({ password }).catch(() => null);
  if (!result || result.error || result.data?.user?.id !== state.user.id) {
    return { ok: false, error: 'restart_required' };
  }

  await logAudit({
    action: 'auth.password_changed', tenantId: null, userId: state.user.id,
    metadata: { method: 'email_recovery' },
  });
  // Unlike auth.signOut(), this preserves 401/403/404 from the Auth server.
  // This is the current user's verified JWT on the ANON client, never service_role.
  const globalLogout = await supabase.auth.admin.signOut(current.accessToken, 'global').catch(() => null);
  // Separate local cookie cleanup: it may tolerate an already-revoked session.
  const localLogout = await supabase.auth.signOut({ scope: 'local' }).catch(() => null);
  await clearDeviceLoginCookies();
  revalidatePath('/', 'layout');
  return {
    ok: true,
    localSessionCleared: !!localLogout && !localLogout.error,
    globalSignOutConfirmed: !!globalLogout && !globalLogout.error,
  };
}
