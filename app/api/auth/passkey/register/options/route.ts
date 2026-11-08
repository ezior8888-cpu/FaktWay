import { getPasskeyConfig, isRequestOriginAllowed } from '@/lib/auth/passkey/config';
import { passkeyError, passkeyJson, passkeyRateLimited } from '@/lib/auth/passkey/http';
import { requirePasskeyManagementSession } from '@/lib/auth/passkey/management-session';
import { beginPasskeyRegistration } from '@/lib/auth/passkey/registration';
import { checkPasskeyManageRateLimit } from '@/lib/rate-limit/passkey';

/** Wymaga sesji, a na koncie z 2FA pełnego AAL2 (`requirePasskeyManagementSession`). */
export async function POST(request: Request) {
  const config = getPasskeyConfig();
  if (!config) return passkeyError('passkey_unavailable', 503);
  if (!isRequestOriginAllowed(request, config)) return passkeyError('origin_not_allowed', 403);

  const session = await requirePasskeyManagementSession();
  if (!session.ok) return session.response;

  const limit = await checkPasskeyManageRateLimit(session.user.id);
  if (!limit.allowed) return passkeyRateLimited(limit.retryAfter);

  try {
    const result = await beginPasskeyRegistration(config, session.user);
    if (!result.ok) return passkeyError('too_many_passkeys', 409);
    return passkeyJson({ options: result.options });
  } catch {
    console.error('[passkey] register_options_failed');
    return passkeyError('passkey_unavailable', 503);
  }
}
