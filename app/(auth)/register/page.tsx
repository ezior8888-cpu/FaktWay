// Plan Finora P15 (E10b): `src/views/pages/auth/register/index.tsx` +
// `register-form.tsx` szablonu. Układ i klasy 1:1; logika nasza i bez zmian:
// `signupWithEmail`, Google przez `loginWithGoogle` (tylko przy włączonym
// Google w GoTrue), Turnstile, wyłącznik `/wylacz rejestracja` (AUD-63).
// W miejscu pola zgody Finory („I agree to all Terms…”) są dwa pola z pakietu
// prawnego (#264): akceptacja regulaminu i umowy powierzenia (wymagana —
// `signupWithEmail` bez `terms=on` odsyła `terms_required`) i dobrowolna
// zgoda na e-maile. Brzmienie obu: lib/legal/versions.ts.

// Next Imports
import Link from 'next/link'

// Component Imports
import { AuthMessage } from '@/components/auth/finora/auth-message'
import { AuthSplitLayout } from '@/components/auth/finora/auth-split-layout'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { GoogleIcon } from '@/components/auth/finora/google-icon'
import { PasswordInput } from '@/components/auth/finora/password-input'
import { HoneypotField } from '@/components/auth/honeypot-field'
import { TurnstileWidget } from '@/components/auth/turnstile-widget'
import { LegalInline } from '@/components/legal/legal-document'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'

// Lib Imports
import { isGoogleLoginEnabled } from '@/lib/auth/oauth-providers'
import { isSignupClosed, SIGNUPS_CLOSED_MESSAGE } from '@/lib/feature-flags/signups'
import { MARKETING_STATEMENT, TERMS_STATEMENT } from '@/lib/legal/versions'

import { loginWithGoogle } from '../login/actions'
import { signupWithEmail } from './actions'

const ERROR_MESSAGES: Record<string, string> = {
  missing_fields: 'Wypełnij wszystkie pola.',
  weak_password:
    'Hasło musi mieć min. 12 znaków, zawierać małą i dużą literę, cyfrę oraz znak specjalny.',
  password_breached:
    'To hasło pojawiło się w znanych wyciekach danych. Wybierz inne, najlepiej passphrase z 4-5 losowych słów.',
  rate_limited:
    'Zbyt wiele prób rejestracji z tego urządzenia. Poczekaj kilka minut i spróbuj ponownie.',
  bot_check_failed:
    'Nie udało się potwierdzić, że nie jesteś botem. Odśwież stronę i spróbuj ponownie.',
  'email rate limit exceeded':
    'Przekroczono limit wysyłki maili. Poczekaj kilka minut i spróbuj ponownie.',
  signups_disabled: SIGNUPS_CLOSED_MESSAGE,
  terms_required:
    'Aby założyć konto, zaakceptuj Regulamin i Umowę powierzenia (pierwsze pole wyboru).',
}

const LEGAL_LINK_CLASS = 'text-foreground underline underline-offset-2 hover:no-underline'

const PANEL_TITLE = 'Załóż konto i wystaw pierwszą fakturę'
const PANEL_TEXT =
  'Po rejestracji podasz NIP, a dane firmy pobierzemy z GUS. Certyfikat KSeF dodasz w ustawieniach, kiedy będziesz gotowy.'

