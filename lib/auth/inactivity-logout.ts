'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { forgetFirstTouchCookie } from '@/lib/analytics/attribution-server';
import { logAudit } from '@/lib/audit/log';
import { signOutCurrentSession } from '@/lib/auth/sign-out';

/**
 * Server Action wywoływana z `IdleWatcher` po 60 min idle.
 *
 * Dlaczego osobna od `signOut`:
 *   - logujemy `auth.logout` z `metadata.reason: 'inactivity'` — w audycie
 *     widać, że user nie kliknął "Wyloguj" świadomie,
 *   - redirect leci do `/login?success=session_expired` z komunikatem
 *     "wylogowaliśmy Cię dla bezpieczeństwa", a nie zwykłe `/login`.
 */
export async function forceSignOutInactive(): Promise<{ ok: false; error: 'local_logout_failed' }> {
  const result = await signOutCurrentSession();
  if (!result.localSessionCleared) return { ok: false, error: 'local_logout_failed' };
  await forgetFirstTouchCookie();
  if (result.userId) {
    await logAudit({
      action: 'auth.logout', tenantId: null, userId: result.userId,
      metadata: {
        reason: 'inactivity_timeout', local_session_cleared: true,
        global_sign_out_confirmed: result.globalSignOutConfirmed,
      },
    });
  }
  revalidatePath('/', 'layout');
  redirect('/login?success=session_expired' + (result.globalSignOutConfirmed ? '' : '&notice=logout_local_only'));
}
