// Third-party Imports
import Link from 'next/link'
import { RiArrowLeftDownLongLine, RiArrowRightUpLine, RiTimeLine } from '@remixicon/react'

// Component Imports
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'

// Util Imports
import { cn } from '@/lib/utils'

/**
 * Karta z trzema kolumnami (dawne „Odwiedzający”, PLAN-PRAWDZIWE-DANE E5):
 * należności według terminu. Wysokość kolumny = udział kwoty (`pct`), nie
 * wpisana klasa; strzałka z propsów (`trend`): w terminie ↗, po terminie ↙.
 */
export type TotalVisitorsColumn = {
  name: string
  /** Pełna nazwa kolumny (dymek przeglądarki i czytnik ekranu). */
  nameTitle: string
  pct: number
  amount: string
  amountTitle?: string
  trend: 'up' | 'down'
  color: string
}

type Props = {
  title: string
  total: string
  totalTitle?: string
  badge: string
  /** Zastrzeżenie o danych (dymek tytułu i czytnik ekranu) — karta nie ma miejsca na podpis. */
  note?: string | null
  detailsHref: string
  visitorData: TotalVisitorsColumn[]
  className?: string
}

const TotalVisitorsCard = ({ title, total, totalTitle, badge, note, detailsHref, visitorData, className }: Props) => {
  return (
    <Card className={cn('gap-4', className)}>
      <CardHeader className='flex flex-col'>
        <div className='flex w-full items-center justify-between gap-2'>
          <div className='flex items-center gap-2 text-base'>
            <Avatar className='after:border-0'>
              <AvatarFallback className='bg-primary/15 dark:bg-primary/25 text-primary shrink-0'>
                <RiTimeLine className='size-4' />
              </AvatarFallback>
            </Avatar>
            <span title={note ?? undefined}>{title}</span>
            {note ? <span className='sr-only'>{note}</span> : null}
          </div>
          {/*
            E7 pkt 2: przycisk bez celu → link, ten sam wygląd. `cn()` jak w `Button`:
            sam `buttonVariants` zostawia obok siebie `border-transparent` (baza) i `border-border`
            (outline), a w arkuszu wygrywa przezroczysta — link tracił obramowanie (zrzuty 24.10.2026).
          */}
          <Link
            href={detailsHref}
            data-slot='button'
            data-variant='outline'
            data-size='xs'
            className={cn(buttonVariants({ variant: 'outline', size: 'xs' }))}
          >
            Szczegóły
          </Link>
        </div>

        <div className='flex items-center gap-2'>
          <span className='text-2xl font-semibold' title={totalTitle}>
            {total}
          </span>
          {/* Odstępstwo od Finory (WCAG 1.4.3): text-primary na primary/15 daje 4,13:1 (ciemny /25: 3,76:1); accent-foreground 8,38 / 6,76. */}
          <Badge className='bg-primary/15 dark:bg-primary/25 [a&]:hover:bg-primary/5 focus-visible:ring-primary/20 dark:focus-visible:ring-primary/40 text-accent-foreground focus-visible:outline-none'>
            {badge}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className='flex flex-1 flex-col gap-4'>
        <Separator />
        <div className='flex flex-1'>
          {visitorData.map((item, index) => (
            <div key={index} className='flex grow flex-col gap-2.5 border-dashed p-2 not-last:border-r'>
              <span className='text-muted-foreground text-sm' title={item.nameTitle}>
                {item.name}
              </span>

              <div className='text-2xl font-medium'>{item.pct}%</div>
              <div className='flex min-h-35 flex-1 items-end'>
                <div className={cn('bg-primary grow rounded-xl', item.color)} style={{ height: `${item.pct}%` }}></div>
              </div>
              <div className='flex items-center justify-between gap-2'>
                <span className='text-muted-foreground text-sm' title={item.amountTitle}>
                  {item.amount}
                </span>
                {item.trend === 'up' ? (
                  <RiArrowRightUpLine className='size-4' />
                ) : (
                  <RiArrowLeftDownLongLine className='size-4' />
                )}
                <span className='sr-only'>{item.nameTitle}</span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export default TotalVisitorsCard
