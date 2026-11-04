'use client'

// React Imports
import { useTransition } from 'react'

// Third-party Imports
import { useRouter } from 'next/navigation'

// Component Imports
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

// Utils Imports
import { monthLabel, shiftMonth } from '@/lib/expenses/month'
import { cn } from '@/lib/utils'

/**
 * Port `src/views/pages/money-management/monthly-analytics/month-selector.tsx`
 * z Finory. Zamiast `nuqs` (plan §10.1: nie dodajemy) adres zmienia
 * `router.push` — miesiąc dalej siedzi w `?miesiac=RRRR-MM`, jak na liście
 * wydatków od F-087. Lista ma 24 miesiące wstecz (Finora: 6), bo wydatki
 * sprzed pół roku też się opisuje; miesiąc z adresu spoza listy dochodzi na
 * jej koniec, żeby wybór był zawsze widoczny.
 *
 * Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): ten sam
 * przełącznik stoi na KPiR, ale KPiR ma od dawna adres `?month=M&year=RRRR`
 * (linki z Przepływów, Flo, testy strefy czasowej) — stąd `query="month-year"`.
 * Domyślnie wszystko jak było (`?miesiac=`, etykieta „Miesiąc wydatków”).
 * Propsy zostają serializowalne (bez funkcji), bo na KPiR rysuje go komponent
 * serwerowy.
 */

type MonthSelectorProps = {
  /** Wybrany miesiąc RRRR-MM. */
  month: string
  /** Bieżący miesiąc RRRR-MM (Europe/Warsaw) — początek listy. */
  currentMonth: string
  /** Ścieżka listy, np. `/expenses` — miesiąc dochodzi jako `?miesiac=RRRR-MM`. */
  basePath: string
  /**
   * Postać adresu: `'miesiac'` (domyślnie) → `?miesiac=RRRR-MM`,
   * `'month-year'` → `?month=M&year=RRRR` (KPiR).
   */
  query?: 'miesiac' | 'month-year'
  /** Etykieta pola dla czytnika ekranu. */
  ariaLabel?: string
  className?: string
}

const MONTHS_BACK = 24

export function monthOptions(currentMonth: string, selected: string): { label: string; value: string }[] {
  const options = Array.from({ length: MONTHS_BACK }, (_, index) => {
    const value = shiftMonth(currentMonth, -index)

    return { label: capitalize(monthLabel(value)), value }
  })

  if (!options.some(option => option.value === selected)) {
    options.push({ label: capitalize(monthLabel(selected)), value: selected })
  }

  return options
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase('pl-PL') + text.slice(1)
}

/** Adres listy dla wybranego miesiąca RRRR-MM w postaci `query`. */
function monthHref(basePath: string, value: string, query: 'miesiac' | 'month-year'): string {
  if (query === 'month-year') {
    const [year, month] = value.split('-')

    return `${basePath}?month=${Number(month)}&year=${year}`
  }

  return `${basePath}?miesiac=${value}`
}

const MonthSelector = ({
  month,
  currentMonth,
  basePath,
  query = 'miesiac',
  ariaLabel = 'Miesiąc wydatków',
  className
}: MonthSelectorProps) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const options = monthOptions(currentMonth, month)

  return (
    <Select
      items={options}
      value={month}
      disabled={isPending}
      onValueChange={value => {
        if (value) startTransition(() => router.push(monthHref(basePath, value, query)))
      }}
    >
      <SelectTrigger
        className={cn('w-48', className)}
        aria-label={ariaLabel}
        // Przejście do innego miesiąca trwa (strona serwerowa) — czytnik słyszy „zajęte”.
        aria-busy={isPending || undefined}
      >
        <SelectValue placeholder='Wybierz miesiąc' />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className='p-1'>
        <SelectGroup>
          {options.map(option => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

export default MonthSelector
