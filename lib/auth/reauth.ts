'use server';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';
import { checkPasswordOperationRateLimit } from '@/lib/rate-limit/password';
import { isGoTrueCaptchaRejection } from '@/lib/security/bot-check';

export interface ReauthResult {
  ok: boolean;
  /** Tłumaczalny kod błędu — UI mapuje na komunikat. */
  error?: 'not_authenticated' | 'invalid_password' | 'unknown' | 'rate_limited' | 'verification_unavailable';
  retryAfter?: number;
}

/**
 * Re-autentykacja hasłem przed wrażliwą operacją (zmiana hasła, włączenie
 * 2FA, usunięcie konta).
 *
 * Hasło sprawdzamy na osobnym kliencie bez cookies i trwałego storage.
 * Logowanie hasłem tworzy sesję AAL1; użycie klienta przeglądarkowej sesji
 * obniżałoby wcześniej potwierdzone MFA. Tymczasowa sesja musi należeć do
 * tego samego użytkownika i jest od razu wylogowywana wyłącznie lokalnie.
 * Ten helper potwierdza hasło, a nie drugi czynnik — MFA sprawdza wywołujący.
 *
 * `captchaToken` (widżet Turnstile w oknie z hasłem) idzie do GoTrue, gdy jest:
 * przy włączonej captcha w GoTrue logowanie hasłem bez niego jest odrzucane
 * (docs/runbooks/captcha-w-gotrue.md). Odmowa captcha to nie „złe hasło”.
 */
export async function reauthenticateWithPassword(
  password: string,
  captchaToken?: string,
): Promise<ReauthResult> {
  if (typeof password !== 'string' || !password || password.length > 1024) {
    return { ok: false, error: 'invalid_password' };
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user?.email) {
    return { ok: false, error: 'not_authenticated' };
  }

  // Every caller, including GDPR, shares one authoritative account budget.
  // Keep it here so a new sensitive action cannot omit the password-attempt limit.
  const limit = await checkPasswordOperationRateLimit(user.id).catch(() => null);
  if (!limit || limit.unavailable) return { ok: false, error: 'verification_unavailable' };
  if (!limit.allowed) return { ok: false, error: 'rate_limited', retryAfter: limit.retryAfter };

  const verifier = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );

  const token = typeof captchaToken === 'string' && captchaToken.length >= 10 && captchaToken.length <= 2048
    ? captchaToken
    : undefined;
  const { data, error } = await verifier.auth.signInWithPassword({
    email: user.email,
    password,
    ...(token ? { options: { captchaToken: token } } : {}),
  });

  // Nawet niespójna odpowiedź tożsamości nie może zostawić celowo otwartej
  // sesji. Używamy JWT wyłącznie z odpowiedzi tego logowania i zakresu local.
  // Zwykłe auth.signOut() ukrywa błędy HTTP 401/403/404. Jego warstwa admin
  // zachowuje te błędy; nazwa SDK nie oznacza użycia klucza service_role.
  let cleanupFailed = false;
  const temporaryToken = data.session?.access_token;
  if (typeof temporaryToken === 'string' && temporaryToken) {
    try {
      const { error: cleanupError } = await verifier.auth.admin.signOut(temporaryToken, 'local');
      cleanupFailed = Boolean(cleanupError);
    } catch {
      cleanupFailed = true;
    }
  }

  if (error) {
    return { ok: false, error: isGoTrueCaptchaRejection(error) ? 'verification_unavailable' : 'invalid_password' };
  }

  if (cleanupFailed || typeof temporaryToken !== 'string' || !temporaryToken || data.user?.id !== user.id) {
    return { ok: false, error: 'unknown' };
  }

  return { ok: true };
}
