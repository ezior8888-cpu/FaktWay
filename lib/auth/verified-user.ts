import 'server-only';

import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import { getRequestPanelMfaState } from './panel-mfa-request';
import { getVerifiedMfaState } from './verified-mfa';

/**
 * Bootstrap and invitations need an authenticated user before an org exists.
 * Jak panel: sesja po biometrii przechodzi. `fullMfa` wymaga prawdziwego kodu
 * (eksport danych konta), znacznik wtedy nie wystarcza.
 */
export async function getVerifiedUserContext(options: { fullMfa?: boolean } = {}) {
  const supabase = await createClient();
  const state = await (options.fullMfa ? getVerifiedMfaState(supabase) : getRequestPanelMfaState(supabase))
    .catch(() => null);
  if (!state) {
    return {
      ok: false as const,
      reason: 'verification_failed' as const,
      error: 'Nie udało się zweryfikować sesji. Zaloguj się ponownie.',
    };
  }
  if (state.status === 'unauthenticated') {
    return { ok: false as const, reason: 'unauthenticated' as const, error: 'Niezalogowany' };
  }
  if (state.status === 'challenge_required') {
    return { ok: false as const, reason: 'mfa_required' as const, error: 'Wymagana weryfikacja dwuetapowa' };
  }
  return { ok: true as const, supabase, user: state.user };
}

/** Call before any data lookup on public routes that render account data. */
export async function requireVerifiedUserForPage(returnTo: string) {
  const context = await getVerifiedUserContext();
  if (!context.ok) {
    const destination = encodeURIComponent(returnTo);
    if (context.reason === 'unauthenticated') redirect(`/login?redirect=${destination}`);
    if (context.reason === 'mfa_required') redirect(`/login/two-factor?redirect=${destination}`);
    // An Auth outage must not fall back to an unverified user or a redirect loop.
    throw new Error(context.error);
  }
  return context;
}
