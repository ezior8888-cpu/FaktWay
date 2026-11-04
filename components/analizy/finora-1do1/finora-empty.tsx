// Pusty stan kart Analiz w kopii 1:1 z Finory (decyzja Bartosza 21.10.2026).
// Bez akcji to dokładnie akapit Finory („No expenses recorded for this
// month.”): `text-muted-foreground text-center text-sm` z `py-10` w kole
// i `py-6` w listach. Plan §7.3 wymaga przy niektórych stanach przycisku
// („Wystaw fakturę”, „Podłącz KSeF”) — wtedy ten sam odstęp, a pod tekstem
// przycisk `outline sm`, jak na Pulpicie.

import Link from 'next/link'

import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import type { FinoraEmptyState } from './types'

type FinoraEmptyProps = FinoraEmptyState & { pad: 'py-10' | 'py-6' }

const FinoraEmpty = ({ message, action, pad }: FinoraEmptyProps) => {
  if (!action) return <p className={cn('text-muted-foreground text-center text-sm', pad)}>{message}</p>

  return (
    <div className={cn('flex flex-col items-center gap-3 text-center', pad)}>
      <p className='text-muted-foreground text-sm'>{message}</p>
      <Link href={action.href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {action.label}
      </Link>
    </div>
  )
}

export { FinoraEmpty }
export default FinoraEmpty
