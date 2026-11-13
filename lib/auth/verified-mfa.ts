import 'server-only';

import type { SupabaseClient, User } from '@supabase/supabase-js';

export type VerifiedMfaState =
  | { status: 'unauthenticated' }
  | { status: 'enrollment_required' | 'challenge_required' | 'verified'; user: User };

type MfaTokenAuth = Pick<SupabaseClient['auth'], 'getUser' | 'getClaims'>;

/**
 * Only the access token is read from cookie storage. Identity and factors come
 * from Auth; AAL comes from verified claims for that EXACT token. Never trust
 * session.user or the no-argument getAuthenticatorAssuranceLevel() as a guard.
 * Auth/verification failures deny access; they never become an AAL1 fallback.
 */
export async function getVerifiedMfaState(
  supabase: { auth: Pick<SupabaseClient['auth'], 'getSession' | 'getUser' | 'getClaims'> },
): Promise<VerifiedMfaState> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw new Error('mfa_session_unavailable');
  const token = sessionData.session?.access_token;
  if (!token) return { status: 'unauthenticated' };
  return getVerifiedMfaStateForToken(supabase.auth, token);
}

/**
 * Ten sam werdykt dla tokenu podanego wprost, a nie z ciasteczek: API aplikacji
 * na telefon (`lib/api/mobile/auth.ts`) dostaje go w nagłówku `Authorization: Bearer`.
 * Tożsamość i czynniki z GoTrue (`getUser`), poziom z claims tego tokenu (`getClaims`).
 */
export async function getVerifiedMfaStateForToken(auth: MfaTokenAuth, token: string): Promise<VerifiedMfaState> {
  const { data: userData, error: userError } = await auth.getUser(token);
  if (userError || !userData.user) return { status: 'unauthenticated' };

  const { data: claimsData, error: claimsError } = await auth.getClaims(token);
  if (claimsError || !claimsData || claimsData.claims.sub !== userData.user.id) {
    throw new Error('mfa_claims_invalid');
  }

  const aal = claimsData.claims.aal;
  if (aal !== 'aal1' && aal !== 'aal2') throw new Error('mfa_assurance_invalid');

  const user = userData.user;
  // A factor unsupported by our UI still protects the account. Do not treat
  // its AAL1 session as an account without MFA at optional-MFA boundaries.
  if (aal === 'aal1' && user.factors?.some((factor) => factor.status === 'verified')) {
    return { status: 'challenge_required', user };
  }
  // TOTP is the factor supported by the application's enrollment/challenge UI.
  // A stale AAL2 token after factor removal must not retain admin privileges.
  if (!user.factors?.some((factor) => factor.factor_type === 'totp' && factor.status === 'verified')) {
    return { status: 'enrollment_required', user };
  }
  return { status: 'verified', user };
}
