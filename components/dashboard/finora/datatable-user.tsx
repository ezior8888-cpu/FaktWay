'use client'

import { useId, useMemo, useState } from 'react'

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
import {
  RiArrowDownSLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiArrowUpSLine,
  RiBrushLine,
  RiDeleteBinLine,
  RiEdit2Line,
  RiEyeLine,
  RiMore2Line,
  RiPencilRulerLine,
  RiUserLine,
  RiVipCrownLine
} from '@remixicon/react'

// Component Imports
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// hooks imports
import { usePagination } from './use-pagination'

// Utils imports
import { cn } from '@/lib/utils'

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    filterVariant?: 'text' | 'range' | 'select'
  }
}

export type Item = {
  id: string
  avatar: string
  fallback: string
  user: string
  email: string
  role: 'admin' | 'author' | 'editor' | 'maintainer' | 'subscriber'
  plan: 'basic' | 'company' | 'enterprise' | 'team'
  billing: 'auto-debit' | 'manual-cash' | 'manual-paypal'
  status: 'active' | 'inactive' | 'pending'
}

/** Polskie etykiety wartości z danych przykładowych (komórki i filtry). */
const LABELS: Record<string, string> = {
  admin: 'Administrator',
  author: 'Autor',
  editor: 'Redaktor',
  maintainer: 'Opiekun',
  subscriber: 'Subskrybent',
  basic: 'Podstawowy',
  company: 'Firma',
  enterprise: 'Korporacja',
  team: 'Zespół',
  active: 'Aktywny',
  inactive: 'Nieaktywny',
  pending: 'Oczekujący'
}

const label = (value: unknown) => LABELS[String(value)] ?? String(value)

const columns: ColumnDef<Item>[] = [
  {
    id: 'select',
    header: ({ table }) => (
      <Checkbox
        checked={table.getIsAllPageRowsSelected()}
        indeterminate={table.getIsSomePageRowsSelected()}
        onCheckedChange={value => table.toggleAllRowsSelected(!!value)}
        aria-label='Zaznacz wszystkie'
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={value => row.toggleSelected(!!value)}
        aria-label='Zaznacz wiersz'
      />
    ),
    size: 50
  },
  {
    header: 'Użytkownik',
    accessorKey: 'user',
    cell: ({ row }) => (
      <div className='flex items-center gap-2'>
        <Avatar className='size-9'>
          {row.original.avatar ? <AvatarImage src={row.original.avatar} alt={row.getValue('user')} /> : null}
          <AvatarFallback className='text-xs'>{row.original.fallback}</AvatarFallback>
        </Avatar>
        <div className='flex flex-col'>
          <span className='font-medium'>{row.getValue('user')}</span>
          <span className='text-muted-foreground'>{row.original.email}</span>
        </div>
      </div>
    ),
    size: 360
  },
  {
    header: 'Rola',
    accessorKey: 'role',
    cell: ({ row }) => {
      const role = row.getValue('role') as string

      const roles = {
        admin: <RiUserLine className='size-4 text-green-600 dark:text-green-400' />,
        author: <RiEdit2Line className='text-chart-1 size-4' />,
        editor: <RiBrushLine className='text-chart-2 size-4' />,
        maintainer: <RiPencilRulerLine className='text-chart-3 size-4' />,
        subscriber: <RiVipCrownLine className='text-chart-5 size-4' />
      }[role]

      return (
        <div className='flex items-center gap-2'>
          {roles}
          <span>{label(role)}</span>
        </div>
      )
    }
  },
  {
    header: 'Plan',
    accessorKey: 'plan',
    cell: ({ row }) => <span className='text-muted-foreground'>{label(row.getValue('plan'))}</span>
  },
  {
    header: 'Płatność',
    accessorKey: 'billing',
    cell: ({ row }) => (
      <span className='text-muted-foreground'>
        {row.getValue('billing') === 'auto-debit'
          ? 'Polecenie zapłaty'
          : row.getValue('billing') === 'manual-cash'
            ? 'Ręcznie – gotówka'
            : 'Ręcznie – PayPal'}
      </span>
    )
  },
  {
    header: 'Status',
    accessorKey: 'status',
    filterFn: 'equalsString',
    cell: ({ row }) => {
      const status = row.getValue('status') as string

      const styles = {
        active:
          'bg-green-600/10 text-green-600 focus-visible:ring-green-600/20 dark:bg-green-400/10 dark:text-green-400 dark:focus-visible:ring-green-400/40 [a&]:hover:bg-green-600/5 dark:[a&]:hover:bg-green-400/5',
        inactive:
          'bg-destructive/10 [a&]:hover:bg-destructive/5 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 text-destructive',
        pending:
          'bg-amber-600/10 text-amber-600 focus-visible:ring-amber-600/20 dark:bg-amber-400/10 dark:text-amber-400 dark:focus-visible:ring-amber-400/40 [a&]:hover:bg-amber-600/5 dark:[a&]:hover:bg-amber-400/5'
      }[status]

      return (
        <Badge className={cn('h-auto border-none focus-visible:outline-none', styles)}>
          {label(row.getValue('status'))}
        </Badge>
      )
    }
  },
  {
    id: 'actions',
    header: () => 'Akcje',
    cell: () => (
      <div className='flex items-center gap-1'>
        <Tooltip>
          <TooltipTrigger render={<Button variant='ghost' size='icon' aria-label='Usuń' />}>
            <RiDeleteBinLine className='size-4.5' />
          </TooltipTrigger>
          <TooltipContent>
            <p>Usuń</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant='ghost' size='icon' aria-label='Podgląd' />}>
            <RiEyeLine className='size-4.5' />
          </TooltipTrigger>
          <TooltipContent>
            <p>Podgląd</p>
          </TooltipContent>
        </Tooltip>
        <RowActions />
      </div>
    ),
    enableHiding: false
  }
]

const UserDatatable = ({ data }: { data: Item[] }) => {
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
          <div className='grid grid-cols-1 gap-6 max-md:*:last:col-span-full sm:grid-cols-2 md:grid-cols-3'>
            <Filter column={table.getColumn('role')!} />
            <Filter column={table.getColumn('plan')!} />
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
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map(row => (
                <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
                  {row.getVisibleCells().map(cell => (
                    <TableCell key={cell.id} className='h-14 first:w-12.5 first:pl-4 last:w-29 last:px-4'>
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

      <div className='flex items-center justify-between gap-3 px-6 py-4 max-sm:flex-col md:max-lg:flex-col'>
        <p className='text-muted-foreground text-sm whitespace-nowrap' aria-live='polite'>
          Pozycje{' '}
          <span>
            {table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1}–
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

export default UserDatatable

function Filter({ column }: { column: Column<Item, unknown> }) {
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
      <Label htmlFor={`${id}-select`}>{columnHeader}</Label>
      <Select
        items={[
          { label: 'Wszystkie', value: 'all' },
          ...sortedUniqueValues.map(value => ({
            label: label(value),
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
                {label(value)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

function RowActions() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size='icon' variant='ghost' aria-label='Więcej akcji' />}>
        <RiMore2Line className='size-4.5' aria-hidden='true' />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuItem>
            <span>Edytuj</span>
          </DropdownMenuItem>
          <DropdownMenuItem>
            <span>Duplikuj</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