function LoginLink() {
  return (
    <p className='text-muted-foreground'>
      Masz już konto?{' '}
      <Link href='/login' className='text-foreground underline underline-offset-4 hover:text-primary'>
        Zaloguj się
      </Link>
    </p>
  )
}

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; retry?: string }>
}) {
  const { error, retry } = await searchParams
  const retryMinutes = retry ? Math.ceil(Number(retry) / 60) : null
  const errorMsg = error
    ? error === 'rate_limited' && retryMinutes
      ? `Zbyt wiele prób rejestracji. Spróbuj ponownie za ~${retryMinutes} min.`
      : (ERROR_MESSAGES[error] ?? error)
    : null

  // Wyłącznik `/wylacz rejestracja`: bez formularza i bez Google, bo pierwsze
  // logowanie Google zakłada konto.
  if (await isSignupClosed()) {
    return (
      <AuthSplitLayout panelTitle={PANEL_TITLE} panelText={PANEL_TEXT}>
        <div>
          <h2 className='mb-2 text-2xl font-semibold'>Utwórz konto</h2>
        </div>
        <AuthMessage tone='error'>{SIGNUPS_CLOSED_MESSAGE}</AuthMessage>
        <LoginLink />
      </AuthSplitLayout>
    )
  }

  const googleEnabled = await isGoogleLoginEnabled()

  return (
    <AuthSplitLayout panelTitle={PANEL_TITLE} panelText={PANEL_TEXT}>
      <div>
        <h2 className='mb-2 text-2xl font-semibold'>Utwórz konto</h2>
        <p className='text-muted-foreground'>Pierwsza faktura w 5 minut</p>
      </div>

      {errorMsg && <AuthMessage tone='error'>{errorMsg}</AuthMessage>}

      {googleEnabled && (
        <>
          <form action={loginWithGoogle}>
            <Button type='submit' variant='outline' className='w-full'>
              <GoogleIcon />
              Zarejestruj przez Google
            </Button>
            {/* Konto z Google powstaje bez naszego formularza — wyraźną
                akceptację zbiera bramka /onboarding/zgody
                (lib/legal/acceptance.ts), gdy dokumenty przestaną być wersją
                roboczą. */}
            <p className='mt-2 text-center text-xs leading-relaxed text-muted-foreground'>
              Rejestrując się przez Google, akceptujesz{' '}
              <LegalInline
                text="[Regulamin](/legal/regulamin) i [Umowę powierzenia](/legal/umowa-powierzenia) oraz potwierdzasz zapoznanie się z [Polityką prywatności](/legal/polityka-prywatnosci)."
                linkClassName={LEGAL_LINK_CLASS}
              />
            </p>
          </form>

          <div className='flex items-center gap-4'>
            <Separator className='flex-1' />
            <p>lub</p>
            <Separator className='flex-1' />
          </div>
        </>
      )}

      <div className='space-y-4'>
        <form action={signupWithEmail}>
          <FieldGroup className='gap-4'>
            {/* Name */}
            <Field className='gap-2'>
              <FieldLabel className='leading-5' htmlFor='name'>
                Imię i nazwisko*
              </FieldLabel>
              <Input
                type='text'
                id='name'
                name='name'
                required
                autoComplete='name'
                placeholder='Wpisz imię i nazwisko'
              />
            </Field>
            {/* Email */}
            <Field className='gap-2'>
              <FieldLabel className='leading-5' htmlFor='email'>
                Adres e‑mail*
              </FieldLabel>
              <Input
                type='email'
                id='email'
                name='email'
                required
                autoComplete='email'
                placeholder='Wpisz adres e‑mail'
              />
            </Field>
            {/* Password */}
            <Field className='w-full gap-2'>
              <FieldLabel className='leading-5' htmlFor='password'>
                Hasło*
              </FieldLabel>
              <PasswordInput
                id='password'
                name='password'
                required
                minLength={12}
                autoComplete='new-password'
                aria-describedby='password-hint'
              />
              <FieldDescription id='password-hint'>
                Min. 12 znaków, mała + duża litera, cyfra, znak specjalny. Sprawdzamy w bazie wycieków.
              </FieldDescription>
            </Field>
            {/* Zgody — w miejscu pola zgody Finory. Zwykłe pola wyboru, bo
                akcja czyta `terms` i `marketing` z FormData („on”). */}
            <label className='flex items-start gap-2.5 text-sm leading-relaxed text-muted-foreground'>
              <input
                type='checkbox'
                name='terms'
                value='on'
                required
                className='mt-1 size-4 shrink-0 accent-primary'
              />
              <span>
                <LegalInline text={TERMS_STATEMENT.text} linkClassName={LEGAL_LINK_CLASS} /> (wymagane)
              </span>
            </label>
            <label className='flex items-start gap-2.5 text-sm leading-relaxed text-muted-foreground'>
              <input
                type='checkbox'
                name='marketing'
                value='on'
                className='mt-1 size-4 shrink-0 accent-primary'
              />
              <span>{MARKETING_STATEMENT.text} (dobrowolne)</span>
            </label>
            <HoneypotField />
            <TurnstileWidget action='register' theme='light' />
            <Field>
              <Button className='w-full' type='submit'>
                Utwórz konto
              </Button>
            </Field>
          </FieldGroup>
        </form>

        <LoginLink />
      </div>
    </AuthSplitLayout>
  )
}
