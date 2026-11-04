'use client';

import { Line, LineChart } from 'recharts';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { formatPlCompactMoney, formatPlMoney } from '@/lib/format/pl';
import { plural } from '@/lib/i18n/plural';

import { PULPIT_EMPTY, PulpitEmptyState } from './card-states';

export interface VatDueCardProps {
  months: { key: string; label: string }[];
  vat: number[];
  /** Sprzedaż netto z tych samych miesięcy — od niej zależy pusty stan. */
  net: number[];
  vatDueLabel: string;
  daysToVatDue: number;
  className?: string;
}

const chartConfig = {
  vat: { label: 'VAT należny', theme: { light: 'var(--chart-5)', dark: 'var(--chart-1)' } },
} satisfies ChartConfig;

export function VatDueCard({ months, vat, net, vatDueLabel, daysToVatDue, className }: VatDueCardProps) {
  const data = months.map((m, i) => ({ month: m.label, vat: vat[i] ?? 0 }));
  const salesMonths = months.filter((_, i) => (net[i] ?? 0) !== 0).length;
  const current = data[data.length - 1]?.vat ?? 0;
  const when =
    daysToVatDue === 0
      ? 'dziś'
      : `za ${daysToVatDue} ${plural(daysToVatDue, ['dzień', 'dni', 'dni'])}`;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-lg font-semibold">VAT należny</CardTitle>
        <CardDescription className="text-muted-foreground text-base">6 mies.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col">
        {salesMonths === 0 ? (
          <PulpitEmptyState
            message={PULPIT_EMPTY.noInvoices}
            action={PULPIT_EMPTY.issueInvoice}
            className="py-3"
          />
        ) : salesMonths < 2 ? (
          <PulpitEmptyState message={PULPIT_EMPTY.trendAfterSecondMonth} className="py-3" />
        ) : (
          <ChartContainer config={chartConfig} className="h-21 w-full">
            <LineChart accessibilityLayer data={data} margin={{ left: 4, right: 4 }}>
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
              <Line dataKey="vat" type="linear" dot={false} stroke="var(--color-vat)" strokeWidth={3} />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
      <CardContent className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xl font-semibold" title={`${formatPlMoney(current)} zł`}>
          {formatPlCompactMoney(current)}
        </span>
        <span className="text-muted-foreground text-right text-sm">
          Termin: {vatDueLabel}, {when}
        </span>
      </CardContent>
    </Card>
  );
}
