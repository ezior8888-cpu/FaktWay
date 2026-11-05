// Kopia 1:1 z finora-src/src/views/dashboards/widgets/widget-recent-activity.tsx (Przepływy, decyzja Bartosza 21.10.2026): zmienione tylko teksty, kwoty, daty i importy.

// React Imports
import type { ReactElement } from 'react'

// Next Imports
import Link from 'next/link'

// Third-party Imports
import { RiArrowDownLine, RiArrowUpLine } from '@remixicon/react'

// Component Imports
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Card, CardContent } from '@/components/ui/card'
import CardHeaderWithMenu, { type CardMenuItem } from '@/components/dashboard/finora/card-header-with-menu'

// Util Imports
import { cn } from '@/lib/utils'

/**
 * PLAN-PRAWDZIWE-DANE E6: ostatnie wpłaty i koszty z FaktWay z propsów
 * (kontrahent, „Wpłata · DD.MM.RRRR”, numer dokumentu w dymku); nazwa jest
 * linkiem do faktury albo wydatku tylko w trybie prawdziwym (E7 pkt 3).
 */
type Props = {
  title: string
  activity: {
    icon: ReactElement
    label: string
    subLabel: string
    subLabelTitle?: string
    amount: string
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

const RecentActivityCard = ({ title, activity, empty, emptyLink, menuItems, className }: Props) => {
  return (
    <Card className={cn(className)}>
      <CardHeaderWithMenu title={title} menuItems={menuItems} />
      <CardContent className='flex flex-1 flex-col justify-between gap-4'>
        {activity.length === 0 && empty ? (
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
        {activity.map((item, index) => (
          <div key={index} className='flex items-center justify-between gap-2'>
            <div className='flex min-w-0 items-center justify-between gap-3'>
              <Avatar className='size-9 after:border-0'>
                <AvatarFallback
                  className={cn('bg-primary/10 text-primary shrink-0 [&>svg]:size-4.5', item.iconClassName)}
                >
                  {item.icon}
                </AvatarFallback>
              </Avatar>
              <div className='flex min-w-0 flex-col'>
                {item.href ? (
                  <Link href={item.href} className='truncate text-base'>
                    {item.label}
                  </Link>
                ) : (
                  <span className='truncate text-base'>{item.label}</span>
                )}
                <span className='text-muted-foreground truncate text-sm' title={item.subLabelTitle}>
                  {item.subLabel}
                </span>
              </div>
            </div>
            {/* Kwota nieściśliwa: przy długiej nazwie firmy ucina się nazwa, a nie zawija kwota. */}
            <div className='flex shrink-0 items-center gap-2 text-sm'>
              <span>
                {item.direction === 'out' ? '-' : '+'}
                {item.amount}
              </span>
              <div className='bg-muted text-primary flex size-6 shrink-0 items-center justify-center rounded-full'>
                {item.direction === 'out' ? (
                  <RiArrowDownLine className='size-4' />
                ) : (
                  <RiArrowUpLine className='size-4' />
                )}
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

export default RecentActivityCard
