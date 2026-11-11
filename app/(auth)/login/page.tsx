// Plan Finora P15 (E10b): `src/views/pages/auth/login/index.tsx` +
// `login-form.tsx` szablonu. Układ i klasy 1:1; logika nasza i bez zmian:
// formularz idzie do `loginWithEmail`, Google do `loginWithGoogle` (przycisk
// tylko przy włączonym Google w GoTrue — #281), Turnstile zostaje.
// Wylatuje Facebook. „Zapamiętaj mnie” wróciło z logowaniem biometrią: domyślnie
// włączone na telefonie, wyłączone na komputerze; przy nim `IdleWatcher`
// nie wylogowuje po 60 min bezczynności.

// Next Imports
import { headers } from 'next/headers'
import Link from 'next/link'

// Component Imports
import { AuthMessage } from '@/components/auth/finora/auth-message'
import { AuthSplitLayout } from '@/components/auth/finora/auth-split-layout'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { GoogleIcon } from '@/components/auth/finora/google-icon'
import { PasswordInput } from '@/components/auth/finora/password-input'
import { HoneypotField } from '@/components/auth/honeypot-field'
import { PasskeyLogin } from '@/components/auth/passkey-login'
import { TurnstileWidget } from '@/components/auth/turnstile-widget'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'

// Lib Imports
import { isGoogleLoginEnabled } from '@/lib/auth/oauth-providers'
import { safeRedirectPath } from '@/lib/auth/safe-redirect'
import { isPhoneUserAgent } from '@/lib/auth/phone-user-agent'
import { SUPPORT_EMAIL } from '@/lib/site'

import { loginWithEmail, loginWithGoogle } from './actions'

/** Nazwa odsyłacza do resetu hasła — komunikat `oauth_disabled` ją cytuje. */
const FORGOT_PASSWORD_LABEL = 'Nie pamiętasz hasła?'

const ERROR_MESSAGES: Record<string, string> = {
  missing_fields: 'Wypełnij email i hasło.',
  invalid_credentials: 'Nieprawidłowy email lub hasło. Upewnij się, że email jest potwierdzony.',
  oauth_failed: 'Nie udało się zalogować przez Google. Spróbuj ponownie.',
  oauth_disabled: `Logowanie przez Google jest teraz wyłączone. Zaloguj się emailem i hasłem. Jeśli konto zakładałeś przez Google i nie masz hasła, ustaw je przez „${FORGOT_PASSWORD_LABEL}” albo napisz do nas: ${SUPPORT_EMAIL}.`,
  auth_callback_failed: 'Link z maila wygasł lub był już użyty. Zarejestruj się ponownie albo poproś o nowy link.',
  rate_limited: 'Zbyt wiele prób logowania. Poczekaj kilka minut i spróbuj ponownie.',
  bot_check_failed: 'Nie udało się potwierdzić, że nie jesteś botem. Odśwież stronę i spróbuj ponownie.',
}

