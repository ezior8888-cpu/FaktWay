import 'server-only';

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { User } from '@supabase/supabase-js';

import { challengeFromClientData, consumeChallengeWith, storeChallengeWith } from '@/lib/auth/passkey/challenges';
import type { PasskeyConfig } from '@/lib/auth/passkey/config';
import { DEVICE_COLUMNS, toPasskeyDevice } from '@/lib/auth/passkey/devices';
import type { PasskeyDevice } from '@/lib/auth/passkey/types';
import { createAdminClient } from '@/lib/supabase/server';

/**
 * EdDSA, ES256, RS256. Jawnie, bo domyślna lista biblioteki zależy od środowiska
 * uruchomieniowego (ML-DSA, gdy Node je ma), a opcje i weryfikacja muszą się zgadzać.
 */
export const SUPPORTED_ALGORITHM_IDS = [-8, -7, -257];
/** Więcej urządzeń na konto to już raczej błąd albo nadużycie niż potrzeba. */
export const MAX_PASSKEYS_PER_ACCOUNT = 10;

const KNOWN_TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);
const TIMEOUT_MS = 120_000;

interface ExistingCredential {
  credential_id: string;
  transports: string[] | null;
}

export async function beginPasskeyRegistration(config: PasskeyConfig, user: User) {
  const admin = createAdminClient();
  const { data, error } = await admin.from('user_passkeys')
    .select('credential_id, transports')
    .eq('user_id', user.id);
  if (error) throw new Error('passkey_lookup_failed');
  const existing = (data ?? []) as ExistingCredential[];
  if (existing.length >= MAX_PASSKEYS_PER_ACCOUNT) return { ok: false as const };

  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: user.email ?? user.id,
    userDisplayName: user.email ?? '',
    // Stały identyfikator: to samo konto na tym samym urządzeniu nadpisuje poświadczenie.
    userID: new TextEncoder().encode(user.id) as Uint8Array<ArrayBuffer>,
    attestationType: 'none',
    timeout: TIMEOUT_MS,
    supportedAlgorithmIDs: SUPPORTED_ALGORITHM_IDS,
    excludeCredentials: existing.map(({ credential_id: id, transports }) => ({ id, transports: transports ?? [] })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  await storeChallengeWith(admin, { challenge: options.challenge, purpose: 'registration', userId: user.id });
  return { ok: true as const, options };
}

export type PasskeyRegistrationOutcome =
  | { ok: true; device: PasskeyDevice }
  | { ok: false; reason: 'failed' | 'already_registered' };

export async function finishPasskeyRegistration(
  config: PasskeyConfig,
  userId: string,
  response: RegistrationResponseJSON,
  deviceLabel: string,
): Promise<PasskeyRegistrationOutcome> {
  const admin = createAdminClient();

  const challenge = challengeFromClientData(response.response.clientDataJSON);
  if (!challenge || !(await consumeChallengeWith(admin, { challenge, purpose: 'registration', userId }))) {
    return { ok: false, reason: 'failed' };
  }

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: SUPPORTED_ALGORITHM_IDS,
    });
  } catch {
    return { ok: false, reason: 'failed' };
  }
  if (!verification.verified || !verification.registrationInfo) return { ok: false, reason: 'failed' };

  const { credential, credentialBackedUp } = verification.registrationInfo;
  const { data, error } = await admin.from('user_passkeys')
    .insert({
      user_id: userId,
      credential_id: credential.id,
      public_key: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: (credential.transports ?? []).filter((transport) => KNOWN_TRANSPORTS.has(transport)),
      device_label: deviceLabel,
      backed_up: credentialBackedUp,
    })
    .select(DEVICE_COLUMNS)
    .single();
  if (error?.code === '23505') return { ok: false, reason: 'already_registered' };
  if (error || !data) throw new Error('passkey_insert_failed');
  return { ok: true, device: toPasskeyDevice(data) };
}
