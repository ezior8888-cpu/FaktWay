// Kształty danych kart Analiz w kopii 1:1 z Finory (decyzja Bartosza 21.10.2026:
// „na razie wszystko 1:1”). Finora bierze typy z `ReturnType<typeof getX>`
// swojej warstwy przykładowej (`@/lib/monthly-analytics`); u nas karty dostają
// te same kształty jako zwykłe propsy, a wypełniają je czyste adaptery
// (`components/analizy/adapters.ts`) z prawdziwych danych. Nazwy pól zostają
// Finory (`totalSpend`, `vsLastMonthPercentage`…), żeby kopia JSX była dosłowna.

import type { ComponentType } from 'react'

export type FinoraIcon = ComponentType<{ className?: string }>

/** Ten sam kształt co `EmptyStateProps` z `components/analizy/finora/empty.ts` (wpisy `ANALIZY_EMPTY` pasują wprost). */
export interface FinoraEmptyState {
  message: string
  action?: { label: string; href: string } | null
}

/** Finora `getMonthlyStats` */
export interface MonthlyStats {
  totalSpend: number
  avgDailySpend: number
  vsLastMonthPercentage: number | null
  topCategory: string | null
}

export interface MonthlyStatsLabels {
  totalSpend: string
  avgDailySpend: string
  vsLastMonth: string
  topCategory: string
  noPreviousMonth: string
}

/** Punkt Finory `getSpendTrend` */
export interface TrendDatum {
  month: string
  amount: number
}

/** Pozycja Finory `getCategoryBreakdown`; `category` to klucz bezpieczny dla CSS po miejscu w rankingu: 's0'…'s5' (także „Pozostałe” — `toCategorySlices`) */
export interface CategorySlice {
  category: string
  label: string
  amount: number
  percentage: number
  color: string
}

export interface RankedItem extends CategorySlice {
  icon: FinoraIcon
}

/** Finora `ExpenseEntry` w liście ostatnich */
export interface FeedItem {
  id: string
  merchant: string
  subtitle: string
  amount: number
  icon: FinoraIcon
  /** Dokument, do którego prowadzi nazwa wiersza (tylko prawdziwe dane); bez zmiany wyglądu. */
  href?: string | null
}

export interface SummaryRow {
  icon: FinoraIcon
  iconClassName: string
  title: string
  value: string
  /** Cel napisu wartości (np. lista „Do opisania”); bez zmiany wyglądu. */
  href?: string | null
}

/** Finora `getIncomeExpenseNet` */
export interface IncomeExpenseNet {
  income: number
  expense: number
  net: number
}

/** Finora `Subscription` (ikona zamiast logo) */
export interface SubscriptionItem {
  id: string
  name: string
  icon: FinoraIcon
  amount: number
  renewsLabel: string
  billingCycle: string
  action?: { href: string; label: string; ariaLabel: string } | null
}

export type { HeatmapDay } from '@/lib/analytics-finance/heatmap'
