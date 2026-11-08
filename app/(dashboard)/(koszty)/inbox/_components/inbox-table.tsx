'use client';

import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { RiCheckLine, RiEyeLine, RiInboxArchiveLine, RiTimeLine } from '@remixicon/react';

import { plDate } from '@/components/expenses/finora/labels';
import { TransactionDatatable } from '@/components/expenses/finora/transaction-datatable';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { companyInitials, shortenLegalForm } from '@/lib/format/legal-form';
import { formatPlMoney } from '@/lib/format/pl';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';

import { INBOX_STATUS_LABELS, type InboxRow, type InboxStatus } from './inbox-rows';

/**
 * Tabela Skrzynki KSeF (P9 ← Finora Transactions, ten sam komponent tabeli co
 * Wydatki). Kolumny: Data wystawienia · Sprzedawca (NIP) · Numer · Numer KSeF
 * · Brutto · Status (Nowa / Opisana) · Akcje. Kolumny „Termin płatności” nie
 * ma — termin faktur kosztowych to N7. Poniżej `lg` karty jak dotąd
 * (sprzedawca, NIP, kwota, data otrzymania z KSeF i numer KSeF), w oprawie
 * Finory. Lista jest sortowana po dacie przyjęcia w KSeF, więc ta data stoi
 * też w tabeli (druga linia komórki daty).
 *
 * Decyzja Bartosza 22.10.2026: zakup z historii KSeF (archiwum, bez kosztu)
 * ma w kolumnie „Status” plakietkę „Historia z KSeF” zamiast „—”.
 */

const STATUS_STYLES: Record<InboxStatus, string> = {
  new: 'bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400',
  reviewed: 'bg-green-600/10 text-green-700 dark:bg-green-400/10 dark:text-green-400',
};

/** Kwota w walucie faktury: „zł” dla PLN, kod waluty dla innych. */
export function inboxAmount(row: Pick<InboxRow, 'gross' | 'currency'>): string {
  return `${formatPlMoney(row.gross)} ${row.currency === 'PLN' ? 'zł' : row.currency}`;
}

/** Plakietka zakupu z historii KSeF — tylko gdy faktura nie ma wydatku. */
export const KSEF_HISTORY_BADGE = 'Historia z KSeF';
export const KSEF_HISTORY_BADGE_TITLE = 'Faktura z historii KSeF — nie dodaliśmy jej do kosztów';
const HISTORY_STYLE = 'bg-muted text-muted-foreground';

const isHistoryArchive = (row: Pick<InboxRow, 'fromKsefHistory' | 'expenseId'>) => row.fromKsefHistory && !row.expenseId;

const statusValue = (row: InboxRow) => row.status ?? (isHistoryArchive(row) ? 'history' : 'none');

/** Data przyjęcia w KSeF z godziną (Europe/Warsaw); brak → „—”, jak dotąd. */
export function inboxAcceptedAt(row: Pick<InboxRow, 'acceptedAt'>): string {
  return row.acceptedAt ? formatWarsawDateTime(row.acceptedAt) : '—';
}

function HistoryBadge() {
  return (
    <Badge className={HISTORY_STYLE} title={KSEF_HISTORY_BADGE_TITLE}>
      {KSEF_HISTORY_BADGE}
    </Badge>
  );
}

function StatusBadge({ status, history = false }: { status: InboxStatus | null; history?: boolean }) {
  if (!status) return history ? <HistoryBadge /> : <span className="text-muted-foreground">—</span>;
  return <Badge className={STATUS_STYLES[status]}>{INBOX_STATUS_LABELS[status]}</Badge>;
}

