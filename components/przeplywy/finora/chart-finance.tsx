'use client'

// Next Imports
import Link from 'next/link'

// Third-party Imports
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { RiBankCardLine, RiMoneyDollarCircleLine, RiWalletLine } from '@remixicon/react'

// Component Imports
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent
} from '@/components/ui/chart'
import { PulpitCardHeader } from '@/components/dashboard/pulpit/card-header'
import { PULPIT_EMPTY, PulpitEmptyState } from '@/components/dashboard/pulpit/card-states'

// Util Imports
import type { CashFlowMonth } from '@/lib/dashboard/cash-flow'
import type { MonthReport } from '@/lib/dashboard/pulpit-report'
import { formatPlCompactMoney, formatPlPercentChange } from '@/lib/format/pl'
import { cn } from '@/lib/utils'

import { MoneyTooltipRow, zl } from './money'

/**
 * „Przychody i koszty” + „Ten miesiąc” jak w KPiR — Finora
 * `views/dashboards/charts/chart-finance.tsx` (karta „Finance” + „Report”),
 * w wersji z Pulpitu z E4 (dwie serie obok siebie, legenda; plan Finora P1).
 *
 * Na `/przeplywy` stoi nad siatką Przepływów (plan P2: „karty P1 Ten miesiąc
 * i Przychody i koszty”) i niesie liczby dawnego `CashFlowDashboard`:
 * przychód, wydatki i dochód miesiąca, zmianę przychodu, sześć miesięcy
 * wykresu i tabeli „Szczegóły miesięczne” (dochód miesiąca w dymku) oraz
 * skrót „Zobacz KPiR” (w szablonie „View Report”).
 */

export interface KpirFinanceCardProps {
  months: CashFlowMonth[]
  revenue: number[]
  costs: number[]
  profit: number[]
  report: MonthReport
  revenueChangePct: number | null
  costsHint: 'none' | 'connect-ksef'
  className?: string
}

const chartConfig = {
  revenue: { label: 'Przychody netto', color: 'var(--chart-1)' },
  // Jak na Pulpicie: chart-5 ma w ciemnym motywie za mały kontrast (WCAG 1.4.11).
  costs: { label: 'Koszty', theme: { light: 'var(--chart-5)', dark: 'var(--foreground)' } }
} satisfies ChartConfig

function changeTone(pct: number): string {
  if (Math.round(pct) > 0) return 'text-green-700 dark:text-green-400'
  if (Math.round(pct) < 0) return 'text-destructive'
  return 'text-muted-foreground'
}

