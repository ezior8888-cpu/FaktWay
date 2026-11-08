'use client'

// Kopia 1:1 z finora-src/src/views/pages/money-management/monthly-analytics/spend-heatmap.tsx (Analizy, decyzja Bartosza 21.10.2026): zmienione tylko teksty (z propsów), kwoty (zł, pl-PL), daty (DD.MM.RRRR), importy i źródło danych. Odstępstwa: tydzień od poniedziałku (polski kalendarz; `heatmapWeeks` z lib, Finora: `getDay` od niedzieli) i podpisy dni P W Ś C P S N z pełną nazwą w `title`; natężenie kwantylowe z lib (`heatmapIntensityClass` — ta sama reguła co Finorowe `getIntensityClassName`, dzień ≤ 0 to `bg-muted`); kolumna podpisów `aria-hidden`; przewijany w bok kontener to `role='region'` z `aria-label`, `tabIndex={0}` i obwódką fokusu (WCAG 2.1.1 — przewinie się go strzałkami); komórki `role='img'` z `aria-label` „DD.MM.RRRR — kwota” (ten sam tekst w podpowiedzi); pusty stan tylko z propsa `empty` (okno bez żadnych dokumentów — wtedy zera byłyby nieprawdą), w każdym innym wypadku siatka rysuje się zawsze, także z samymi zerami.

// Type Imports
import type { FinoraEmptyState, HeatmapDay } from './types'

// Component Imports
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import FinoraEmpty from './finora-empty'

// Util Imports
import { heatmapIntensityClass, heatmapWeeks } from '@/lib/analytics-finance/heatmap'
import { isoDatePl } from '@/lib/analytics-finance/months'
import { formatZl } from './format'

type SpendHeatmapProps = {
  title: string
  description: string
  data: HeatmapDay[]
  empty?: FinoraEmptyState | null
  className?: string
}

/** Pn, Wt, Śr, Cz, Pt, So, Nd — jedna litera, jak w Finorze. */
const WEEKDAY_LABELS = ['P', 'W', 'Ś', 'C', 'P', 'S', 'N']
const WEEKDAY_NAMES = ['poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota', 'niedziela']

const SpendHeatmap = ({ title, description, data, empty, className }: SpendHeatmapProps) => {
  const sortedNonZeroAmounts = data
    .map(day => day.amount)
    .filter(amount => amount > 0)
    .sort((a, b) => a - b)

  // Każdy dzień na swoim (tydzień, dzień tygodnia), żeby kolumny układały się jak kalendarz.
  const weeks = heatmapWeeks(data)

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {empty ? (
          <FinoraEmpty {...empty} pad='py-10' />
        ) : (
          <div
            role='region'
            aria-label={title}
            tabIndex={0}
            className='focus-visible:ring-ring/50 flex gap-2 overflow-x-auto rounded-sm pb-1 outline-none focus-visible:ring-[3px]'
          >
            <div className='flex flex-col gap-3.5' aria-hidden='true'>
              {WEEKDAY_LABELS.map((label, index) => (
                <span
                  key={index}
                  title={WEEKDAY_NAMES[index]}
                  className='text-muted-foreground flex size-3.75 items-center justify-center text-xs leading-none'
                >
                  {label}
                </span>
              ))}
            </div>
            {weeks.map((week, weekIndex) => (
              <div key={weekIndex} className='flex flex-col gap-3.5'>
                {WEEKDAY_LABELS.map((_, weekdayIndex) => {
                  const day = week[weekdayIndex]

                  if (!day) return <div key={weekdayIndex} className='size-3.75' />

                  const label = `${isoDatePl(day.date)} — ${formatZl(day.amount)}`

                  return (
                    <Tooltip key={day.date}>
                      <TooltipTrigger
                        render={
                          <div
                            role='img'
                            aria-label={label}
                            className={`size-3.75 rounded-sm ${heatmapIntensityClass(day.amount, sortedNonZeroAmounts)}`}
                          />
                        }
                      />
                      <TooltipContent>{label}</TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default SpendHeatmap
