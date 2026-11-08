// Kopia 1:1 z finora-src/src/views/dashboards/statistics/statistics-area-stat-card.tsx (Przepływy, decyzja Bartosza 21.10.2026): zmienione tylko teksty, kwoty, daty i importy.
'use client'

// Third-party Imports
import { Area, AreaChart } from 'recharts'

// Component Imports
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { DymekWiersz } from '@/components/dashboard/finora/dymek'

// Util Imports
import { formatPlMoney } from '@/lib/format/pl'
import { cn } from '@/lib/utils'

/**
 * PLAN-PRAWDZIWE-DANE E6: kwota, plakietka, podpis plakietki i krzywa
 * z propsów (`adaptery.ts`: 8 punktów — sumy 8 ostatnich tygodni, dymek
 * z zakresem tygodnia); wygląd bez zmian.
 * Brak podstawy procentu → „—”, brak wpływów → pusty stan w miejscu podpisu.
 */

export type StatisticsAreaStatCardProps = {
  chartKey: string
  title: string
  amount: string
  /** Pełna kwota i zastrzeżenie danej (dymek kwoty). */
  amountTitle: string
  changePercentage: string
  /** Podpis plakietki („wobec poprzedniego miesiąca”) albo pusty stan karty. */
  comparison: string
  color: string
  badgeClassName: string
  chartData: { label: string; value: number }[]
  className?: string
}

const StatisticsAreaStatCard = ({
  chartKey,
  title,
  amount,
  amountTitle,
  changePercentage,
  comparison,
  color,
  badgeClassName,
  chartData,
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
        <div className='flex shrink-0 flex-col justify-between gap-6'>
          <div className='flex flex-col gap-1'>
            <span className='text-muted-foreground text-sm'>{title}</span>
            <span className='text-3xl font-semibold' title={amountTitle}>
              {amount}
            </span>
          </div>
          <div className='flex gap-3'>
            <Badge className={cn('h-6 px-3 py-1', badgeClassName)}>{changePercentage}</Badge>
            <span className='text-muted-foreground'>{comparison}</span>
          </div>
        </div>
        <ChartContainer config={chartConfig} className='max-h-26.5 w-full max-w-70 flex-1 max-sm:max-w-35'>
          <AreaChart data={chartData} margin={{ left: 4, right: 0 }}>
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
                    <DymekWiersz
                      color={item.color}
                      label={String((item.payload as { label?: string } | undefined)?.label ?? '')}
                      value={`${formatPlMoney(Number(value))} zł`}
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
      </CardContent>
    </Card>
  )
}

export default StatisticsAreaStatCard
