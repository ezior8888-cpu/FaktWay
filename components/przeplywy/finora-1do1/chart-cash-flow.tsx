'use client'

// Kopia 1:1 z finora-src/src/views/dashboards/charts/chart-cash-flow.tsx (Przepływy, decyzja Bartosza 21.10.2026): zmienione tylko teksty, kwoty, daty i importy.

// React Imports
import { useState } from 'react'

// Third-party Imports
import { Bar, BarChart, XAxis, YAxis } from 'recharts'

// Component Imports
import { Card, CardContent } from '@/components/ui/card'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DemoBadge } from '@/components/dashboard/demo-badge'
import CardHeaderWithMenu, { type CardMenuItem } from '@/components/dashboard/finora/card-header-with-menu'
import { DymekWiersz } from '@/components/dashboard/finora/dymek'

// Util Imports
import type { FlowBucket } from '@/lib/dashboard/cash-movements'
import { INFLOW_EMPTY_TITLE, INFLOW_NONE, INFLOW_NOTE } from '@/lib/dashboard/inflow-labels'
import { formatPlCompactNumber, formatPlInt, formatPlMoney } from '@/lib/format/pl'
import { cn } from '@/lib/utils'

/**
 * PLAN-PRAWDZIWE-DANE E6: dane z propsów (`buildCashFlowChart` przez
 * `adaptery.ts`), wygląd bez zmian. Sumy nad wykresem idą za AKTYWNĄ
 * zakładką (w szablonie zawsze z miesięcy), oś Y z danych („12 tys.”),
 * dymek z „zł”. Seria „Wpływy” to oznaczone wpłaty (D-W odwołane 02.11.2026),
 * a okres bez żadnej wpłaty mówi to wprost.
 */

type TabValue = 'weekly' | 'monthly' | 'yearly'

const cashFlowChartConfig = {
  inflow: {
    label: 'Wpływy',
    color: 'var(--chart-2)'
  },
  outflow: {
    label: 'Koszty (brutto)',
    color: 'var(--chart-4)'
  }
} satisfies ChartConfig

const tabsData: { value: TabValue; label: string }[] = [
  { value: 'weekly', label: 'Tygodniowo' },
  { value: 'monthly', label: 'Miesięcznie' },
  { value: 'yearly', label: 'Rocznie' }
]

// Kwota bez groszy jak w szablonie („22 300 zł”); pełna w dymku sumy.
const formatPln = (value: number) => `${formatPlInt(Math.round(value))} zł`
const zl = (value: number) => `${formatPlMoney(value)} zł`

function totals(buckets: readonly FlowBucket[]) {
  return {
    inflow: buckets.reduce((sum, b) => sum + b.inflow, 0),
    outflow: buckets.reduce((sum, b) => sum + b.outflow, 0),
    inflowCount: buckets.reduce((sum, b) => sum + b.inflowCount, 0)
  }
}

/**
 * Krok etykiet domyślnej osi recharts (`getNiceTickValues`, 5 etykiet) —
 * ta sama oś co w Finorze (0, 950, 1900, 2850, 3800), więc kroki „po 0,05 ×
 * 10ⁿ”: przy maksimum 37 801 zł to 9500 („28,5 tys.”).
 */
function rechartsStep(max: number): number {
  const rough = max / 4
  if (!(rough > 0)) return 1
  const scale = 10 ** (Math.floor(Math.log10(rough)) + 1)
  const amend = scale === 10 ? 0.1 : 0.05

  return Math.ceil(rough / scale / amend) * amend * scale
}

/**
 * Szerokość osi Y tylko tyle, by zmieściły się etykiety („28,5 tys.”). Nie
 * węższa niż w szablonie: domyślne 60 px przy `margin left -20`.
 */
function yAxisWidth(buckets: readonly FlowBucket[]): number {
  const max = Math.max(0, ...buckets.flatMap(b => [b.inflow, b.outflow]))
  const step = rechartsStep(max)
  let longest = 1

  for (let i = 0; i <= 5; i++) {
    longest = Math.max(longest, formatPlCompactNumber(step * i).length)
  }

  return Math.max(40, Math.ceil(longest * 6 + 8))
}

