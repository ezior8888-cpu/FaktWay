// Kopia 1:1 z finora-src/src/views/pages/money-management/monthly-analytics/income-expense-summary.tsx (Analizy, decyzja Bartosza 21.10.2026): zmienione tylko teksty (z propsów), kwoty (zł, pl-PL), daty (DD.MM.RRRR), importy i źródło danych. Odstępstwa: Server Component (bez stanu); zielony `POSITIVE_TEXT_TONE` (green-700, kontrast AA na `bg-muted`) zamiast Finorowego green-600; ikona `shrink-0`, tekst `min-w-0`, wartość `tabular-nums`. Znaczniki zostają zdublowane z karty „Spending Streaks”, tak jak w Finorze.

// Third-party Imports
import { RiArrowDownCircleLine, RiArrowUpCircleLine, RiScales3Line } from '@remixicon/react'

// Type Imports
import type { IncomeExpenseNet } from './types'

// Component Imports
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { POSITIVE_TEXT_TONE } from '@/components/dashboard/pulpit/stat-tile'

// Util Imports
import { formatZl } from './format'

type IncomeExpenseSummaryProps = {
  data: IncomeExpenseNet
  className?: string
}

const IncomeExpenseSummary = ({ data, className }: IncomeExpenseSummaryProps) => {
  const rows = [
    {
      icon: RiArrowUpCircleLine,
      iconClassName: POSITIVE_TEXT_TONE,
      title: 'Przychody',
      amount: data.income
    },
    { icon: RiArrowDownCircleLine, iconClassName: 'text-destructive', title: 'Koszty', amount: data.expense },
    { icon: RiScales3Line, iconClassName: 'text-foreground', title: 'Wynik (netto)', amount: data.net }
  ]

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Przychody a koszty</CardTitle>
        {/* E10 (D-K): koszty z faktur zakupu z KSeF i wydatków — nie tylko KPiR; napis tej samej długości. */}
        <CardDescription>Netto · z KSeF i wydatków, bez VAT do odliczenia</CardDescription>
      </CardHeader>
      <CardContent className='space-y-2'>
        {rows.map(row => (
          <div key={row.title} className='bg-muted flex items-center gap-3 p-3'>
            <row.icon className={`size-6 shrink-0 ${row.iconClassName}`} />
            <div className='min-w-0'>
              <p className='text-sm font-medium'>{row.title}</p>
              <p className='text-muted-foreground text-sm tabular-nums'>{formatZl(row.amount)}</p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

export default IncomeExpenseSummary
