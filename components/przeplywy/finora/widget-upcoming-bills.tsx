// Next Imports
import Link from 'next/link'

// Third-party Imports
import { RiCalendarScheduleLine } from '@remixicon/react'

// Component Imports
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Card, CardContent } from '@/components/ui/card'
import { PulpitCardHeader } from '@/components/dashboard/pulpit/card-header'
import { PulpitEmptyState } from '@/components/dashboard/pulpit/card-states'

// Util Imports
import type { UpcomingInflow } from '@/lib/dashboard/cash-movements'
import { plural } from '@/lib/i18n/plural'
import { cn } from '@/lib/utils'

import { zl } from './money'

/**
 * „Spodziewane wpływy” — Finora `views/dashboards/widgets/widget-upcoming-bills.tsx`
 * („Upcoming Bills”, plan Finora P2). Lista 1:1; zamiast rachunków do
 * zapłacenia — należności (§2.4 pkt 11) z terminem w najbliższych 30 dniach.
 * Kart „Nadchodzące płatności” nie budujemy, bo faktury kosztowe z KSeF nie
 * mają w bazie terminu ani statusu zapłaty (N7).
 */

const ICON_TONES = [
  'bg-primary/10 text-primary dark:bg-primary/20',
  'bg-chart-2/10 text-chart-2',
  'bg-chart-4/10 text-chart-4',
  'bg-chart-3/10 text-chart-3',
  'bg-chart-5/10 text-chart-5'
] as const

export const UPCOMING_EMPTY = 'Brak faktur z terminem płatności w najbliższych 30 dniach'

type Props = {
  title: string
  subTitle: string
  bills: UpcomingInflow[]
  /** Ile należności ma termin w oknie (lista pokazuje najbliższe). */
  count: number
  note: string
  className?: string
}

export function dueInLabel(daysLeft: number): string {
  if (daysLeft <= 0) return 'Termin dziś'
  if (daysLeft === 1) return 'Termin jutro'
  return `Termin za ${daysLeft} ${plural(daysLeft, ['dzień', 'dni', 'dni'])}`
}

const UpcomingBillsCard = ({ title, subTitle, bills, count, note, className }: Props) => {
  return (
    <Card className={cn(className)}>
      <PulpitCardHeader title={title} subtitle={subTitle} className='flex items-center justify-between' />
      <CardContent className='flex flex-1 flex-col justify-between gap-4'>
        {bills.length === 0 ? (
          <PulpitEmptyState message={UPCOMING_EMPTY} />
        ) : (
          bills.map((bill, index) => (
            <div key={bill.id} className='flex items-center justify-between gap-2'>
              <div className='flex min-w-0 items-center gap-3'>
                <Avatar className='size-9 after:border-0'>
                  <AvatarFallback
                    className={cn(
                      'bg-primary/10 text-primary shrink-0 [&>svg]:size-4.5',
                      ICON_TONES[index % ICON_TONES.length]
                    )}
                  >
                    <RiCalendarScheduleLine aria-hidden />
                  </AvatarFallback>
                </Avatar>
                <div className='flex min-w-0 flex-col'>
                  <Link
                    href={`/invoices/${bill.id}`}
                    className='truncate text-base underline-offset-4 hover:underline'
                    title={bill.internalNumber ? `${bill.name} · ${bill.internalNumber}` : bill.name}
                  >
                    {bill.name}
                  </Link>
                  <span className='text-muted-foreground truncate text-sm'>
                    {dueInLabel(bill.daysLeft)}
                    {bill.internalNumber ? ` · ${bill.internalNumber}` : ''}
                  </span>
                </div>
              </div>
              <span className='shrink-0 text-sm font-medium'>{zl(bill.amount)}</span>
            </div>
          ))
        )}
        <p className='text-muted-foreground text-xs'>
          {count > bills.length ? `Pokazano ${bills.length} z ${count} · ` : ''}
          {note}
        </p>
      </CardContent>
    </Card>
  )
}

export default UpcomingBillsCard
