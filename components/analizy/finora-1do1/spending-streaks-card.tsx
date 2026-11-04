// Kopia 1:1 z finora-src/src/views/pages/money-management/monthly-analytics/spending-streaks-card.tsx (Analizy, decyzja Bartosza 21.10.2026): zmienione tylko teksty (z propsów), kwoty (zł, pl-PL), daty (DD.MM.RRRR), importy i źródło danych. Odstępstwa: Server Component (bez stanu); wiersze z propsów zamiast serii „no-spend” (plan Finora §5 P10/P11 i §8: „Spending Streaks” jako gra odpada, w tym miejscu stoją „VAT z wydatków” i „Należności” w tym samym układzie trzech wierszy `bg-muted p-3`); ikona `shrink-0`, tekst `min-w-0`, wartość `tabular-nums`.

// Next Imports
import Link from 'next/link'

// Type Imports
import type { SummaryRow } from './types'

// Component Imports
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

type SpendingStreaksCardProps = {
  title: string
  description: string
  /** Pełne zastrzeżenie w dymku podpisu (podpis w jednej linii jak dotąd). */
  descriptionTitle?: string
  rows: SummaryRow[]
  className?: string
}

const SpendingStreaksCard = ({ title, description, descriptionTitle, rows, className }: SpendingStreaksCardProps) => {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription title={descriptionTitle}>{description}</CardDescription>
      </CardHeader>
      <CardContent className='space-y-2'>
        {rows.map(row => (
          <div key={row.title} className='bg-muted flex items-center gap-3 p-3'>
            <row.icon className={`size-6 shrink-0 ${row.iconClassName}`} />
            <div className='min-w-0'>
              <p className='text-sm font-medium'>{row.title}</p>
              <p className='text-muted-foreground text-sm tabular-nums'>
                {row.href ? (
                  <Link href={row.href}>
                    {row.value}
                  </Link>
                ) : (
                  row.value
                )}
              </p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

export default SpendingStreaksCard
