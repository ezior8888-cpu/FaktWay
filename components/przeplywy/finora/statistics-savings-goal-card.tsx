'use client'

// React Imports
import type { ReactNode } from 'react'

// Next Imports
import Link from 'next/link'

// Third-party Imports
import { Label, PolarGrid, PolarRadiusAxis, RadialBar, RadialBarChart } from 'recharts'

// Component Imports
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type ChartConfig, ChartContainer } from '@/components/ui/chart'
import { PULPIT_EMPTY, PulpitEmptyState } from '@/components/dashboard/pulpit/card-states'

// Util Imports
import type { TaxEstimate } from '@/lib/dashboard/tax-estimate'
import type { VatLimitOverview, VatLimitLevel } from '@/lib/dashboard/vat-limit'
import { formatPlCompactMoney } from '@/lib/format/pl'
import { cn } from '@/lib/utils'

import { plDate, zl } from './money'

/**
 * Karta z pierścieniem — Finora `views/dashboards/statistics/statistics-savings-goal-card.tsx`
 * („Savings goal”, plan Finora P2). Pierścień, etykieta w środku i podpis pod
 * spodem 1:1; dwie treści zamiast celu oszczędnościowego:
 *
 * - firma zwolniona podmiotowo (art. 113) — „Limit zwolnienia z VAT”:
 *   procent wykorzystania z `getVatLimit` (funkcje `lib/flo/functions/vat-limit.ts`),
 *   kolor według progów 60/80/90/100%, prognoza; bez daty rozpoczęcia
 *   działalności procent liczony od PEŁNEGO limitu to dolna granica (jak
 *   `components/dashboard/pulpit/vat-limit-card.tsx`);
 * - płatnik VAT — „Odłóż na podatek”: kwota `estimateIncomeTaxThisYear`,
 *   pełny łuk bez procentu (nie znamy kwoty już odłożonej).
 *
 * Pierścień Finory nie ma osi kąta, więc wartość wypełnia cały łuk od
 * `startAngle` do `endAngle` — procent niesie `endAngle` (w szablonie 335°
 * dla 68%: 90° + 0,68 × 360°).
 */

const ringConfig = {
  progress: {
    label: 'Postęp',
    color: 'var(--chart-2)'
  }
} satisfies ChartConfig

const RING_START = 90

const DISCLAIMER = 'Sprzedaż bez faktury (np. z kasy fiskalnej) i z faktur spoza FaktWay dolicz sam.'

/**
 * Kolor pierścienia według progów 60/80/90/100%. Tylko zmienne, które
 * Tailwind na pewno wygeneruje (`amber-600` i `amber-700` stoją w klasach
 * kart Przepływów) — nieużyta zmienna motywu nie trafia do CSS.
 */
function ringColor(level: VatLimitLevel): string {
  if (level === 'ok') return 'var(--chart-2)'
  if (level === 60) return 'var(--color-amber-600)'
  if (level === 80) return 'var(--color-amber-700)'
  return 'var(--destructive)'
}

function levelTone(level: VatLimitLevel): string {
  if (level === 'ok') return 'text-primary'
  if (level === 60 || level === 80) return 'text-amber-700 dark:text-amber-400'
  return 'text-destructive'
}

function Ring({
  pct,
  color,
  lines,
  firstLineClassName = 'text-4xl'
}: {
  /** 0–100; 100 = pełny łuk. */
  pct: number
  color: string
  lines: [ReactNode, ReactNode, ReactNode]
  /** Rozmiar pierwszego wiersza — kwota w złotych jest szersza niż procent z szablonu. */
  firstLineClassName?: string
}) {
  const progress = Math.max(0, Math.min(100, pct))
  const data = [{ progress, fill: 'var(--color-progress)' }]

  return (
    <ChartContainer
      config={{ progress: { ...ringConfig.progress, color } }}
      className='mx-auto aspect-square h-62 w-62'
    >
      <RadialBarChart
        data={data}
        startAngle={RING_START}
        endAngle={RING_START + (progress / 100) * 360}
        innerRadius={115}
        outerRadius={86}
      >
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
                    <tspan x={viewBox.cx} y={(viewBox.cy || 0) - 18} className={cn('fill-foreground font-semibold', firstLineClassName)}>
                      {lines[0]}
                    </tspan>
                    <tspan x={viewBox.cx} y={(viewBox.cy || 0) + 16} className='fill-foreground text-xl font-medium'>
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
  )
}

export type VatLimitGoalCardProps = Pick<
  VatLimitOverview,
  'cumulative' | 'used' | 'annualLimit' | 'startedOn' | 'limit' | 'lowerBound'
> & {
  /**
   * Szacunek podatku dochodowego — firma zwolniona z VAT też płaci PIT,
   * a ta karta zajmuje miejsce „Odłóż na podatek”, więc kwota zostaje tu
   * jednym wierszem (żadna liczba ze starych `/przeplywy` nie znika).
   */
  taxEstimate?: TaxEstimate | null
  className?: string
}

function TaxEstimateLine({ estimate }: { estimate: TaxEstimate }) {
  return (
    <p className='text-muted-foreground text-center text-xs'>
      {`${estimate.label}: ${zl(estimate.amount)} · ${estimate.subtitle}`}
    </p>
  )
}

