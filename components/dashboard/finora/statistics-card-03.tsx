// React Imports
import type { ReactNode } from 'react'

// Third-party Imports
import { RiArrowDownSLine, RiArrowUpSLine } from '@remixicon/react'

// Component Imports
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

// Util Imports
import { formatPlPercentChange } from '@/lib/format/pl'
import { cn } from '@/lib/utils'

// Statistics card data type
export type StatisticsCardProps = {
  icon: ReactNode
  /**
   * Zmiana w procentach; strzałka i znak liczone z niej (PLAN-PRAWDZIWE-DANE
   * E5, dawniej wpisane na sztywno). `null` (brak podstawy) → „—” bez strzałki.
   */
  changePct: number | null
  value: string
  /** Pełna wartość w dymku przeglądarki (`title`), np. kwota do grosza. */
  valueTitle?: string
  title: string
  badgeContent: string
  className?: string
  iconClassName?: string
}

const StatisticsCard = ({
  icon,
  value,
  valueTitle,
  title,
  changePct,
  badgeContent,
  className,
  iconClassName
}: StatisticsCardProps) => {
  const rounded = changePct === null ? null : Math.round(changePct)

  return (
    <Card className={className}>
      <CardHeader className='flex items-center justify-between'>
        <Avatar className='size-9.5 after:border-0'>
          <AvatarFallback
            className={cn('bg-primary/10 text-primary size-9.5 shrink-0 [&>svg]:size-4.75', iconClassName)}
          >
            {icon}
          </AvatarFallback>
        </Avatar>
        <p className='flex items-center gap-1 text-base'>
          {rounded === null ? '—' : formatPlPercentChange(rounded)}{' '}
          {rounded !== null && rounded > 0 ? <RiArrowUpSLine className='size-4' /> : null}
          {rounded !== null && rounded < 0 ? <RiArrowDownSLine className='size-4' /> : null}
        </p>
      </CardHeader>
      <CardContent className='flex flex-1 flex-col justify-between gap-4'>
        <p className='flex flex-col gap-1'>
          <span className='text-lg font-semibold' title={valueTitle}>
            {value}
          </span>
          <span className='text-muted-foreground text-sm'>{title}</span>
        </p>
        {/*
          Odstępstwo od Finory (WCAG 1.4.3): tekst `accent-foreground`, nie `primary` —
          `text-primary` na `bg-primary/10` ma 4,44:1 (jasny), na `dark:bg-primary/25`
          3,76:1 (ciemny); `accent-foreground` daje 9,00 i 6,76:1.
        */}
        <Badge className='bg-primary/10 text-accent-foreground dark:bg-primary/25'>{badgeContent}</Badge>
      </CardContent>
    </Card>
  )
}

export default StatisticsCard
