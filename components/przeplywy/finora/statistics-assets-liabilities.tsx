// Third-party Imports
import { RiArrowLeftDownLine, RiArrowRightUpLine } from '@remixicon/react'

// Component Imports
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PulpitEmptyState } from '@/components/dashboard/pulpit/card-states'

// Util Imports
import { formatPlCompactMoney } from '@/lib/format/pl'
import { plural } from '@/lib/i18n/plural'
import { cn } from '@/lib/utils'

import { zl } from './money'

/**
 * „Należności” — Finora `views/dashboards/statistics/statistics-assets-liabilities.tsx`
 * („Assets vs Liabilities” z pierwszego rzędu strony Net Worth, plan Finora
 * P2). Pasek i dwie kwoty 1:1: przed terminem (lewa) i po terminie (prawa),
 * obie z `getReceivables` (§2.4 pkt 11); „po terminie” z daty, nie ze
 * statusu.
 */

export const RECEIVABLES_EMPTY = 'Brak otwartych należności'

type Props = {
  notDue: number
  overdue: number
  count: number
  overdueCount: number
  note: string
  className?: string
}

const StatisticsAssetsLiabilities = ({ notDue, overdue, count, overdueCount, note, className }: Props) => {
  const total = notDue + overdue
  const notDueShare = total > 0 ? Math.round((notDue / total) * 100) : 0
  const notDueCount = count - overdueCount

  return (
    <Card className={cn(className)}>
      <CardHeader>
        <CardTitle className='text-lg font-semibold'>Należności</CardTitle>
        <CardDescription className='text-muted-foreground text-base'>Przed terminem / po terminie</CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-5'>
        {total <= 0 ? (
          <PulpitEmptyState message={RECEIVABLES_EMPTY} />
        ) : (
          <>
            <div
              className='flex h-2.5 overflow-hidden rounded-full'
              role='img'
              aria-label={`Przed terminem ${notDueShare}%, po terminie ${100 - notDueShare}%`}
            >
              <div className='bg-chart-2 h-full' style={{ width: `${notDueShare}%` }} />
              <div className='bg-chart-4 h-full' style={{ width: `${100 - notDueShare}%` }} />
            </div>

            <div className='flex items-center justify-between gap-2'>
              <div
                className='flex items-center gap-2'
                title={`Przed terminem: ${zl(notDue)} (${notDueCount} ${plural(notDueCount, ['faktura', 'faktury', 'faktur'])})`}
              >
                <div className='bg-chart-2/10 text-chart-2 flex size-8 shrink-0 items-center justify-center rounded-full'>
                  <RiArrowLeftDownLine className='size-4' aria-hidden />
                </div>
                <span className='text-base font-semibold'>{formatPlCompactMoney(notDue)}</span>
                <span className='sr-only'>przed terminem</span>
              </div>
              <div
                className='flex items-center gap-2'
                title={`Po terminie: ${zl(overdue)} (${overdueCount} ${plural(overdueCount, ['faktura', 'faktury', 'faktur'])})`}
              >
                <span className='text-base font-semibold'>{formatPlCompactMoney(overdue)}</span>
                <span className='sr-only'>po terminie</span>
                <div className='bg-chart-4/10 text-chart-4 flex size-8 shrink-0 items-center justify-center rounded-full'>
                  <RiArrowRightUpLine className='size-4' aria-hidden />
                </div>
              </div>
            </div>
          </>
        )}
        <p className='text-muted-foreground text-xs'>{note}</p>
      </CardContent>
    </Card>
  )
}

export default StatisticsAssetsLiabilities
