'use client'

// Kopia 1:1 z finora-src/src/views/dashboards/datatables/datatable-transaction.tsx (Przepływy, decyzja Bartosza 21.10.2026): zmienione tylko teksty, kwoty, daty i importy.

import { useId, useMemo, useState } from 'react'

import Link from 'next/link'

import type { Column, ColumnDef, ColumnFiltersState, PaginationState, RowData } from '@tanstack/react-table'
import {
  flexRender,
  getCoreRowModel,
  getFacetedMinMaxValues,
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

// hooks imports
import { usePagination } from '@/hooks/use-pagination'

// Utils imports
import { plural } from '@/lib/i18n/plural'
import { cn } from '@/lib/utils'

/**
 * PLAN-PRAWDZIWE-DANE E6, E7 pkt 4: wiersze to operacje z FaktWay (wpłaty
 * i koszty, `cashFlowOperations` przez `adaptery.ts`): inicjały zamiast
 * nieistniejących awatarów, „NIP … · numer” zamiast e-maila, prawdziwe
 * kategorie i statusy (filtry z wartości w danych), a menu wiersza otwiera
 * dokument zamiast „Edytuj / Duplikuj / Usuń”. Wygląd bez zmian.
 */

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    filterVariant?: 'text' | 'range' | 'select'
  }
}

export type Item = {
  id: string
  initials: string
  counterparty: string
  /** Druga linia: „NIP … · numer dokumentu”. */
  detail: string
  category: string
  /** Kierunek pieniędzy (zwrot kosztu to wpływ). */
  direction: 'in' | 'out'
  /** Kwota bez znaku; znak i kolor z `direction`. */
  amount: number
  status: 'paid' | 'correction' | 'reviewed' | 'pending' | 'ksef'
  /** „Otwórz fakturę” / „Otwórz wydatek”. */
  openLabel: string
  /** `null` w danych przykładowych — demo nie ma prawdziwych dokumentów. */
  href: string | null
}

// Statusy po polsku: wpływ to „Opłacona” (prawdziwa zapłata) albo „Korekta” (korekta in minus zapłaconej
// faktury). Koszt „Zatwierdzony” albo „Do akceptacji” (opisanie, nie zapłata), faktura zakupu z KSeF
// bez wydatku „Z KSeF” (E10 — nie ma jej w Wydatkach, więc nie ma czego akceptować).
// Bez `capitalize` z Finory: wielowyrazowe etykiety („Do akceptacji”, „Bez kategorii”) dostałyby
// wielką literę w każdym słowie; wielką literę na początku daje adapter.
const STATUS_LABELS: Record<Item['status'], string> = {
  paid: 'Opłacona',
  correction: 'Korekta',
  reviewed: 'Zatwierdzony',
  pending: 'Do akceptacji',
  ksef: 'Z KSeF'
}

const valueLabel = (value: string) => STATUS_LABELS[value as Item['status']] ?? value

const columns: ColumnDef<Item>[] = [
  {
    header: 'Kontrahent',
    accessorKey: 'counterparty',
    cell: ({ row }) => (
      <div className='flex items-center gap-2'>
        <Avatar className='size-9'>
          <AvatarFallback className='text-xs'>{row.original.initials}</AvatarFallback>
        </Avatar>
        <div className='flex flex-col'>
          <span className='font-medium'>{row.getValue('counterparty')}</span>
          <span className='text-muted-foreground'>{row.original.detail}</span>
        </div>
      </div>
    ),
    size: 300
  },
  {
    header: 'Kategoria',
    accessorKey: 'category',
    filterFn: 'equalsString',
    cell: ({ row }) => <span className='text-muted-foreground'>{row.getValue('category') as string}</span>
  },
  {
    header: 'Kwota',
    accessorKey: 'amount',
    cell: ({ row }) => {
      const amount = parseFloat(row.getValue('amount'))
      const direction = row.original.direction

      // useGrouping 'always': pl-PL bez tego nie grupuje kwot czterocyfrowych („3200,00 zł”).
      const formatted = new Intl.NumberFormat('pl-PL', {
        style: 'currency',
        currency: 'PLN',
        useGrouping: 'always'
      }).format(amount)

      return (
        <span className={direction === 'in' ? 'text-green-600 dark:text-green-400' : 'text-destructive'}>
          {direction === 'in' ? '+' : '-'}
          {formatted}
        </span>
      )
    }
  },
  {
    header: 'Status',
    accessorKey: 'status',
    filterFn: 'equalsString',
    cell: ({ row }) => {
      const status = row.getValue('status') as string

      const styles = {
        paid:
          'bg-green-600/10 text-green-600 focus-visible:ring-green-600/20 dark:bg-green-400/10 dark:text-green-400 dark:focus-visible:ring-green-400/40 [a&]:hover:bg-green-600/5 dark:[a&]:hover:bg-green-400/5',
        reviewed:
          'bg-green-600/10 text-green-600 focus-visible:ring-green-600/20 dark:bg-green-400/10 dark:text-green-400 dark:focus-visible:ring-green-400/40 [a&]:hover:bg-green-600/5 dark:[a&]:hover:bg-green-400/5',
        // „Korekta” i „Z KSeF” (E10): ten sam wygląd co „Zatwierdzony” — bez nowego koloru
        // (zasada Bartosza 23.10.2026), bez bursztynu „do zrobienia”.
        correction:
          'bg-green-600/10 text-green-600 focus-visible:ring-green-600/20 dark:bg-green-400/10 dark:text-green-400 dark:focus-visible:ring-green-400/40 [a&]:hover:bg-green-600/5 dark:[a&]:hover:bg-green-400/5',
        ksef:
          'bg-green-600/10 text-green-600 focus-visible:ring-green-600/20 dark:bg-green-400/10 dark:text-green-400 dark:focus-visible:ring-green-400/40 [a&]:hover:bg-green-600/5 dark:[a&]:hover:bg-green-400/5',
        pending:
          'bg-amber-600/10 text-amber-600 focus-visible:ring-amber-600/20 dark:bg-amber-400/10 dark:text-amber-400 dark:focus-visible:ring-amber-400/40 [a&]:hover:bg-amber-600/5 dark:[a&]:hover:bg-amber-400/5'
      }[status]

      return (
        <Badge className={cn('h-auto border-none focus-visible:outline-none', styles)}>
          {valueLabel(row.getValue('status') as string)}
        </Badge>
      )
    }
  },
  {
    id: 'actions',
    header: () => 'Akcje',
    cell: ({ row }) => <RowActions href={row.original.href} label={row.original.openLabel} />,
    size: 60,
    enableHiding: false
  }
]

