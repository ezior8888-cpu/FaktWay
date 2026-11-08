'use client'

import { useId, useMemo, useState } from 'react'

import Link from 'next/link'

import type { Column, ColumnDef, ColumnFiltersState, PaginationState } from '@tanstack/react-table'
import {
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getPaginationRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable
} from '@tanstack/react-table'
import { RiArrowDownSLine, RiArrowLeftSLine, RiArrowRightSLine, RiArrowUpSLine, RiMore2Line } from '@remixicon/react'

// Component Imports
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem } from '@/components/ui/pagination'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { usePagination } from '@/components/dashboard/finora/use-pagination'

// Utils imports
import type { CashFlowOperation, OperationStatus } from '@/lib/dashboard/cash-movements'
import { cn } from '@/lib/utils'

import { plDate } from './money'
import { amountTone, signedAmount } from './operation-amount'

/**
 * „Wszystkie operacje” — Finora `views/dashboards/datatables/datatable-transaction.tsx`
 * (plan Finora P2). Filtry „Kategoria” i „Status”, kolumny, paginacja po
 * pięć wierszy 1:1. Wiersze: wpłaty (faktury opłacone, §2.4 pkt 14) i wydatki
 * (§2.4 pkt 12) z ostatnich 12 miesięcy.
 *
 * Różnice wobec szablonu: menu akcji ma jedną działającą pozycję (otwarcie
 * faktury albo wydatku) zamiast „Edit / Duplicate / Delete”; poniżej `lg`
 * zamiast tabeli lista kart z tych samych, przefiltrowanych wierszy (plan
 * §7.2 — tabela przewijana w bok na telefonie to błąd).
 */

export const OPERATION_STATUS_LABELS: Record<OperationStatus, string> = {
  paid: 'Opłacona',
  // Korekta in minus zapłaconej faktury — wspólny typ statusów z `cash-movements`.
  correction: 'Korekta',
  reviewed: 'Zatwierdzony',
  pending: 'Do akceptacji',
  // Faktura zakupu z KSeF bez wydatku (E10) — wspólny typ statusów z `cash-movements`.
  ksef: 'Z KSeF'
}

const STATUS_STYLES: Record<OperationStatus, string> = {
  paid: 'bg-green-700/10 text-green-800 focus-visible:ring-green-600/20 dark:bg-green-400/10 dark:text-green-400 dark:focus-visible:ring-green-400/40',
  correction: 'bg-green-700/10 text-green-800 focus-visible:ring-green-600/20 dark:bg-green-400/10 dark:text-green-400 dark:focus-visible:ring-green-400/40',
  reviewed:
    'bg-green-700/10 text-green-800 focus-visible:ring-green-600/20 dark:bg-green-400/10 dark:text-green-400 dark:focus-visible:ring-green-400/40',
  ksef:
    'bg-green-700/10 text-green-800 focus-visible:ring-green-600/20 dark:bg-green-400/10 dark:text-green-400 dark:focus-visible:ring-green-400/40',
  pending:
    'bg-amber-600/10 text-amber-800 focus-visible:ring-amber-600/20 dark:bg-amber-400/10 dark:text-amber-400 dark:focus-visible:ring-amber-400/40'
}

const FILTER_LABELS: Record<string, (value: string) => string> = {
  status: value => OPERATION_STATUS_LABELS[value as OperationStatus] ?? value
}

