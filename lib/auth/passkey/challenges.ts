import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Wyzwania WebAuthn: jednorazowe, 5 minut, tylko `service_role` (migracja 00159).
 *
 * Wyzwanie odnajdujemy po wartości z `clientDataJSON`, a nie po ciasteczku, dlatego
 * końcówki nie zależą od przeglądarki: natywna wtyczka woła je tak samo.
 *
 * Zużycie to jedno polecenie `DELETE ... RETURNING`, więc przy równoległych
 * żądaniach wiersz dostaje najwyżej jedno. Test na prawdziwej bazie:
 * `tests/rls-passkeys.test.ts`. Warianty `*With` przyjmują klienta, żeby ten test
 * mógł je wołać bez kontekstu żądania.
 */

export type ChallengePurpose = 'registration' | 'login';

type AdminClient = Pick<SupabaseClient, 'from'>;

const TABLE = 'webauthn_challenges';
const MAX_CHALLENGE_LENGTH = 512;

export async function storeChallengeWith(
  admin: AdminClient,
  input: { challenge: string; purpose: ChallengePurpose; userId?: string },
): Promise<void> {
  // Sprzątanie przy tworzeniu nowego: tabela nie rośnie i nie potrzebuje crona.
  // Porażka sprzątania nie jest powodem, żeby odmówić logowania.
  await admin.from(TABLE).delete().lt('expires_at', new Date().toISOString());
  const { error } = await admin.from(TABLE).insert({
    challenge: input.challenge,
    purpose: input.purpose,
    user_id: input.userId ?? null,
  });
  if (error) throw new Error('webauthn_challenge_store_failed');
}

/** `true` tylko dla pierwszego wywołania z żywym wyzwaniem o tym celu i właścicielu. */
export async function consumeChallengeWith(
  admin: AdminClient,
  input: { challenge: string; purpose: ChallengePurpose; userId?: string },
): Promise<boolean> {
  if (!input.challenge || input.challenge.length > MAX_CHALLENGE_LENGTH) return false;
  let query = admin.from(TABLE).delete()
    .eq('challenge', input.challenge)
    .eq('purpose', input.purpose)
    .gt('expires_at', new Date().toISOString());
  if (input.purpose === 'registration') {
    if (!input.userId) return false;
    query = query.eq('user_id', input.userId);
  }
  const { data, error } = await query.select('id');
  if (error) throw new Error('webauthn_challenge_consume_failed');
  return (data?.length ?? 0) === 1;
}

/** Wyzwanie z odpowiedzi uwierzytelniacza; podpis i origin sprawdza potem biblioteka. */
export function challengeFromClientData(clientDataJSON: string): string | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8'));
    const challenge = (parsed as { challenge?: unknown } | null)?.challenge;
    return typeof challenge === 'string' && challenge.length > 0 ? challenge : null;
  } catch {
    return null;
  }
}
