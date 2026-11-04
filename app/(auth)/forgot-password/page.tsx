// Plan Finora P15 (E10b): `src/views/pages/auth/forgot-password/index.tsx`
// + `forgot-password-form.tsx` szablonu. Układ i klasy 1:1; logika nasza
// i bez zmian: `requestPasswordReset` z Turnstile, komunikaty z adresu.

// Next Imports
import Link from 'next/link'

// Third-party Imports
import { RiArrowLeftSLine } from '@remixicon/react'

// Component Imports
import { AuthMessage } from '@/components/auth/finora/auth-message'
import { AuthSplitLayout } from '@/components/auth/finora/auth-split-layout'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { HoneypotField } from '@/components/auth/honeypot-field'
import { TurnstileWidget } from '@/components/auth/turnstile-widget'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

import { requestPasswordReset } from './actions'

const ERROR_MESSAGES: Record<string, string> = {
  verification_unavailable: 'Nie możemy teraz bezpiecznie wysłać prośby. Spróbuj ponownie za chwilę.',
  invalid_email: 'Podaj prawidłowy adres email.',
  rate_limited:
    'Zbyt wiele prób resetu hasła. Poczekaj chwilę i spróbuj ponownie.',
  bot_check_failed:
    'Nie udało się potwierdzić, że nie jesteś botem. Odśwież stronę i spróbuj ponownie.',
}

const SUCCESS_MESSAGES: Record<string, string> = {
  email_sent:
    'Jeśli konto z tym adresem istnieje, otrzymasz link do resetu hasła. Sprawdź skrzynkę (również folder spam) i otwórz link w tej samej przeglądarce, w której wysłano prośbę.',
}

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string; retry?: string }>
}) {
  const { error, success, retry } = await searchParams
  const seconds = Number(retry)
  const retryMinutes = Number.isFinite(seconds) && seconds > 0 && seconds <= 3600 ? Math.ceil(seconds / 60) : null
  const errorMsg = error
    ? error === 'rate_limited' && retryMinutes
      ? `Zbyt wiele prób resetu hasła. Spróbuj ponownie za ~${retryMinutes} min.`
      : (ERROR_MESSAGES[error] ?? 'Coś poszło nie tak. Spróbuj ponownie.')
    : null
  const successMsg = success ? SUCCESS_MESSAGES[success] : null

  return (
    <AuthSplitLayout
      panelTitle='Spokojnie! Nowe hasło ustawisz w chwilę'
      panelText='Podaj adres e‑mail konta, a wyślemy bezpieczny link do ustawienia nowego hasła. Jeśli maila nie ma w skrzynce, zajrzyj do folderu spam.'
    >
      <div>
        <h2 className='mb-2 text-2xl font-semibold'>Nie pamiętasz hasła?</h2>
        <p className='text-muted-foreground'>Bez obaw, wyślemy Ci link do ustawienia nowego hasła.</p>
      </div>

      {successMsg && <AuthMessage tone='success'>{successMsg}</AuthMessage>}
      {errorMsg && <AuthMessage tone='error'>{errorMsg}</AuthMessage>}

      <div className='space-y-4'>
        <form action={requestPasswordReset}>
          <FieldGroup className='gap-4'>
            {/* Email */}
            <Field>
              <FieldLabel className='leading-5' htmlFor='email'>
                Adres e‑mail*
              </FieldLabel>
              <Input
                type='email'
                id='email'
                name='email'
                maxLength={254}
                required
                autoComplete='email'
                placeholder='Wpisz adres e‑mail'
              />
            </Field>
            <HoneypotField />
            <TurnstileWidget action='forgot-password' />
            <Field>
              <Button className='w-full' type='submit'>
                Wyślij link resetujący
              </Button>
            </Field>
          </FieldGroup>
        </form>

        <Button variant='ghost' className='group w-full' render={<Link href='/login' />} nativeButton={false}>
          <RiArrowLeftSLine className='size-5 transition-transform duration-200 group-hover:-translate-x-0.5' />
          Wróć do logowania
        </Button>
      </div>
    </AuthSplitLayout>
  )
}
