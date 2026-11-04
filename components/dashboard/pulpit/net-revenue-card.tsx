'use client';

import { Bar, BarChart } from 'recharts';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { formatPlCompactMoney, formatPlMoney, formatPlPercentChange } from '@/lib/format/pl';
import { cn } from '@/lib/utils';

import { PULPIT_EMPTY, PulpitEmptyState } from './card-states';
import { POSITIVE_TEXT_TONE } from './stat-tile';

export interface NetRevenueCardProps {
  months: { key: string; label: string }[];
  net: number[];
  changePct: number | null;
  className?: string;
}

const chartConfig = {
  net: { label: 'Przychód netto', color: 'var(--chart-2)' },
} satisfies ChartConfig;

export function NetRevenueCard({ months, net, changePct, className }: NetRevenueCardProps) {
  const data = months.map((m, i) => ({ month: m.label, net: net[i] ?? 0 }));
  const nonZero = data.filter(d => d.net !== 0).length;
  const current = data[data.length - 1]?.net ?? 0;

  return (
    <Card className={cn('justify-between', className)}>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="text-lg font-semibold" title={`${formatPlMoney(current)} zł`}>
            {formatPlCompactMoney(current)}
          </CardTitle>
          {changePct === null ? null : (
            <span
              className={cn(
                'text-base',
                Math.round(changePct) > 0
                  ? POSITIVE_TEXT_TONE
                  : Math.round(changePct) < 0
                    ? 'text-destructive'
                    : 'text-muted-foreground',
              )}
            >
              {formatPlPercentChange(changePct)}
            </span>
          )}
        </div>
        <CardDescription className="text-muted-foreground text-base">Przychód netto</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col">
        {nonZero === 0 ? (
          <PulpitEmptyState message={PULPIT_EMPTY.noInvoices} action={PULPIT_EMPTY.issueInvoice} />
        ) : nonZero < 2 ? (
          <PulpitEmptyState message={PULPIT_EMPTY.trendAfterSecondMonth} />
        ) : (
          <ChartContainer config={chartConfig} className="h-31 w-full">
            <BarChart accessibilityLayer data={data} barSize={12} margin={{ left: 0, right: 0 }}>
              <Bar dataKey="net" fill="var(--color-net)" radius={[12, 12, 0, 0]} />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    formatter={(value, _name, item) => (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="text-muted-foreground">
                          {String((item.payload as { month?: string } | undefined)?.month ?? '')}
                        </span>
                        <span className="text-foreground font-mono font-medium tabular-nums">
                          {`${formatPlMoney(Number(value))} zł`}
                        </span>
                      </div>
                    )}
                  />
                }
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