/** Wariant firmy zwolnionej podmiotowo: „Limit zwolnienia z VAT”. */
export function VatLimitGoalCard({
  cumulative,
  used,
  annualLimit,
  startedOn,
  limit,
  lowerBound = null,
  taxEstimate = null,
  className
}: VatLimitGoalCardProps) {
  const noSales = cumulative.every(v => v === 0)
  const shownPct = (pct: number) => Math.max(0, Math.floor(pct))

  return (
    <Card className={cn(className)}>
      <CardHeader>
        <CardTitle className='text-lg font-semibold'>Limit zwolnienia z VAT</CardTitle>
        <CardDescription className='text-muted-foreground text-base'>Sprzedaż z faktur w KSeF od 1 stycznia</CardDescription>
      </CardHeader>
      <CardContent className='flex flex-1 flex-col items-center justify-center gap-2'>
        {noSales ? (
          <>
            <PulpitEmptyState message={PULPIT_EMPTY.noInvoices} action={PULPIT_EMPTY.issueInvoice} />
            {limit ? (
              <p className='text-muted-foreground text-center text-xs'>Limit na ten rok: {zl(limit.effectiveLimit)}</p>
            ) : (
              <>
                <p className='text-muted-foreground text-center text-xs'>
                  Pełny limit roczny: {zl(annualLimit)} — mniejszy, jeśli działalność ruszyła w tym roku
                </p>
                <Link href='/settings#data-rozpoczecia' className='text-primary text-sm underline-offset-4 hover:underline'>
                  Uzupełnij datę rozpoczęcia działalności
                </Link>
              </>
            )}
          </>
        ) : limit ? (
          <>
            <Ring
              pct={limit.pct}
              color={ringColor(limit.level)}
              lines={[`${shownPct(limit.pct)}%`, formatPlCompactMoney(used), `z ${formatPlCompactMoney(limit.effectiveLimit)}`]}
            />
            <span className={cn('text-center text-sm font-medium', levelTone(limit.level))}>
              {limit.level === 100
                ? 'Limit przekroczony. Sprawdź z księgową rejestrację do VAT.'
                : limit.remaining === 0
                  ? 'Limit wykorzystany w całości — kolejna sprzedaż go przekroczy. Sprawdź z księgową rejestrację do VAT.'
                  : limit.crossesOn
                    ? `Przy obecnym tempie limit skończy się ok. ${plDate(limit.crossesOn)}`
                    : 'Przy obecnym tempie limit wystarczy do końca roku'}
            </span>
            <p className='text-muted-foreground text-center text-xs' title={limit.formula}>
              {`${zl(used)} z ${zl(limit.effectiveLimit)}`}
              {limit.prorated && startedOn ? ` · limit proporcjonalny: działalność od ${plDate(startedOn)}` : ''}
            </p>
          </>
        ) : (
          <>
            <Ring
              pct={lowerBound?.pct ?? 0}
              color={ringColor(lowerBound?.level ?? 'ok')}
              lines={[
                `${shownPct(lowerBound?.pct ?? 0)}%`,
                formatPlCompactMoney(used),
                `z ${formatPlCompactMoney(annualLimit)}`
              ]}
            />
            {lowerBound?.level === 100 ? (
              <span className='text-destructive text-center text-sm font-medium'>
                Sprzedaż przekroczyła pełny roczny limit {zl(annualLimit)}. Sprawdź z księgową rejestrację do VAT.
              </span>
            ) : lowerBound && lowerBound.level !== 'ok' ? (
              <span className={cn('text-center text-sm font-medium', levelTone(lowerBound.level))}>
                Co najmniej {shownPct(lowerBound.pct)}% pełnego limitu — podaj datę rozpoczęcia, jeśli firma ruszyła w tym roku.
              </span>
            ) : null}
            <p className='text-muted-foreground text-center text-xs'>
              {`${zl(used)} z pełnego limitu ${zl(annualLimit)}. Podaj datę rozpoczęcia działalności, a policzymy wykorzystanie limitu.`}
            </p>
            <Link href='/settings#data-rozpoczecia' className='text-primary text-sm underline-offset-4 hover:underline'>
              Uzupełnij w ustawieniach
            </Link>
          </>
        )}
        <p className='text-muted-foreground text-center text-xs'>{DISCLAIMER}</p>
        {taxEstimate ? <TaxEstimateLine estimate={taxEstimate} /> : null}
      </CardContent>
    </Card>
  )
}

/** Wariant płatnika VAT: „Odłóż na podatek”. */
export function TaxSavingsGoalCard({ estimate, className }: { estimate: TaxEstimate; className?: string }) {
  return (
    <Card className={cn(className)}>
      <CardHeader>
        <CardTitle className='text-lg font-semibold'>Odłóż na podatek</CardTitle>
        <CardDescription className='text-muted-foreground text-base'>{estimate.label}</CardDescription>
      </CardHeader>
      <CardContent className='flex flex-1 flex-col items-center justify-center gap-2'>
        <Ring
          pct={100}
          color='var(--chart-2)'
          firstLineClassName='text-2xl'
          lines={[formatPlCompactMoney(estimate.amount), 'do odłożenia', '19% liniowy']}
        />
        <span className='text-primary text-center text-sm font-medium'>{`${zl(estimate.amount)} · ${estimate.subtitle}`}</span>
      </CardContent>
    </Card>
  )
}
