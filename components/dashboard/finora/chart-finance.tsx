'use client'

// React Imports
import type { ReactNode } from 'react'

// Third-party Imports
import Link from 'next/link'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { RiBankCardLine, RiMoneyDollarCircleLine, RiWalletLine } from '@remixicon/react'

// Component Imports
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { DemoBadge } from '@/components/dashboard/demo-badge'
import CardHeaderWithMenu, { type CardMenuItem } from './card-header-with-menu'
import { DymekWiersz } from './dymek'

// Util Imports
import { formatPlCompactNumber, formatPlMoney } from '@/lib/format/pl'
import { cn } from '@/lib/utils'

/**
 * Miesiąc wykresu „Finanse” (PLAN-PRAWDZIWE-DANE E5, Z17 po zmianie Bartosza
 * 23.10.2026): te same trzy serie w stosie, ale Koszty (netto) + Zysk (netto)
 * + VAT należny = sprzedaż brutto miesiąca. Słupki nie schodzą pod oś: przy
 * stracie zysk w słupku = 0, a strata jest w dymku (`result` < 0).
 */
export type FinanseMiesiac = {
  /** Podpis osi X, np. „Paź”. */
  month: string
  /** Słupek: zysk netto, ≥ 0. */
  profit: number
  /** Słupek: VAT należny, ≥ 0. */
  vat: number
  /** Słupek: koszty netto, ≥ 0. */
  costs: number
  /** Dymek: przychód netto. */
  revenue: number
  /** Dymek: przychód − koszty (ujemny = strata). */
  result: number
  /** Dymek: VAT należny ze znakiem (korekta może dać minus). */
  vatDue: number
  /** Dymek: koszty ze znakiem. */
  costsAmount: number
}

export type FinanceReportRow = {
  kind: 'profit' | 'revenue' | 'costs'
  title: string
  amount: string
}

export type FinanceCardProps = {
  subTitle: string
  /** Nazwa serii kosztów w dymku — z zastrzeżeniem „KSeF od DD.MM” (Z9). */
  costsLabel: string
  months: FinanseMiesiac[]
  report: { subTitle: string; rows: FinanceReportRow[] }
  financeMenu: CardMenuItem[]
  reportMenu: CardMenuItem[]
  /** D-P: plakietka „Dane przykładowe” w nagłówku „Finanse”. */
  demo?: boolean
  className?: string
}

/**
 * Serie stosu od dołu: Koszty, Zysk, VAT należny (poprawka ze zrzutów
 * 24.10.2026). Kolory i kolejność segmentów jak w Finorze (dolny `chart-2`,
 * środkowy `chart-3`, górny `chart-4`) — zmieniło się tylko, która wartość
 * idzie do którego segmentu: Koszty + Zysk = przychód netto, VAT na wierzchu
 * = sprzedaż brutto. Przy kosztach 55–90% wpływów (dane przykładowe jak
 * „Przepływy” Finory) to koszty dają duży dolny segment, jak dawny zysk.
 * Nazwy w dymku idą za wartościami.
 */
export const financeChartConfig = {
  costs: {
    label: 'Koszty',
    color: 'var(--chart-2)'
  },
  profit: {
    label: 'Zysk',
    color: 'var(--chart-3)'
  },
  vat: {
    label: 'VAT należny',
    color: 'var(--chart-4)'
  }
} satisfies ChartConfig

const reportIcons: Record<FinanceReportRow['kind'], { icon: ReactNode; className: string }> = {
  profit: { icon: <RiMoneyDollarCircleLine className='size-4.5' />, className: 'bg-chart-2/10 text-chart-2' },
  revenue: { icon: <RiWalletLine className='size-4.5' />, className: 'bg-chart-3/10 text-chart-3' },
  costs: { icon: <RiBankCardLine className='size-4.5' />, className: 'bg-chart-4/10 text-chart-4' }
}

const zl = (n: number) => `${formatPlMoney(n)} zł`

/** Kroki „ładnej” osi (× 10ⁿ): etykiety to okrągłe kwoty, jak 0–50 w Finorze. */
const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]

/** Tyle przedziałów co w Finorze (etykiety 0, 10, 20, 30, 40, 50): sześć etykiet. */
const Y_INTERVALS = 5

/**
 * Oś Y jak w Finorze (poprawka Bartosza 23.10.2026: „przywróć stare wykresy”):
 * zamiast stałej skali 0–50 — „ładne” maksimum z danych i sześć
 * etykiet od zera. Przy danych w skali Finory (do 50 tys.) to dokładnie
 * 0, 10, 20, 30, 40, 50 (tys.). Pusty wykres — skala Finory 0–50.
 */