/** Inicjały do awatara: „Alfa Beta sp. z o.o.” → „AB”. */
function initials(name: string): string {
  const words = name
    .replace(/["„”]/g, '')
    .split(/\s+/)
    .filter(word => /^[\p{L}\p{N}]/u.test(word))
  return (words[0]?.[0] ?? '?').toUpperCase() + (words[1]?.[0] ?? '').toUpperCase()
}

function subLine(operation: CashFlowOperation): string {
  const kind = operation.direction === 'in' ? 'Wpłata' : 'Wydatek'
  return [kind, operation.reference, plDate(operation.date)].filter(Boolean).join(' · ')
}

function StatusBadge({ status }: { status: OperationStatus }) {
  return (
    <Badge className={cn('h-auto border-none focus-visible:outline-none', STATUS_STYLES[status])}>
      {OPERATION_STATUS_LABELS[status]}
    </Badge>
  )
}

const columns: ColumnDef<CashFlowOperation>[] = [
  {
    header: 'Kontrahent',
    accessorKey: 'counterparty',
    cell: ({ row }) => (
      <div className='flex items-center gap-2'>
        <Avatar className='size-9'>
          <AvatarFallback className='text-xs'>{initials(row.original.counterparty)}</AvatarFallback>
        </Avatar>
        <div className='flex min-w-0 flex-col'>
          <span className='truncate font-medium' title={row.original.counterparty}>
            {row.getValue('counterparty')}
          </span>
          <span className='text-muted-foreground truncate'>{subLine(row.original)}</span>
        </div>
      </div>
    ),
    size: 300
  },
  {
    header: 'Kategoria',
    accessorKey: 'category',
    filterFn: 'equalsString',
    cell: ({ row }) => <span className='text-muted-foreground'>{row.getValue('category')}</span>
  },
  {
    header: 'Kwota',
    accessorKey: 'amount',
    cell: ({ row }) => <span className={amountTone(row.original)}>{signedAmount(row.original)}</span>
  },
  {
    header: 'Status',
    accessorKey: 'status',
    filterFn: 'equalsString',
    cell: ({ row }) => <StatusBadge status={row.original.status} />
  },
  {
    id: 'actions',
    header: () => 'Akcje',
    cell: ({ row }) => <RowActions operation={row.original} />,
    size: 60,
    enableHiding: false
  }
]

const TransactionDatatable = ({ data }: { data: CashFlowOperation[] }) => {
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])

  const pageSize = 5

  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: pageSize
  })

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns,
    getRowId: row => row.id,
    state: {
      columnFilters,
      pagination
    },
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    enableSortingRemoval: false,
    getPaginationRowModel: getPaginationRowModel(),
    onPaginationChange: setPagination
  })

  const { pages, showLeftEllipsis, showRightEllipsis } = usePagination({
    currentPage: table.getState().pagination.pageIndex + 1,
    totalPages: table.getPageCount(),
    paginationItemsToDisplay: 2
  })

  const rows = table.getRowModel().rows
  const firstShown = table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1
  const lastShown = Math.min(
    Math.max(table.getState().pagination.pageIndex * table.getState().pagination.pageSize + table.getState().pagination.pageSize, 0),
    table.getRowCount()
  )

  return (
    <div className='w-full'>
      <div className='border-b'>
        <div className='flex flex-col gap-4 p-6'>
          <div className='flex flex-col gap-1'>
            <h2 className='text-lg font-semibold'>Wszystkie operacje</h2>
            <span className='text-muted-foreground text-sm'>
              Ostatnie 12 miesięcy · wpłaty według dnia oznaczenia, wydatki według daty dokumentu
            </span>
          </div>
          <div className='grid grid-cols-1 gap-6 max-md:*:last:col-span-full sm:grid-cols-2'>
            <Filter column={table.getColumn('category')!} />
            <Filter column={table.getColumn('status')!} />
          </div>
        </div>
        <div className='hidden lg:block'>
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map(headerGroup => (
                <TableRow key={headerGroup.id} className='h-14 border-t'>
                  {headerGroup.headers.map(header => {
                    return (
                      <TableHead
                        key={header.id}
                        style={{ width: `${header.getSize()}px` }}
                        className='text-muted-foreground first:pl-4 last:px-4 last:text-center'
                        // Odstępstwo od Finory (WCAG 4.1.2): kierunek sortowania dla czytnika.
                        aria-sort={
                          header.column.getCanSort()
                            ? (({ asc: 'ascending', desc: 'descending' } as const)[
                                header.column.getIsSorted() as 'asc' | 'desc'
                              ] ?? 'none')
                            : undefined
                        }
                      >
                        {header.isPlaceholder ? null : header.column.getCanSort() ? (
                          <div
                            className={cn(
                              header.column.getCanSort() &&
                                'flex h-full cursor-pointer items-center justify-between gap-2 select-none'
                            )}
                            onClick={header.column.getToggleSortingHandler()}
                            onKeyDown={e => {
                              if (header.column.getCanSort() && (e.key === 'Enter' || e.key === ' ')) {
                                e.preventDefault()
                                header.column.getToggleSortingHandler()?.(e)
                              }
                            }}
                            role='button'
                            tabIndex={header.column.getCanSort() ? 0 : undefined}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {{
                              asc: <RiArrowUpSLine className='size-4 shrink-0 opacity-60' aria-hidden='true' />,
                              desc: <RiArrowDownSLine className='size-4 shrink-0 opacity-60' aria-hidden='true' />
                            }[header.column.getIsSorted() as string] ?? null}
                          </div>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                      </TableHead>
                    )
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {rows.length ? (
                rows.map(row => (
                  <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
                    {row.getVisibleCells().map(cell => (
                      <TableCell key={cell.id} className='h-14 first:pl-4 last:px-4'>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className='h-24 text-center'>
                    Brak wyników.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {/* Poniżej `lg`: te same wiersze jako karty (plan §7.2). */}
        <ul className='divide-y border-t lg:hidden'>
          {rows.length ? (
            rows.map(row => {
              const operation = row.original
              return (
                <li key={row.id} className='flex items-start gap-3 px-6 py-4'>
                  <Avatar className='size-9'>
                    <AvatarFallback className='text-xs'>{initials(operation.counterparty)}</AvatarFallback>
                  </Avatar>
                  <div className='flex min-w-0 flex-1 flex-col gap-1'>
                    <div className='flex items-start justify-between gap-3'>
                      <Link
                        href={operation.href}
                        className='truncate font-medium underline-offset-4 hover:underline'
                        title={operation.counterparty}
                      >
                        {operation.counterparty}
                      </Link>
                      <span className={cn('shrink-0 text-sm', amountTone(operation))}>{signedAmount(operation)}</span>
                    </div>
                    <span className='text-muted-foreground truncate text-sm'>{subLine(operation)}</span>
                    <div className='flex flex-wrap items-center gap-2'>
                      <span className='text-muted-foreground text-sm'>{operation.category}</span>
                      <StatusBadge status={operation.status} />
                    </div>
                  </div>
                </li>
              )
            })
          ) : (
            <li className='text-muted-foreground px-6 py-8 text-center text-sm'>Brak wyników.</li>
          )}
        </ul>
      </div>

      <div className='flex items-center justify-between gap-3 px-6 py-4 max-sm:flex-col md:max-lg:flex-col'>
        <p className='text-muted-foreground text-sm whitespace-nowrap' aria-live='polite'>
          {table.getRowCount() > 0 ? (
            <>
              Pozycje{' '}
              <span>
                {firstShown}–{lastShown}
              </span>{' '}
              z <span>{table.getRowCount().toString()}</span>
            </>
          ) : (
            'Brak pozycji'
          )}
        </p>

        <div>
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <Button
                  className='disabled:pointer-events-none disabled:opacity-50'
                  variant='ghost'
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                  aria-label='Poprzednia strona'
                >
                  <RiArrowLeftSLine aria-hidden='true' />
                  Poprzednia
                </Button>
              </PaginationItem>

              {showLeftEllipsis && (
                <PaginationItem>
                  <PaginationEllipsis />
                </PaginationItem>
              )}

              {pages.map(page => {
                const isActive = page === table.getState().pagination.pageIndex + 1

                return (
                  <PaginationItem key={page}>
                    <Button
                      size='icon'
                      // Odstępstwo od Finory (WCAG 1.4.3): numer strony `text-accent-foreground`, nie `text-primary`.
                      // `text-primary` na `bg-primary/10` ma 4,44:1 (jasny) i 3,84 / 4,13:1 pod kursorem (`primary/20`,
                      // jasny / ciemny); `accent-foreground` daje 9,00 / 7,79:1 (jasny) i 8,93 / 7,43:1 (ciemny).
                      className={`${!isActive && 'bg-primary/10 text-accent-foreground hover:bg-primary/20 focus-visible:ring-primary/20 dark:focus-visible:ring-primary/40'}`}
                      onClick={() => table.setPageIndex(page - 1)}
                      aria-current={isActive ? 'page' : undefined}
                    >
                      {page}
                    </Button>
                  </PaginationItem>
                )
              })}

              {showRightEllipsis && (
                <PaginationItem>
                  <PaginationEllipsis />
                </PaginationItem>
              )}

              <PaginationItem>
                <Button
                  className='disabled:pointer-events-none disabled:opacity-50'
                  variant='ghost'
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                  aria-label='Następna strona'
                >
                  Następna
                  <RiArrowRightSLine aria-hidden='true' />
                </Button>
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      </div>
    </div>
  )
}

export default TransactionDatatable

function Filter({ column }: { column: Column<CashFlowOperation, unknown> }) {
  const id = useId()
  const columnFilterValue = column.getFilterValue()

  const columnHeader = typeof column.columnDef.header === 'string' ? column.columnDef.header : ''
  const label = FILTER_LABELS[column.id] ?? ((value: string) => value)

  const facetedUniqueValues = column.getFacetedUniqueValues()

  const sortedUniqueValues = useMemo(() => {
    const values = Array.from(facetedUniqueValues.keys()).map(value => String(value))

    return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b, 'pl'))
  }, [facetedUniqueValues])

  return (
    <div className='flex w-full flex-col gap-2'>
      <Label htmlFor={`${id}-select`}>{columnHeader}</Label>
      <Select
        items={[
          { label: 'Wszystkie', value: 'all' },
          ...sortedUniqueValues.map(value => ({
            label: label(value),
            value
          }))
        ]}
        value={columnFilterValue?.toString() ?? 'all'}
        onValueChange={(value: string | null) => {
          column.setFilterValue(value === 'all' || value === null ? undefined : value)
        }}
      >
        <SelectTrigger id={`${id}-select`} className='w-full'>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value='all'>Wszystkie</SelectItem>
            {sortedUniqueValues.map(value => (
              <SelectItem key={value} value={value}>
                {label(value)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

function RowActions({ operation }: { operation: CashFlowOperation }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size='icon' variant='ghost' aria-label='Więcej akcji' />}>
        <RiMore2Line className='size-4.5' aria-hidden='true' />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link href={operation.href} />}>
            <span>{operation.direction === 'in' ? 'Otwórz fakturę' : 'Otwórz wydatek'}</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
