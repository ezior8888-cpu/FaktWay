'use client';

import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts';
import { RiArrowLeftDownLine, RiArrowRightUpLine, RiErrorWarningLine } from '@remixicon/react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { Separator } from '@/components/ui/separator';
import { formatPlMoney } from '@/lib/format/pl';
import { countLabel } from '@/lib/i18n/plural';
import type { KpirTotals } from '@/lib/reports/kpir-totals';
import { cn } from '@/lib/utils';

import { formatZl, formatZlCompact, kpirAxisTicks, marginPct, type KpirSeriesPoint } from './kpir-model';

/**
 * Plakietka i odcień przychodu. Zieleń, nie `chart-2`/`primary`: w jasnym
 * motywie `primary` = `chart-2`, a koszt ma już `bg-primary/10` — przychód
 * i koszt różnią się więc kolorem, znakiem, strzałką i tekstem. Tekst -800 / -300
 * ma ≥ 4,5:1 na karcie i w wierszach tabeli (`finora-kontrast-przeoczone`).
 */
export const REVENUE_TINT = 'bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-300';

// Kolory jak na Pulpicie i w Przepływach (`chart-finance.tsx`): chart-5 ma
// w ciemnym motywie za mały kontrast z kartą (WCAG 1.4.11) — tam `foreground`.
const chartConfig = {
  revenue: { label: 'Przychody', color: 'var(--chart-1)' },
  costs: { label: 'Koszty', theme: { light: 'var(--chart-5)', dark: 'var(--foreground)' } },
} satisfies ChartConfig;

const DAY_TICKS = [1, 8, 15, 22, 29];

const tooltipDate = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** „2026-10-12” → „12 paź”. */
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return tooltipDate.format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Wiersz dymku jak `MoneyTooltipRow` z Przepływów, ale z `formatZl` — tamten
 * pisze minus z klawiatury („-500,00 zł”), a narastający przychód po korekcie
 * in minus bywa ujemny (niezmiennik 8: „−”). Poprawka Bartosza 21.10.2026:
 * przeprojektowanie Księgowości.
 */
export function KpirTooltipRow({ label, amount, color }: { label: string; amount: number; color?: string }) {
  return (
    <div className="flex w-full items-center justify-between gap-4">
      <span className="text-muted-foreground flex items-center gap-1.5">
        {color ? <span className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} aria-hidden /> : null}
        {label}
      </span>
      <span className="text-foreground font-mono font-medium tabular-nums">{formatZl(amount)}</span>
    </div>
  );
}

/**
 * Karta wyniku miesiąca — port układu Finory `views/dashboards/charts/chart-net-worth.tsx`
 * (poprawka Bartosza 21.10.2026: przeprojektowanie Księgowości). Po lewej
 * dochód albo strata (wartość bez znaku, pełna kwota ze znakiem w `title`),
 * marża i wykres przychodów i kosztów narastająco (luka między liniami to
 * wynik). Po prawej przychody i koszty z `kpirTotals` oraz notka o kosztach
 * poza sumą z przyciskiem „Pokaż” (wzór Finory `autopay-coverage-card.tsx`).
 *
 * Na `xl` karta stoi obok pierścienia i rozciąga się do jego wysokości —
 * wykres rośnie razem z nią (`flex-1`), zamiast zostawiać pusty pas pod
 * legendą.
 */
