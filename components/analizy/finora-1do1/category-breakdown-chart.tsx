'use client'

// Kopia 1:1 z finora-src/src/views/pages/money-management/monthly-analytics/category-breakdown-chart.tsx (Analizy, decyzja Bartosza 21.10.2026): zmienione tylko teksty (z propsów), kwoty (zł, pl-PL), daty (DD.MM.RRRR), importy i źródło danych. Odstępstwa: konfiguracja serii z danych (Finora ma stałe `EXPENSE_CATEGORIES`; u nas top 5 + „Pozostałe”, klucze po miejscu 's0'…'s5', także dla „Pozostałe”, kolor z adaptera); legenda bez jednostki z końca nazwy produktu (`legendLabels`; zostaje, gdy bez niej dwie pozycje miałyby tę samą nazwę), a do klas legendy Finory dochodzi `LEGEND_ITEM_FIT` (pozycja do podziału na rzędy liczy się najwyżej jako 1/3 szerokości, więc 6 pozycji zawsze mieści się w 2 rzędach i recharts nie zmniejsza koła; dłuższa nazwa ucięta wielokropkiem, pełna w `title`) — poprawka 21.10.2026 po pomiarze: nazwy z jednostką zawijały legendę do 3 rzędów i koło miało 138,6 zamiast 154,2 px średnicy; pusty stan z akcją z §7.3 (`FinoraEmpty`, ten sam `py-10`); ukryta lista `sr-only` z kwotą i udziałem każdego wycinka (WCAG 1.1.1 — w wykresie są tylko w podpowiedzi pod myszą).

// Third-party Imports
import { Cell, Pie, PieChart } from 'recharts'

// Type Imports
import type { CategorySlice, FinoraEmptyState } from './types'

// Component Imports
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig
} from '@/components/ui/chart'
import FinoraEmpty from './finora-empty'

// Util Imports
import { cn } from '@/lib/utils'
import { formatZl, legendLabels } from './format'

/**
 * Pozycja legendy (dziecko `ChartLegendContent`): naturalna szerokość
 * (`max-w-max`), ale baza flex to 1/3 wiersza minus dwa odstępy `gap-x-4`
 * (−1px na zaokrąglenia). `flex-wrap` dzieli na rzędy po bazie, więc długie
 * nazwy liczą się jako 1/3 i w rzędzie mieszczą się zawsze co najmniej 3
 * pozycje — top 5 + „Pozostałe” to najwyżej 2 rzędy, jak u Finory. `grow`
 * oddaje wolne miejsce w rzędzie długim nazwom, `min-w-0` pozwala uciąć tekst.
 */
const LEGEND_ITEM_FIT = '*:min-w-0 *:max-w-max *:grow *:basis-[calc((100%-var(--spacing)*8)/3-1px)]'

type CategoryBreakdownChartProps = {
  title: string
  description: string
  data: CategorySlice[]
  empty: FinoraEmptyState
  className?: string
}

const CategoryBreakdownChart = ({ title, description, data, empty, className }: CategoryBreakdownChartProps) => {
  const legendNames = legendLabels(data.map(slice => slice.label))

  const chartConfig: ChartConfig = Object.fromEntries(
    data.map((slice, i) => [
      slice.category,
      {
        label: (
          <span className='truncate' title={slice.label}>
            {legendNames[i]}
          </span>
        ),
        color: slice.color
      }
    ])
  )

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <FinoraEmpty {...empty} pad='py-10' />
        ) : (
          <>
            <ChartContainer config={chartConfig} className='mx-auto aspect-square max-h-70'>
              <PieChart>
                <ChartTooltip
                  content={<ChartTooltipContent hideLabel formatter={value => formatZl(Number(value))} />}
                />
                <Pie data={data} dataKey='amount' nameKey='category' innerRadius={60} strokeWidth={2}>
                  {data.map(entry => (
                    <Cell key={entry.category} fill={`var(--color-${entry.category})`} />
                  ))}
                </Pie>
                <ChartLegend
                  content={
                    <ChartLegendContent nameKey='category' className={cn('flex-wrap gap-x-4 gap-y-1', LEGEND_ITEM_FIT)} />
                  }
                />
              </PieChart>
            </ChartContainer>
            <ul className='sr-only'>
              {data.map(slice => (
                <li key={slice.category}>{`${slice.label}: ${formatZl(slice.amount)} (${Math.round(slice.percentage)}%)`}</li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  )
}

export default CategoryBreakdownChart
