'use client'

// Third-party Imports
import { Area, AreaChart, CartesianGrid, Line, XAxis, YAxis } from 'recharts'
import { RiFileList3Line, RiPercentLine, RiReceiptLine } from '@remixicon/react'

// Component Imports
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Separator } from '@/components/ui/separator'
import { DashboardExportsPdfLink } from '@/components/dashboard/exports-route-client'
import { PulpitCardHeader } from '@/components/dashboard/pulpit/card-header'
import { PULPIT_EMPTY, PulpitEmptyState } from '@/components/dashboard/pulpit/card-states'

// Util Imports
import { formatPlCompactMoney, formatPlInt, formatPlPercentChange } from '@/lib/format/pl'
import { plural } from '@/lib/i18n/plural'
import { cn } from '@/lib/utils'

import { MoneyTooltipRow, zl } from './money'

/**
 * „Podsumowanie podatku VAT” w karcie Finory `views/dashboards/charts/chart-net-worth.tsx`
 * (lewa karta pierwszego rzędu strony Net Worth, plan Finora P2).
 *
 * Treść dawnego `VatSummaryCard` bez zmian — tytuł, podpis, „Eksport PDF”,
 * netto / VAT należny / brutto miesiąca z faktur przyjętych w bieżącym
 * środowisku KSeF i termin płatności VAT. W miejscu wykresu wartości netto
 * z szablonu stoi dawny wykres sprzedaży brutto sześciu miesięcy na tle roku
 * wcześniej (`SalesChartCard`), a w miejscu zdania pod listą — liczby dawnej
 * karty „liczby miesiąca” (`MonthlyFiguresCard`: przyjęte, szkice, zmiana
 * sprzedaży). Obie stare karty zniknęły z `/przeplywy`, ich liczby są tutaj.
 */

export interface VatSummaryCardProps {
  /** „październik 2026” — gotowy napis. */
  monthName: string
  totalNet: number
  totalVat: number
  totalGross: number
  /** „25.11.2026”. */
  vatDueLabel: string
  daysToVatDue: number
  acceptedCount: number
  prevAcceptedCount: number
  hasPrevMonth: boolean
  draftCount: number
  momGrossPct: number
  isBestMonthOfYear: boolean
  sales: {
    months: { key: string; label: string }[]
    /** Brutto per miesiąc (ROZ bez rozliczonych zaliczek). */
    currentSeries: number[]
    /** Brutto tych samych miesięcy rok wcześniej. */
    prevSeries: number[]
    currentMonthKey: string
    /** Rok bieżącego miesiąca w Europe/Warsaw — podpis serii. */
    year: number
  }
  className?: string
}

export function vatDueText(vatDueLabel: string, daysToVatDue: number): string {
  return `Termin płatności VAT: ${vatDueLabel} — pozostało ${daysToVatDue} ${daysToVatDue === 1 ? 'dzień' : 'dni'}`
}

