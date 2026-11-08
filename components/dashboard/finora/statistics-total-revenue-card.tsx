'use client'

// Third-party Imports
import { Bar, BarChart } from 'recharts'

// Component Imports
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { DymekWiersz } from './dymek'

// Util Imports
import { formatPlMoney, formatPlPercentChange } from '@/lib/format/pl'
import { cn } from '@/lib/utils'

export type PrzychodMiesiac = {
  /** Podpis miesiąca, np. „Paź”. */
  month: string
  /** Netto miesiąca w tym roku. */
  current: number
  /** Netto tego samego miesiąca rok wcześniej. */
  previous: number
}

export type StatisticsTotalRevenueCardProps = {
  value: string
  valueTitle?: string
  /** Zmiana m/m; `null` (brak podstawy) → bez procentu. */
  changePct: number | null
  description: string
  descriptionTitle?: string
  series: PrzychodMiesiac[]
  /** Czy firma ma sprzedaż sprzed roku — bez niej dymek mówi „brak danych”, nie „0 zł”. */
  hasPrevYear: boolean
  className?: string
}

// Revenue chart config: te same kolory co w Finorze, prawdziwe nazwy serii.
const revenueChartConfig = {
  current: {
    label: 'Ten rok',
    color: 'var(--chart-2)'
  },
  previous: {
    label: 'Rok wcześniej',
    color: 'color-mix(in oklab, var(--chart-2) 20%, transparent)'
  }
} satisfies ChartConfig

const zl = (n: number) => `${formatPlMoney(n)} zł`

const StatisticsTotalRevenueCard = ({
  value,
  valueTitle,
  changePct,
  description,
  descriptionTitle,
  series,
  hasPrevYear,
  className
}: StatisticsTotalRevenueCardProps) => {
  return (
    <Card className={cn('justify-between', className)}>
      <CardHeader>
        <div className='flex items-center gap-2'>
          <CardTitle className='text-lg font-semibold' title={valueTitle}>
            {value}
          </CardTitle>
          <span className='text-base'>{changePct === null ? null : formatPlPercentChange(changePct)}</span>
        </div>
        <CardDescription className='text-muted-foreground text-base' title={descriptionTitle}>
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={revenueChartConfig} className='h-31 w-full'>
          <BarChart
            accessibilityLayer
            data={series}
            barSize={12}
            margin={{
              left: 0,
              right: 0
            }}
            barGap={0}
          >
            <Bar dataKey='current' fill='var(--color-current)' radius={[12, 12, 0, 0]} />
            <Bar dataKey='previous' fill='var(--color-previous)' radius={[12, 12, 0, 0]} />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => String(payload?.[0]?.payload?.month ?? '')}
                  formatter={(itemValue, name, item) =>
                    name === 'previous' ? (
                      <DymekWiersz color={item.color} label='Rok wcześniej' value={hasPrevYear ? zl(Number(itemValue)) : 'brak danych'} />
                    ) : (
                      <DymekWiersz color={item.color} label='Ten rok' value={zl(Number(itemValue))} />
                    )
                  }
                />
              }
            />
          </BarChart>
        </ChartContainer>
        {/* Blada seria nie ma kontrastu 3:1 — kwoty obu serii także tekstem (PLAN-PRAWDZIWE-DANE §11 pkt 9). */}
        <ul className='sr-only'>
          {series.map(m => (
            <li key={m.month}>
              {`${m.month}: ten rok ${zl(m.current)}, rok wcześniej ${hasPrevYear ? zl(m.previous) : 'brak danych'}`}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

export default StatisticsTotalRevenueCard
