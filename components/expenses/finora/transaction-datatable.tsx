'use client'

// React Imports
import { useId, useMemo, useState, type ReactNode } from 'react'

// Third-party Imports
import type { Column, ColumnDef, ColumnFiltersState, PaginationState, Row, RowData } from '@tanstack/react-table'
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
import { RiArrowDownSLine, RiArrowLeftSLine, RiArrowRightSLine, RiArrowUpSLine, RiSearchLine } from '@remixicon/react'

// Component Imports
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem } from '@/components/ui/pagination'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

// Hook Imports
import { usePagination } from '@/hooks/use-pagination'

/**
 * Port tabeli Finora `src/views/pages/transactions/transaction-table/data-table.tsx`
 * (plan Finora P8 Wydatki i P9 Skrzynka KSeF — „ten sam komponent tabeli”).
 * Układ, klasy, pasek „Pokaż” + akcja po lewej, wyszukiwarka i filtry po
 * prawej, sortowanie nagłówków, paginacja i „Pozycje 1–10 z N” 1:1.
 *
 * Różnice (opisane w raporcie E6):
 * - kolumny, filtry i wyszukiwanie podaje strona (wydatki, skrzynka), bo
 *   dane są nasze, nie przykładowe; akcję „+ Add Transaction” zastępuje
 *   `action` (na wydatkach nasz `CaptureButton`, 10.2 pkt 10);
 * - tabela jest od `lg`, a poniżej `lg` te same wiersze (po filtrach
 *   i stronicowaniu) rysuje `renderCards` — karty jak dziś (plan §7.2:
 *   przewijanie tabeli w bok na 375 px to błąd);
 * - bez kolumny zaznaczania: w Finorze nic z zaznaczeniem nie robi, u nas też
 *   nie ma akcji zbiorczej;
 * - nagłówek sortowalny to `<button>` zamiast fokusowalnego `<div>`, a <th>
 *   ma `aria-sort` (WCAG 4.1.2 i 1.3.1); wygląd bez zmian.
 */

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    filterVariant?: 'text' | 'range' | 'select'
  }
}

export type TableFilterSpec = {
  columnId: string
  /** „Wszystkie źródła” itd. */
  allLabel: string
  /** Etykiety wartości (np. `ksef_inbox` → „KSeF”). */
  labels?: Record<string, string>
}

type TransactionDatatableProps<T> = {
  data: T[]
  columns: ColumnDef<T>[]
  filters: TableFilterSpec[]
  searchId: string
  searchPlaceholder: string
  /** Tekst, w którym szuka pole wyszukiwania (bez rozróżniania wielkości liter). */
  searchText: (row: T) => string
  /** Przycisk obok „Pokaż” (Finora: „+ Add Transaction”). */
  action?: ReactNode
  /** Karty poniżej `lg`: wiersze bieżącej strony i wszystkie wiersze po filtrach. */
  renderCards?: (pageRows: Row<T>[], filteredRows: Row<T>[]) => ReactNode
  /** Brak wyników po filtrach (Finora: „No results.”). */
  emptyText?: string
  /** Brak danych w ogóle — nasz pusty stan zamiast „Brak wyników.” (plan §7.3). */
  emptyState?: ReactNode
  pageSize?: number
}

const PAGE_SIZES = [5, 10, 25, 50]

