// Kopia 1:1 z finora-src/src/views/dashboards/widgets/widget-upcoming-bills.tsx (Przepływy, decyzja Bartosza 21.10.2026): zmienione tylko teksty, kwoty, daty i importy.
// React Imports
import type { ReactElement } from 'react'

// Next Imports
import Link from 'next/link'

// Component Imports
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Card, CardContent } from '@/components/ui/card'
import CardHeaderWithMenu, { type CardMenuItem } from '@/components/dashboard/finora/card-header-with-menu'

// Util Imports
import { cn } from '@/lib/utils'

/**
 * PLAN-PRAWDZIWE-DANE E6: „Nadchodzące rachunki” → „Spodziewane wpływy”
 * (faktury z terminem w 30 dni) z propsów; nazwa jest linkiem do faktury
 * tylko w trybie prawdziwym (E7 pkt 3). Opis danych (`note`: otwarte faktury
 * bez oznaczonej zapłaty) nie ma miejsca w podtytule — idzie do jego dymku
 * i do czytnika ekranu.
 */
type Props = {
  title: string
  subTitle: string
  /** Zastrzeżenie danej częściowej: dymek podtytułu i czytnik ekranu. */
  note?: string
  bills: {
    icon: ReactElement
    title: string
    titleHint?: string
    dueDate: string
    amount: string
    iconClassName?: string
    href?: string | null
  }[]
  /** Tekst pustej listy (karta bez pozycji). */
  empty?: string
  menuItems?: CardMenuItem[]
  className?: string
}

const UpcomingBillsCard = ({ title, subTitle, note, bills, empty, menuItems, className }: Props) => {
  return (
    <Card className={cn(className)}>
      <CardHeaderWithMenu title={title} subTitle={subTitle} subTitleHint={note} menuItems={menuItems} />
      <CardContent className='flex flex-1 flex-col justify-between gap-4'>
        {bills.length === 0 && empty ? <span className='text-muted-foreground text-sm'>{empty}</span> : null}
        {bills.map((bill, index) => (
          <div key={index} className='flex items-center justify-between gap-2'>
            <div className='flex min-w-0 items-center gap-3'>
              <Avatar className='size-9 after:border-0'>
                <AvatarFallback
                  className={cn('bg-primary/10 text-primary shrink-0 [&>svg]:size-4.5', bill.iconClassName)}
                >
                  {bill.icon}
                </AvatarFallback>
              </Avatar>
              <div className='flex min-w-0 flex-col'>
                {bill.href ? (
                  <Link href={bill.href} className='truncate text-base' title={bill.titleHint}>
                    {bill.title}
                  </Link>
                ) : (
                  <span className='truncate text-base' title={bill.titleHint}>
                    {bill.title}
                  </span>
                )}
                <span className='text-muted-foreground truncate text-sm'>{bill.dueDate}</span>
              </div>
            </div>
            {/* Kwota nieściśliwa: przy długiej nazwie firmy ucina się nazwa, a nie zawija kwota. */}
            <span className='shrink-0 text-sm font-medium'>{bill.amount}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

export default UpcomingBillsCard
