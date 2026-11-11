'use server';

import { revalidatePath } from 'next/cache';
import { sendJobEvent } from '@/lib/jobs/enqueue';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { logAudit } from '@/lib/audit/log';
import { recordSignupCompleted } from '@/lib/analytics/funnel';
import { getClientIp } from '@/lib/auth/get-client-ip';
import { validatePassword } from '@/lib/auth/password';
import { readAccessTokenFacts, sessionAuditMetadata } from '@/lib/auth/sessions/access-token';
import { isSignupClosed } from '@/lib/feature-flags/signups';
import { checkRegisterRateLimit } from '@/lib/rate-limit/auth';
import { isHoneypotTripped } from '@/lib/security/honeypot';
import { checkBotBeforeGoTrue, isGoTrueCaptchaRejection } from '@/lib/security/bot-check';
import { userRegistered } from '@/lib/jobs/events';
import { recordTermsAcceptance } from '@/lib/legal/record';
import { createClient } from '@/lib/supabase/server';

/**
 * Server Action: rejestracja email+hasło.
 * Supabase wyśle email z linkiem potwierdzającym (jeśli włączone).
 */
export async function signupWithEmail(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const name = String(formData.get('name') ?? '');

  if (!email || !password) {
    redirect('/register?error=missing_fields');
  }

  // Wyłącznik z bramki (`/wylacz rejestracja`) — przed Turnstile i HIBP.
  if (await isSignupClosed()) {
    redirect('/register?error=signups_disabled');
  }

  // Akceptacja regulaminu i umowy powierzenia — `required` w formularzu to
  // tylko wygoda; formularz można wysłać z pominięciem przeglądarki.
  if (formData.get('terms') !== 'on') {
    redirect('/register?error=terms_required');
  }
  const marketingConsent = formData.get('marketing') === 'on';

  // Pole-pułapka przed Turnstile (jak w logowaniu).
  if (isHoneypotTripped(formData)) {
    redirect('/register?error=bot_check_failed');
  }

  const ip = await getClientIp();

  // Bot protection — pierwsza linia obrony przed spam signup. Przy
  // włączonym AUTH_CAPTCHA_IN_GOTRUE token sprawdza GoTrue (`captchaToken`).
  const bot = await checkBotBeforeGoTrue(formData, ip);
  if (!bot.ok) {
    redirect('/register?error=bot_check_failed');
  }

  // Anti-spam signup — per-IP.
  const rl = await checkRegisterRateLimit(ip);
  if (!rl.allowed) {
    redirect(`/register?error=rate_limited&retry=${rl.retryAfter}`);
  }

  // Strength + HIBP breach check. Wykonujemy PO rate-limit żeby nie palić
  // budżetu HIBP na bot spam.
  const pw = await validatePassword(password);
  if (!pw.valid) {
    redirect(
      `/register?error=${pw.reason === 'breached' ? 'password_breached' : 'weak_password'}`,
    );
  }

  const headersList = await headers();
  const origin = headersList.get('origin') ?? process.env.NEXT_PUBLIC_APP_URL;

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: name },
      emailRedirectTo: `${origin}/auth/callback`,
      ...(bot.captchaToken ? { captchaToken: bot.captchaToken } : {}),
    },
  });

  if (error) {
    if (isGoTrueCaptchaRejection(error)) redirect('/register?error=bot_check_failed');
    redirect(`/register?error=${encodeURIComponent(error.message)}`);
  }

  const authUser = data.user;

  // Dowód akceptacji. Tylko dla NOWEGO konta: przy zajętym adresie GoTrue
  // zwraca konto bez tożsamości (ochrona przed sprawdzaniem, kto ma konto) —
  // cudzemu kontu nie dopisujemy akceptacji z cudzego formularza. Błąd zapisu
  // nie blokuje rejestracji: bramka (/onboarding/zgody) poprosi o akceptację
  // ponownie, gdy dokumenty będą finalne.
  if (authUser?.id && (authUser.identities?.length ?? 0) > 0) {
    const recorded = await recordTermsAcceptance({
      userId: authUser.id,
      method: 'register_form',
      marketingConsent,
    }).catch(() => ({ ok: false }));
    if (!recorded.ok) console.error('[register] legal acceptance not recorded');
  }

  if (authUser?.id && authUser.email) {
    const firstName =
      name.trim().split(/\s+/)[0] || email.split('@')[0] || 'użytkowniku';
    try {
      await sendJobEvent(
        userRegistered.create({
          userId: authUser.id,
          email: authUser.email,
          firstName,
        }),
      );
    } catch (e) {
      console.error('[inngest] user/registered send failed', e);
    }

    // Zajęty adres: GoTrue zwraca konto bez tożsamości, z losowym id. To nie rejestracja.
    if ((authUser.identities?.length ?? 0) > 0) {
      await recordSignupCompleted({ user: authUser, method: 'password' });
    }
  }

  // Potwierdzenie email włączone w Supabase → session = null, trzeba kliknąć link z maila.
  // Potwierdzenie wyłączone → od razu jest sesja, użytkownik zalogowany.
  if (!data.session) {
    redirect('/login?success=check_email');
  }

  const uid = data.user?.id;
  if (uid) {
    // `session_id` łączy wpis z sesją na liście urządzeń (00174), jak przy logowaniu.
    const { sessionId } = readAccessTokenFacts(data.session.access_token);
    await logAudit({
      action: 'auth.signup',
      tenantId: null,
      userId: uid,
      metadata: { flow: 'session_immediate', ...sessionAuditMetadata(sessionId) },
    });
  }

  revalidatePath('/', 'layout');
  redirect('/dashboard');
}
