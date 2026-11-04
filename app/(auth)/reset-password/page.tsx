// Plan Finora P15 (E10b): ekranu nowego hasła Finora nie ma — dostaje układ
// logowania (`AuthSplitLayout`; przed E10b ta trasa nie miała żadnej ramki).
// Logika bez zmian: stan odzyskiwania z `getVerifiedPasswordRecoveryState`.

// Next Imports
import Link from 'next/link'
import { redirect } from 'next/navigation'

// Component Imports
import { AuthMessage } from '@/components/auth/finora/auth-message'
import { AuthSplitLayout } from '@/components/auth/finora/auth-split-layout'

// Lib Imports
import { getVerifiedPasswordRecoveryState } from '@/lib/auth/password-recovery'
import { createClient } from '@/lib/supabase/server'

import { ResetPasswordForm } from './reset-password-form'

export const dynamic = 'force-dynamic'

export default async function ResetPasswordPage() {
  const supabase = await createClient().catch(() => null)
  const state = supabase ? await getVerifiedPasswordRecoveryState(supabase) : null
  if (state?.status === 'challenge_required' && state.user.factors?.some(
    (factor) => factor.factor_type === 'totp' && factor.status === 'verified',
  )) redirect('/login/two-factor?redirect=%2Freset-password')

  return (
    <AuthSplitLayout
      panelTitle='Prawie gotowe!'
      panelText='Wybierz nowe hasło. Po zapisie wylogujemy pozostałe urządzenia, a Ty zalogujesz się nowym hasłem.'
    >
      <div>
        <h2 className='mb-2 text-2xl font-semibold'>Ustaw nowe hasło</h2>
        <p className='text-muted-foreground'>Wybierz hasło, którego nie używasz w innym serwisie.</p>
      </div>
      {state?.status === 'verified' ? <ResetPasswordForm /> : (
        <AuthMessage tone='error'>
          {state?.status === 'challenge_required'
            ? 'To konto wymaga drugiego składnika, którego nie możemy tu obsłużyć. Skontaktuj się z pomocą.'
            : 'Link jest nieważny, wygasł lub został otwarty w innej przeglądarce. Poproś o nowy i otwórz go w tej samej przeglądarce, w której wysłano prośbę.'}
        </AuthMessage>
      )}
      <p className='text-muted-foreground'>
        <Link href='/forgot-password' className='text-foreground hover:underline'>Poproś o nowy link</Link>
      </p>
    </AuthSplitLayout>
  )
}
