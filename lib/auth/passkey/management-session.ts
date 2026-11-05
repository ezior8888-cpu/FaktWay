import 'server-only';

import type { User } from '@supabase/supabase-js';
import type { NextResponse } from 'next/server';

import { passkeyError } from '@/lib/auth/passkey/http';
import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';
import { createClient } from '@/lib/supabase/server';

type ManagementSession =
  | { ok: true; supabase: Awaited<ReturnType<typeof createClient>>; user: User }
  | { ok: false; response: NextResponse };

/**
 * Dodawanie i usuwanie urządzeń: sesja bez znacznika biometrii. `getVerifiedMfaState`
 * wprost, nie bramka panelu: konto z 2FA musi tu podać prawdziwy kod, inaczej
 * skradziona sesja dopisałaby sobie własne urządzenie.
 */
export async function requirePasskeyManagementSession(): Promise<ManagementSession> {
  const supabase = await createClient();
  const state = await getVerifiedMfaState(supabase).catch(() => null);
  if (!state) return { ok: false, response: passkeyError('session_verification_failed', 503) };
  if (state.status === 'unauthenticated') return { ok: false, response: passkeyError('not_authenticated', 401) };
  if (state.status === 'challenge_required') return { ok: false, response: passkeyError('mfa_required', 403) };
  return { ok: true, supabase, user: state.user };
}
