'use server';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';
import { confirmAccountPassword } from '@/lib/auth/password-check';

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

  // Limit prób, logowanie na osobnym kliencie i sprzątanie sesji: `lib/auth/password-check.ts`
  // (to samo dla telefonu, M10b).
  const verifier = () => createSupabaseClient(
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
  return confirmAccountPassword({ userId: user.id, email: user.email, password, verifier, captchaToken });
}
