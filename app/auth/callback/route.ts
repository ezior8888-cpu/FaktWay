import { NextResponse } from 'next/server';
import { recordGoogleSignupIfNew } from '@/lib/analytics/funnel';
import { logAudit } from '@/lib/audit/log';
import { safeRedirectPath } from '@/lib/auth/safe-redirect';
import { loginMethodFromAmr, readAccessTokenFacts, sessionAuditMetadata } from '@/lib/auth/sessions/access-token';
import { getTrustedAppOrigin } from '@/lib/auth/trusted-origin';
import { createClient } from '@/lib/supabase/server';

const PRIVATE_HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

/**
 * Wpis `auth.login` po logowaniu Google i linkiem z e-maila (krok 8.5). Wcześniej
 * ślad zostawiały tylko hasło i biometria, więc historia logowań i lista urządzeń
 * nie znały tych sesji. `session_id` łączy wpis z sesją (00174).
 *
 * Bez firmy (`tenantId: null`): trasa poza wymianą kodu nie pyta bazy klientem
 * sesji (`auth-browser-url-boundary.test.ts` liczy jej zapytania), a historia
 * logowań czyta wpisy po użytkowniku, nie po firmie. `logAudit` nie rzuca, więc
 * audyt nie zatrzyma logowania.
 */
async function logCallbackLogin(userId: string | undefined, accessToken: string | undefined): Promise<void> {
  if (!userId) return;
  const facts = readAccessTokenFacts(accessToken);
  const method = loginMethodFromAmr(facts.amrMethods);
  await logAudit({
    action: 'auth.login',
    tenantId: null,
    userId,
    metadata: { ...(method ? { method } : {}), ...sessionAuditMetadata(facts.sessionId) },
  });
}

/** Complete PKCE using only the configured public origin. */
export async function GET(request: Request) {
  const origin = getTrustedAppOrigin();
  if (!origin) return NextResponse.json({ error: 'auth_unavailable' }, { status: 503, headers: PRIVATE_HEADERS });

  const { searchParams } = new URL(request.url);
  const next = safeRedirectPath(searchParams.get('next'));
  const code = searchParams.get('code');
  const redirect = (path: string) => NextResponse.redirect(new URL(path, origin), { headers: PRIVATE_HEADERS });
  if (!code) {
    // Fragments never reach the server. The finish page clears them before Auth I/O.
    return redirect('/auth/finish?' + new URLSearchParams({ next }));
  }
  if (code.length > 2048 || searchParams.getAll('code').length !== 1) {
    return redirect('/login?error=auth_callback_failed');
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return redirect('/login?error=auth_callback_failed');
    await recordGoogleSignupIfNew(data?.user);
    await logCallbackLogin(data?.user?.id, data?.session?.access_token);
    return redirect(next);
  } catch {
    return redirect('/login?error=auth_callback_failed');
  }
}
