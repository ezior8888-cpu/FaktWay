// Kopia 1:1 z finora-src/src/views/dashboards/statistics/statistics-savings-goal-card.tsx (Przepływy, decyzja Bartosza 21.10.2026): zmienione tylko teksty, kwoty, daty i importy.
'use client'

// Third-party Imports
import { Label, PolarGrid, PolarRadiusAxis, RadialBar, RadialBarChart } from 'recharts'

// Component Imports
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type ChartConfig, ChartContainer } from '@/components/ui/chart'

// Util Imports
import { cn } from '@/lib/utils'

const savingsGoalChartConfig = {
  progress: {
    label: 'Postęp',
    color: 'var(--chart-2)'
  }
} satisfies ChartConfig

/** Początek łuku jak w szablonie; procent niesie `endAngle` (68% → 335°). */
const RING_START = 90

/**
 * PLAN-PRAWDZIWE-DANE E6: „Cel oszczędnościowy” bez celu i salda zamienia
 * się w „Odłóż na podatek” (płatnik VAT, łuk = stawka 19%) albo „Limit
 * zwolnienia z VAT” (art. 113) — treść z propsów (`adaptery.ts`), wygląd bez
 * zmian: ten sam pierścień na jasnym torze, trzy wiersze w środku i podpis.
 */
type StatisticsSavingsGoalCardProps = {
  title: string
  subtitle: string
  /** 0–100; 100 = pełny łuk. */
  pct: number
  lines: [string, string, string]
  caption: string
  className?: string
}

const StatisticsSavingsGoalCard = ({ title, subtitle, pct, lines, caption, className }: StatisticsSavingsGoalCardProps) => {
  const progress = Math.max(0, Math.min(100, pct))
  const chartData = [{ progress, fill: 'var(--color-progress)' }]

  return (
    <Card className={cn(className)}>
      <CardHeader>
        <CardTitle className='text-lg font-semibold'>{title}</CardTitle>
        <CardDescription className='text-muted-foreground text-base'>{subtitle}</CardDescription>
      </CardHeader>
      <CardContent className='flex flex-1 flex-col items-center justify-center gap-2'>
        <ChartContainer config={savingsGoalChartConfig} className='mx-auto aspect-square h-62 w-62'>
          <RadialBarChart data={chartData} startAngle={RING_START} endAngle={RING_START + (progress / 100) * 360} innerRadius={115} outerRadius={86}>
            <PolarGrid
              gridType='circle'
              radialLines={false}
              stroke='none'
              className='first:fill-primary/10 last:fill-card'
              polarRadius={[113, 88]}
            />
            <RadialBar dataKey='progress' cornerRadius={14} />
            <PolarRadiusAxis tick={false} tickLine={false} axisLine={false}>
              <Label
                content={({ viewBox }) => {
                  if (viewBox && 'cx' in viewBox && 'cy' in viewBox) {
                    return (
                      <text x={viewBox.cx} y={viewBox.cy} textAnchor='middle' dominantBaseline='middle'>
                        <tspan
                          x={viewBox.cx}
                          y={(viewBox.cy || 0) - 18}
                          className='fill-foreground text-4xl font-semibold'
                        >
                          {lines[0]}
                        </tspan>
                        <tspan
                          x={viewBox.cx}
                          y={(viewBox.cy || 0) + 16}
                          className='fill-foreground text-xl font-medium'
                        >
                          {lines[1]}
                        </tspan>
                        <tspan x={viewBox.cx} y={(viewBox.cy || 0) + 38} className='fill-muted-foreground text-sm'>
                          {lines[2]}
                        </tspan>
                      </text>
                    )
                  }
                }}
              />
            </PolarRadiusAxis>
          </RadialBarChart>
        </ChartContainer>
        <span className='text-primary text-sm font-medium'>{caption}</span>
      </CardContent>
    </Card>
  )
}

export default StatisticsSavingsGoalCard
