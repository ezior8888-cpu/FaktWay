'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { ColumnDef, ColumnFiltersState, PaginationState } from '@tanstack/react-table';
import {
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { RiSearchLine } from '@remixicon/react';

import { ContractorRowActions } from '@/components/contractors/contractor-row-actions';
import {
  ColumnSelectFilter,
  DataTablePagination,
  DataTableView,
  FinoraListCard,
  PageSizeSelect,
} from '@/components/lists/finora-data-table';
import { ContractorReminderToggle } from '@/components/reminders/contractor-reminder-toggle';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { BulkValidateButton } from '@/components/validation/bulk-validate-button';
import { VatStatusBadge } from '@/components/validation/vat-status-badge';
import { companyInitials, shortenLegalForm } from '@/lib/format/legal-form';
import { formatPlInt, formatPlMoney } from '@/lib/format/pl';
import { plural } from '@/lib/i18n/plural';

type VatStatus = 'active' | 'exempt' | 'inactive' | 'unknown' | 'pending';

export interface ContractorTableRow {
  id: string;
  nip: string | null;
  name: string | null;
  address: { addressLine1?: string; addressLine2?: string } | null;
  email: string | null;
  vat_status: VatStatus | null;
  validation_warning: string | null;
  reminder_excluded: boolean | null;
  /**
   * Należności i faktury po terminie kontrahenta (§2.4 pkt 11, po NIP).
   * `null`, gdy należności nie dało się policzyć — kolumny pokazują „—”.
   */
  receivables: { outstanding: number; overdueCount: number } | null;
}

const VAT_LABELS: Record<VatStatus, string> = {
  active: 'Czynny VAT',
  exempt: 'Zwolniony VAT',
  inactive: 'Wykreślony',
  unknown: 'Niezweryfikowany',
  pending: 'Sprawdzanie',
};

const money = (n: number) => `${formatPlMoney(n)} zł`;

/** Nazwa jak w wierszu (skrócona forma prawna); bez nazwy — NIP. */
function displayName(row: Pick<ContractorTableRow, 'name' | 'nip'>): string {
  return row.name ? shortenLegalForm(row.name) : row.nip ? `NIP ${row.nip}` : 'kontrahenta';
}

function overdueBadge(count: number) {
  return (
    <Badge variant="destructive">
      {formatPlInt(count)} {plural(count, ['faktura', 'faktury', 'faktur'])}
    </Badge>
  );
}

function OutstandingCell({ row }: { row: ContractorTableRow }) {
  if (!row.receivables) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={row.receivables.outstanding > 0 ? 'tabular-nums' : 'text-muted-foreground tabular-nums'}>
      {money(row.receivables.outstanding)}
    </span>
  );
}

function OverdueCell({ row }: { row: ContractorTableRow }) {
  if (!row.receivables) return <span className="text-muted-foreground">—</span>;
  return row.receivables.overdueCount > 0 ? overdueBadge(row.receivables.overdueCount) : <span className="text-muted-foreground">0</span>;
}

/**
 * Kolumny tabeli (stałe — bez zależności od stanu komponentu). Eksport dla
 * testu filtra „Status VAT”.
 */
export const CONTRACTOR_COLUMNS: ColumnDef<ContractorTableRow>[] = [
  {
    header: 'Nazwa',
    id: 'name',
    accessorFn: (row) => row.name ?? '',
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <Avatar className="size-9">
          <AvatarFallback className="bg-primary/10 text-accent-foreground text-xs">
            {companyInitials(row.original.name)}
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col">
          <span className="max-w-64 truncate font-medium" title={row.original.name ?? undefined}>
            {row.original.name ? shortenLegalForm(row.original.name) : '—'}
          </span>
          <span className="text-muted-foreground max-w-64 truncate">
            {row.original.address?.addressLine2 || row.original.email || '—'}
          </span>
        </div>
      </div>
    ),
    size: 300,
  },
  {
    header: 'NIP',
    accessorKey: 'nip',
    cell: ({ row }) => <span className="text-muted-foreground font-mono">{row.original.nip ?? '—'}</span>,
    size: 130,
  },
  {
    header: 'Status VAT',
    id: 'vat',
    accessorFn: (row) => row.vat_status ?? 'unknown',
    // Dokładne dopasowanie jak w Finorze: domyślny includesString dla 'active' łapał też 'inactive'.
    filterFn: 'equalsString',
    cell: ({ row }) => (
      <VatStatusBadge status={row.original.vat_status ?? 'unknown'} warning={row.original.validation_warning} />
    ),
    size: 150,
  },
  {
    header: 'Należności',
    id: 'outstanding',
    accessorFn: (row) => row.receivables?.outstanding ?? -1,
    cell: ({ row }) => <OutstandingCell row={row.original} />,
  },
  {
    header: 'Po terminie',
    id: 'overdue',
    accessorFn: (row) => row.receivables?.overdueCount ?? -1,
    cell: ({ row }) => <OverdueCell row={row.original} />,
  },
  {
    header: 'Przypomnienia',
    id: 'reminders',
    enableSorting: false,
    cell: ({ row }) => (
      <ContractorReminderToggle
        contractorId={row.original.id}
        contractorName={displayName(row.original)}
        excluded={row.original.reminder_excluded ?? false}
      />
    ),
    size: 120,
  },
  {
    id: 'actions',
    header: () => 'Akcje',
    enableSorting: false,
    cell: ({ row }) => <ContractorRowActions contractor={row.original} />,
    size: 110,
  },
];

