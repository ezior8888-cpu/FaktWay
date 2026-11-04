// Next Imports
import Link from 'next/link'

// Third-party Imports
import { RiArrowDownLine, RiArrowUpLine, RiBillLine, RiReceiptLine } from '@remixicon/react'

// Component Imports
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Card, CardContent } from '@/components/ui/card'
import { PulpitCardHeader } from '@/components/dashboard/pulpit/card-header'
import { PulpitEmptyState } from '@/components/dashboard/pulpit/card-states'

// Util Imports
import type { CashFlowOperation } from '@/lib/dashboard/cash-movements'
import { PAID_EMPTY_STATE } from '@/lib/invoices/paid-labels'
import { cn } from '@/lib/utils'

import { plDate } from './money'
import { signedAmount } from './operation-amount'

/**
 * „Ostatnie operacje” — Finora `views/dashboards/widgets/widget-recent-activity.tsx`
 * („Recent Activity”, plan Finora P2). Lista 1:1: ostatnie wpłaty (dzień
 * oznaczenia) i ostatnie wydatki (dzień dokumentu), razem pięć pozycji.
 */

const ICON_TONES = [
  'bg-primary/10 text-primary dark:bg-primary/20',
  'bg-chart-4/10 text-chart-4',
  'bg-chart-2/10 text-chart-2',
  'bg-chart-3/10 text-chart-3',
  'bg-chart-5/10 text-chart-5'
] as const

type Props = {
  title: string
  activity: CashFlowOperation[]
  className?: string
}

const RecentActivityCard = ({ title, activity, className }: Props) => {
  return (
    <Card className={cn(className)}>
      <PulpitCardHeader title={title} className='flex items-center justify-between' />
      <CardContent className='flex flex-1 flex-col justify-between gap-4'>
        {activity.length === 0 ? (
          <PulpitEmptyState message={PAID_EMPTY_STATE} />
        ) : (
          activity.map((item, index) => (
            <div key={item.id} className='flex items-center justify-between gap-2'>
              <div className='flex min-w-0 items-center justify-between gap-3'>
                <Avatar className='size-9 after:border-0'>
                  <AvatarFallback
                    className={cn(
                      'bg-primary/10 text-primary shrink-0 [&>svg]:size-4.5',
                      ICON_TONES[index % ICON_TONES.length]
                    )}
                  >
                    {item.direction === 'in' ? <RiReceiptLine aria-hidden /> : <RiBillLine aria-hidden />}
                  </AvatarFallback>
                </Avatar>
                <div className='flex min-w-0 flex-col'>
                  <Link
                    href={item.href}
                    className='truncate text-base underline-offset-4 hover:underline'
                    title={item.counterparty}
                  >
                    {item.counterparty}
                  </Link>
                  <span className='text-muted-foreground truncate text-sm'>
                    {`${item.direction === 'in' ? 'Wpłata' : 'Wydatek'} · ${plDate(item.date)}`}
                  </span>
                </div>
              </div>
              <div className='flex shrink-0 items-center gap-2 text-sm'>
                <span>{signedAmount(item)}</span>
                <div className='bg-muted text-primary flex size-6 shrink-0 items-center justify-center rounded-full'>
                  {item.direction === 'out' ? (
                    <RiArrowDownLine className='size-4' aria-label='Wydatek' />
                  ) : (
                    <RiArrowUpLine className='size-4' aria-label='Wpływ' />
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

export default RecentActivityCard
