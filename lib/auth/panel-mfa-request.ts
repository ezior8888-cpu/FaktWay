import 'server-only';

import { cookies } from 'next/headers';

import { getPanelMfaState } from '@/lib/auth/panel-mfa';
import { PASSKEY_SESSION_COOKIE } from '@/lib/auth/passkey/session-marker';

/**
 * `getPanelMfaState` dla Server Actions, stron i końcówek: znacznik z ciasteczek
 * żądania, czytany dopiero przy `challenge_required`. Proxy podaje swój czytnik
 * z `request.cookies`, dlatego `next/headers` nie siedzi w `panel-mfa.ts`.
 */
export function getRequestPanelMfaState(supabase: Parameters<typeof getPanelMfaState>[0]) {
  return getPanelMfaState(supabase, async () => (await cookies()).get(PASSKEY_SESSION_COOKIE)?.value);
}
