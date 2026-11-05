import { NextResponse } from 'next/server';
import { recordGoogleSignupIfNew } from '@/lib/analytics/funnel';
import { safeRedirectPath } from '@/lib/auth/safe-redirect';
import { getTrustedAppOrigin } from '@/lib/auth/trusted-origin';
import { createClient } from '@/lib/supabase/server';

const PRIVATE_HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

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
    return redirect(next);
  } catch {
    return redirect('/login?error=auth_callback_failed');
  }
}
