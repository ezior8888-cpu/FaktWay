import 'server-only';

import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { User } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

import { challengeFromClientData, consumeChallengeWith } from '@/lib/auth/passkey/challenges';
import type { PasskeyConfig } from '@/lib/auth/passkey/config';
import {
  createPasskeySessionMarker,
  passkeySessionCookieOptions,
  PASSKEY_SESSION_COOKIE,
} from '@/lib/auth/passkey/session-marker';
import { REMEMBER_ME_COOKIE, REMEMBER_ME_VALUE, rememberMeCookieOptions } from '@/lib/auth/device-cookies';
import { createAdminClient, createClient } from '@/lib/supabase/server';

/**
 * Asercja WebAuthn zamieniona na sesję GoTrue.
 *
 * Każde niepowodzenie po stronie „kto to jest” (brak wyzwania, nieznane poświadczenie,
 * zły podpis, brak biometrii, cofnięty licznik, blokada konta) daje ten sam wynik
 * `failed`, żeby odpowiedź nie mówiła, co dokładnie się nie zgodziło.
 * `session_unavailable` to tylko awaria po naszej stronie: można ponowić.
 */

export type PasskeyLoginOutcome =
  | { ok: true; userId: string; passkeyId: string }
  | { ok: false; reason: 'failed' | 'session_unavailable' };

const FAILED = { ok: false, reason: 'failed' } as const;
const SESSION_UNAVAILABLE = { ok: false, reason: 'session_unavailable' } as const;

interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string[] | null;
}

/** Blokada operatora (`/admin/users`), konto usunięte albo bez potwierdzonego adresu. */
function isAccountOpen(user: User, now = Date.now()): user is User & { email: string } {
  if (!user.email || !user.email_confirmed_at || user.deleted_at) return false;
  const { banned_until: bannedUntil } = user;
  return !bannedUntil || new Date(bannedUntil).getTime() <= now;
}

export async function finishPasskeyLogin(
  config: PasskeyConfig,
  response: AuthenticationResponseJSON,
): Promise<PasskeyLoginOutcome> {
  const admin = createAdminClient();

  // Wyzwanie zużywamy pierwsze: nieudana próba też je kasuje, więc tej samej
  // odpowiedzi nie da się podsuwać wielokrotnie.
  const challenge = challengeFromClientData(response.response.clientDataJSON);
  if (!challenge || !(await consumeChallengeWith(admin, { challenge, purpose: 'login' }))) return FAILED;

  const { data: row, error: rowError } = await admin.from('user_passkeys')
    .select('id, user_id, credential_id, public_key, counter, transports')
    .eq('credential_id', response.id)
    .maybeSingle<PasskeyRow>();
  if (rowError) throw new Error('passkey_lookup_failed');
  if (!row) return FAILED;

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserVerification: true,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')),
        counter: Number(row.counter),
        transports: row.transports ?? [],
      },
    });
  } catch {
    // Biblioteka rzuca przy każdej niezgodności (podpis, origin, UV, licznik).
    return FAILED;
  }
  if (!verification.verified) return FAILED;

  const account = await admin.auth.admin.getUserById(row.user_id);
  if (account.error) return account.error.status === 404 ? FAILED : SESSION_UNAVAILABLE;
  const user = account.data.user;
  if (!user || user.id !== row.user_id || !isAccountOpen(user)) return FAILED;

  // Warunkowo po poprzedniej wartości: druga asercja w tym samym czasie nie nadpisze
  // licznika po cichu. Zero wierszy znaczy, że ktoś był szybszy, więc bez logowania.
  const { authenticationInfo } = verification;
  const advanced = await admin.from('user_passkeys')
    .update({
      counter: authenticationInfo.newCounter,
      backed_up: authenticationInfo.credentialBackedUp,
      last_used_at: new Date().toISOString(),
    })
    .eq('id', row.id)
    .eq('counter', row.counter)
    .select('id');
  if (advanced.error) throw new Error('passkey_counter_update_failed');
  if ((advanced.data?.length ?? 0) !== 1) return FAILED;

  return issueSession(user, row.id);
}

/**
 * Sesja bez wysyłki maila: `generateLink` tylko tworzy token, `verifyOtp` na kliencie
 * serwerowym zapisuje ciasteczka sesji. Token nie opuszcza serwera.
 *
 * Skutek uboczny: magic link nadpisuje token odzyskiwania, więc wcześniej wysłany
 * link „nie pamiętam hasła” przestaje działać (klient prosi o nowy).
 */
async function issueSession(user: User & { email: string }, passkeyId: string): Promise<PasskeyLoginOutcome> {
  const link = await createAdminClient().auth.admin.generateLink({ type: 'magiclink', email: user.email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash || link.data.user?.id !== user.id) return SESSION_UNAVAILABLE;

  const supabase = await createClient();
  const verified = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
  if (verified.error) {
    return verified.error.code === 'user_banned' ? FAILED : SESSION_UNAVAILABLE;
  }
  const { session, user: sessionUser } = verified.data;

  const marker = session && sessionUser?.id === user.id
    ? await markerForSession(supabase, session.access_token, user.id)
    : null;
  if (!marker) {
    // Sesja bez znacznika albo cudza: lepiej nie zostawiać jej w ciasteczkach.
    await supabase.auth.signOut({ scope: 'local' }).catch(() => null);
    return SESSION_UNAVAILABLE;
  }

  const store = await cookies();
  store.set(PASSKEY_SESSION_COOKIE, marker, passkeySessionCookieOptions());
  // Logowanie biometrią liczy się jak „Zapamiętaj mnie”: `IdleWatcher` nie wylogowuje.
  store.set(REMEMBER_ME_COOKIE, REMEMBER_ME_VALUE, rememberMeCookieOptions());
  return { ok: true, userId: user.id, passkeyId };
}

async function markerForSession(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accessToken: string,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase.auth.getClaims(accessToken);
  const sessionId = data?.claims.session_id;
  if (error || data?.claims.sub !== userId || typeof sessionId !== 'string') return null;
  return createPasskeySessionMarker({ sub: userId, sessionId }).catch(() => null);
}
