// Kopia 1:1 z finora-src/src/views/pages/money-management/monthly-analytics/monthly-stats-cards.tsx (Analizy, decyzja Bartosza 21.10.2026): zmienione tylko teksty (z propsów), kwoty (zł, pl-PL), daty (DD.MM.RRRR), importy i źródło danych. Odstępstwa: Server Component (bez `useMemo` — lista liczy się raz na serwerze); kwoty w skrócie `formatPlCompactMoney` z pełną kwotą w `title` (§7.1); procent całkowity z minusem typograficznym (`formatPlPercentChange`, Finora: `toFixed(1)`); bez poprzedniego miesiąca „—” z ikoną `RiArrowUpDownLine` i wyjaśnieniem w `title` (procent bez podstawy nie istnieje; Finora pokazuje wtedy liczbę); ikona czwartego kafla z propsów (koszty: metka, sprzedaż: klient). Bez dopisku pod etykietą — wysokość kafla jak w Finorze.

// Third-party Imports
import {
  RiArrowDownLine,
  RiArrowUpDownLine,
  RiArrowUpLine,
  RiCalendarLine,
  RiPriceTag3Line,
  RiWalletLine
} from '@remixicon/react'

// Type Imports
import type { FinoraIcon, MonthlyStats, MonthlyStatsLabels } from './types'

// Component Imports
import StatsCards, { type StatItem } from '@/components/dashboard/stats-cards'

// Util Imports
import { formatPlCompactMoney, formatPlPercentChange } from '@/lib/format/pl'
import { formatZl } from './format'

type MonthlyStatsCardsProps = {
  stats: MonthlyStats
  labels: MonthlyStatsLabels
  topCategoryIcon?: FinoraIcon
  className?: string
}

const changeItem = (pct: number | null, labels: MonthlyStatsLabels): StatItem => {
  if (pct === null) {
    return { label: labels.vsLastMonth, value: '—', valueTitle: labels.noPreviousMonth, icon: RiArrowUpDownLine }
  }

  // Kierunek strzałki po zaokrągleniu, jak tekst: „0%” przy −0,4% nie dostaje strzałki w dół.
  const isSpendUp = Math.round(pct) >= 0

  return {
    label: labels.vsLastMonth,
    value: formatPlPercentChange(pct),
    icon: isSpendUp ? RiArrowUpLine : RiArrowDownLine
  }
}

const MonthlyStatsCards = ({ stats, labels, topCategoryIcon = RiPriceTag3Line, className }: MonthlyStatsCardsProps) => {
  const items: StatItem[] = [
    {
      label: labels.totalSpend,
      value: formatPlCompactMoney(stats.totalSpend),
      valueTitle: formatZl(stats.totalSpend),
      icon: RiWalletLine
    },
    {
      label: labels.avgDailySpend,
      value: formatPlCompactMoney(stats.avgDailySpend),
      valueTitle: formatZl(stats.avgDailySpend),
      icon: RiCalendarLine
    },
    changeItem(stats.vsLastMonthPercentage, labels),
    {
      label: labels.topCategory,
      value: stats.topCategory ?? '—',
      valueTitle: stats.topCategory ?? undefined,
      valueClassName: 'truncate',
      icon: topCategoryIcon
    }
  ]

  return <StatsCards stats={items} className={className} />
}

export default MonthlyStatsCards