const TransactionDatatable = ({ data, emptyMessage = 'Brak wyników.' }: { data: Item[]; emptyMessage?: string }) => {
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
    getFacetedMinMaxValues: getFacetedMinMaxValues(),
    enableSortingRemoval: false,
    getPaginationRowModel: getPaginationRowModel(),
    onPaginationChange: setPagination
  })

  const { pages, showLeftEllipsis, showRightEllipsis } = usePagination({
    currentPage: table.getState().pagination.pageIndex + 1,
    totalPages: table.getPageCount(),
    paginationItemsToDisplay: 2
  })

  return (
    <div className='w-full'>
      <div className='border-b'>
        <div className='flex flex-col gap-4 p-6'>
          <div className='grid grid-cols-1 gap-6 max-md:*:last:col-span-full sm:grid-cols-2'>
            <Filter column={table.getColumn('category')!} />
            <Filter column={table.getColumn('status')!} />
          </div>
        </div>
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
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map(row => (
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
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className='flex items-center justify-between gap-3 px-6 py-4 max-sm:flex-col md:max-lg:flex-col'>
        <p className='text-muted-foreground text-sm whitespace-nowrap' aria-live='polite'>
          Wyświetlane{' '}
          <span>
            {Math.min(
              table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1,
              table.getRowCount()
            )}{' '}
            do{' '}
            {Math.min(
              Math.max(
                table.getState().pagination.pageIndex * table.getState().pagination.pageSize +
                  table.getState().pagination.pageSize,
                0
              ),
              table.getRowCount()
            )}
          </span>{' '}
          z{' '}
          <span>
            {table.getRowCount().toString()} {plural(table.getRowCount(), ['wpisu', 'wpisów', 'wpisów'])}
          </span>
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
                  aria-label='Przejdź do poprzedniej strony'
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
                      // Odstępstwo od Finory: text-accent-foreground zamiast text-primary na bg-primary/10 (WCAG, jak w reszcie repo).
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
                  aria-label='Przejdź do następnej strony'
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

// Odstępstwo od Finory: wyłączenie reguły no-explicit-any (jak w oryginale używającym Column<any>).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function Filter({ column }: { column: Column<any, unknown> }) {
  const id = useId()
  const columnFilterValue = column.getFilterValue()
  const { filterVariant } = column.columnDef.meta ?? {}

  const columnHeader = typeof column.columnDef.header === 'string' ? column.columnDef.header : ''

  const facetedUniqueValues = column.getFacetedUniqueValues()

  const sortedUniqueValues = useMemo(() => {
    if (filterVariant === 'range') return []

    const values = Array.from(facetedUniqueValues.keys())

    const flattenedValues = values.reduce((acc: string[], curr) => {
      if (Array.isArray(curr)) {
        return [...acc, ...curr]
      }

      return [...acc, curr]
    }, [])

    return Array.from(new Set(flattenedValues)).sort()
  }, [facetedUniqueValues, filterVariant])

  return (
    <div className='flex w-full flex-col gap-2'>
      <Label htmlFor={`${id}-select`}>Wybierz: {columnHeader}</Label>
      <Select
        items={[
          { label: `Wszystkie`, value: 'all' },
          ...sortedUniqueValues.map(value => ({
            label: valueLabel(String(value)),
            value: String(value)
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
              <SelectItem key={String(value)} value={String(value)}>
                {valueLabel(String(value))}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * Menu wiersza (E7 pkt 4): jedna pozycja „Otwórz fakturę / wydatek”.
 * Przyjętych faktur nie wolno usuwać, a „Usuń” sugerowało kasowanie faktury
 * z KSeF. W danych przykładowych pozycja jest wyłączona (brak dokumentu).
 */
export function RowActions({ href, label, defaultOpen }: { href: string | null; label: string; defaultOpen?: boolean }) {
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger render={<Button size='icon' variant='ghost' aria-label='Więcej akcji' />}>
        <RiMore2Line className='size-4.5' aria-hidden='true' />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        <DropdownMenuGroup>
          {href ? (
            <DropdownMenuItem render={<Link href={href} />}>
              <span>{label}</span>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled>
              <span>{label}</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
