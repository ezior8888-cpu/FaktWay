// Third-party Imports
import { RiGroupLine, RiReceiptLine, RiShoppingBag3Line } from '@remixicon/react'

// Component Imports
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Card, CardContent } from '@/components/ui/card'
import { PulpitCardHeader } from '@/components/dashboard/pulpit/card-header'
import { PulpitEmptyState } from '@/components/dashboard/pulpit/card-states'

// Util Imports
import type { CashFlowSource } from '@/lib/dashboard/cash-movements'
import { PAID_EMPTY_STATE } from '@/lib/invoices/paid-labels'
import { cn } from '@/lib/utils'

import { zl } from './money'
import { Progress } from '@/components/ui/progress'

/**
 * „Skąd i dokąd płyną pieniądze” — Finora
 * `views/dashboards/widgets/widget-top-cash-flow-sources.tsx` (plan Finora P2).
 * Lista 1:1: klienci (+) według opłaconych faktur, dostawcy (−) według
 * wydatków brutto; pasek = udział w sumie swojej strony.
 */

const ICON_TONES = [
  'bg-primary/10 text-primary dark:bg-primary/20',
  'bg-chart-2/10 text-chart-2',
  'bg-chart-3/10 text-chart-3',
  'bg-chart-4/10 text-chart-4',
  'bg-chart-5/10 text-chart-5'
] as const

type Props = {
  title: string
  subTitle?: string
  sources: CashFlowSource[]
  className?: string
}

function sourceType(source: CashFlowSource): string {
  if (source.consumers) return 'Klienci indywidualni'
  const role = source.direction === 'in' ? 'Klient' : 'Dostawca'
  return source.nip ? `${role} · NIP ${source.nip}` : role
}

const TopCashFlowSourcesCard = ({ title, subTitle, sources, className }: Props) => {
  return (
    <Card className={cn(className)}>
      <PulpitCardHeader title={title} subtitle={subTitle} className='flex items-center justify-between' />
      <CardContent className='flex flex-1 flex-col justify-evenly gap-5'>
        {sources.length === 0 ? (
          <PulpitEmptyState message={PAID_EMPTY_STATE} />
        ) : (
          sources.map((source, index) => {
            const Icon = source.consumers ? RiGroupLine : source.direction === 'in' ? RiReceiptLine : RiShoppingBag3Line

            return (
              <div key={source.key} className='flex items-center justify-between gap-4'>
                <div className='flex min-w-0 items-center gap-3'>
                  <Avatar className='size-10 after:border-0'>
                    <AvatarFallback
                      className={cn(
                        'bg-primary/10 text-primary shrink-0 [&>svg]:size-4.5',
                        ICON_TONES[index % ICON_TONES.length]
                      )}
                    >
                      <Icon aria-hidden />
                    </AvatarFallback>
                  </Avatar>
                  <div className='flex min-w-0 flex-col'>
                    <span className='truncate text-base' title={source.name}>
                      {source.name}
                    </span>
                    <span className='text-muted-foreground truncate text-sm'>{sourceType(source)}</span>
                  </div>
                </div>
                <div className='flex shrink-0 flex-col items-end gap-2'>
                  <span
                    className={cn(
                      'text-sm',
                      source.direction === 'in' ? 'text-green-700 dark:text-green-400' : 'text-destructive'
                    )}
                  >
                    {source.direction === 'in' ? '+' : '−'}
                    {zl(source.amount)}
                  </span>
                  <Progress
                    value={source.share}
                    aria-label={`Udział: ${source.share}%`}
                    className={cn(
                      'w-32 **:data-[slot=progress-track]:h-1.5',
                      source.direction === 'out' && '**:data-[slot=progress-indicator]:bg-chart-4'
                    )}
                  />
                </div>
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}

export default TopCashFlowSourcesCard
