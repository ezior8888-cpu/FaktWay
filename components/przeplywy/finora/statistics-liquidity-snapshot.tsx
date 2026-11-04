// Next Imports
import Link from 'next/link'

// Component Imports
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PulpitEmptyState } from '@/components/dashboard/pulpit/card-states'

// Util Imports
import { formatPlCompactMoney } from '@/lib/format/pl'
import { plural } from '@/lib/i18n/plural'
import { cn } from '@/lib/utils'

import { zl } from './money'
import { RECEIVABLES_EMPTY } from './statistics-assets-liabilities'

/**
 * „Zaległości” — Finora `views/dashboards/statistics/statistics-liquidity-snapshot.tsx`
 * („Liquidity Snapshot” z pierwszego rzędu strony Net Worth, plan Finora P2).
 * Procent i pasek 1:1: jaka część należności (§2.4 pkt 11) jest po terminie.
 * Przy zerowych należnościach — pusty stan, nie „0%”.
 */

type Props = {
  overdue: number
  total: number
  /** Najstarsza zaległość w dniach; `null`, gdy nic nie jest po terminie. */
  oldestOverdueDays: number | null
  /** Podpis sumy należności (§2.4 pkt 11) — ten sam co na karcie „Należności”. */
  note: string
  className?: string
}

const StatisticsLiquiditySnapshot = ({ overdue, total, oldestOverdueDays, note, className }: Props) => {
  const overduePercentage = total > 0 ? Math.round((overdue / total) * 100) : 0

  return (
    <Card className={cn(className)}>
      <CardHeader>
        <CardTitle className='text-lg font-semibold'>Zaległości</CardTitle>
        <CardDescription className='text-muted-foreground text-base'>
          {total > 0 ? `Po terminie: ${overduePercentage}% należności` : 'Część należności po terminie'}
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        {total <= 0 ? (
          <PulpitEmptyState message={RECEIVABLES_EMPTY} />
        ) : (
          <>
            <div className='flex items-end gap-3'>
              <span className='text-3xl font-semibold'>{overduePercentage}%</span>
              <span className='text-muted-foreground pb-1 text-sm' title={zl(overdue)}>
                należności po terminie ({formatPlCompactMoney(overdue)})
              </span>
            </div>
            <div
              className='bg-muted h-2 overflow-hidden rounded-full'
              role='img'
              aria-label={`Po terminie ${overduePercentage}% należności`}
            >
              <div className='bg-chart-1 h-full rounded-full' style={{ width: `${overduePercentage}%` }} />
            </div>
            {oldestOverdueDays !== null ? (
              <div className='flex flex-wrap items-center justify-between gap-2 text-sm'>
                <span className='text-muted-foreground'>
                  {`Najstarsza: ${oldestOverdueDays} ${plural(oldestOverdueDays, ['dzień', 'dni', 'dni'])} po terminie`}
                </span>
                <Link href='/payments/overdue' className='text-primary underline-offset-4 hover:underline'>
                  Szczegóły
                </Link>
              </div>
            ) : null}
          </>
        )}
        <p className='text-muted-foreground text-xs'>{note}</p>
      </CardContent>
    </Card>
  )
}

export default StatisticsLiquiditySnapshot