/**
 * Tabela kontrahentów w układzie data-table Finory (Invoice List): „Pokaż N”,
 * „Sprawdź wszystkich”, wyszukiwarka i filtr statusu VAT; karty poniżej `lg`.
 *
 * Wyszukiwarka to dalej formularz GET szukający w BAZIE po nazwie i NIP
 * (F-011), nie filtr załadowanej strony — tak jak przed przeniesieniem.
 * Filtr „Status VAT” i „Pokaż N” działają na załadowanej liście (≤ 200).
 */
export function ContractorsTable({
  contractors,
  q,
  emptyText,
  note,
}: {
  contractors: ContractorTableRow[];
  q: string;
  emptyText: string;
  note?: string;
}) {
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });


  // eslint-disable-next-line react-hooks/incompatible-library -- tanstack zwraca funkcje, których React Compiler nie zapamiętuje (jak w Finorze)
  const table = useReactTable({
    data: contractors,
    columns: CONTRACTOR_COLUMNS,
    state: { columnFilters, pagination },
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    enableSortingRemoval: false,
    getPaginationRowModel: getPaginationRowModel(),
    onPaginationChange: setPagination,
  });

  // Pełny arkusz (poprawka Bartosza 21.10.2026): obszar tabeli rośnie do dołu
  // karty, nota i paginacja stoją przy jej dolnej krawędzi — jak listy Faktur.
  return (
    <div className="flex w-full flex-1 flex-col">
      <div className="flex-1 border-b">
        <div className="flex gap-6 p-4 pt-0 max-lg:flex-col lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <PageSizeSelect table={table} />
            <BulkValidateButton />
          </div>
          <div className="flex flex-1 flex-wrap items-center gap-4 lg:justify-end">
            <form method="get" action="/contractors" className="flex w-full items-center gap-2 sm:max-w-sm" role="search">
              <InputGroup>
                <InputGroupAddon>
                  <RiSearchLine aria-hidden />
                </InputGroupAddon>
                <InputGroupInput
                  name="q"
                  type="search"
                  defaultValue={q}
                  placeholder="Szukaj po nazwie lub NIP"
                  aria-label="Szukaj po nazwie lub NIP"
                />
              </InputGroup>
              {q ? (
                <Link href="/contractors" className={buttonVariants({ variant: 'outline' })}>
                  Wyczyść
                </Link>
              ) : null}
            </form>
            <ColumnSelectFilter
              column={table.getColumn('vat')!}
              labels={VAT_LABELS}
              allLabel="Wszystkie statusy VAT"
              label="Status VAT"
            />
          </div>
        </div>
        <DataTableView
          table={table}
          emptyText={emptyText}
          renderCard={(row) => {
            const contractor = row.original;
            return (
              <FinoraListCard
                leading={
                  <Avatar className="size-9">
                    <AvatarFallback className="bg-primary/10 text-accent-foreground text-xs">
                      {companyInitials(contractor.name)}
                    </AvatarFallback>
                  </Avatar>
                }
                title={contractor.name ? shortenLegalForm(contractor.name) : '—'}
                subtitle={contractor.nip ? `NIP ${contractor.nip}` : undefined}
                amount={contractor.receivables ? money(contractor.receivables.outstanding) : '—'}
                amountNote={contractor.receivables && contractor.receivables.overdueCount > 0
                  ? `${formatPlInt(contractor.receivables.overdueCount)} po terminie`
                  : 'należności'}
                meta={<VatStatusBadge status={contractor.vat_status ?? 'unknown'} warning={contractor.validation_warning} />}
                actions={
                  <>
                    {/* Nazwę przełącznika daje aria-label z kontrahentem — napis tylko dla oka. */}
                    <span className="text-muted-foreground text-xs" aria-hidden>Przypomnienia</span>
                    <ContractorReminderToggle
                      contractorId={contractor.id}
                      contractorName={displayName(contractor)}
                      excluded={contractor.reminder_excluded ?? false}
                    />
                    <div className="ml-auto">
                      <ContractorRowActions contractor={contractor} />
                    </div>
                  </>
                }
              />
            );
          }}
        />
      </div>
      {note ? <p className="text-muted-foreground px-4 pt-4 text-xs">{note}</p> : null}
      <DataTablePagination table={table} />
    </div>
  );
}
