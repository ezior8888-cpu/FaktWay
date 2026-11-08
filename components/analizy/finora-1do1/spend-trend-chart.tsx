'use client'

// Kopia 1:1 z finora-src/src/views/pages/money-management/monthly-analytics/spend-trend-chart.tsx (Analizy, decyzja Bartosza 21.10.2026): zmienione tylko teksty (z propsów), kwoty (zł, pl-PL), daty (DD.MM.RRRR), importy i źródło danych. Odstępstwa: podpisy osi Y bez „zł” (`formatAxisMoney`), żeby zmieściły się w Finorowym `width={48}`; `[&_.recharts-surface]:overflow-visible` na kontenerze, żeby dłuższy podpis („120 tys.”) wszedł w margines karty zamiast się uciąć; podpowiedź odtwarza domyślny wiersz Finory (kropka, nazwa serii, kwota) z pełną kwotą `formatZl` i bez `className='w-30'` — stała szerokość ~114 px nie mieści „Wydatki 12 345,67 zł” (jedyne odstępstwo rozmiaru, dotyczy tylko podpowiedzi); pusty stan (gdy wszystkie 6 miesięcy to zero) w pudełku o klasach wykresu, więc karta nie zmienia wysokości; ukryta lista `sr-only` z kwotą każdego miesiąca (WCAG 1.1.1 — recharts nie ogłasza podpowiedzi, a SVG daje czytnikowi tylko podpisy osi; tak samo jak w kole, bez wpływu na wygląd i rozmiar).

// React Imports
import type { CSSProperties } from 'react'

// Third-party Imports
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'

// Type Imports
import type { FinoraEmptyState, TrendDatum } from './types'

// Component Imports
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import FinoraEmpty from './finora-empty'

// Util Imports
import { formatAxisMoney, formatZl } from './format'

type SpendTrendChartProps = {
  title: string
  description: string
  seriesLabel: string
  data: TrendDatum[]
  empty?: FinoraEmptyState | null
  className?: string
}

const SpendTrendChart = ({ title, description, seriesLabel, data, empty, className }: SpendTrendChartProps) => {
  const chartConfig = {
    amount: { label: seriesLabel, color: 'var(--chart-1)' }
  } satisfies ChartConfig

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {empty ? (
          <div className='flex aspect-video max-h-70 w-full items-center justify-center'>
            <FinoraEmpty {...empty} pad='py-6' />
          </div>
        ) : (
          <>
            <ChartContainer config={chartConfig} className='max-h-70 w-full [&_.recharts-surface]:overflow-visible'>
              <BarChart accessibilityLayer data={data}>
                <CartesianGrid vertical={false} strokeDasharray='5' stroke='var(--border)' />
                <XAxis dataKey='month' tickLine={false} tickMargin={10} axisLine={false} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={10}
                  width={48}
                  tickFormatter={value => formatAxisMoney(Number(value))}
                />
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      formatter={(value, _name, item) => (
                        <>
                          <div
                            className='h-2.5 w-2.5 shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)'
                            style={
                              {
                                '--color-bg': item.color ?? 'var(--color-amount)',
                                '--color-border': item.color ?? 'var(--color-amount)'
                              } as CSSProperties
                            }
                          />
                          <div className='flex flex-1 items-center justify-between gap-4 leading-none'>
                            <span className='text-muted-foreground'>{seriesLabel}</span>
                            <span className='text-foreground font-mono font-medium tabular-nums'>
                              {formatZl(Number(value))}
                            </span>
                          </div>
                        </>
                      )}
                    />
                  }
                />
                <Bar dataKey='amount' fill='var(--color-amount)' radius={4} />
              </BarChart>
            </ChartContainer>
            <ul className='sr-only'>
              {data.map(point => (
                <li key={point.month}>{`${point.month}: ${formatZl(point.amount)}`}</li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  )
}

export default SpendTrendChart