export function TransactionDatatable<T>({
  data,
  columns,
  filters,
  searchId,
  searchPlaceholder,
  searchText,
  action,
  renderCards,
  emptyText = 'Brak wyników.',
  emptyState,
  pageSize = 10
}: TransactionDatatableProps<T>) {
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState('')

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
      globalFilter,
      pagination
    },
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: (row, _columnId, filterValue) => {
      const search = String(filterValue).toLowerCase()

      return searchText(row.original).toLowerCase().includes(search)
    },
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

  const pageRows = table.getRowModel().rows
  const noData = data.length === 0 && emptyState !== undefined

  // Pełny arkusz (poprawka Bartosza 21.10.2026): korzeń to rosnąca kolumna,
  // a obszar listy (`border-b`) bierze resztę wysokości — paginacja stoi przy
  // dolnej krawędzi karty, pusty arkusz jest między ostatnim wierszem a nią.
  // Gdy rodzic nie jest rosnącą kolumną flex, `flex-1` nic nie zmienia.
  return (
    <div className='flex w-full flex-1 flex-col'>
      <div className='flex flex-1 flex-col border-b'>
        <div className='flex items-start gap-6 p-4 pt-0 max-lg:flex-col lg:justify-between'>
          <div className='flex items-center gap-4'>
            <div className='flex items-center gap-2'>
              <Label htmlFor={`${searchId}-rows`} className='text-muted-foreground text-base font-normal max-sm:sr-only'>
                Pokaż
              </Label>
              <Select
                items={PAGE_SIZES.map(s => ({
                  label: String(s),
                  value: String(s)
                }))}
                value={table.getState().pagination.pageSize.toString()}
                onValueChange={(value: string | null) => {
                  if (value) table.setPageSize(Number(value))
                }}
              >
                <SelectTrigger id={`${searchId}-rows`} className='w-fit whitespace-nowrap'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className='p-0.5' alignItemWithTrigger={false}>
                  <SelectGroup>
                    {PAGE_SIZES.map(size => (
                      <SelectItem key={size} value={size.toString()}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            {action}
          </div>
          <div className='flex w-full flex-1 flex-wrap items-center gap-4 lg:w-auto lg:justify-end'>
            <div className='w-full sm:max-w-xs'>
              <Label htmlFor={searchId} className='sr-only'>
                Szukaj
              </Label>
              <InputGroup>
                <InputGroupAddon>
                  <RiSearchLine />
                </InputGroupAddon>
                <InputGroupInput
                  id={searchId}
                  value={globalFilter}
                  onChange={e => setGlobalFilter(e.target.value)}
                  placeholder={searchPlaceholder}
                  type='text'
                />
              </InputGroup>
            </div>
            {filters.map(filter => {
              const column = table.getColumn(filter.columnId)

              return column ? (
                <Filter key={filter.columnId} column={column} labels={filter.labels} allLabel={filter.allLabel} />
              ) : null
            })}
          </div>
        </div>
        {noData ? (
          // Pusty stan raz, nie osobno w tabeli i w kartach: tekst stoi
          // w jednym węźle (e2e 04 szuka go `getByText` w trybie ścisłym).
          // W rosnącym obszarze listy stoi na środku, jak `Empty` Cyklicznych.
          <div className='flex flex-1 flex-col justify-center border-t'>{emptyState}</div>
        ) : (
          <>
            <div className='hidden lg:block'>
              <Table>
                <TableHeader>
                  {table.getHeaderGroups().map(headerGroup => (
                    <TableRow key={headerGroup.id} className='h-14 border-t'>
                      {headerGroup.headers.map(header => {
                        const canSort = !header.isPlaceholder && header.column.getCanSort()
                        const sorted = header.column.getIsSorted()

                        return (
                          <TableHead
                            key={header.id}
                            style={{ width: `${header.getSize()}px` }}
                            className='text-muted-foreground first:pl-4 last:px-4 last:text-center'
                            aria-sort={
                              canSort ? (sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none') : undefined
                            }
                          >
                            {header.isPlaceholder ? null : canSort ? (
                              // Finora: `<div onClick tabIndex>`; u nas przycisk (WCAG 4.1.2),
                              // stan sortowania ogłasza `aria-sort` na <th>.
                              <button
                                type='button'
                                className='flex h-full w-full cursor-pointer items-center justify-between gap-2 text-left select-none'
                                onClick={header.column.getToggleSortingHandler()}
                              >
                                {flexRender(header.column.columnDef.header, header.getContext())}
                                {{
                                  asc: <RiArrowUpSLine className='shrink-0 opacity-60' size={16} aria-hidden='true' />,
                                  desc: <RiArrowDownSLine className='shrink-0 opacity-60' size={16} aria-hidden='true' />
                                }[sorted as string] ?? null}
                              </button>
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
                  {pageRows.length ? (
                    pageRows.map(row => (
                      <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
                        {row.getVisibleCells().map(cell => (
                          <TableCell key={cell.id} className='h-14 first:pl-4'>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={columns.length} className='h-24 text-center'>
                        {emptyText}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            {renderCards ? (
              <div className='border-t lg:hidden'>
                {pageRows.length ? (
                  renderCards(pageRows, table.getFilteredRowModel().rows)
                ) : (
                  <p className='text-muted-foreground flex min-h-24 items-center justify-center p-4 text-center text-sm'>{emptyText}</p>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className='flex items-center justify-between gap-3 p-4 pb-0 max-sm:flex-col md:max-lg:flex-col'>
        <p className='text-muted-foreground text-sm whitespace-nowrap' aria-live='polite'>
          Pozycje{' '}
          <span>
            {table.getRowCount() === 0
              ? 0
              : table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1}
            –
            {Math.min(
              Math.max(
                table.getState().pagination.pageIndex * table.getState().pagination.pageSize +
                  table.getState().pagination.pageSize,
                0
              ),
              table.getRowCount()
            )}
          </span>{' '}
          z <span>{table.getRowCount().toString()}</span>
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

function Filter<T>({
  column,
  labels,
  allLabel
}: {
  column: Column<T, unknown>
  labels?: Record<string, string>
  allLabel: string
}) {
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

    return Array.from(new Set(flattenedValues)).sort((a, b) => String(a).localeCompare(String(b), 'pl'))
  }, [facetedUniqueValues, filterVariant])

  const labelFor = (value: string) => labels?.[value] ?? value

  if (filterVariant === 'select') {
    return (
      <div className='w-full sm:max-w-44'>
        <Label htmlFor={`${id}-select`} className='sr-only'>
          {columnHeader}
        </Label>
        <Select
          items={[
            { label: allLabel, value: 'all' },
            ...sortedUniqueValues.map(value => ({
              label: labelFor(String(value)),
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
          <SelectContent className='p-1' alignItemWithTrigger={false}>
            <SelectGroup>
              <SelectItem value='all'>{allLabel}</SelectItem>
              {sortedUniqueValues.map(value => (
                <SelectItem key={String(value)} value={String(value)}>
                  {labelFor(String(value))}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    )
  }

  return (
    <div className='w-full max-w-2xs'>
      <Label htmlFor={`${id}-input`} className='sr-only'>
        {columnHeader}
      </Label>
      <InputGroup>
        <InputGroupAddon>
          <RiSearchLine />
        </InputGroupAddon>
        <InputGroupInput
          id={`${id}-input`}
          value={(columnFilterValue ?? '') as string}
          onChange={e => column.setFilterValue(e.target.value)}
          placeholder={`Szukaj: ${columnHeader.toLowerCase()}`}
          type='text'
        />
      </InputGroup>
    </div>
  )
}
