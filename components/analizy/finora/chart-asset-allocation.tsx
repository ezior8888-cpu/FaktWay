'use client';

import { Cell, Pie, PieChart } from 'recharts';

import { PulpitCardHeader } from '@/components/dashboard/pulpit/card-header';
import { PulpitEmptyState } from '@/components/dashboard/pulpit/card-states';
import { Card, CardContent } from '@/components/ui/card';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import type { BreakdownSlice } from '@/lib/analytics-finance/breakdown';
import { formatPlMoney } from '@/lib/format/pl';
import { cn } from '@/lib/utils';

import { CONCENTRATION_WARNING, type EmptyStateProps } from './empty';
import { sliceChartConfig, sliceSlot } from './slices';

/**
 * Port Finory `dashboards/charts/chart-asset-allocation.tsx` („Asset
 * Allocation” z Net Worth) → „Udział klientów w przychodach” (P11): top 5
 * klientów + „Pozostali”. Nagłówek jak `card-header-with-menu.tsx`, ale bez
 * menu „⋯”, którego pozycje w szablonie nic nie robią (wzór: Pulpit).
 * Gdy jeden klient ma ponad połowę przychodu — podpis-ostrzeżenie pod
 * wykresem.
 */

type AssetAllocationCardProps = {
  data: BreakdownSlice[];
  concentrated: boolean;
  empty: EmptyStateProps;
  className?: string;
};

const AssetAllocationCard = ({ data, concentrated, empty, className }: AssetAllocationCardProps) => {
  const config = sliceChartConfig(data);
  const chartData = data.map((slice, index) => ({ ...slice, slot: sliceSlot(slice, index) }));

  return (
    <Card className={cn(className)}>
      <PulpitCardHeader title="Udział klientów w przychodach" subtitle="Sprzedaż netto · wybrany miesiąc" />
      <CardContent className="flex flex-1 flex-col items-center justify-center gap-3">
        {data.length === 0 ? (
          <PulpitEmptyState {...empty} />
        ) : (
          <>
            <ChartContainer config={config} className="mx-auto aspect-square h-full max-h-70">
              <PieChart>
                <ChartTooltip
                  cursor={false}
                  content={<ChartTooltipContent hideLabel nameKey="slot" formatter={(value, name) => (
                    <div className="flex w-full items-center justify-between gap-4">
                      <span className="text-muted-foreground">{config[String(name)]?.label ?? ''}</span>
                      <span className="text-foreground font-mono font-medium tabular-nums">
                        {`${formatPlMoney(Number(value))} zł`}
                      </span>
                    </div>
                  )} />}
                />
                <Pie data={chartData} dataKey="amount" nameKey="slot" innerRadius={60} strokeWidth={2}>
                  {chartData.map((entry) => (
                    <Cell key={entry.slot} fill={`var(--color-${entry.slot})`} />
                  ))}
                </Pie>
                <ChartLegend content={<ChartLegendContent nameKey="slot" className="flex-wrap gap-x-4 gap-y-2" />} />
              </PieChart>
            </ChartContainer>
            {/* Odstępstwo od Finory (WCAG 1.1.1): kwoty i udziały są w wykresie
                tylko w podpowiedzi pod myszą — tu jako tekst dla czytnika. */}
            <ul className="sr-only">
              {data.map((slice) => (
                <li key={slice.key}>{`${slice.label}: ${formatPlMoney(slice.amount)} zł (${Math.round(slice.percentage)}%)`}</li>
              ))}
            </ul>
            {concentrated ? <p className="text-destructive text-center text-sm font-medium">{CONCENTRATION_WARNING}</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
};

export default AssetAllocationCard;
