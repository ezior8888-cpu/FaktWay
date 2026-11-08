// Kopia 1:1 z finora-src/src/views/dashboards/widgets/widget-top-cash-flow-sources.tsx (Przepływy, decyzja Bartosza 21.10.2026): zmienione tylko teksty, kwoty, daty i importy.
// React Imports
import type { ReactElement } from 'react'

// Next Imports
import Link from 'next/link'

// Component Imports
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import CardHeaderWithMenu, { type CardMenuItem } from '@/components/dashboard/finora/card-header-with-menu'

// Util Imports
import { cn } from '@/lib/utils'

/**
 * PLAN-PRAWDZIWE-DANE E6: źródła = kontrahenci (klienci z oznaczonych wpłat, dostawcy
 * z kosztów) z propsów; nazwa jest linkiem do kontrahentów tylko w trybie
 * prawdziwym (E7 pkt 3), wygląd wiersza bez zmian. Długa nazwa firmy jest
 * przycinana, żeby wiersz nie urósł o linię.
 */
type Props = {
  title: string
  sources: {
    icon: ReactElement
    sourceName: string
    sourceType: string
    amount: string
    amountTitle?: string
    share: number
    direction: 'in' | 'out'
    iconClassName?: string
    href?: string | null
  }[]
  /** Tekst pustej listy (karta bez pozycji). */
  empty?: string
  /** Dokąd iść z pustej listy (oznaczenie zapłaty przy fakturze). */
  emptyLink?: { label: string; href: string } | null
  menuItems?: CardMenuItem[]
  className?: string
}

const TopCashFlowSourcesCard = ({ title, sources, empty, emptyLink, menuItems, className }: Props) => {
  return (
    <Card className={cn(className)}>
      <CardHeaderWithMenu title={title} menuItems={menuItems} />
      <CardContent className='flex flex-1 flex-col justify-evenly gap-5'>
        {sources.length === 0 && empty ? (
          <span className='text-muted-foreground text-sm'>
            {empty}
            {emptyLink ? (
              <>
                {' '}
                <Link href={emptyLink.href} className='text-foreground font-medium underline underline-offset-2'>
                  {emptyLink.label}
                </Link>
              </>
            ) : null}
          </span>
        ) : null}
        {sources.map((source, index) => (
          <div key={index} className='flex items-center justify-between gap-4'>
            <div className='flex min-w-0 items-center gap-3'>
              <Avatar className='size-10 after:border-0'>
                <AvatarFallback
                  className={cn('bg-primary/10 text-primary shrink-0 [&>svg]:size-4.5', source.iconClassName)}
                >
                  {source.icon}
                </AvatarFallback>
              </Avatar>
              <div className='flex min-w-0 flex-col'>
                {source.href ? (
                  <Link href={source.href} className='truncate text-base'>
                    {source.sourceName}
                  </Link>
                ) : (
                  <span className='truncate text-base'>{source.sourceName}</span>
                )}
                <span className='text-muted-foreground truncate text-sm' title={source.sourceType}>
                  {source.sourceType}
                </span>
              </div>
            </div>
            <div className='flex flex-col items-end gap-2'>
              <span
                className={cn(
                  'text-sm',
                  source.direction === 'in' ? 'text-green-600 dark:text-green-400' : 'text-destructive'
                )}
                title={source.amountTitle}
              >
                {source.direction === 'in' ? '+' : '-'}
                {source.amount}
              </span>
              <Progress
                value={source.share}
                className={cn(
                  'w-32 **:data-[slot=progress-track]:h-1.5',
                  source.direction === 'out' && '**:data-[slot=progress-indicator]:bg-chart-4'
                )}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

export default TopCashFlowSourcesCard