export function financeYAxis(max: number): { max: number; ticks: number[] } {
  const raw = max > 0 ? max / Y_INTERVALS : 10
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = (NICE_STEPS.find(u => u * power >= raw - 1e-9) ?? 10) * power

  return { max: step * Y_INTERVALS, ticks: Array.from({ length: Y_INTERVALS + 1 }, (_, i) => step * i) }
}

/**
 * Szerokość osi Y tylko tyle, by zmieściły się etykiety („50 tys.”). Dla
 * etykiet Finory („0”–„50”) daje 30 px, czyli dokładnie dawne `margin left -30`
 * przy domyślnej szerokości osi 60.
 */
function yAxisWidth(ticks: readonly number[]): number {
  const longest = Math.max(1, ...ticks.map(tick => formatPlCompactNumber(tick).length))

  return Math.max(30, Math.ceil(longest * 6 + 8))
}

const FinanceCard = ({ subTitle, costsLabel, months, report, financeMenu, reportMenu, demo, className }: FinanceCardProps) => {
  const config = { ...financeChartConfig, costs: { ...financeChartConfig.costs, label: costsLabel } } satisfies ChartConfig
  const axis = financeYAxis(Math.max(0, ...months.map(m => m.profit + m.vat + m.costs)))

  return (
    <Card className={cn('grid grid-cols-1 gap-x-2 gap-y-4 lg:grid-cols-5', className)}>
      <div className='flex flex-col gap-10 max-lg:border-b max-lg:pb-6 lg:col-span-3 lg:border-r lg:pr-2'>
        <CardHeaderWithMenu title='Finanse' subTitle={subTitle} menuItems={financeMenu} badge={demo ? <DemoBadge skracana /> : undefined} className='flex justify-between' />
        <CardContent className='flex-1'>
          <ChartContainer config={config} className='h-full min-h-65 w-full'>
            <BarChart accessibilityLayer data={months} barSize={12} margin={{ left: 0, bottom: -5 }}>
              <CartesianGrid vertical={false} strokeDasharray='4' stroke='var(--border)' />
              <XAxis
                dataKey='month'
                tickLine={false}
                tickMargin={10}
                axisLine={false}
                tickFormatter={value => String(value).slice(0, 3)}
                tick={{ fill: 'var(--muted-foreground)' }}
              />
              <YAxis
                domain={[0, axis.max]}
                ticks={axis.ticks}
                width={yAxisWidth(axis.ticks)}
                tickFormatter={value => formatPlCompactNumber(Number(value))}
                tickLine={false}
                tickMargin={8}
                axisLine={false}
                tick={{ fill: 'var(--muted-foreground)' }}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    hideLabel
                    formatter={(_value, name, item) => {
                      const m = item.payload as FinanseMiesiac

                      if (name === 'profit') {
                        return <DymekWiersz color={item.color} label={m.result < 0 ? 'Strata' : 'Zysk'} value={zl(Math.abs(m.result))} />
                      }

                      if (name === 'vat') return <DymekWiersz color={item.color} label='VAT należny' value={zl(m.vatDue)} />

                      return <DymekWiersz color={item.color} label={costsLabel} value={zl(m.costsAmount)} />
                    }}
                  />
                }
              />
              <Bar dataKey='costs' stackId='a' fill='var(--color-costs)' />
              <Bar dataKey='profit' stackId='a' fill='var(--color-profit)' />
              <Bar dataKey='vat' stackId='a' fill='var(--color-vat)' />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </div>
      <div className='flex flex-col gap-10 lg:col-span-2'>
        <CardHeaderWithMenu title='Raport' subTitle={report.subTitle} menuItems={reportMenu} className='flex justify-between' />
        <CardContent className='flex flex-1 flex-col justify-between gap-6 text-base'>
          {report.rows.map((row, index) => (
            <div key={index} className='flex items-center gap-3'>
              <Avatar className='size-9 after:border-0'>
                <AvatarFallback
                  className={cn('bg-primary/10 text-primary shrink-0 [&>svg]:size-4.5', reportIcons[row.kind].className)}
                >
                  {reportIcons[row.kind].icon}
                </AvatarFallback>
              </Avatar>
              <div className='flex flex-col'>
                <span>{row.title}</span>
                <span className='text-muted-foreground text-sm'>{row.amount}</span>
              </div>
            </div>
          ))}

          {/* E7 pkt 2: przycisk bez celu → link, ten sam wygląd (`data-slot` dla odstępów z globals.css). */}
          <Link href='/przeplywy' data-slot='button' data-variant='default' data-size='lg' className={buttonVariants({ size: 'lg' })}>
            Zobacz przepływy
          </Link>
        </CardContent>
      </div>
    </Card>
  )
}

export default FinanceCard