export function KpirResultCard({
  totals,
  monthTitle,
  series,
  lastDay,
  nonDeductedVat,
  uncountedCount,
  settledError,
  onShowUncounted,
  className,
}: {
  totals: KpirTotals;
  monthTitle: string;
  series: readonly KpirSeriesPoint[];
  /** Liczba dni miesiąca — zakres osi X. */
  lastDay: number;
  /** VAT bez odliczenia zawarty w kosztach z sum. */
  nonDeductedVat: number;
  uncountedCount: number;
  /** Zaliczek ROZ nie odczytano — przychód może być zawyżony, bez marży. */
  settledError: boolean;
  onShowUncounted: () => void;
  className?: string;
}) {
  const { profit, totalRevenue, totalExpenses } = totals;
  const loss = profit < 0;
  const margin = settledError ? null : marginPct(totals);
  const ticks = kpirAxisTicks(series);

  return (
    <Card className={cn('shadow-none', className)}>
      <CardContent className="grid flex-1 grid-cols-1 gap-6 md:grid-cols-5">
        <div className="flex min-w-0 flex-col gap-4 md:col-span-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{loss ? 'Strata' : 'Dochód'}</h2>
              <p className="text-muted-foreground text-sm">{monthTitle}</p>
            </div>
            {margin !== null ? (
              <Badge
                className={cn('h-6 px-3 tabular-nums', margin >= 0 ? REVENUE_TINT : 'bg-destructive/10 text-destructive')}
              >
                {`Marża ${margin < 0 ? '−' : ''}${Math.abs(margin)}%`}
              </Badge>
            ) : null}
          </div>

          {/* Bez minusa przy „Strata” (podwójne zaprzeczenie); pełna kwota ze znakiem w `title`. */}
          <p
            className={cn(
              'text-3xl font-semibold tabular-nums whitespace-nowrap sm:text-4xl',
              loss ? 'text-destructive' : 'text-green-700 dark:text-green-400',
            )}
            title={formatZl(profit)}
          >
            {formatPlMoney(Math.abs(profit))} zł
          </p>

          {series.length >= 2 ? (
            <div className="flex flex-1 flex-col gap-3 max-sm:hidden">
              {/* Wykres absolutnie w rosnącym pojemniku (co najmniej 152 px): wysokość
                  daje układ, nie treść — `ResponsiveContainer` w elemencie mierzonym
                  po treści zostawał przy pierwszym rozmiarze (200 px) i nie malał. */}
              <div className="relative min-h-38 flex-1">
                <ChartContainer
                  config={chartConfig}
                  className="absolute inset-0 aspect-auto h-full w-full"
                  role="img"
                  aria-label="Przychody i koszty narastająco"
                >
                  {/* `accessibilityLayer={false}`: recharts 3 domyślnie daje svg `tabindex=0`
                      i `role="application"`, a w `role="img"` dzieci są prezentacyjne — Tab
                      zatrzymywał się na elemencie bez nazwy (axe: nested-interactive). */}
                  <AreaChart accessibilityLayer={false} data={[...series]} margin={{ left: -5, right: 5, top: 4, bottom: 0 }}>
                    <CartesianGrid vertical={false} strokeDasharray="4" stroke="var(--border)" />
                    <ReferenceLine y={0} stroke="var(--border)" />
                    <XAxis
                      dataKey="day"
                      type="number"
                      domain={[1, lastDay]}
                      ticks={DAY_TICKS.filter((tick) => tick <= lastDay)}
                      tickLine={false}
                      tickMargin={10}
                      axisLine={false}
                      tick={{ fill: 'var(--muted-foreground)' }}
                    />
                    {/* Szerokość 80 jak na wykresach Pulpitu i Przepływów (przy 64 „4,5 tys. zł”
                        traciło pierwszą cyfrę); podziałki równe i okrągłe z `kpirAxisTicks`. */}
                    <YAxis
                      tickFormatter={(value: number) => formatZlCompact(value)}
                      ticks={ticks}
                      domain={[ticks[0]!, ticks.at(-1)!]}
                      interval={0}
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
                          labelFormatter={(_, payload) => {
                            const date = (payload?.[0]?.payload as KpirSeriesPoint | undefined)?.date;
                            return date ? dayLabel(date) : '';
                          }}
                          formatter={(value, name) => (
                            <KpirTooltipRow
                              label={chartConfig[name as keyof typeof chartConfig]?.label ?? String(name)}
                              amount={Number(value)}
                              color={`var(--color-${String(name)})`}
                            />
                          )}
                        />
                      }
                    />
                    <defs>
                      <linearGradient id="fillKpirRevenue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-revenue)" stopOpacity={0.5} />
                        <stop offset="95%" stopColor="var(--color-revenue)" stopOpacity={0.05} />
                      </linearGradient>
                      <linearGradient id="fillKpirCosts" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-costs)" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="var(--color-costs)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <Area
                      dataKey="revenue"
                      type="monotone"
                      fill="url(#fillKpirRevenue)"
                      stroke="var(--color-revenue)"
                      strokeWidth={2.5}
                      dot={false}
                      activeDot={{ r: 5, stroke: 'var(--card)' }}
                    />
                    <Area
                      dataKey="costs"
                      type="monotone"
                      fill="url(#fillKpirCosts)"
                      stroke="var(--color-costs)"
                      strokeWidth={2.5}
                      dot={false}
                      activeDot={{ r: 5, stroke: 'var(--card)' }}
                    />
                  </AreaChart>
                </ChartContainer>
              </div>
              <div className="text-muted-foreground flex gap-4 text-sm" aria-hidden>
                <span className="flex items-center gap-1.5">
                  <span className="bg-chart-1 size-2.5 shrink-0" />
                  Przychody
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="bg-chart-5 dark:bg-foreground size-2.5 shrink-0" />
                  Koszty
                </span>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col justify-center gap-4 max-md:border-t max-md:pt-6 md:col-span-2 md:border-l md:pl-6">
          <div className="flex items-center gap-3">
            <Avatar className="size-9 after:border-0">
              <AvatarFallback className={REVENUE_TINT}>
                <RiArrowLeftDownLine className="size-4.5" aria-hidden />
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-1 items-start justify-between gap-2">
              <div className="flex min-w-0 flex-col">
                <span className="text-muted-foreground text-sm">Przychody</span>
                {settledError ? (
                  <span className="text-xs text-amber-800 dark:text-amber-300">może być zawyżony</span>
                ) : (
                  <span className="text-muted-foreground text-xs">faktury przyjęte w KSeF</span>
                )}
              </div>
              <span className="text-base font-medium tabular-nums whitespace-nowrap">{formatZl(totalRevenue)}</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Avatar className="size-9 after:border-0">
              <AvatarFallback className="bg-destructive/10 text-destructive">
                <RiArrowRightUpLine className="size-4.5" aria-hidden />
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-1 items-start justify-between gap-2">
              <div className="flex min-w-0 flex-col">
                <span className="text-muted-foreground text-sm">Koszty</span>
                {nonDeductedVat > 0 ? (
                  <span className="text-muted-foreground text-xs">
                    w tym VAT bez odliczenia {formatPlMoney(nonDeductedVat)} zł
                  </span>
                ) : null}
              </div>
              <span className="text-base font-medium tabular-nums whitespace-nowrap">{formatZl(totalExpenses)}</span>
            </div>
          </div>

          {uncountedCount > 0 ? (
            <>
              <Separator />
              {/* `dark:bg-input/30` i obrys: w ciemnym motywie `muted` = `card`, notka traciła ramkę. */}
              <div className="bg-muted ring-foreground/10 flex items-center gap-3 p-3 ring-1 dark:bg-input/30">
                <RiErrorWarningLine className="size-5 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden />
                <p className="flex-1 text-sm">{countLabel(uncountedCount, ['koszt', 'koszty', 'kosztów'])} poza sumą</p>
                <Button variant="outline" size="sm" onClick={onShowUncounted}>
                  Pokaż
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
