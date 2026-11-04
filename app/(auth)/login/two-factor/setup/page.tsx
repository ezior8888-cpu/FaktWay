// Plan Finora P15 (E10b): konfiguracja 2FA operatora w układzie logowania
// Finory. Logika bez zmian; sama karta TOTP to `TwoFactorCard` z ustawień
// bezpieczeństwa (jej wygląd należy do etapu ustawień).

// Next Imports
import { redirect } from 'next/navigation'

// Component Imports
import { TwoFactorCard } from '@/app/(dashboard)/settings/security/_components/two-factor-card'
import { AuthSplitLayout } from '@/components/auth/finora/auth-split-layout'

// Lib Imports
import { isAdminEmail } from '@/lib/auth/admin-guard'
import { getVerifiedMfaState } from '@/lib/auth/verified-mfa'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

/** Operator enrollment is independent of tenant membership and dashboard layout. */
export default async function AdminMfaSetupPage() {
  const state = await getVerifiedMfaState(await createClient())
  if (state.status === 'unauthenticated') redirect('/login')
  const { user } = state
  if (!user.email_confirmed_at || !isAdminEmail(user.email)) redirect('/dashboard')
  if (state.status === 'verified') redirect('/admin')
  if (state.status === 'challenge_required') redirect('/login/two-factor?redirect=%2Fadmin')

  return (
    <AuthSplitLayout
      panelTitle='Zabezpiecz panel administratora'
      panelText='Wejście do panelu operatora wymaga drugiego składnika logowania: kodu z aplikacji uwierzytelniającej.'
    >
      <div>
        <h2 className='mb-2 text-2xl font-semibold'>Zabezpiecz dostęp administratora</h2>
        <p className='text-muted-foreground'>
          Skonfiguruj aplikację uwierzytelniającą, aby wejść do panelu administracyjnego.
          Nie musisz w tym celu zakładać firmy.
        </p>
      </div>
      <TwoFactorCard isEnabled={false} />
    </AuthSplitLayout>
  )
}
