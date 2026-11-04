'use client';

import Link from 'next/link';
import { RiBankCardLine, RiMoneyDollarCircleLine, RiWalletLine } from '@remixicon/react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { formatPlCompactMoney, formatPlMoney } from '@/lib/format/pl';
import { cn } from '@/lib/utils';

import { PulpitCardHeader } from './card-header';
import { PULPIT_EMPTY, PulpitEmptyState } from './card-states';

export interface FinanceCardProps {
  months: { key: string; label: string }[];
  net: number[];
  costs: number[];
  report: { revenue: number; costs: number; profit: number; monthlyAverageNet: number | null };
  costsHint: 'none' | 'connect-ksef';
  className?: string;
}

const chartConfig = {
  net: { label: 'Przychody netto', color: 'var(--chart-1)' },
  // Ciemny motyw: chart-5 ma ok. 1,8:1 (WCAG 1.4.11); chart-1 zajmują Przychody, więc chart-2.
  // W ciemnym: chart-2 obok chart-1 to 1,45:1 (nie do odróżnienia), foreground ma
  // 11,9:1 do karty i inną barwę niż niebieskie przychody.
  costs: { label: 'Koszty', theme: { light: 'var(--chart-5)', dark: 'var(--foreground)' } },
} satisfies ChartConfig;

function moneyZl(n: number): string {
  return `${formatPlMoney(n)} zł`;
}

export function FinanceCard({ months, net, costs, report, costsHint, className }: FinanceCardProps) {
  const data = months.map((m, i) => ({ month: m.label, net: net[i] ?? 0, costs: costs[i] ?? 0 }));
  const monthsWithValue = data.filter(d => d.net !== 0 || d.costs !== 0).length;
  const allZero = monthsWithValue === 0;
  const shown = data.findLast(d => d.net !== 0 || d.costs !== 0) ?? { month: '', net: 0, costs: 0 };

  const loss = report.profit < 0;
  const reportRows = [
    {
      icon: <RiMoneyDollarCircleLine className="size-4.5" />,
      title: loss ? 'Strata' : 'Zysk',
      amount: moneyZl(Math.abs(report.profit)),
      amountClassName: loss ? 'text-destructive' : undefined,
      iconClassName: 'bg-chart-2/10 text-chart-2',
    },
    {
      icon: <RiWalletLine className="size-4.5" />,
      title: 'Przychody',
      amount: moneyZl(report.revenue),
      iconClassName: 'bg-chart-3/10 text-chart-3',
    },
    {
      icon: <RiBankCardLine className="size-4.5" />,
      title: 'Koszty',
      amount: moneyZl(report.costs),
      iconClassName: 'bg-chart-4/10 text-chart-4',
    },
  ];

  return (
    <Card className={cn('grid grid-cols-1 gap-x-2 gap-y-4 lg:grid-cols-5', className)}>
      <div className="flex flex-col gap-10 max-lg:border-b max-lg:pb-6 lg:col-span-3 lg:border-r lg:pr-2">
        <PulpitCardHeader title="Przychody i koszty" subtitle="Ostatnie 12 miesięcy" />
        <CardContent className="flex flex-1 flex-col">
          {allZero ? (
            <PulpitEmptyState message={PULPIT_EMPTY.noInvoices} action={PULPIT_EMPTY.issueInvoice} />
          ) : monthsWithValue < 2 ? (
            <div className="flex flex-1 flex-col justify-center gap-4">
              <div className="flex flex-wrap gap-8">
                <div className="flex flex-col">
                  <span className="text-muted-foreground text-sm">{`Przychody netto · ${shown.month}`}</span>
                  <span className="text-xl font-semibold" title={moneyZl(shown.net)}>
                    {formatPlCompactMoney(shown.net)}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-muted-foreground text-sm">{`Koszty · ${shown.month}`}</span>
                  <span className="text-xl font-semibold" title={moneyZl(shown.costs)}>
                    {formatPlCompactMoney(shown.costs)}
                  </span>
                </div>
              </div>
              <p className="text-muted-foreground text-sm">{PULPIT_EMPTY.trendAfterSecondMonth}</p>
            </div>
          ) : (
            <>
              <span className="sr-only">Wykres słupkowy: Przychody netto i Koszty w ostatnich 12 miesiącach</span>
            <ChartContainer config={chartConfig} className="h-full min-h-65 w-full">
              <BarChart accessibilityLayer data={data} barSize={10} margin={{ left: -10, bottom: -5 }}>
                <CartesianGrid vertical={false} strokeDasharray="4" stroke="var(--border)" />
                <XAxis
                  dataKey="month"
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
                  tick={{ fill: 'var(--muted-foreground)' }}
                />
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      formatter={(value, name) => (
                        <div className="flex w-full items-center justify-between gap-4">
                          <span className="text-muted-foreground">
                            {chartConfig[name as keyof typeof chartConfig]?.label ?? name}
                          </span>
                          <span className="text-foreground font-mono font-medium tabular-nums">
                            {moneyZl(Number(value))}
                          </span>
                        </div>
                      )}
                    />
                  }
                />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="net" fill="var(--color-net)" />
                <Bar dataKey="costs" fill="var(--color-costs)" />
              </BarChart>
            </ChartContainer>
            </>
          )}
          {costsHint === 'connect-ksef' ? (
            <Link
              href={PULPIT_EMPTY.connectKsefHref}
              className="text-primary mt-3 text-sm underline-offset-4 hover:underline"
            >
              {PULPIT_EMPTY.connectKsef}
            </Link>
          ) : null}
        </CardContent>
      </div>
      <div className="flex flex-col gap-10 lg:col-span-2">
        <PulpitCardHeader
          title="Ten miesiąc"
          subtitle={
            report.monthlyAverageNet === null
              ? 'Średnia pojawi się po pierwszym pełnym miesiącu'
              : `Średnio miesięcznie: ${moneyZl(report.monthlyAverageNet)}`
          }
        />
        <CardContent className="flex flex-1 flex-col justify-between gap-6 text-base">
          {reportRows.map(row => (
            <div key={row.title} className="flex items-center gap-3">
              <Avatar className="size-9 after:border-0">
                <AvatarFallback className={cn('bg-primary/10 text-primary shrink-0 [&>svg]:size-4.5', row.iconClassName)}>
                  {row.icon}
                </AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-col">
                <span>{row.title}</span>
                <span
                  className={cn('text-muted-foreground truncate text-sm', row.amountClassName)}
                  title={row.amount}
                >
                  {row.amount}
                </span>
              </div>
            </div>
          ))}
          <Link href="/przeplywy" className={buttonVariants({ size: 'lg' })}>
            Zobacz przepływy
          </Link>
        </CardContent>
      </div>
    </Card>
  );
}
