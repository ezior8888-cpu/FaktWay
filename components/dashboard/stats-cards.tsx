import { Fragment, type ComponentType, type ReactNode } from 'react'

import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

// Port z szablonu Finora (src/views/stats-cards.tsx). Różnice: Server
// Component (bez 'use client' — nic tu nie używa stanu) i opcjonalny podpis
// `note` pod etykietą (np. „według oznaczonych wpłat”).

export type StatItem = {
  label: string
  value: string
  icon: ComponentType<{ className?: string }>
  valueClassName?: string
  /** Pełna wartość w `title`, gdy `value` jest skrótem (plan Finora §7.1). */
  valueTitle?: string
  /** Podpis pod etykietą: źródło liczby albo zastrzeżenie. */
  note?: ReactNode
}

type StatsCardsProps = {
  stats: StatItem[]
  iconPosition?: 'left' | 'right'
  footer?: ReactNode
  className?: string
}

const StatsCards = ({ stats, iconPosition = 'left', footer, className }: StatsCardsProps) => {
  const groups = stats.reduce<StatItem[][]>((acc, stat, index) => {
    if (index % 2 === 0) {
      acc.push([stat])
    } else {
      acc[acc.length - 1]?.push(stat)
    }

    return acc
  }, [])

  return (
    <Card className={cn('shadow-none', className)}>
      <CardContent className={cn(footer && 'space-y-5')}>
        <div className='flex gap-5 max-xl:flex-col'>
          {groups.map((group, groupIndex) => (
            <Fragment key={groupIndex}>
              {groupIndex > 0 && (
                <>
                  <Separator className='xl:hidden' />
                  <Separator orientation='vertical' className='hidden xl:block' />
                </>
              )}
              <div className='flex flex-1 gap-5 max-sm:flex-col'>
                {group.map((stat, statIndex) => (
                  <Fragment key={stat.label}>
                    {statIndex > 0 && (
                      <>
                        <Separator className='sm:hidden' />
                        <Separator orientation='vertical' className='hidden sm:block' />
                      </>
                    )}
                    <div className='flex min-w-0 flex-1 items-center justify-between gap-4'>
                      {iconPosition === 'left' && (
                        <div className='bg-muted flex size-10 shrink-0 items-center justify-center'>
                          <stat.icon className='text-foreground size-6' />
                        </div>
                      )}
                      <div className='min-w-0'>
                        <h4
                          className={cn('text-foreground text-2xl font-medium tabular-nums', stat.valueClassName)}
                          title={stat.valueTitle}
                        >
                          {stat.value}
                        </h4>
                        <p className='text-muted-foreground text-sm'>{stat.label}</p>
                        {stat.note ? <p className='text-muted-foreground mt-0.5 text-xs'>{stat.note}</p> : null}
                      </div>
                      {iconPosition === 'right' && (
                        <div className='bg-muted flex size-10 shrink-0 items-center justify-center'>
                          <stat.icon className='text-foreground size-6' />
                        </div>
                      )}
                    </div>
                  </Fragment>
                ))}
              </div>
            </Fragment>
          ))}
        </div>

        {footer && (
          <>
            <Separator />
            {footer}
          </>
        )}
      </CardContent>
    </Card>
  )
}

export default StatsCards
