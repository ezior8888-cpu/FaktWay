// Plan Finora P15 (E10b): ekranu 2FA Finora nie ma — składamy go z jej
// układu logowania (`AuthSplitLayout`), `Field` i `Input`. Logika bez zmian:
// stan MFA z `getVerifiedMfaState`, kod do `verifyMfaChallengeAction`.

// Next Imports
import { redirect } from 'next/navigation'

// Component Imports
import { AuthMessage } from '@/components/auth/finora/auth-message'
import { AuthSplitLayout } from '@/components/auth/finora/auth-split-layout'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// Lib Imports
import { safeRedirectPath } from '@/lib/auth/safe-redirect'
import { getVerifiedMfaState } from '@/lib/auth/verified-mfa'
import { SUPPORT_EMAIL } from '@/lib/site'
import { createClient } from '@/lib/supabase/server'

import { verifyMfaChallengeAction } from './actions'

export const dynamic = 'force-dynamic'

const ERROR_MESSAGES: Record<string, string> = {
  invalid_code:
    'Kod nieprawidłowy. Sprawdź godzinę w telefonie i wpisz aktualny kod z aplikacji TOTP.',
  no_factor:
    'Nie znaleźliśmy aktywnego 2FA. Skontaktuj się z pomocą techniczną.',
  recovery_unavailable:
    'Odzyskiwanie dostępu kodem ratunkowym jest obecnie niedostępne. Kod nie został zużyty. Skontaktuj się z pomocą.',
  verification_unavailable:
    'Nie możemy teraz sprawdzić kodu. Spróbuj ponownie za chwilę.',
  rate_limited:
    'Zbyt wiele prób. Poczekaj chwilę i spróbuj ponownie.',
  unknown: 'Coś poszło nie tak. Spróbuj ponownie.',
}

export default async function TwoFactorChallengePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; redirect?: string; potwierdzenie?: string }>
}) {
  const { error, redirect: redirectParam, potwierdzenie } = await searchParams
  const safeNext = safeRedirectPath(redirectParam ?? null)
  const state = await getVerifiedMfaState(await createClient())
  if (state.status === 'unauthenticated') redirect('/login')
  if (state.status === 'verified') redirect(safeNext)
  if (state.status === 'enrollment_required') redirect('/settings/security')

  const errorMsg = error ? ERROR_MESSAGES[error] ?? ERROR_MESSAGES.unknown : null

  return (
    <AuthSplitLayout
      panelTitle='Jeszcze jeden krok'
      panelText='Kod z aplikacji uwierzytelniającej potwierdza, że to Ty. Nowy kod pojawia się w aplikacji co kilkadziesiąt sekund.'
    >
      <div>
        <h2 className='mb-2 text-2xl font-semibold'>Weryfikacja dwuetapowa</h2>
        <p className='text-muted-foreground'>Wpisz 6-cyfrowy kod z aplikacji TOTP.</p>
      </div>

      {/* Przejście z operacji wrażliwej po logowaniu biometrią (`mfaStepUpHref`). */}
      {potwierdzenie === '1' && !errorMsg && (
        <AuthMessage tone='success'>
          Ta operacja wymaga kodu z aplikacji. Po potwierdzeniu wrócisz na poprzednią stronę.
        </AuthMessage>
      )}
      {errorMsg && <AuthMessage tone='error'>{errorMsg}</AuthMessage>}

      <div className='space-y-4'>
        <form action={verifyMfaChallengeAction}>
          <input type='hidden' name='redirect' value={safeNext} />
          <FieldGroup className='gap-4'>
            <Field className='gap-2'>
              <FieldLabel htmlFor='code' className='leading-5'>
                Kod z aplikacji*
              </FieldLabel>
              <Input
                id='code'
                name='code'
                inputMode='numeric'
                pattern='[0-9]{6}'
                maxLength={6}
                autoComplete='one-time-code'
                required
                placeholder='123456'
                autoFocus
                className='font-mono tracking-[0.3em]'
              />
            </Field>
            <Field>
              <Button className='w-full' type='submit'>
                Zweryfikuj
              </Button>
            </Field>
          </FieldGroup>
        </form>

        <p className='text-center text-muted-foreground'>
          Samodzielne odzyskiwanie dostępu po utracie aplikacji TOTP jest obecnie
          niedostępne. Jeśli nie masz do niej dostępu,{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className='text-foreground hover:underline'>
            skontaktuj się z pomocą
          </a>.
        </p>
      </div>
    </AuthSplitLayout>
  )
}
