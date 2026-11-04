'use client'

// React Imports
import { useState } from 'react'

// Third-party Imports
import { Bar, BarChart, XAxis, YAxis } from 'recharts'

// Component Imports
import { Card, CardContent } from '@/components/ui/card'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PulpitCardHeader } from '@/components/dashboard/pulpit/card-header'
import { PulpitEmptyState } from '@/components/dashboard/pulpit/card-states'

// Util Imports
import type { CashFlowChartData, FlowBucket } from '@/lib/dashboard/cash-movements'
import { formatPlCompactMoney } from '@/lib/format/pl'
import { PAID_EMPTY_STATE } from '@/lib/invoices/paid-labels'
import { cn } from '@/lib/utils'

import { MoneyTooltipRow, zl } from './money'

/**
 * „Wpływy i wydatki” — Finora `views/dashboards/charts/chart-cash-flow.tsx`
 * (plan Finora P2). Siatka, przełącznik i wykres 1:1; dane przykładowe
 * zastąpione wpływami według oznaczonych wpłat (§2.4 pkt 14) i wydatkami
 * brutto z kosztów (§2.4 pkt 12).
 *
 * Różnice wobec szablonu: sumy „Wpłynęło” / „Wydano” idą za wybraną
 * zakładką (w szablonie zawsze z widoku miesięcznego), menu „⋯” bez
 * działających pozycji wylatuje (jak na kartach Pulpitu z E4).
 */

const cashFlowChartConfig = {
  inflow: {
    label: 'Wpływy',
    color: 'var(--chart-2)'
  },
  outflow: {
    label: 'Wydatki',
    color: 'var(--chart-4)'
  }
} satisfies ChartConfig

type TabValue = 'week' | 'month' | 'year'

const tabsData: Array<{ value: TabValue; label: string }> = [
  { value: 'week', label: 'Tydzień' },
  { value: 'month', label: 'Miesiąc' },
  { value: 'year', label: 'Rok' }
]

function totals(buckets: readonly FlowBucket[]) {
  return {
    inflow: buckets.reduce((sum, b) => sum + b.inflow, 0),
    outflow: buckets.reduce((sum, b) => sum + b.outflow, 0),
    inflowCount: buckets.reduce((sum, b) => sum + b.inflowCount, 0)
  }
}

const CashFlowCard = ({ data, className }: { data: CashFlowChartData; className?: string }) => {
  const [tab, setTab] = useState<TabValue>('month')
  const current = totals(data[tab])
  const noMovements = (Object.keys(data) as TabValue[]).every(key => {
    const t = totals(data[key])
    return t.inflowCount === 0 && t.outflow === 0
  })

  return (
    <Card className={cn(className)}>
      <PulpitCardHeader
        title='Wpływy i wydatki'
        subtitle='Wpływy według oznaczonych wpłat, wydatki brutto z kosztów'
        className='flex items-center justify-between'
      />

      <Tabs value={tab} onValueChange={value => setTab(value as TabValue)} className='gap-6'>
        <CardContent className='flex flex-wrap items-center justify-between gap-4'>
          <div className='flex items-center gap-6'>
            <div className='flex items-center gap-2'>
              <span className='bg-chart-2 h-8 w-1 rounded-full' />
              <div className='flex flex-col'>
                <span
                  className='text-xl font-semibold'
                  title={current.inflowCount > 0 ? zl(current.inflow) : PAID_EMPTY_STATE}
                >
                  {current.inflowCount > 0 ? formatPlCompactMoney(current.inflow) : '—'}
                </span>
                <span className='text-muted-foreground text-sm'>Wpłynęło</span>
              </div>
            </div>
            <div className='flex items-center gap-2'>
              <span className='bg-chart-4 h-8 w-1 rounded-full' />
              <div className='flex flex-col'>
                <span className='text-xl font-semibold' title={zl(current.outflow)}>
                  {formatPlCompactMoney(current.outflow)}
                </span>
                <span className='text-muted-foreground text-sm'>Wydano</span>
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
          {noMovements ? (
            <PulpitEmptyState message={PAID_EMPTY_STATE} />
          ) : (
            tabsData.map(item => (
              <TabsContent key={item.value} value={item.value}>
                <span className='sr-only'>
                  {`Wykres słupkowy: wpływy i wydatki, widok ${item.label.toLowerCase()}`}
                </span>
                <ChartContainer config={cashFlowChartConfig} className='h-65 w-full'>
                  <BarChart
                    accessibilityLayer
                    data={data[item.value]}
                    barGap={4}
                    margin={{ left: -20, right: 0, bottom: -5 }}
                  >
                    <XAxis
                      dataKey='label'
                      tickLine={false}
                      tickMargin={10}
                      axisLine={false}
                      tick={{ fill: 'var(--muted-foreground)' }}
                    />
                    <YAxis
                      tickFormatter={(v: number) => formatPlCompactMoney(v)}
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      width={80}
                      tick={{ fill: 'var(--muted-foreground)' }}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={
                        <ChartTooltipContent
                          labelFormatter={(_, payload) =>
                            (payload?.[0]?.payload as FlowBucket | undefined)?.period ?? ''
                          }
                          formatter={(value, name) => (
                            <MoneyTooltipRow
                              label={cashFlowChartConfig[name as keyof typeof cashFlowChartConfig]?.label ?? String(name)}
                              amount={Number(value)}
                              color={`var(--color-${String(name)})`}
                            />
                          )}
                        />
                      }
                    />
                    <Bar dataKey='inflow' fill='var(--color-inflow)' radius={4} />
                    <Bar dataKey='outflow' fill='var(--color-outflow)' radius={4} />
                  </BarChart>
                </ChartContainer>
                {totals(data[item.value]).inflowCount === 0 ? (
                  <p className='text-muted-foreground mt-2 text-sm'>{PAID_EMPTY_STATE}</p>
                ) : null}
              </TabsContent>
            ))
          )}
        </CardContent>
      </Tabs>
    </Card>
  )
}

export default CashFlowCard
