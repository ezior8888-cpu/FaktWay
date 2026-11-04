'use client'

import { useMemo } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { RiCheckLine, RiTimeLine } from '@remixicon/react'

import { CaptureButton } from '@/components/expenses/capture-button'
import { ExpenseDayCards, ExpensesEmptyState, type ExpenseRow } from '@/components/expenses/expenses-list'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { companyInitials, shortenLegalForm } from '@/lib/format/legal-form'
import { formatPlMoney } from '@/lib/format/pl'
import { roundToCents } from '@/lib/xml/invoice-calculator'

import { ExpenseRowActions } from './expense-row-actions'
import {
  documentLabel,
  kpirShortLabel,
  NO_CATEGORY,
  REVIEW_LABELS,
  REVIEW_STYLES,
  SOURCE_LABELS,
  plDate,
  sourceLabel,
  sourceStyle,
  type ReviewStatus
} from './labels'
import { TransactionDatatable } from './transaction-datatable'

/**
 * Tabela Wydatków (P8 ← Finora Transactions). Kolumny wg planu: Data ·
 * Sprzedawca (nazwa + NIP) · Źródło · Kategoria · Kolumna KPiR · Dokument ·
 * Brutto · Status · Akcje. Filtry „Wszystkie źródła / kategorie / statusy”,
 * „+ Dodaj wydatek” to nasz `CaptureButton`. Poniżej `lg` karty po dniu.
 *
 * Wiersze to lista z serwera (miesiąc albo „Do opisania”), bez zmian
 * zapytania — filtry i wyszukiwanie działają w przeglądarce, jak w Finorze.
 */

const reviewStatus = (expense: ExpenseRow): ReviewStatus => (expense.is_reviewed ? 'reviewed' : 'unreviewed')

export const expenseColumns: ColumnDef<ExpenseRow>[] = [
  {
    header: 'Data',
    accessorKey: 'issue_date',
    cell: ({ row }) => <span className='text-muted-foreground tabular-nums'>{plDate(row.original.issue_date)}</span>,
    size: 110
  },
  {
    header: 'Sprzedawca',
    id: 'seller',
    accessorFn: row => row.seller_name,
    cell: ({ row }) => {
      const expense = row.original

      return (
        <div className='flex items-center gap-2'>
          <Avatar className='size-9 items-center justify-center'>
            <AvatarFallback className='text-xs'>{companyInitials(expense.seller_name)}</AvatarFallback>
          </Avatar>
          <div className='flex min-w-0 flex-col'>
            <span className='max-w-56 truncate font-medium' title={expense.seller_name}>
              {shortenLegalForm(expense.seller_name)}
            </span>
            <span className='text-muted-foreground font-mono'>{expense.seller_nip ? `NIP ${expense.seller_nip}` : 'bez NIP'}</span>
          </div>
        </div>
      )
    },
    size: 260
  },
  {
    header: 'Źródło',
    id: 'source',
    accessorFn: row => row.source,
    filterFn: 'equalsString',
    cell: ({ row }) => <Badge className={sourceStyle(row.original.source)}>{sourceLabel(row.original.source)}</Badge>,
    size: 110,
    meta: {
      filterVariant: 'select'
    }
  },
  {
    header: 'Kategoria',
    id: 'category',
    accessorFn: row => row.category_label?.trim() || NO_CATEGORY,
    filterFn: 'equalsString',
    cell: ({ row }) => (
      <span className='text-muted-foreground'>{row.original.category_label?.trim() || NO_CATEGORY}</span>
    ),
    size: 150,
    meta: {
      filterVariant: 'select'
    }
  },
  {
    header: 'Kolumna KPiR',
    id: 'kpir',
    accessorFn: row => kpirShortLabel(row.kpir_column),
    cell: ({ row }) => <span className='text-muted-foreground'>{kpirShortLabel(row.original.kpir_column)}</span>,
    size: 130
  },
  {
    header: 'Dokument',
    id: 'document',
    accessorFn: row => `${documentLabel(row.document_type)} ${row.document_number ?? ''}`,
    cell: ({ row }) => (
      <div className='flex flex-col'>
        <span className='text-muted-foreground'>{documentLabel(row.original.document_type)}</span>
        <span className='text-muted-foreground font-mono text-xs'>{row.original.document_number ?? '—'}</span>
      </div>
    ),
    size: 160
  },
  {
    header: 'Brutto',
    id: 'gross',
    accessorFn: row => Number(row.gross_amount),
    cell: ({ row }) => (
      <span className='font-medium tabular-nums'>{formatPlMoney(Number(row.original.gross_amount))} zł</span>
    ),
    size: 130
  },
  {
    header: 'Status',
    id: 'status',
    accessorFn: reviewStatus,
    filterFn: 'equalsString',
    cell: ({ row }) => {
      const status = reviewStatus(row.original)

      return (
        <Avatar className='after:border-none' title={REVIEW_LABELS[status]}>
          <AvatarFallback className={REVIEW_STYLES[status]}>
            {status === 'reviewed' ? <RiCheckLine className='size-4' /> : <RiTimeLine className='size-4' />}
            <span className='sr-only'>{REVIEW_LABELS[status]}</span>
          </AvatarFallback>
        </Avatar>
      )
    },
    size: 90,
    meta: {
      filterVariant: 'select'
    }
  },
  {
    id: 'actions',
    header: () => 'Akcje',
    cell: ({ row }) => (
      <ExpenseRowActions expense={row.original} label={shortenLegalForm(row.original.seller_name)} />
    ),
    size: 100,
    enableHiding: false,
    enableSorting: false
  }
]

export function searchExpenseText(expense: ExpenseRow): string {
  return [expense.seller_name, expense.seller_nip, expense.document_number, expense.category_label, expense.notes]
    .filter(Boolean)
    .join(' ')
}

export function ExpensesTable({
  expenses,
  listVariant
}: {
  expenses: ExpenseRow[]
  listVariant: 'month' | 'unreviewed'
}) {
  const filters = useMemo(
    () => [
      { columnId: 'source', allLabel: 'Wszystkie źródła', labels: SOURCE_LABELS },
      { columnId: 'category', allLabel: 'Wszystkie kategorie' },
      { columnId: 'status', allLabel: 'Wszystkie statusy', labels: REVIEW_LABELS }
    ],
    []
  )

  return (
    <TransactionDatatable
      data={expenses}
      columns={expenseColumns}
      filters={filters}
      searchId='expense-search'
      searchPlaceholder='Szukaj: sprzedawca, NIP, numer…'
      searchText={searchExpenseText}
      action={<CaptureButton triggerClassName='max-lg:hidden' />}
      emptyState={<ExpensesEmptyState variant={listVariant} />}
      renderCards={(pageRows, filteredRows) => {
        const dayTotals = new Map<string, number>()
        for (const row of filteredRows) {
          const date = row.original.issue_date
          dayTotals.set(date, roundToCents((dayTotals.get(date) ?? 0) + Number(row.original.gross_amount)))
        }

        return <ExpenseDayCards expenses={pageRows.map(row => row.original)} dayTotals={dayTotals} />
      }}
    />
  )
}

