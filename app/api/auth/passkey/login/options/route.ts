import { generateAuthenticationOptions } from '@simplewebauthn/server';

import { getClientIp } from '@/lib/auth/get-client-ip';
import { storeChallengeWith } from '@/lib/auth/passkey/challenges';
import { getPasskeyConfig, isRequestOriginAllowed } from '@/lib/auth/passkey/config';
import { passkeyError, passkeyJson, passkeyRateLimited } from '@/lib/auth/passkey/http';
import { checkPasskeyLoginOptionsRateLimit } from '@/lib/rate-limit/passkey';
import { createAdminClient } from '@/lib/supabase/server';

const TIMEOUT_MS = 120_000;

/**
 * Trasa publiczna (`PUBLIC_API_PREFIXES` w `lib/supabase/middleware.ts`). Puste
 * `allowCredentials`: poświadczenia wykrywalne, więc nikt nie podaje adresu e-mail
 * i odpowiedź nie mówi, czy jakieś konto istnieje.
 */
export async function POST(request: Request) {
  const config = getPasskeyConfig();
  if (!config) return passkeyError('passkey_unavailable', 503);
  if (!isRequestOriginAllowed(request, config)) return passkeyError('origin_not_allowed', 403);

  const limit = await checkPasskeyLoginOptionsRateLimit(await getClientIp());
  if (!limit.allowed) return passkeyRateLimited(limit.retryAfter);

  try {
    const options = await generateAuthenticationOptions({
      rpID: config.rpId,
      userVerification: 'required',
      allowCredentials: [],
      timeout: TIMEOUT_MS,
    });
    await storeChallengeWith(createAdminClient(), { challenge: options.challenge, purpose: 'login' });
    return passkeyJson({ options });
  } catch {
    console.error('[passkey] login_options_failed');
    return passkeyError('passkey_unavailable', 503);
  }
}