type CashFlowCardProps = {
  tabs: Record<TabValue, FlowBucket[]>
  subTitle: string
  /** Pełne zdanie podtytułu (dymek i czytnik ekranu) — podtytuł mieści się w jednej linii. */
  subTitleHint?: string
  menuItems?: CardMenuItem[]
  /** D-P: plakietka „Dane przykładowe” w nagłówku. */
  demo?: boolean
  className?: string
}

const CashFlowCard = ({ tabs, subTitle, subTitleHint, menuItems, demo, className }: CashFlowCardProps) => {
  const [tab, setTab] = useState<TabValue>('monthly')
  const current = totals(tabs[tab])

  return (
    <Card className={cn(className)}>
      <CardHeaderWithMenu title='Przepływy pieniężne' subTitle={subTitle} subTitleHint={subTitleHint} menuItems={menuItems} badge={demo ? <DemoBadge skracana /> : undefined} />

      <Tabs value={tab} onValueChange={value => setTab(value as TabValue)} className='gap-6'>
        <CardContent className='flex flex-wrap items-center justify-between gap-4'>
          <div className='flex items-center gap-6'>
            <div className='flex items-center gap-2'>
              <span className='bg-chart-2 h-8 w-1 rounded-full' />
              <div className='flex flex-col'>
                <span
                  className='text-xl font-semibold'
                  title={current.inflowCount > 0 ? `${zl(current.inflow)} · ${INFLOW_NOTE}` : INFLOW_EMPTY_TITLE}
                >
                  {current.inflowCount > 0 ? formatPln(current.inflow) : '—'}
                </span>
                <span className='text-muted-foreground text-sm'>Suma wpływów</span>
              </div>
            </div>
            <div className='flex items-center gap-2'>
              <span className='bg-chart-4 h-8 w-1 rounded-full' />
              <div className='flex flex-col'>
                <span className='text-xl font-semibold' title={`${zl(current.outflow)} brutto`}>
                  {formatPln(current.outflow)}
                </span>
                <span className='text-muted-foreground text-sm'>Suma kosztów</span>
              </div>
            </div>
          </div>

          <TabsList>
            {tabsData.map(item => (
              <TabsTrigger className='shadow-none' key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </CardContent>

        <CardContent>
          {tabsData.map(item => (
            <TabsContent key={item.value} value={item.value}>
              <ChartContainer config={cashFlowChartConfig} className='h-65 w-full'>
                <BarChart accessibilityLayer data={tabs[item.value]} barGap={4} margin={{ left: 0, right: 0, bottom: -5 }}>
                  <XAxis
                    dataKey='label'
                    tickLine={false}
                    tickMargin={10}
                    axisLine={false}
                    tick={{ fill: 'var(--muted-foreground)' }}
                  />
                  <YAxis
                    width={yAxisWidth(tabs[item.value])}
                    tickFormatter={value => formatPlCompactNumber(Number(value))}
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tick={{ fill: 'var(--muted-foreground)' }}
                  />
                  <ChartTooltip
                    cursor={false}
                    content={
                      <ChartTooltipContent
                        labelFormatter={(_, payload) => String((payload?.[0]?.payload as FlowBucket | undefined)?.period ?? '')}
                        formatter={(value, name, item) => {
                          const bucket = item.payload as FlowBucket

                          if (name === 'inflow') {
                            return (
                              <DymekWiersz
                                color={item.color}
                                label={cashFlowChartConfig.inflow.label}
                                value={bucket.inflowCount > 0 ? zl(Number(value)) : INFLOW_NONE}
                              />
                            )
                          }

                          return <DymekWiersz color={item.color} label={cashFlowChartConfig.outflow.label} value={zl(Number(value))} />
                        }}
                      />
                    }
                  />
                  <Bar dataKey='inflow' fill='var(--color-inflow)' radius={4} />
                  <Bar dataKey='outflow' fill='var(--color-outflow)' radius={4} />
                </BarChart>
              </ChartContainer>
            </TabsContent>
          ))}
        </CardContent>
      </Tabs>
    </Card>
  )
}

export default CashFlowCard
