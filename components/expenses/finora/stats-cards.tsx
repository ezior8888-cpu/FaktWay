import { Fragment, type ComponentType, type ReactNode } from 'react'

import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

// Port z szablonu Finora (src/views/stats-cards.tsx, wołany przez
// src/views/pages/transactions/transaction-stats-cards.tsx z
// `iconPosition='right'` i `className='mb-6'`). Ta sama karta, grupy po dwa
// i separatory 1:1. Różnica: komórka to SLOT, nie gotowy obiekt — każdy kafel
// z danymi stoi we własnym <Suspense> + `SectionErrorBoundary` (plan Finora
// §2.4 pkt 15), więc wyjątek strażnika kosztów zabiera jedną komórkę, a nie
// całą kartę. Wygląd komórki (`StatCell`) jest kopią wnętrza pętli Finory.

type StatsCardsFrameProps = {
  /** Komórki w kolejności Finory (grupy po dwie). */
  cells: ReactNode[]
  footer?: ReactNode
  className?: string
}

export function StatsCardsFrame({ cells, footer, className }: StatsCardsFrameProps) {
  const groups = cells.reduce<ReactNode[][]>((acc, cell, index) => {
    if (index % 2 === 0) {
      acc.push([cell])
    } else {
      acc[acc.length - 1]?.push(cell)
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
                {group.map((cell, cellIndex) => (
                  <Fragment key={cellIndex}>
                    {cellIndex > 0 && (
                      <>
                        <Separator className='sm:hidden' />
                        <Separator orientation='vertical' className='hidden sm:block' />
                      </>
                    )}
                    <div className='flex min-w-0 flex-1'>{cell}</div>
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

export type StatCellProps = {
  label: string
  value: string
  /** Pełna kwota w podpowiedzi, gdy `value` jest skrócone (plan §7.1). */
  valueTitle?: string
  icon: ComponentType<{ className?: string }>
  iconPosition?: 'left' | 'right'
  valueClassName?: string
  /** Podpis pod etykietą: źródło liczby albo zastrzeżenie. */
  note?: ReactNode
  /** Działanie pod podpisem (np. „Sprawdź teraz” w Skrzynce KSeF). */
  action?: ReactNode
}

export function StatCell({ label, value, valueTitle, icon: Icon, iconPosition = 'right', valueClassName, note, action }: StatCellProps) {
  return (
    <div className='flex min-w-0 flex-1 items-center justify-between gap-4'>
      {iconPosition === 'left' && (
        <div className='bg-muted flex size-10 shrink-0 items-center justify-center'>
          <Icon className='text-foreground size-6' />
        </div>
      )}
      <div className='min-w-0'>
        <h4 className={cn('text-foreground text-2xl font-medium tabular-nums', valueClassName)} title={valueTitle}>
          {value}
        </h4>
        <p className='text-muted-foreground text-sm'>{label}</p>
        {note ? <p className='text-muted-foreground mt-0.5 text-xs'>{note}</p> : null}
        {action}
      </div>
      {iconPosition === 'right' && (
        <div className='bg-muted flex size-10 shrink-0 items-center justify-center'>
          <Icon className='text-foreground size-6' />
        </div>
      )}
    </div>
  )
}

/** Komórka z błędem jednego kafla: etykieta + treść wyjątku (już przefiltrowana). */
export function StatCellError({ label, message }: { label: string; message: string }) {
  return (
    <div className='flex min-w-0 flex-1 flex-col justify-center gap-1' role='status'>
      <p className='text-foreground text-sm font-medium'>{label}</p>
      <p className='text-muted-foreground text-xs'>{message}</p>
    </div>
  )
}

export function StatCellSkeleton() {
  return (
    <div className='flex min-w-0 flex-1 items-center justify-between gap-4' aria-busy='true'>
      <div className='space-y-2'>
        <Skeleton className='h-8 w-24' />
        <Skeleton className='h-4 w-32' />
      </div>
      <Skeleton className='size-10' />
    </div>
  )
}
