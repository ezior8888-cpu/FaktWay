'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef, ColumnFiltersState, OnChangeFn, PaginationState } from '@tanstack/react-table';
import {
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { RiRepeatLine } from '@remixicon/react';

import {
  ColumnSelectFilter,
  DataTablePagination,
  DataTableView,
  FinoraListCard,
  PageSizeSelect,
  TableSearch,
} from '@/components/lists/finora-data-table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { companyInitials, shortenLegalForm } from '@/lib/format/legal-form';
import { formatPlMoney } from '@/lib/format/pl';
import type { RecurringInvoiceListItem, RecurringTemplateCandidate } from '@/lib/invoices/recurring/queries';
import { recurringPeriodLabel } from '@/lib/invoices/recurring/schedule';
import {
  RECURRING_FREQUENCY_LABELS,
  RECURRING_STATUS_LABELS,
  type RecurringStatus,
} from '@/types/recurring-invoice';

import { RecurringInvoiceSheet } from './recurring-invoice-sheet';
import { RecurringRowActions } from './recurring-row-actions';
import { RecurringStatusBadge } from './recurring-status-badge';

const money = (n: number | null) => (n === null ? '—' : `${formatPlMoney(n)} zł`);

/** Kolejność sortowania statusów: najpierw to, co czeka na ruch klienta. */
const STATUS_ORDER: Record<RecurringStatus, number> = { due: 0, active: 1, paused: 2 };

function ContractorCell({ item }: { item: RecurringInvoiceListItem }) {
  return (
    <div className='flex min-w-0 items-center gap-2'>
      <Avatar className='size-9'>
        <AvatarFallback className='bg-primary/10 text-accent-foreground text-xs'>
          {companyInitials(item.contractorName)}
        </AvatarFallback>
      </Avatar>
      {/* `max-w-*` obok `truncate`: w tabeli o układzie automatycznym sam `truncate` niczego nie ucina
          (komórka rośnie do pełnej długości tekstu). Wzór: contractors-table.tsx. */}
      <span className='max-w-56 truncate font-medium' title={item.contractorName ?? undefined}>
        {item.contractorName ? shortenLegalForm(item.contractorName) : '—'}
      </span>
    </div>
  );
}

function NextRunCell({ item }: { item: RecurringInvoiceListItem }) {
  return (
    <div className='flex flex-col'>
      <span className='text-muted-foreground tabular-nums'>{formatIsoDatePl(item.next_run_date)}</span>
      <span className='text-muted-foreground text-xs'>za {recurringPeriodLabel(item.period)}</span>
    </div>
  );
}

/**
 * Kolumny P6 wg `recurring-invoice-table/data-table.tsx` Finory: ID → Szablon,
 * Client → Kontrahent, Frequency, Next Run, Amount, Status, Actions.
 * Eksport dla testu.
 */
export function recurringColumns(onEdit: (item: RecurringInvoiceListItem) => void): ColumnDef<RecurringInvoiceListItem>[] {
  return [
    {
      header: 'Szablon',
      id: 'name',
      accessorFn: (row) => row.name,
      cell: ({ row }) => (
        <div className='flex min-w-0 flex-col'>
          <span className='max-w-56 truncate font-medium' title={row.original.name}>
            {row.original.name}
          </span>
          <span className='text-muted-foreground max-w-56 truncate font-mono text-xs'>
            {row.original.templateNumber ?? '(bez numeru)'}
          </span>
        </div>
      ),
      size: 220,
    },
    {
      header: 'Kontrahent',
      id: 'contractor',
      accessorFn: (row) => row.contractorName ?? '',
      cell: ({ row }) => <ContractorCell item={row.original} />,
      size: 240,
    },
    {
      header: 'Częstotliwość',
      id: 'frequency',
      accessorFn: (row) => RECURRING_FREQUENCY_LABELS[row.frequency],
      cell: ({ row }) => (
        <div className='flex flex-col'>
          <span>{RECURRING_FREQUENCY_LABELS[row.original.frequency]}</span>
          <span className='text-muted-foreground text-xs'>w dniu {row.original.day_of_month}.</span>
        </div>
      ),
    },
    {
      header: 'Następne wystawienie',
      id: 'nextRun',
      accessorFn: (row) => row.next_run_date,
      cell: ({ row }) => <NextRunCell item={row.original} />,
    },
    {
      header: 'Kwota brutto wzoru',
      id: 'amount',
      accessorFn: (row) => row.templateGrossTotal ?? undefined,
      sortUndefined: 'last',
      cell: ({ row }) => <span className='tabular-nums'>{money(row.original.templateGrossTotal)}</span>,
    },
    {
      header: 'Status',
      id: 'status',
      accessorFn: (row) => row.status,
      sortingFn: (a, b) => STATUS_ORDER[a.original.status] - STATUS_ORDER[b.original.status],
      filterFn: 'equalsString',
      cell: ({ row }) => <RecurringStatusBadge status={row.original.status} />,
      size: 150,
    },
    {
      id: 'actions',
      header: () => 'Akcje',
      cell: ({ row }) => <RecurringRowActions item={row.original} onEdit={onEdit} />,
      size: 150,
      enableHiding: false,
      enableSorting: false,
    },
  ];
}

export interface RecurringInvoicesViewProps {
  items: RecurringInvoiceListItem[];
  /** Dziś w Europe/Warsaw (RRRR-MM-DD) — podgląd „Następne wystawienie” w arkuszu. */
  today: string;
  candidates: RecurringTemplateCandidate[];
  candidatesError?: string | null;
  /** Wzór z `?wzor=<id>` — arkusz „Nowa faktura cykliczna” otwiera się z nim wybranym. */
  initialTemplate?: RecurringTemplateCandidate | null;
  /** Adres miał `?wzor=`: otwórz arkusz od razu (także gdy wzoru nie da się wybrać). */
  openSheetOnLoad?: boolean;
  /** Dlaczego `?wzor=` nie dało wzoru (komunikat nad tabelą). */
  templateNotice?: string | null;
}

/**
 * Tabela faktur cyklicznych `/invoices/recurring` w układzie
 * `invoices-recurring/index.tsx` Finory: JEDNA karta z paskiem narzędzi
 * („Pokaż N”, „+ Nowa faktura cykliczna”, wyszukiwarka, filtr statusu),
 * tabelą od `lg` (niżej karty — plan §7.2) i stopką z paginacją.
 * Dane z serwera (`items`); wstrzymanie, usunięcie i zapis odświeżają stronę.
 *
 * Poprawka 21.10.2026: zakładka „Cykliczne” ekranu Faktur — pierwszy rząd karty
 * to zakładki, a karta (także pusta) sięga do stopki pustym arkuszem.
 */
export function RecurringInvoicesView({
  items,
  today,
  candidates,
  candidatesError = null,
  initialTemplate = null,
  openSheetOnLoad = false,
  templateNotice = null,
}: RecurringInvoicesViewProps) {
  const router = useRouter();
  const [sheetOpen, setSheetOpen] = useState(openSheetOnLoad);
  const [editing, setEditing] = useState<RecurringInvoiceListItem | null>(null);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });

  const openCreate = () => {
    setEditing(null);
    setSheetOpen(true);
  };
  const openEdit = (item: RecurringInvoiceListItem) => {
    setEditing(item);
    setSheetOpen(true);
  };
  const handleSheetOpenChange = (open: boolean) => {
    setSheetOpen(open);
    // Po zamknięciu arkusza otwartego z adresu usuwamy `?wzor=`, żeby odświeżenie go nie otwierało znowu.
    if (!open && openSheetOnLoad) router.replace('/invoices/recurring');
  };

  // Po `router.refresh()` (wstrzymaj / wznów / usuń / edytuj) serwer przysyła nową tablicę `items`.
  // Domyślnie tanstack zeruje wtedy stronę (`autoResetPageIndex`), więc klient wracał na stronę 1.
  // Wyłączamy to i zerujemy ręcznie tylko tam, gdzie zmienia się zestaw wierszy z woli klienta.
  const resetPage = () => setPagination((p) => (p.pageIndex === 0 ? p : { ...p, pageIndex: 0 }));
  const changeSearch: OnChangeFn<string> = (value) => {
    setGlobalFilter(value);
    resetPage();
  };
  const changeColumnFilters: OnChangeFn<ColumnFiltersState> = (updater) => {
    setColumnFilters(updater);
    resetPage();
  };

  const columns = useMemo(
    () =>
      recurringColumns((item) => {
        setEditing(item);
            setSheetOpen(true);
      }),
    [],
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- tanstack zwraca funkcje, których React Compiler nie zapamiętuje (jak w Finorze)
  const table = useReactTable({
    data: items,
    columns,
    getRowId: (row) => row.id,
    state: { columnFilters, globalFilter, pagination },
    autoResetPageIndex: false,
    onColumnFiltersChange: changeColumnFilters,
    onGlobalFilterChange: changeSearch,
    globalFilterFn: (row, _columnId, filterValue) => {
      const search = String(filterValue).toLowerCase();
      return (
        row.original.name.toLowerCase().includes(search) ||
        (row.original.contractorName ?? '').toLowerCase().includes(search) ||
        (row.original.templateNumber ?? '').toLowerCase().includes(search)
      );
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    enableSortingRemoval: false,
    getPaginationRowModel: getPaginationRowModel(),
    onPaginationChange: setPagination,
  });

  // Usunięcie jedynej pozycji ostatniej strony: przytnij indeks do ostatniej istniejącej strony,
  // zamiast pokazywać pustą tabelę. Ustawienie stanu w trakcie renderu, pod warunkiem (wzorzec
  // „dostosuj stan do zmiany danych” z dokumentacji Reacta), więc bez migotania pustej strony.
  const lastPageIndex = Math.max(0, table.getPageCount() - 1);
  if (pagination.pageIndex > lastPageIndex) setPagination((p) => ({ ...p, pageIndex: lastPageIndex }));

  // Zawartość karty sekcji Faktur: kartę i rząd zakładek daje
  // `(faktury)/layout.tsx` (poprawka Bartosza 25.10.2026 — przełączenie
  // zakładki zmienia tylko tabelę), więc tu bez własnej karty.
  return (
    <div className='flex flex-1 flex-col'>
      {templateNotice ? (
        <div className='px-4 pt-2'>
          <Alert>
            <AlertTitle>Nie wybraliśmy faktury-wzoru</AlertTitle>
            <AlertDescription>{templateNotice}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      {items.length === 0 ? (
        // Pusty stan w oprawie `Empty` Finory (jak „Invoice Not Found”), z przyciskiem jak w pasku narzędzi.
        <>
          <Empty className='py-12'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <RiRepeatLine />
              </EmptyMedia>
              <EmptyTitle>Brak faktur cyklicznych</EmptyTitle>
              <EmptyDescription>
                Wystawiasz co miesiąc tę samą fakturę? Ustaw ją jako cykliczną — w wybranym dniu FaktWay
                przypomni o wystawieniu i wypełni formularz. Fakturę zawsze sprawdzasz i wysyłasz sam.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={openCreate}>+ Nowa faktura cykliczna</Button>
            </EmptyContent>
          </Empty>
        </>
      ) : (
        <>
          <div className='flex w-full flex-1 flex-col pt-2'>
            <div className='flex-1 border-b'>
              <div className='flex gap-6 p-4 pt-0 max-lg:flex-col lg:items-center lg:justify-between'>
                <div className='flex flex-wrap items-center gap-4'>
                  <PageSizeSelect table={table} />
                  <Button onClick={openCreate}>+ Nowa faktura cykliczna</Button>
                </div>
                <div className='flex flex-1 flex-wrap items-center gap-4 lg:justify-end'>
                  <TableSearch
                    value={globalFilter}
                    onChange={changeSearch}
                    placeholder='Szukaj po nazwie lub kontrahencie'
                    className='max-w-2xs sm:max-w-2xs'
                  />
                  <ColumnSelectFilter
                    column={table.getColumn('status')!}
                    labels={RECURRING_STATUS_LABELS}
                    allLabel='Wszystkie'
                    label='Status faktury cyklicznej'
                  />
                </div>
              </div>
              <DataTableView
                table={table}
                renderCard={(row) => {
                  const item = row.original;
                  return (
                    <FinoraListCard
                      leading={
                        <Avatar className='size-9'>
                          <AvatarFallback className='bg-primary/10 text-accent-foreground text-xs'>
                            {companyInitials(item.contractorName)}
                          </AvatarFallback>
                        </Avatar>
                      }
                      title={<span title={item.name}>{item.name}</span>}
                      subtitle={item.templateNumber ?? undefined}
                      amount={money(item.templateGrossTotal)}
                      amountNote={RECURRING_FREQUENCY_LABELS[item.frequency]}
                      meta={
                        <>
                          <span className='truncate'>
                            {item.contractorName ? shortenLegalForm(item.contractorName) : '—'}
                          </span>
                          <span className='tabular-nums'>
                            Następne wystawienie {formatIsoDatePl(item.next_run_date)} (za{' '}
                            {recurringPeriodLabel(item.period)})
                          </span>
                          <RecurringStatusBadge status={item.status} />
                        </>
                      }
                      actions={<RecurringRowActions item={item} onEdit={openEdit} layout='card' />}
                    />
                  );
                }}
              />
            </div>
            <DataTablePagination table={table} />
          </div>
        </>
      )}

      <RecurringInvoiceSheet
        open={sheetOpen}
        onOpenChange={handleSheetOpenChange}
        today={today}
        candidates={candidates}
        candidatesError={candidatesError}
        initialTemplate={editing ? null : initialTemplate}
        editing={editing}
        templateNotice={templateNotice}
      />
    </div>
  );
}