const SUCCESS_MESSAGES: Record<string, string> = {
  check_email: 'Konto utworzone! Sprawdź swoją skrzynkę pocztową, wysłaliśmy link aktywacyjny.',
  // Bez `account_deleted` od 15.10.2026: usuwanie firmy z aplikacji jest
  // wstrzymane (idzie przez pomoc — components/settings/company-deletion.tsx),
  // a komunikat obiecywał trwałe usunięcie po 30 dniach, którego nic nie
  // wykonywało.
  session_expired: 'Wylogowaliśmy Cię po godzinie bezczynności. Zaloguj się ponownie, aby kontynuować.',
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string; redirect?: string; retry?: string; notice?: string }>
}) {
  const { error, success, retry, notice, redirect: redirectParam } = await searchParams
  const isPhone = isPhoneUserAgent((await headers()).get('user-agent'))
  const retryMinutes = retry ? Math.ceil(Number(retry) / 60) : null
  const errorMsg = error
    ? error === 'rate_limited' && retryMinutes
      ? `Zbyt wiele prób logowania. Spróbuj ponownie za ~${retryMinutes} min.`
      : ERROR_MESSAGES[error] ?? error
    : null
  const successMsg = success ? SUCCESS_MESSAGES[success] ?? null : null
  const googleEnabled = await isGoogleLoginEnabled()

  return (
    <AuthSplitLayout
      panelTitle='Witaj ponownie!'
      panelText='Zaloguj się, żeby wystawić fakturę, sprawdzić płatności i odebrać faktury kosztowe z KSeF.'
    >
      <div>
        <h1 className='mb-2 text-2xl font-semibold'>Zaloguj się</h1>
        <p className='text-muted-foreground'>
          {googleEnabled ? 'Witaj ponownie! Wybierz, jak chcesz się zalogować:' : 'Witaj ponownie! Wpisz e‑mail i hasło:'}
        </p>
      </div>

      {successMsg && <AuthMessage tone='success'>{successMsg}</AuthMessage>}
      {errorMsg && <AuthMessage tone='error'>{errorMsg}</AuthMessage>}
      {notice === 'logout_local_only' && (
        <AuthMessage tone='success'>
          Wylogowaliśmy tę przeglądarkę. Nie udało się potwierdzić wylogowania na pozostałych urządzeniach.
        </AuthMessage>
      )}

      <PasskeyLogin redirectTo={safeRedirectPath(redirectParam ?? null)} withSeparator={!googleEnabled} />

      {googleEnabled && (
        <>
          <form action={loginWithGoogle} className='flex flex-wrap gap-4 sm:gap-6'>
            <Button type='submit' variant='outline' className='grow'>
              <GoogleIcon />
              Zaloguj przez Google
            </Button>
          </form>

          <div className='flex items-center gap-4'>
            <Separator className='flex-1' />
            <p>lub e‑mailem</p>
            <Separator className='flex-1' />
          </div>
        </>
      )}

      <div className='space-y-4'>
        <form action={loginWithEmail}>
          <FieldGroup className='gap-4'>
            {/* Email */}
            <Field className='gap-2'>
              <FieldLabel htmlFor='email' className='leading-5'>
                Adres e‑mail*
              </FieldLabel>
              <Input
                type='email'
                id='email'
                name='email'
                required
                autoComplete='username webauthn'
                placeholder='Wpisz adres e‑mail'
              />
            </Field>
            {/* Password */}
            <Field className='w-full gap-2'>
              <FieldLabel htmlFor='password' className='leading-5'>
                Hasło*
              </FieldLabel>
              <PasswordInput id='password' name='password' required autoComplete='current-password' />
            </Field>
            {/* Zapamiętaj mnie i Forgot Password. Całe pole etykiety ma co najmniej 44 px. */}
            <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-2'>
              <label data-testid='remember-me-field' className='flex min-h-[44px] cursor-pointer items-center gap-2 text-base'>
                <Checkbox name='remember' defaultChecked={isPhone} />
                Zapamiętaj mnie
              </label>
              <Link href='/forgot-password' className='text-base text-nowrap hover:underline'>
                {FORGOT_PASSWORD_LABEL}
              </Link>
            </div>
            <HoneypotField />
            <TurnstileWidget action='login' theme='light' />
            <Field>
              <Button className='w-full' type='submit'>
                Zaloguj się
              </Button>
            </Field>
          </FieldGroup>
        </form>
        <p className='text-center text-muted-foreground'>
          Nie masz konta?{' '}
          <Link href='/register' className='text-foreground underline underline-offset-4 hover:text-primary'>
            Utwórz konto
          </Link>
        </p>
        {/* Pierwsze logowanie Google zakłada konto, więc zgoda musi być widoczna i tu. */}
        <p className='text-center text-sm text-muted-foreground'>
          Zakładając konto akceptujesz <Link href='/legal/regulamin' className='underline'>regulamin</Link> i{' '}
          <Link href='/legal/umowa-powierzenia' className='underline'>umowę powierzenia</Link> oraz potwierdzasz
          zapoznanie się z{' '}
          <Link href='/legal/polityka-prywatnosci' className='underline'>polityką prywatności</Link>.
        </p>
      </div>
    </AuthSplitLayout>
  )
}
