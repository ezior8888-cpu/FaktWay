import 'server-only';

import type { SupabaseClient, JwtPayload } from '@supabase/supabase-js';

import { verifyPasskeySessionMarker } from '@/lib/auth/passkey/session-marker';
import { getVerifiedMfaState, type VerifiedMfaState } from '@/lib/auth/verified-mfa';

type MfaAuth = Pick<SupabaseClient['auth'], 'getSession' | 'getUser' | 'getClaims'>;

/**
 * Bramka PANELU: jak `getVerifiedMfaState`, ale sesja AAL1 konta z 2FA ze znacznikiem
 * logowania biometrią TEJ sesji przechodzi jak `verified`.
 *
 * Tylko dla wejścia do panelu i zwykłych działań w firmie. Operacje wrażliwe
 * (certyfikat KSeF, płatności, `/admin`, hasło, 2FA, urządzenia) wołają
 * `getVerifiedMfaState` wprost i dalej dostają `challenge_required`.
 *
 * Claims przechwytujemy z wywołania wewnątrz `getVerifiedMfaState`: to te same,
 * zweryfikowane claims tego samego tokenu, bez dodatkowego zapytania do GoTrue.
 * Gdy kontrola nic nie zwróciła (także w testach z atrapą modułu), znacznika
 * nie sprawdzamy i zostaje `challenge_required`.
 */
export async function getPanelMfaState(
  supabase: { auth: MfaAuth },
  readMarker: () => string | undefined | Promise<string | undefined>,
): Promise<VerifiedMfaState> {
  const { auth } = supabase;
  let verifiedClaims: JwtPayload | null = null;
  const state = await getVerifiedMfaState({
    auth: {
      getSession: () => auth.getSession(),
      getUser: (jwt) => auth.getUser(jwt),
      getClaims: async (...args: Parameters<MfaAuth['getClaims']>) => {
        const result = await auth.getClaims(...args);
        verifiedClaims = result.data?.claims ?? null;
        return result;
      },
    } as MfaAuth,
  });
  if (state.status !== 'challenge_required') return state;

  const claims = verifiedClaims as JwtPayload | null;
  const sessionId = claims?.session_id;
  if (typeof sessionId !== 'string' || claims?.sub !== state.user.id) return state;

  let marker: string | undefined;
  try {
    marker = await readMarker();
  } catch {
    // Poza kontekstem żądania nie ma ciasteczek, czyli nie ma znacznika.
    return state;
  }
  const passes = await verifyPasskeySessionMarker(marker, { sub: state.user.id, sessionId });
  return passes ? { status: 'verified', user: state.user } : state;
}
