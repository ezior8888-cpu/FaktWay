'use client';

import type { RemixiconComponentType } from '@remixicon/react';
import { RiFileList3Line, RiFlaskLine, RiShoppingBag3Line, RiTeamLine, RiTruckLine } from '@remixicon/react';
import { Cell, Label, Pie, PieChart } from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { cn } from '@/lib/utils';

import { KpirTooltipRow } from './kpir-result-card';
import { formatZl, formatZlCompact, type CostSlice, type CountedColumn, type KpirColumnKey } from './kpir-model';

// Kolory jak plasterki Finory (chart-1…5). chart-5 w ciemnym motywie ginie na
// karcie (WCAG 1.4.11) — tam `foreground`, jak koszty na wykresach Pulpitu.
const chartConfig = {
  col_10: { label: 'Towary i materiały', color: 'var(--chart-1)' },
  col_11: { label: 'Koszty uboczne zakupu', color: 'var(--chart-2)' },
  col_12: { label: 'Wynagrodzenia', color: 'var(--chart-3)' },
  col_13: { label: 'Pozostałe wydatki', color: 'var(--chart-4)' },
  col_15: { label: 'Koszty B+R', theme: { light: 'var(--chart-5)', dark: 'var(--foreground)' } },
} satisfies ChartConfig;

/**
 * Kwadrat z ikoną w legendzie. Legenda leży poza `ChartContainer`, więc nie
 * widzi zmiennych `--color-*` wykresu — te same kolory jako klasy.
 */
const SLICE_STYLE: Record<CountedColumn, { square: string; icon: string; Icon: RemixiconComponentType }> = {
  col_10: { square: 'bg-chart-1', icon: 'text-primary-foreground', Icon: RiShoppingBag3Line },
  col_11: { square: 'bg-chart-2', icon: 'text-primary-foreground', Icon: RiTruckLine },
  col_12: { square: 'bg-chart-3', icon: 'text-primary-foreground', Icon: RiTeamLine },
  col_13: { square: 'bg-chart-4', icon: 'text-primary-foreground', Icon: RiFileList3Line },
  col_15: { square: 'bg-chart-5 dark:bg-foreground', icon: 'text-primary-foreground dark:text-background', Icon: RiFlaskLine },
};

/**
 * „Koszty według kolumn” — port Finory `views/pages/insurance/premium/premium-breakdown-chart.tsx`
 * (poprawka Bartosza 21.10.2026: przeprojektowanie Księgowości). Pierścień
 * z kolumn sum KPiR (10–13 i B+R), w środku koszty razem (`totalExpenses`).
 * Wiersz legendy to przycisk: filtruje księgę po tej kolumnie i przewija do
 * niej; drugi klik zdejmuje filtr. Kolumna na minusie (same korekty) jest
 * w legendzie z „—” zamiast udziału i bez plasterka.
 *
 * Koszty poza sumą tu nie trafiają — pokazuje je notka karty wyniku,
 * segment „Do sprawdzenia” i plakietka w wierszu.
 */
export function KpirCostStructureCard({
  slices,
  totalExpenses,
  activeColumn,
  onSelectColumn,
  className,
}: {
  slices: readonly CostSlice[];
  totalExpenses: number;
  /** Kolumna wybrana w filtrze księgi (`'10'`…), jeśli to kolumna kosztów. */
  activeColumn: string | undefined;
  onSelectColumn: (column: KpirColumnKey) => void;
  className?: string;
}) {
  const pie = slices.filter((slice) => slice.amount > 0);

  return (
    <Card className={cn('shadow-none max-sm:hidden', className)}>
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Koszty według kolumn</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-6 max-sm:flex-col xl:flex-col">
        <ChartContainer config={chartConfig} className="mx-auto aspect-square min-h-45 w-45 shrink-0">
          <PieChart>
            <ChartTooltip
              content={
                <ChartTooltipContent
                  hideLabel
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
            <Pie
              data={pie}
              dataKey="amount"
              nameKey="key"
              innerRadius={58}
              outerRadius={80}
              strokeWidth={3}
              stroke="var(--card)"
            >
              {pie.map((slice) => (
                <Cell key={slice.key} fill={`var(--color-${slice.key})`} />
              ))}
              <Label
                content={({ viewBox }) => {
                  if (!viewBox || !('cx' in viewBox) || !('cy' in viewBox)) return null;

                  return (
                    <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                      <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) - 8} className="fill-foreground text-lg font-semibold">
                        {/* Minus typograficzny, gdy korekty zbiją koszty poniżej zera. */}
                        {formatZlCompact(totalExpenses)}
                      </tspan>
                      <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) + 12} className="fill-muted-foreground text-xs">
                        razem
                      </tspan>
                    </text>
                  );
                }}
              />
            </Pie>
          </PieChart>
        </ChartContainer>

        <ul className="w-full flex-1 space-y-3">
          {slices.map((slice) => {
            const style = SLICE_STYLE[slice.key];
            const active = activeColumn === slice.filterKey;

            return (
              <li key={slice.key}>
                {/* Wybrany wiersz: tło akcentu i obrys `ring` (≥ 3:1 do karty w obu motywach).
                    Samo `bg-muted` znikało w ciemnym motywie (`muted` = `card`). */}
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onSelectColumn(slice.filterKey)}
                  className="hover:bg-muted dark:hover:bg-input/30 aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-pressed:ring-ring focus-visible:ring-ring flex w-full items-center gap-3 p-1 text-left outline-none focus-visible:ring-2 aria-pressed:ring-1 aria-pressed:ring-inset"
                >
                  <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md', style.square)}>
                    <style.Icon className={cn('size-3.5', style.icon)} aria-hidden />
                  </span>
                  <span className="flex-1 text-sm font-medium">{slice.label}</span>
                  <span className={cn('text-xs tabular-nums', active ? 'text-accent-foreground' : 'text-muted-foreground')}>
                    {slice.share === null ? '—' : `${Math.round(slice.share * 100)}%`}
                  </span>
                  <span className="w-24 text-right text-sm font-medium tabular-nums whitespace-nowrap">
                    {formatZl(slice.amount)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
