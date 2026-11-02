'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { logAudit } from '@/lib/audit/log';
import { ANALYTICS_EVENTS } from '@/lib/analytics/events';
import { trackServer } from '@/lib/analytics/server';
import {
  clearedCookieOptions,
  PASSKEY_OFFER_COOKIE,
  passkeyOfferCookieOptions,
  REMEMBER_ME_COOKIE,
  REMEMBER_ME_VALUE,
  rememberMeCookieOptions,
} from '@/lib/auth/device-cookies';
import { getClientIp } from '@/lib/auth/get-client-ip';
import { isGoogleLoginEnabled } from '@/lib/auth/oauth-providers';
import { isPhoneUserAgent } from '@/lib/mobile-access';
import { checkLoginRateLimit } from '@/lib/rate-limit/auth';
import { isHoneypotTripped } from '@/lib/security/honeypot';
import { checkBotBeforeGoTrue, isGoTrueCaptchaRejection } from '@/lib/security/bot-check';
import { createClient } from '@/lib/supabase/server';
import { signOutCurrentSession } from '@/lib/auth/sign-out';

/** Wybór z tego logowania zastępuje poprzedni: odznaczone pole działa od razu. */
async function applyRememberMe(remember: boolean): Promise<void> {
  const store = await cookies();
  if (remember) store.set(REMEMBER_ME_COOKIE, REMEMBER_ME_VALUE, rememberMeCookieOptions());
  else store.set(REMEMBER_ME_COOKIE, '', clearedCookieOptions());
}

/**
 * Server Action: logowanie email+hasło.
 * Na błąd → redirect na /login z query `?error=...`.
 * Na sukces → redirect na /dashboard (pulpit aplikacji).
 */
export async function loginWithEmail(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) {
    redirect('/login?error=missing_fields');
  }

  // Pole-pułapka: człowiek go nie widzi, prosty bot wypełnia. Przed
  // Turnstile, żeby taki bot nie kosztował nawet zapytania do Cloudflare.
  if (isHoneypotTripped(formData)) {
    redirect('/login?error=bot_check_failed');
  }

  const ip = await getClientIp();

  // Bot protection PRZED rate-limit i Supabase call. Przy włączonym
  // AUTH_CAPTCHA_IN_GOTRUE token sprawdza GoTrue (`captchaToken` niżej).
  // Bypass: LOAD_TEST_MODE=true + nagłówek x-turnstile-bypass (nigdy na prod) — Faza 28.
  const bot = await checkBotBeforeGoTrue(formData, ip, { allowLoadTestBypass: true });
  if (!bot.ok) {
    redirect('/login?error=bot_check_failed');
  }

  // Anti brute-force / credential stuffing — sprawdzamy PRZED Supabase
  // żeby nawet nieprawidłowy email nie liczył się jako kosztowny call.
  const rl = await checkLoginRateLimit(ip, email);
  if (!rl.allowed) {
    redirect(`/login?error=rate_limited&retry=${rl.retryAfter}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
    ...(bot.captchaToken ? { options: { captchaToken: bot.captchaToken } } : {}),
  });

  if (error) {
    redirect(isGoTrueCaptchaRejection(error) ? '/login?error=bot_check_failed' : '/login?error=invalid_credentials');
  }

  await applyRememberMe(formData.get('remember') !== null);
  // Jednorazowa propozycja „Włącz logowanie biometrią” w panelu (PasskeyEnrollOffer).
  if (isPhoneUserAgent((await headers()).get('user-agent'))) {
    (await cookies()).set(PASSKEY_OFFER_COOKIE, '1', passkeyOfferCookieOptions());
  }

  const {
    data: { user: signedIn },
  } = await supabase.auth.getUser();
  if (signedIn) {
    const { data: row } = await supabase
      .from('users')
      .select('last_active_tenant_id')
      .eq('id', signedIn.id)
      .maybeSingle();
    await logAudit({
      action: 'auth.login',
      tenantId: row?.last_active_tenant_id ?? null,
      userId: signedIn.id,
      metadata: { method: 'password' },
    });
    await trackServer({
      distinctId: signedIn.id,
      event: ANALYTICS_EVENTS.loginCompleted,
      properties: { method: 'password' },
    });
  }

  revalidatePath('/', 'layout');

  // 2FA gate — jeśli user ma TOTP factor, signInWithPassword daje AAL1.
  // Przekierowujemy do challenge zamiast bezpośrednio do dashboard.
  const { data: aal } =
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === 'aal1' && aal?.nextLevel === 'aal2') {
    redirect('/login/two-factor');
  }

  redirect('/dashboard');
}

/**
 * Server Action: inicjacja logowania przez Google.
 * Przekierowuje do Google → Google do /auth/callback.
 * Przy wyłączonym dostawcy w GoTrue wraca z komunikatem zamiast wysyłać
 * klienta na błąd JSON z GoTrue (`lib/auth/oauth-providers.ts`).
 */
export async function loginWithGoogle(): Promise<void> {
  if (!(await isGoogleLoginEnabled())) {
    redirect('/login?error=oauth_disabled');
  }

  const headersList = await headers();
  const origin = headersList.get('origin') ?? process.env.NEXT_PUBLIC_APP_URL;

  // Pole „Zapamiętaj mnie” jest w formularzu e-mail, więc tu decyduje jego domyślna
  // wartość: telefon tak, komputer nie.
  await applyRememberMe(isPhoneUserAgent(headersList.get('user-agent')));

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${origin}/auth/callback`,
    },
  });

  if (error || !data.url) {
    redirect('/login?error=oauth_failed');
  }

  redirect(data.url);
}

/**
 * Server Action: wylogowanie.
 */
export async function signOut(): Promise<void> {
  const result = await signOutCurrentSession();
  if (!result.localSessionCleared) throw new Error('Nie udało się wylogować tej przeglądarki. Spróbuj ponownie.');
  if (result.userId) {
    await logAudit({
      action: 'auth.logout', tenantId: null, userId: result.userId,
      metadata: { local_session_cleared: true, global_sign_out_confirmed: result.globalSignOutConfirmed },
    });
  }
  revalidatePath('/', 'layout');
  redirect(result.globalSignOutConfirmed ? '/login' : '/login?notice=logout_local_only');
}
