// Kopia 1:1 z finora-src/src/views/pages/money-management/monthly-analytics/recent-expenses-feed.tsx (Analizy, decyzja Bartosza 21.10.2026): zmienione tylko teksty (z propsów), kwoty (zł, pl-PL), daty (DD.MM.RRRR), importy i źródło danych. Odstępstwa: Server Component (bez stanu); ikona i druga linia z danych (data DD.MM.RRRR, przy fakturze także numer); dwa kierunki — wydatki ('out': strzałka w dół, `text-destructive`, jak w Finorze) i faktury sprzedaży ('in': strzałka w górę, zielony `POSITIVE_TEXT_TONE` o kontraście AA); kwota ujemna (korekta in minus) odwraca strzałkę i kolor i ma minus typograficzny, żeby korekta sprzedaży nie wyglądała jak wpływ; długa nazwa i druga linia ucięte z pełnym tekstem w `title` (`min-w-0`, `truncate`), kolumna kwoty `shrink-0`, `tabular-nums`; przy fakturze („[Korekta · ]numer · data”) druga linia to jeden rząd flex, w którym data jest nieściśliwa, a ucina się numer (`SubtitleLine`) — poprawka 21.10.2026: na telefonie i przy dwóch kolumnach ucinała się data, jedyne, co Finora tu pokazuje, a `title` nie działa na dotyku; pusty stan z akcją z §7.3 (`FinoraEmpty`, ten sam `py-6`).

// Next Imports
import Link from 'next/link'

// Third-party Imports
import { RiArrowDownLine, RiArrowUpLine } from '@remixicon/react'

// Type Imports
import type { FeedItem, FinoraEmptyState } from './types'

// Component Imports
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { POSITIVE_TEXT_TONE } from '@/components/dashboard/pulpit/stat-tile'
import FinoraEmpty from './finora-empty'

// Util Imports
import { cn } from '@/lib/utils'
import { formatZl } from './format'

/** Data z adaptera (`isoDatePl`): DD.MM.RRRR. */
const DATE_PART = /^\d{2}\.\d{2}\.\d{4}$/
const SEPARATOR = ' · '

/**
 * Druga linia wiersza. Sama data (wydatek) — akapit Finory. Data z numerem
 * faktury — jeden rząd: fragmenty przed i po dacie ucinają się (`truncate`),
 * data nie (`shrink-0`), więc zostaje widoczna niezależnie od kolejności,
 * w jakiej adapter skleja fragmenty. Wysokość ta sama: jedna linia `text-xs`.
 * Separator ma `whitespace-pre`, bo spacja na brzegu elementu flex znika;
 * czytnik go pomija (`aria-hidden`) i czyta fragmenty po kolei.
 */
const SubtitleLine = ({ text }: { text: string }) => {
  const parts = text.split(SEPARATOR)
  const at = parts.findIndex(part => DATE_PART.test(part))

  if (parts.length === 1 || at === -1) {
    return (
      <p className='text-muted-foreground truncate text-xs' title={text}>
        {text}
      </p>
    )
  }

  const before = parts.slice(0, at).join(SEPARATOR)
  const after = parts.slice(at + 1).join(SEPARATOR)
  const separator = (
    <span className='shrink-0 whitespace-pre' aria-hidden='true'>
      {SEPARATOR}
    </span>
  )

  return (
    <p className='text-muted-foreground flex min-w-0 text-xs' title={text}>
      {before ? (
        <>
          <span className='truncate'>{before}</span>
          {separator}
        </>
      ) : null}
      <span className='shrink-0'>{parts[at]}</span>
      {after ? (
        <>
          {separator}
          <span className='truncate'>{after}</span>
        </>
      ) : null}
    </p>
  )
}

type RecentExpensesFeedProps = {
  title: string
  description: string
  data: FeedItem[]
  direction: 'out' | 'in'
  empty: FinoraEmptyState
  className?: string
}

const RecentExpensesFeed = ({ title, description, data, direction, empty, className }: RecentExpensesFeedProps) => {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className='space-y-4'>
        {data.length === 0 ? (
          <FinoraEmpty {...empty} pad='py-6' />
        ) : (
          data.map(expense => {
            // Wydatek albo korekta sprzedaży in minus — w dół; wpływ albo korekta zakupu in minus — w górę.
            const isDown = (direction === 'out') === expense.amount >= 0
            const Arrow = isDown ? RiArrowDownLine : RiArrowUpLine
            const tone = isDown ? 'text-destructive' : POSITIVE_TEXT_TONE

            return (
              <div key={expense.id} className='flex items-center gap-4'>
                <div className='bg-muted flex size-10 shrink-0 items-center justify-center rounded-full'>
                  <expense.icon className='text-foreground size-5' />
                </div>
                <div className='min-w-0 flex-1'>
                  <p className='truncate text-sm font-medium' title={expense.merchant}>
                    {expense.href ? (
                      <Link href={expense.href}>
                        {expense.merchant}
                      </Link>
                    ) : (
                      expense.merchant
                    )}
                  </p>
                  <SubtitleLine text={expense.subtitle} />
                </div>
                <div className='flex shrink-0 items-center gap-1'>
                  <Arrow className={cn('size-4', tone)} />
                  <span className={cn('text-sm font-medium tabular-nums', tone)}>{formatZl(expense.amount)}</span>
                </div>
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}

export default RecentExpensesFeed