const VatSummaryCard = ({
  monthName,
  totalNet,
  totalVat,
  totalGross,
  vatDueLabel,
  daysToVatDue,
  acceptedCount,
  prevAcceptedCount,
  hasPrevMonth,
  draftCount,
  momGrossPct,
  isBestMonthOfYear,
  sales,
  className
}: VatSummaryCardProps) => {
  const salesChartConfig = {
    current: {
      label: String(sales.year),
      color: 'var(--chart-2)'
    },
    previous: {
      label: String(sales.year - 1),
      color: 'var(--muted-foreground)'
    }
  } satisfies ChartConfig

  const data = sales.months.map((m, i) => ({
    month: m.label,
    current: sales.currentSeries[i] ?? 0,
    previous: sales.prevSeries[i] ?? 0
  }))
  const noSales = sales.currentSeries.every(v => v === 0)
  const hasPrevSeries = sales.prevSeries.some(v => v > 0)

  const summaryData = [
    {
      icon: <RiFileList3Line className='size-4.5' />,
      title: 'Netto',
      amount: totalNet,
      iconClassName: 'bg-chart-2/10 text-chart-2'
    },
    {
      icon: <RiPercentLine className='size-4.5' />,
      title: 'VAT należny',
      amount: totalVat,
      iconClassName: 'bg-chart-4/10 text-chart-4'
    },
    {
      icon: <RiReceiptLine className='size-4.5' />,
      title: 'Brutto',
      amount: totalGross,
      iconClassName: 'bg-chart-3/10 text-chart-3'
    }
  ]

  const grossChange = isBestMonthOfYear
    ? 'najlepszy wynik w roku'
    : hasPrevMonth
      ? `${formatPlPercentChange(momGrossPct)} m/m`
      : 'pierwszy miesiąc ze sprzedażą'

  return (
    <Card className={cn(className)}>
      <PulpitCardHeader
        title='Podsumowanie podatku VAT'
        subtitle={`${monthName} · faktury przyjęte w bieżącym środowisku KSeF`}
        action={<DashboardExportsPdfLink />}
      />
      <CardContent className='grid grid-cols-1 gap-6 lg:grid-cols-5'>
        <div className='flex flex-col gap-4 lg:col-span-3'>
          <div className='flex flex-wrap items-center gap-3'>
            <span className='text-4xl font-semibold' title={`VAT należny: ${zl(totalVat)}`}>
              <span className='sr-only'>VAT należny: </span>
              {zl(totalVat)}
            </span>
            <Badge className='h-auto min-h-6 bg-amber-600/10 px-3 py-1 whitespace-normal text-amber-800 dark:bg-amber-400/10 dark:text-amber-400'>
              {vatDueText(vatDueLabel, daysToVatDue)}
            </Badge>
          </div>

          {noSales && !hasPrevSeries ? (
            <PulpitEmptyState message={PULPIT_EMPTY.noInvoices} action={PULPIT_EMPTY.issueInvoice} />
          ) : (
            <>
              {/* Bez sprzedaży w 6 miesiącach, ale z rokiem poprzednim: wykres
                  zostaje dla porównania rok do roku, jak w dawnym SalesChartCard. */}
              {noSales ? (
                <p className='text-muted-foreground text-sm'>Brak przyjętych faktur w tym okresie</p>
              ) : null}
              <span className='sr-only'>
                {`Wykres sprzedaży brutto ostatnich 6 miesięcy na tle roku ${sales.year - 1}`}
              </span>
              <ChartContainer config={salesChartConfig} className='h-38 w-full'>
                <AreaChart accessibilityLayer data={data} margin={{ left: -5, right: 5, top: 4, bottom: 0 }}>
                  <CartesianGrid vertical={false} strokeDasharray='4' stroke='var(--border)' />
                  <XAxis
                    dataKey='month'
                    tickLine={false}
                    tickMargin={10}
                    axisLine={false}
                    tick={{ fill: 'var(--muted-foreground)' }}
                  />
                  <YAxis
                    tickFormatter={(value: number) => formatPlCompactMoney(value)}
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
                        formatter={(value, name) => (
                          <MoneyTooltipRow
                            label={salesChartConfig[name as keyof typeof salesChartConfig]?.label ?? String(name)}
                            amount={Number(value)}
                            color={`var(--color-${String(name)})`}
                          />
                        )}
                      />
                    }
                  />
                  <defs>
                    <linearGradient id='fillVatSales' x1='0' y1='0' x2='0' y2='1'>
                      <stop offset='5%' stopColor='var(--color-current)' stopOpacity={0.5} />
                      <stop offset='95%' stopColor='var(--color-current)' stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <Area
                    dataKey='current'
                    type='monotone'
                    fill='url(#fillVatSales)'
                    stroke='var(--color-current)'
                    strokeWidth={2.5}
                    dot={false}
                    activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--card)' }}
                  />
                  {hasPrevSeries ? (
                    <Line
                      dataKey='previous'
                      type='monotone'
                      stroke='var(--color-previous)'
                      strokeWidth={2}
                      strokeDasharray='5 5'
                      dot={false}
                    />
                  ) : null}
                </AreaChart>
              </ChartContainer>
            </>
          )}

          <div className='flex flex-wrap items-center justify-between gap-2 text-sm'>
            <span className='text-muted-foreground'>Sprzedaż brutto w ostatnich 6 miesiącach</span>
            <span className='text-muted-foreground flex items-center gap-3'>
              <span className='flex items-center gap-1.5'>
                <span className='bg-chart-2 size-2 shrink-0 rounded-full' aria-hidden />
                <span className='text-foreground font-medium'>{sales.year}</span>
              </span>
              <span className='flex items-center gap-1.5'>
                <span className='bg-muted-foreground size-2 shrink-0 rounded-full' aria-hidden />
                {sales.year - 1}
              </span>
            </span>
          </div>
        </div>

        <div className='flex flex-col justify-center gap-4 max-lg:border-t max-lg:pt-6 lg:col-span-2 lg:border-l lg:pl-6'>
          {summaryData.map(item => (
            <div key={item.title} className='flex items-center gap-3'>
              <Avatar className='size-9 after:border-0'>
                <AvatarFallback className={cn('bg-primary/10 text-primary shrink-0', item.iconClassName)}>
                  {item.icon}
                </AvatarFallback>
              </Avatar>
              <div className='flex min-w-0 flex-1 items-center justify-between gap-2'>
                <span className='text-muted-foreground text-sm'>{item.title}</span>
                <span className='truncate text-base font-medium' title={zl(item.amount)}>
                  {zl(item.amount)}
                </span>
              </div>
            </div>
          ))}
          <Separator />
          <p className='text-muted-foreground text-sm'>
            Przyjęte przez KSeF:{' '}
            <span className='text-foreground font-medium'>
              {`${formatPlInt(acceptedCount)} ${plural(acceptedCount, ['faktura', 'faktury', 'faktur'])}`}
            </span>
            {hasPrevMonth
              ? ` (poprzedni miesiąc: ${formatPlInt(prevAcceptedCount)})`
              : ' (brak przyjętych w poprzednim miesiącu)'}
            . Szkice lokalne bez przypisanego środowiska:{' '}
            <span className='text-foreground font-medium'>{formatPlInt(draftCount)}</span>. Sprzedaż brutto:{' '}
            <span className='text-foreground font-medium'>{grossChange}</span>.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

export default VatSummaryCard
