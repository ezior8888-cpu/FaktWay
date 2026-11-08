// Kopia 1:1 z finora-src/src/views/pages/money-management/monthly-analytics/category-ranked-list.tsx (Analizy, decyzja Bartosza 21.10.2026): zmienione tylko teksty (z propsów), kwoty (zł, pl-PL), daty (DD.MM.RRRR), importy i źródło danych. Odstępstwa: Server Component (bez stanu); nazwa i ikona pozycji z danych (Finora: stałe `EXPENSE_CATEGORIES` i `EXPENSE_CATEGORY_ICONS`); długa nazwa ucięta z pełną w `title` (`min-w-0`, `truncate`, `gap-3`), kwota `shrink-0 tabular-nums`; pasek z `aria-label` (nazwa i udział); pusty stan z akcją z §7.3 (`FinoraEmpty`, ten sam `py-6`).

// Type Imports
import type { FinoraEmptyState, RankedItem } from './types'

// Component Imports
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import FinoraEmpty from './finora-empty'

// Util Imports
import { formatZl } from './format'

type CategoryRankedListProps = {
  title: string
  description: string
  data: RankedItem[]
  empty: FinoraEmptyState
  className?: string
}

const CategoryRankedList = ({ title, description, data, empty, className }: CategoryRankedListProps) => {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className='space-y-4'>
        {data.length === 0 ? (
          <FinoraEmpty {...empty} pad='py-6' />
        ) : (
          data.map(item => (
            <div key={item.category} className='flex items-center gap-4'>
              <div className='bg-muted flex size-10 shrink-0 items-center justify-center rounded-full'>
                <item.icon className='text-foreground size-5' />
              </div>
              <div className='min-w-0 flex-1 space-y-1.5'>
                <div className='flex items-center justify-between gap-3 text-sm'>
                  <span className='truncate font-medium' title={item.label}>
                    {item.label}
                  </span>
                  <span className='text-muted-foreground shrink-0 tabular-nums'>{formatZl(item.amount)}</span>
                </div>
                <Progress
                  value={item.percentage}
                  className='*:data-[slot=progress-track]:h-1.5'
                  aria-label={`${item.label}: ${Math.round(item.percentage)}%`}
                />
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

export default CategoryRankedList