export function KpirFinanceCard({
  months,
  revenue,
  costs,
  profit,
  report,
  revenueChangePct,
  costsHint,
  className
}: KpirFinanceCardProps) {
  const data = months.map((m, i) => ({
    month: m.label,
    period: m.longLabel,
    revenue: revenue[i] ?? 0,
    costs: costs[i] ?? 0,
    profit: profit[i] ?? 0
  }))
  const monthsWithValue = data.filter(d => d.revenue !== 0 || d.costs !== 0).length
  const allZero = monthsWithValue === 0
  const shown = data.findLast(d => d.revenue !== 0 || d.costs !== 0) ?? data[data.length - 1]!

  const loss = report.profit < 0
  const reportRows = [
    {
      icon: <RiMoneyDollarCircleLine className='size-4.5' />,
      figure: 'profit',
      title: loss ? 'Strata' : 'Zysk',
      amount: zl(Math.abs(report.profit)),
      amountClassName: loss ? 'text-destructive' : undefined,
      extra: null,
      iconClassName: 'bg-chart-2/10 text-chart-2'
    },
    {
      icon: <RiWalletLine className='size-4.5' />,
      figure: 'revenue',
      title: 'Przychody',
      amount: zl(report.revenue),
      extra:
        revenueChangePct === null ? null : (
          <span className={cn('text-sm', changeTone(revenueChangePct))}>
            {`${formatPlPercentChange(revenueChangePct)} vs poprzedni miesiąc`}
          </span>
        ),
      iconClassName: 'bg-chart-3/10 text-chart-3'
    },
    {
      icon: <RiBankCardLine className='size-4.5' />,
      figure: 'costs',
      title: 'Koszty',
      amount: zl(report.costs),
      extra: null,
      iconClassName: 'bg-chart-4/10 text-chart-4'
    }
  ]

  return (
    <Card className={cn('grid grid-cols-1 gap-x-2 gap-y-4 lg:grid-cols-5', className)}>
      <div className='flex flex-col gap-10 max-lg:border-b max-lg:pb-6 lg:col-span-3 lg:border-r lg:pr-2'>
        <PulpitCardHeader title='Przychody i koszty' subtitle='Ostatnie 6 miesięcy · jak w KPiR, z faktur przyjętych w KSeF' />
        <CardContent className='flex flex-1 flex-col'>
          {allZero ? (
            <PulpitEmptyState message={PULPIT_EMPTY.noInvoices} action={PULPIT_EMPTY.issueInvoice} />
          ) : monthsWithValue < 2 ? (
            <div className='flex flex-1 flex-col justify-center gap-4'>
              <div className='flex flex-wrap gap-8'>
                <div className='flex flex-col'>
                  <span className='text-muted-foreground text-sm'>{`Przychody netto · ${shown.period}`}</span>
                  <span className='text-xl font-semibold' title={zl(shown.revenue)}>
                    {formatPlCompactMoney(shown.revenue)}
                  </span>
                </div>
                <div className='flex flex-col'>
                  <span className='text-muted-foreground text-sm'>{`Koszty · ${shown.period}`}</span>
                  <span className='text-xl font-semibold' title={zl(shown.costs)}>
                    {formatPlCompactMoney(shown.costs)}
                  </span>
                </div>
                <div className='flex flex-col'>
                  <span className='text-muted-foreground text-sm'>{`Dochód · ${shown.period}`}</span>
                  <span className='text-xl font-semibold' title={zl(shown.profit)}>
                    {formatPlCompactMoney(shown.profit)}
                  </span>
                </div>
              </div>
              <p className='text-muted-foreground text-sm'>{PULPIT_EMPTY.trendAfterSecondMonth}</p>
            </div>
          ) : (
            <>
              <span className='sr-only'>Wykres słupkowy: Przychody netto i Koszty w ostatnich 6 miesiącach</span>
              <ChartContainer config={chartConfig} className='h-full min-h-65 w-full'>
                <BarChart accessibilityLayer data={data} barSize={12} margin={{ left: -10, bottom: -5 }}>
                  <CartesianGrid vertical={false} strokeDasharray='4' stroke='var(--border)' />
                  <XAxis
                    dataKey='month'
                    tickLine={false}
                    tickMargin={10}
                    axisLine={false}
                    tick={{ fill: 'var(--muted-foreground)' }}
                  />
                  <YAxis
                    tickFormatter={(v: number) => formatPlCompactMoney(v)}
                    tickLine={false}
                    tickMargin={8}
                    axisLine={false}
                    width={80}
                    tick={{ fill: 'var(--muted-foreground)' }}
                  />
                  <ChartTooltip
                    cursor={false}
                    content={
                      <ChartTooltipContent
                        labelFormatter={(_, payload) =>
                          (payload?.[0]?.payload as { period?: string } | undefined)?.period ?? ''
                        }
                        formatter={(value, name, item) => (
                          <div className='flex w-full flex-col gap-1.5'>
                            <MoneyTooltipRow
                              label={chartConfig[name as keyof typeof chartConfig]?.label ?? String(name)}
                              amount={Number(value)}
                              color={`var(--color-${String(name)})`}
                            />
                            {name === 'costs' ? (
                              <MoneyTooltipRow
                                label='Dochód'
                                amount={Number((item?.payload as { profit?: number } | undefined)?.profit ?? 0)}
                              />
                            ) : null}
                          </div>
                        )}
                      />
                    }
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar dataKey='revenue' fill='var(--color-revenue)' />
                  <Bar dataKey='costs' fill='var(--color-costs)' />
                </BarChart>
              </ChartContainer>
            </>
          )}
          {costsHint === 'connect-ksef' ? (
            <Link
              href={PULPIT_EMPTY.connectKsefHref}
              className='text-primary mt-3 text-sm underline-offset-4 hover:underline'
            >
              {PULPIT_EMPTY.connectKsef}
            </Link>
          ) : null}
        </CardContent>
      </div>
      <div className='flex flex-col gap-10 lg:col-span-2'>
        <PulpitCardHeader
          title='Ten miesiąc'
          subtitle={
            report.monthlyAverageNet === null
              ? 'Średnia pojawi się po pierwszym pełnym miesiącu'
              : `Średnio miesięcznie: ${zl(report.monthlyAverageNet)}`
          }
        />
        <CardContent className='flex flex-1 flex-col justify-between gap-6 text-base'>
          {reportRows.map(row => (
            <div key={row.title} className='flex items-center gap-3'>
              <Avatar className='size-9 after:border-0'>
                <AvatarFallback
                  className={cn('bg-primary/10 text-primary shrink-0 [&>svg]:size-4.5', row.iconClassName)}
                >
                  {row.icon}
                </AvatarFallback>
              </Avatar>
              <div className='flex min-w-0 flex-col'>
                <span>{row.title}</span>
                <span
                  className={cn('text-muted-foreground truncate text-sm', row.amountClassName)}
                  title={row.amount}
                  data-figure={row.figure}
                >
                  {row.amount}
                </span>
                {row.extra}
              </div>
            </div>
          ))}

          <Link href='/reports/kpir' className={buttonVariants({ size: 'lg' })}>
            Zobacz KPiR
          </Link>
        </CardContent>
      </div>
    </Card>
  )
}

export default KpirFinanceCard
