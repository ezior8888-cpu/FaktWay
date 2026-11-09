import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

import { ANALYTICS_EVENTS } from '@/lib/analytics/events';
import { trackServer } from '@/lib/analytics/server';
import { logAudit } from '@/lib/audit/log';
import { getClientIp } from '@/lib/auth/get-client-ip';
import { getPasskeyConfig, isRequestOriginAllowed } from '@/lib/auth/passkey/config';
import { passkeyError, passkeyJson, passkeyRateLimited, readJsonBody } from '@/lib/auth/passkey/http';
import { finishPasskeyLogin } from '@/lib/auth/passkey/login';
import { loginVerifyBody } from '@/lib/auth/passkey/schemas';
import { safeRedirectPath } from '@/lib/auth/safe-redirect';
import { sessionAuditMetadata } from '@/lib/auth/sessions/access-token';
import { requestNewLoginCheck } from '@/lib/auth/sessions/new-login-check';
import { checkPasskeyLoginVerifyRateLimit } from '@/lib/rate-limit/passkey';
import { createClient } from '@/lib/supabase/server';

/**
 * Trasa publiczna. Bez Turnstile: asercji nie podrobi bot. Sesja GoTrue, znacznik
 * biometrii i „zapamiętane” trafiają do ciasteczek tej odpowiedzi, więc przeglądarka
 * i widok w aplikacji natywnej dostają je tak samo. Adres powrotu klient wykonuje sam.
 */
export async function POST(request: Request) {
  const config = getPasskeyConfig();
  if (!config) return passkeyError('passkey_unavailable', 503);
  if (!isRequestOriginAllowed(request, config)) return passkeyError('origin_not_allowed', 403);

  const limit = await checkPasskeyLoginVerifyRateLimit(await getClientIp());
  if (!limit.allowed) return passkeyRateLimited(limit.retryAfter);

  const body = loginVerifyBody.safeParse(await readJsonBody(request));
  if (!body.success) return passkeyError('invalid_request', 400);

  try {
    const outcome = await finishPasskeyLogin(config, body.data.response as AuthenticationResponseJSON);
    if (!outcome.ok) {
      return outcome.reason === 'failed'
        ? passkeyError('passkey_login_failed', 401)
        : passkeyError('session_unavailable', 503);
    }

    const { userId, passkeyId, sessionId } = outcome;
    const supabase = await createClient();
    const { data: profile } = await supabase.from('users')
      .select('last_active_tenant_id')
      .eq('id', userId)
      .maybeSingle();
    await logAudit({
      action: 'auth.login',
      tenantId: profile?.last_active_tenant_id ?? null,
      userId,
      // `session_id` łączy wpis z sesją na liście urządzeń (00174).
      metadata: { method: 'passkey', passkey_id: passkeyId, ...sessionAuditMetadata(sessionId) },
    });
    await requestNewLoginCheck({ userId, sessionId });
    await trackServer({
      userId,
      event: ANALYTICS_EVENTS.loginCompleted,
      properties: { method: 'passkey' },
    });

    return passkeyJson({ ok: true, redirectTo: safeRedirectPath(body.data.redirectTo) });
  } catch {
    console.error('[passkey] login_verify_failed');
    return passkeyError('session_unavailable', 503);
  }
}
