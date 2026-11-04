// Plan Finora P15 (E10b): anulowanie usunięcia konta w układzie logowania
// Finory. Logika bez zmian: GET jest wyłącznie formularzem, decyzję zapisuje
// `cancelGdprDeletionAction` dopiero po kliknięciu.

// Next Imports
import Link from 'next/link'

// Component Imports
import { AuthMessage } from '@/components/auth/finora/auth-message'
import { AuthSplitLayout } from '@/components/auth/finora/auth-split-layout'
import { Button } from '@/components/ui/button'

import { GdprCancelForm } from './cancel-form'

export const dynamic = 'force-dynamic'

export default async function GdprCancelPage({ searchParams }: {
  searchParams: Promise<{ token?: string; outcome?: string }>
}) {
  const { token } = await searchParams
  const cleanToken = typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? token : null
  // GET jest wyłącznie formularzem. Parametry query nie mogą deklarować sukcesu.
  return (
    <AuthSplitLayout
      panelTitle='Zmieniłeś zdanie?'
      panelText='Dopóki usuwanie konta się nie rozpoczęło, możesz je zachować jednym przyciskiem z linku w mailu.'
    >
      <div>
        <h2 className='mb-2 text-2xl font-semibold'>Anulowanie usunięcia konta</h2>
      </div>
      {cleanToken ? <GdprCancelForm token={cleanToken} /> : (
        <AuthMessage tone='error'>Otwórz pełny link z maila albo zaloguj się i anuluj żądanie w ustawieniach konta.</AuthMessage>
      )}
      <Button variant='outline' className='w-full' render={<Link href='/login' />} nativeButton={false}>
        Przejdź do logowania
      </Button>
    </AuthSplitLayout>
  )
}
