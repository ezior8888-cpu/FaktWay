import { logAudit } from '@/lib/audit/log';
import { getPasskeyConfig, isRequestOriginAllowed } from '@/lib/auth/passkey/config';
import { passkeyError, passkeyJson, passkeyRateLimited } from '@/lib/auth/passkey/http';
import { requirePasskeyManagementSession } from '@/lib/auth/passkey/management-session';
import { checkPasskeyManageRateLimit } from '@/lib/rate-limit/passkey';
import { isUuid } from '@/lib/supabase/active-org';

/**
 * Usuwa urządzenie i wylogowuje pozostałe sesje konta: urządzenie mogło zginąć,
 * a jego sesja ma znacznik biometrii. Ta sesja zostaje. Zapis klientem użytkownika,
 * więc obowiązuje też polityka RLS z 00159 (własne urządzenie, AAL2 przy 2FA).
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const config = getPasskeyConfig();
  if (!config) return passkeyError('passkey_unavailable', 503);
  if (!isRequestOriginAllowed(request, config)) return passkeyError('origin_not_allowed', 403);

  const { id } = await context.params;
  if (!isUuid(id)) return passkeyError('invalid_request', 400);

  const session = await requirePasskeyManagementSession();
  if (!session.ok) return session.response;
  const { supabase, user } = session;

  const limit = await checkPasskeyManageRateLimit(user.id);
  if (!limit.allowed) return passkeyRateLimited(limit.retryAfter);

  const removed = await supabase.from('user_passkeys')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
    .select('id, device_label');
  if (removed.error) {
    console.error('[passkey] remove_failed');
    return passkeyError('passkey_unavailable', 503);
  }
  const row = removed.data?.[0];
  if (!row) return passkeyError('not_found', 404);

  // Urządzenie już usunięte: porażki wylogowania nie zamieniamy w błąd operacji,
  // tylko mówimy o niej klientowi, żeby mógł wylogować się ręcznie.
  const signOut = await supabase.auth.signOut({ scope: 'others' }).catch(() => null);
  const othersSignedOut = !!signOut && !signOut.error;

  await logAudit({
    action: 'auth.passkey_removed',
    tenantId: null,
    userId: user.id,
    metadata: { passkey_id: row.id, device_label: row.device_label, others_signed_out: othersSignedOut },
  });
  return passkeyJson({ ok: true, othersSignedOut });
}
