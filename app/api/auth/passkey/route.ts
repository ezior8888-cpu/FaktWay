import { listPasskeyDevices } from '@/lib/auth/passkey/devices';
import { passkeyError, passkeyJson } from '@/lib/auth/passkey/http';
import { getRequestPanelMfaState } from '@/lib/auth/panel-mfa-request';
import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';
import { createClient } from '@/lib/supabase/server';

/**
 * Lista urządzeń konta. Widzi ją każda sesja panelu, także po biometrii.
 * `canManage` mówi, czy dodawanie i usuwanie przejdzie bez prośby o kod.
 */
export async function GET() {
  const supabase = await createClient();
  const state = await getVerifiedMfaState(supabase).catch(() => null);
  if (!state) return passkeyError('session_verification_failed', 503);
  if (state.status === 'unauthenticated') return passkeyError('not_authenticated', 401);

  const canManage = state.status !== 'challenge_required';
  if (!canManage) {
    const panel = await getRequestPanelMfaState(supabase).catch(() => null);
    if (panel?.status !== 'verified') return passkeyError('mfa_required', 403);
  }

  try {
    return passkeyJson({ canManage, devices: await listPasskeyDevices(supabase, state.user.id) });
  } catch {
    console.error('[passkey] list_failed');
    return passkeyError('passkey_unavailable', 503);
  }
}
