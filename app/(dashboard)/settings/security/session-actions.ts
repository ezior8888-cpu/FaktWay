'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { logAudit } from '@/lib/audit/log';
import { accountSecurityRefusal } from '@/lib/auth/sessions/load';
import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';
import { createClient } from '@/lib/supabase/server';

/**
 * Wylogowanie na odległość (krok 8.5): jedno urządzenie albo wszystkie poza tym.
 *
 * Klient z sesji użytkownika i funkcje 00174 (`revoke_account_session`,
 * `revoke_other_account_sessions`): baza usuwa wiersz `auth.sessions` tylko
 * własnego konta, nigdy bieżącej sesji, i tylko z sesji z kodem 2FA (AAL2) albo
 * z konta bez 2FA. GoTrue robi przy wylogowaniu to samo (DELETE z `auth.sessions`),
 * a proxy aplikacji przy następnym żądaniu wylogowanego urządzenia dostaje od
 * GoTrue `session_not_found` i kieruje na logowanie.
 *
 * Kod 2FA sprawdzamy też tutaj (`getVerifiedMfaState`), żeby sesja po biometrii
 * od razu dostała przejście do kodu, zamiast odmowy z bazy.
 */

const PATH = '/settings/security';
const revokeSessionInput = z.object({ sessionId: z.string().uuid() });

export type SessionActionError =
  | 'invalid_request'
  | 'not_authenticated'
  | 'mfa_required'
  | 'current_session'
  | 'verification_unavailable'
  | 'failed';

type Failure = { ok: false; error: SessionActionError };
export type RevokeSessionResult = { ok: true; revoked: boolean } | Failure;
export type RevokeOtherSessionsResult = { ok: true; count: number } | Failure;

async function sessionClient(): Promise<
  Failure | { ok: true; supabase: Awaited<ReturnType<typeof createClient>>; userId: string }
> {
  const supabase = await createClient().catch(() => null);
  if (!supabase) return { ok: false, error: 'verification_unavailable' };
  const state = await getVerifiedMfaState(supabase).catch(() => null);
  if (!state) return { ok: false, error: 'verification_unavailable' };
  if (state.status === 'unauthenticated') return { ok: false, error: 'not_authenticated' };
  if (state.status === 'challenge_required') return { ok: false, error: 'mfa_required' };
  return { ok: true, supabase, userId: state.user.id };
}

function refusal(error: { code?: string | null; message?: string | null }): Failure {
  switch (accountSecurityRefusal(error)) {
    case 'code_step_required': return { ok: false, error: 'mfa_required' };
    case 'session_not_found': return { ok: false, error: 'not_authenticated' };
    case 'current_session': return { ok: false, error: 'current_session' };
    default: return { ok: false, error: 'failed' };
  }
}

export async function revokeSessionAction(input: unknown): Promise<RevokeSessionResult> {
  const parsed = revokeSessionInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_request' };
  const { sessionId } = parsed.data;

  const session = await sessionClient();
  if (!session.ok) return session;

  let result: { data: unknown; error: { code?: string | null; message?: string | null } | null };
  try {
    result = await session.supabase.rpc('revoke_account_session', { p_session_id: sessionId });
  } catch {
    return { ok: false, error: 'failed' };
  }
  if (result.error) return refusal(result.error);
  if (typeof result.data !== 'boolean') return { ok: false, error: 'failed' };

  // `false`: sesji już nie ma albo nie należy do tego konta (baza nie mówi, które).
  if (result.data) {
    await logAudit({
      action: 'auth.session_revoked',
      tenantId: null,
      userId: session.userId,
      metadata: { session_id: sessionId },
    });
  }
  revalidatePath(PATH);
  return { ok: true, revoked: result.data };
}

export async function revokeOtherSessionsAction(): Promise<RevokeOtherSessionsResult> {
  const session = await sessionClient();
  if (!session.ok) return session;

  let result: { data: unknown; error: { code?: string | null; message?: string | null } | null };
  try {
    result = await session.supabase.rpc('revoke_other_account_sessions');
  } catch {
    return { ok: false, error: 'failed' };
  }
  if (result.error) return refusal(result.error);
  if (typeof result.data !== 'number' || !Number.isInteger(result.data) || result.data < 0) {
    return { ok: false, error: 'failed' };
  }

  if (result.data > 0) {
    await logAudit({
      action: 'auth.other_sessions_revoked',
      tenantId: null,
      userId: session.userId,
      metadata: { count: result.data },
    });
  }
  revalidatePath(PATH);
  return { ok: true, count: result.data };
}
