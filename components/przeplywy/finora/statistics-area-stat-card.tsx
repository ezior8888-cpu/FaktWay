'use client'

// Next Imports
import Link from 'next/link'

// Third-party Imports
import { Area, AreaChart } from 'recharts'

// Component Imports
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'

// Util Imports
import type { MonthFlow } from '@/lib/dashboard/cash-movements'
import { formatPlCompactMoney, formatPlPercentChange } from '@/lib/format/pl'
import { cn } from '@/lib/utils'

import { MoneyTooltipRow, zl } from './money'

/**
 * Kafel „Wpłynęło / Wydano w tym miesiącu” — Finora
 * `views/dashboards/statistics/statistics-area-stat-card.tsx` (plan Finora P2).
 * Układ, plakietka i wykres warstwowy 1:1. Wykres to suma narastająca od
 * 1. dnia miesiąca do dziś (w szablonie osiem dni z danymi przykładowymi).
 *
 * `empty` zastępuje kwotę, gdy w miesiącu nie ma czego pokazać — wpływy bez
 * żadnej oznaczonej wpłaty to „Oznacz wpłatę przy fakturze”, nigdy
 * „0 zł” (§2.4 pkt 14).
 */

export type StatisticsAreaStatCardProps = {
  chartKey: string
  title: string
  flow: MonthFlow
  color: string
  /** Podpis pod kwotą, np. „według oznaczonych wpłat”. */
  note?: string
  empty?: { message: string; href?: string; linkLabel?: string } | null
  className?: string
}

/**
 * Plakietka zmiany: wzrost zielony, spadek czerwony (plan Finora §7.1;
 * w szablonie obie plakietki mają kolor `chart-4`). Odcienie jak na kafelkach
 * Pulpitu — `green-600` z szablonu ma na białej karcie za mały kontrast.
 */
function changeTone(pct: number): string {
  if (Math.round(pct) > 0) return 'bg-green-700/10 text-green-800 dark:bg-green-400/15 dark:text-green-400'
  if (Math.round(pct) < 0) return 'bg-destructive/10 text-destructive'
  return 'bg-muted text-muted-foreground'
}

/** „Narastająco do 15.10” z RRRR-MM-DD. */
function untilDayLabel(iso: string | undefined): string {
  return iso ? `Narastająco do ${iso.slice(8, 10)}.${iso.slice(5, 7)}` : 'Narastająco'
}

const StatisticsAreaStatCard = ({
  chartKey,
  title,
  flow,
  color,
  note,
  empty = null,
  className
}: StatisticsAreaStatCardProps) => {
  const gradientId = `fillAreaStat-${chartKey}`

  const chartConfig = {
    value: {
      label: title,
      color
    }
  } satisfies ChartConfig

  return (
    <Card className={cn(className)}>
      <CardContent className='flex flex-1 items-center justify-between gap-4 pr-6'>
        <div className='flex min-w-0 shrink-0 flex-col justify-between gap-6'>
          <div className='flex flex-col gap-1'>
            <span className='text-muted-foreground text-sm'>{title}</span>
            {empty ? (
              <>
                <span className='text-3xl font-semibold'>—</span>
                <span className='text-muted-foreground max-w-56 text-sm'>{empty.message}</span>
                {empty.href ? (
                  <Link href={empty.href} className='text-primary text-sm underline-offset-4 hover:underline'>
                    {empty.linkLabel}
                  </Link>
                ) : null}
              </>
            ) : (
              <>
                <span className='text-3xl font-semibold' title={zl(flow.amount)}>
                  {formatPlCompactMoney(flow.amount)}
                </span>
                {note ? <span className='text-muted-foreground text-xs'>{note}</span> : null}
              </>
            )}
          </div>
          {empty ? null : (
            <div className='flex flex-wrap gap-3'>
              {flow.changePct === null ? (
                <span className='text-muted-foreground text-sm'>Brak danych z poprzedniego miesiąca</span>
              ) : (
                <>
                  <Badge className={cn('h-6 px-3 py-1', changeTone(flow.changePct))}>{formatPlPercentChange(flow.changePct)}</Badge>
                  <span className='text-muted-foreground'>vs poprzedni miesiąc</span>
                </>
              )}
            </div>
          )}
        </div>
        {empty || flow.daily.length < 2 ? null : (
          <ChartContainer config={chartConfig} className='max-h-26.5 w-full max-w-70 flex-1 max-sm:max-w-35'>
            <AreaChart data={flow.daily} margin={{ left: 4, right: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1='0' y1='0' x2='0' y2='1'>
                  <stop offset='10%' stopColor='var(--color-value)' stopOpacity={1} />
                  <stop offset='90%' stopColor='var(--color-value)' stopOpacity={0} />
                </linearGradient>
              </defs>
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    hideLabel
                    formatter={(value, _name, item) => (
                      <MoneyTooltipRow
                        label={untilDayLabel((item?.payload as { date?: string } | undefined)?.date)}
                        amount={Number(value)}
                      />
                    )}
                  />
                }
              />
              <Area
                dataKey='value'
                type='natural'
                fill={`url(#${gradientId})`}
                stroke='var(--color-value)'
                strokeWidth={2}
                stackId='a'
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

export default StatisticsAreaStatCard