function RowAction({ row }: { row: InboxRow }) {
  if (!row.expenseId) {
    return (
      <span
        className="text-muted-foreground text-xs"
        title={row.fromKsefHistory ? KSEF_HISTORY_BADGE_TITLE : 'Wydatek z tej faktury jeszcze powstaje'}
      >
        —
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            href={`/expenses/${row.expenseId}`}
            className={buttonVariants({ variant: 'ghost', size: 'icon' })}
            aria-label={`Opisz wydatek z faktury ${row.number ?? row.ksefNumber ?? ''}`.trim()}
          />
        }
      >
        <RiEyeLine className="size-4.5" />
      </TooltipTrigger>
      <TooltipContent>
        <p>{row.status === 'new' ? 'Opisz wydatek' : 'Szczegóły wydatku'}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export const inboxColumns: ColumnDef<InboxRow>[] = [
  {
    header: 'Data wystawienia',
    id: 'issueDate',
    accessorFn: (row) => row.issueDate ?? '',
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span className="text-muted-foreground tabular-nums">{plDate(row.original.issueDate)}</span>
        <span className="text-muted-foreground text-xs tabular-nums" title="Data otrzymania z KSeF">
          Otrzymana {inboxAcceptedAt(row.original)}
        </span>
      </div>
    ),
    size: 150,
  },
  {
    header: 'Sprzedawca',
    id: 'seller',
    accessorFn: (row) => row.sellerName,
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <Avatar className="size-9 items-center justify-center">
          <AvatarFallback className="text-xs">{companyInitials(row.original.sellerName)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col">
          <span className="max-w-56 truncate font-medium" title={row.original.sellerName}>
            {shortenLegalForm(row.original.sellerName)}
          </span>
          <span className="text-muted-foreground font-mono">NIP {row.original.sellerNip}</span>
        </div>
      </div>
    ),
    size: 260,
  },
  {
    header: 'Numer',
    id: 'number',
    accessorFn: (row) => row.number ?? '',
    cell: ({ row }) => <span className="text-muted-foreground font-mono">{row.original.number ?? '—'}</span>,
    size: 150,
  },
  {
    header: 'Numer KSeF',
    id: 'ksefNumber',
    accessorFn: (row) => row.ksefNumber ?? '',
    cell: ({ row }) => (
      <span className="text-muted-foreground font-mono text-xs break-all">{row.original.ksefNumber ?? '—'}</span>
    ),
    size: 260,
  },
  {
    header: 'Brutto',
    id: 'gross',
    accessorFn: (row) => row.gross,
    cell: ({ row }) => <span className="font-medium tabular-nums">{inboxAmount(row.original)}</span>,
    size: 130,
  },
  {
    header: 'Status',
    id: 'status',
    accessorFn: statusValue,
    filterFn: 'equalsString',
    cell: ({ row }) => <StatusBadge status={row.original.status} history={isHistoryArchive(row.original)} />,
    size: 100,
    meta: {
      filterVariant: 'select',
    },
  },
  {
    id: 'actions',
    header: () => 'Akcje',
    cell: ({ row }) => (
      <div className="flex items-center justify-center">
        <RowAction row={row.original} />
      </div>
    ),
    size: 90,
    enableHiding: false,
    enableSorting: false,
  },
];

const FILTERS = [
  {
    columnId: 'status',
    allLabel: 'Wszystkie statusy',
    labels: { ...INBOX_STATUS_LABELS, none: 'Bez wydatku', history: KSEF_HISTORY_BADGE },
  },
];

/** Bez kolumn zależnych od wydatków — gdy ich odczyt padł (strona pokazuje komunikat). */
const COLUMNS_WITHOUT_STATUS = inboxColumns.filter((column) => column.id !== 'status' && column.id !== 'actions');

export function searchInboxText(row: InboxRow): string {
  return [row.sellerName, row.sellerNip, row.number, row.ksefNumber].filter(Boolean).join(' ');
}

/** Pusty stan skrzynki — tekst pilnowany przez `e2e/tests/04-empty-states.spec.ts`. */
export function InboxEmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <Avatar className="size-12 after:border-0">
        <AvatarFallback className="bg-primary/10 text-primary [&>svg]:size-6">
          <RiInboxArchiveLine />
        </AvatarFallback>
      </Avatar>
      <div className="space-y-1">
        <h3 className="text-foreground text-base font-semibold">Brak faktur przychodzących</h3>
        <p className="text-muted-foreground mx-auto max-w-md text-sm">
          Otrzymane faktury pojawią się tutaj automatycznie po synchronizacji z KSeF
        </p>
      </div>
    </div>
  );
}

function InboxCard({ row, statusUnavailable }: { row: InboxRow; statusUnavailable: boolean }) {
  const content = (
    <>
      <Avatar className="after:border-none">
        <AvatarFallback className={row.status ? STATUS_STYLES[row.status] : undefined}>
          {row.status === 'reviewed' ? <RiCheckLine className="size-4" /> : <RiTimeLine className="size-4" />}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-foreground truncate text-sm font-medium" title={row.sellerName}>
              {shortenLegalForm(row.sellerName)}
            </p>
            <p className="text-muted-foreground truncate font-mono text-xs">NIP {row.sellerNip}</p>
          </div>
          <p className="text-foreground shrink-0 text-sm font-medium tabular-nums">{inboxAmount(row)}</p>
        </div>
        <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="tabular-nums" title="Data otrzymania z KSeF">{inboxAcceptedAt(row)}</span>
          <span className="tabular-nums">wyst. {plDate(row.issueDate)}</span>
          {row.number ? <span className="font-mono">{row.number}</span> : null}
          {statusUnavailable ? null : <StatusBadge status={row.status} history={isHistoryArchive(row)} />}
        </div>
        <p className="text-muted-foreground mt-1 truncate font-mono text-xs">{row.ksefNumber ?? '—'}</p>
      </div>
    </>
  );
  return row.expenseId ? (
    <Link href={`/expenses/${row.expenseId}`} className="hover:bg-muted/50 flex items-start gap-3 px-4 py-3 transition-colors">
      {content}
    </Link>
  ) : (
    <div className="flex items-start gap-3 px-4 py-3">{content}</div>
  );
}

export function InboxTable({
  rows,
  statusUnavailable = false,
}: {
  rows: InboxRow[];
  /** Odczyt wydatków powiązanych padł: kolumny „Status” i „Akcje” są ukryte, a nie „—”. */
  statusUnavailable?: boolean;
}) {
  return (
    <TransactionDatatable
      data={rows}
      columns={statusUnavailable ? COLUMNS_WITHOUT_STATUS : inboxColumns}
      filters={statusUnavailable ? [] : FILTERS}
      searchId="inbox-search"
      searchPlaceholder="Szukaj: sprzedawca, NIP, numer…"
      searchText={searchInboxText}
      emptyState={<InboxEmptyState />}
      renderCards={(pageRows) => (
        <div className="divide-y">
          {pageRows.map((row) => (
            <InboxCard key={row.id} row={row.original} statusUnavailable={statusUnavailable} />
          ))}
        </div>
      )}
    />
  );
}
