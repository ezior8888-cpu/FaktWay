import type { RegistrationResponseJSON } from '@simplewebauthn/server';

import { logAudit } from '@/lib/audit/log';
import { getPasskeyConfig, isRequestOriginAllowed } from '@/lib/auth/passkey/config';
import { deviceLabelFromUserAgent, sanitizeDeviceLabel } from '@/lib/auth/passkey/device-label';
import { passkeyError, passkeyJson, passkeyRateLimited, readJsonBody } from '@/lib/auth/passkey/http';
import { requirePasskeyManagementSession } from '@/lib/auth/passkey/management-session';
import { finishPasskeyRegistration } from '@/lib/auth/passkey/registration';
import { registerVerifyBody } from '@/lib/auth/passkey/schemas';
import { checkPasskeyManageRateLimit } from '@/lib/rate-limit/passkey';

export async function POST(request: Request) {
  const config = getPasskeyConfig();
  if (!config) return passkeyError('passkey_unavailable', 503);
  if (!isRequestOriginAllowed(request, config)) return passkeyError('origin_not_allowed', 403);

  const session = await requirePasskeyManagementSession();
  if (!session.ok) return session.response;

  const limit = await checkPasskeyManageRateLimit(session.user.id);
  if (!limit.allowed) return passkeyRateLimited(limit.retryAfter);

  const body = registerVerifyBody.safeParse(await readJsonBody(request));
  if (!body.success) return passkeyError('invalid_request', 400);

  const deviceLabel = sanitizeDeviceLabel(body.data.deviceLabel)
    ?? deviceLabelFromUserAgent(request.headers.get('user-agent'));

  try {
    const outcome = await finishPasskeyRegistration(
      config, session.user.id, body.data.response as RegistrationResponseJSON, deviceLabel,
    );
    if (!outcome.ok) {
      return outcome.reason === 'already_registered'
        ? passkeyError('already_registered', 409)
        : passkeyError('passkey_registration_failed', 400);
    }
    await logAudit({
      action: 'auth.passkey_added',
      tenantId: null,
      userId: session.user.id,
      metadata: {
        passkey_id: outcome.device.id,
        device_label: outcome.device.deviceLabel,
        backed_up: outcome.device.backedUp,
      },
    });
    return passkeyJson({ ok: true, device: outcome.device });
  } catch {
    console.error('[passkey] register_verify_failed');
    return passkeyError('passkey_unavailable', 503);
  }
}
