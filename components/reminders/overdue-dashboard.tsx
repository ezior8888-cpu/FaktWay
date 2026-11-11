'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useOptimistic, useState, useTransition } from 'react';
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
import {
  RiCheckboxCircleLine,
  RiCheckLine,
  RiCloseLine,
  RiErrorWarningLine,
  RiLoader4Line,
  RiMailSendLine,
  RiPauseLine,
  RiPlayLine,
  RiQuestionLine,
  RiSendPlaneLine,
  RiSettings3Line,
  RiTimeLine,
} from '@remixicon/react';
import { toast } from 'sonner';

import { ReminderConsentDialog } from './reminder-consent-dialog';
import { toggleInvoiceRemindersAction } from '@/app/actions/reminders';
import { PanelStats } from '@/components/lists/panel-stats';
import {
  MarkPaidButton,
  stableOptimisticReducer,
  useInvoicePayment,
  type PayableInvoice,
} from '@/components/invoices/use-invoice-payment';
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
import { buttonVariants, Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RECEIVABLES_NOTE } from '@/lib/dashboard/receivables-note';
import { formatIsoDatePl, formatTimestampDatePl } from '@/lib/format/iso-date';
import { companyInitials, shortenLegalForm } from '@/lib/format/legal-form';
import { formatPlInt, formatPlMoney } from '@/lib/format/pl';
import { plural } from '@/lib/i18n/plural';
import type { LatestReminderState, ReminderStatus } from '@/lib/overdue/reminder-overview';
import { cn } from '@/lib/utils';

export interface OverdueInvoice {
  id: string;
  internal_number: string;
  payment_due_date: string;
  gross_total: number;
  amount_due: number;
  days_overdue: number;
  buyer_name: string;
  buyer_nip: string | null;
  buyer_email: string | null;
  reminders_paused: boolean;
  reminders_sent_count: number;
  reminder_status: 'none' | 'pending' | 'review' | 'unavailable';
  /** Ostatni wpis `payment_reminders` (kolumny „Przypomnienie” i „Status”). */
  latest_reminder: LatestReminderState;
}

interface Props {
  overdueInvoices: OverdueInvoice[];
  stats: {
    totalCount: number;
    totalAmount: number;
    avgDaysOverdue: number;
    /** Pokazane faktury z `reminders_paused = true`. */
    pausedCount: number;
    /** `null`, gdy odczytu nie da się potwierdzić — kafel pokazuje „—”, nie „0”. */
    sentThisMonth: number | null;
  };
  /**
   * Lista mogła się nie zmieścić w limicie strony (100 pozycji) — wtedy kafel
   * „Faktur po terminie” mówi, że to pierwsze z nich. Bez flagi noty nie ma.
   */
  limitReached?: boolean;
  /** „Ustawienia przypomnień” tylko dla właściciela (P7). */
  canManageSettings?: boolean;
  /** Rola pozwala oznaczać zapłatę (`canChangeInvoicePayment`); księgowa ma wgląd. */
  canMarkPaid?: boolean;
}

/** „Cofnij” zwraca wiersz, którego serwer już może nie mieć: zapamiętujemy go przy dotknięciu. */
interface PayableOverdue extends PayableInvoice {
  invoice: OverdueInvoice;
}

type OverdueListChange = { type: 'hide'; id: string } | { type: 'show'; invoice: OverdueInvoice };

/** Lista po dotknięciu „Zapłacone” albo „Cofnij”: ta sama kolejność co na serwerze (najstarsze zaległości). */
export function applyOverdueChange(list: OverdueInvoice[], change: OverdueListChange): OverdueInvoice[] {
  if (change.type === 'hide') return list.filter((invoice) => invoice.id !== change.id);
  if (list.some((invoice) => invoice.id === change.invoice.id)) return list;
  return [...list, change.invoice].sort(
    (a, b) => b.days_overdue - a.days_overdue || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

const overdueReducer = stableOptimisticReducer(applyOverdueChange);

const money = (n: number) => `${formatPlMoney(n)} zł`;

/** Status kolumny „Status”: wpis z `payment_reminders` albo jego brak. */
type RowStatus = ReminderStatus | 'none' | 'unavailable';

const STATUS_LABELS: Record<RowStatus, string> = {
  pending: 'Zaplanowane',
  sent: 'Wysłane',
  failed: 'Nieudane',
  cancelled: 'Anulowane',
  none: 'Bez przypomnień',
  unavailable: 'Stan niedostępny',
};

// Kolory jak `REMINDER_STATUS_STYLES` / `TRANSACTION_STATUS_STYLES` w Finorze.
const STATUS_STYLES: Record<RowStatus, string> = {
  pending: 'bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400',
  sent: 'bg-green-600/10 text-green-700 dark:bg-green-400/10 dark:text-green-400',
  failed: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-destructive/10 text-destructive',
  none: 'bg-muted text-muted-foreground',
  unavailable: 'bg-muted text-muted-foreground',
};

const STATUS_ICONS: Record<RowStatus, React.ReactElement> = {
  pending: <RiTimeLine className="size-4" />,
  sent: <RiCheckLine className="size-4" />,
  failed: <RiErrorWarningLine className="size-4" />,
  cancelled: <RiCloseLine className="size-4" />,
  none: <RiMailSendLine className="size-4" />,
  unavailable: <RiQuestionLine className="size-4" />,
};

function rowStatus(invoice: OverdueInvoice): RowStatus {
  const latest = invoice.latest_reminder;
  if (latest === 'unavailable') return 'unavailable';
  return latest ? latest.status : 'none';
}

function dueLabel(invoice: OverdueInvoice): string {
  return invoice.payment_due_date.trim() ? formatIsoDatePl(invoice.payment_due_date) : '—';
}

function daysOverdueLabel(days: number): string {
  return `${formatPlInt(days)} ${plural(days, ['dzień', 'dni', 'dni'])} po terminie`;
}

/** Stan wysyłki z odczytu „pending” (orientacyjny, jak dotąd). */
function reminderNoticeOf(invoice: OverdueInvoice): string | null {
  return invoice.reminder_status === 'pending'
    ? 'Oczekuje na wysyłkę'
    : invoice.reminder_status === 'review'
      ? 'Wymaga weryfikacji wysyłki'
      : invoice.reminder_status === 'unavailable'
        ? 'Stan wysyłki niedostępny'
        : null;
}

function StatusAvatar({ status }: { status: RowStatus }) {
  return (
    <Avatar className="after:border-none" title={STATUS_LABELS[status]}>
      <AvatarFallback className={STATUS_STYLES[status]}>
        {STATUS_ICONS[status]}
        <span className="sr-only">{STATUS_LABELS[status]}</span>
      </AvatarFallback>
    </Avatar>
  );
}

function BuyerCell({ invoice }: { invoice: OverdueInvoice }) {
  return (
    <div className="flex items-center gap-2">
      <Avatar className="size-9">
        <AvatarFallback className="bg-primary/10 text-accent-foreground text-xs">
          {companyInitials(invoice.buyer_name)}
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium" title={invoice.buyer_name || undefined}>
          {invoice.buyer_name ? shortenLegalForm(invoice.buyer_name) : '—'}
        </span>
        {invoice.buyer_nip ? (
          <span className="text-muted-foreground font-mono">{invoice.buyer_nip}</span>
        ) : null}
      </div>
    </div>
  );
}

function ReminderCell({ invoice }: { invoice: OverdueInvoice }) {
  const latest = invoice.latest_reminder;
  const notice = reminderNoticeOf(invoice);
  return (
    <div className="flex flex-col">
      <span>
        {latest === 'unavailable' ? 'Niedostępne' : latest ? formatTimestampDatePl(latest.scheduledFor) : '—'}
      </span>
      <span className="text-muted-foreground">
        {latest && latest !== 'unavailable' ? `Etap ${latest.stage} · ` : ''}
        Wysłane {invoice.reminders_sent_count}/3
      </span>
      {notice ? (
        <span className={cn('text-xs', invoice.reminder_status === 'review' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
          {notice}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Akcje jednej zaległości: „Zapłacone”, „Przygotuj przypomnienie” (podgląd
 * i zgoda w `ReminderConsentDialog`) oraz „Wstrzymaj / Wznów”
 * (`toggleInvoiceRemindersAction`). JEDEN komponent dla tabeli i karty —
 * inaczej dwie kopie obsługi wstrzymania.
 */
function OverdueRowActions({
  invoice,
  onPrepare,
  onMarkPaid,
}: {
  invoice: OverdueInvoice;
  onPrepare: () => void;
  onMarkPaid?: (invoice: OverdueInvoice) => void;
}) {
  const router = useRouter();
  const [isPausing, startPausing] = useTransition();

  const canPrepareReminder = !invoice.reminders_paused && invoice.reminder_status === 'none';
  const prepareLabel = invoice.reminder_status === 'review'
    ? 'Wysyłka wymaga weryfikacji'
    : invoice.reminder_status === 'pending'
      ? 'Przypomnienie już zlecone'
      : invoice.reminder_status === 'unavailable'
        ? 'Stan wysyłki niedostępny'
        : 'Przygotuj przypomnienie';
  const pauseLabel = invoice.reminders_paused ? 'Wznów przypomnienia' : 'Wstrzymaj przypomnienia';

  const handleTogglePause = () => {
    startPausing(async () => {
      const reason = invoice.reminders_paused
        ? undefined
        : (prompt('Powód wstrzymania przypomnień (opcjonalnie):') ?? undefined);

      const result = await toggleInvoiceRemindersAction(
        invoice.id,
        !invoice.reminders_paused,
        reason,
      );
      if (result.success) {
        toast.success(invoice.reminders_paused ? 'Wznowiono' : 'Wstrzymano');
        router.refresh();
      } else {
        toast.error(result.error ?? 'Nie udało się zmienić ustawienia');
      }
    });
  };

  return (
    <div className="flex items-center justify-center gap-1">
      {onMarkPaid ? (
        <MarkPaidButton number={invoice.internal_number || null} onClick={() => onMarkPaid(invoice)} />
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              disabled={!canPrepareReminder}
              aria-label={prepareLabel}
              onClick={onPrepare}
            />
          }
        >
          <RiSendPlaneLine className="size-4.5" />
        </TooltipTrigger>
        <TooltipContent>
          <p>{prepareLabel}</p>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              disabled={isPausing}
              aria-label={pauseLabel}
              onClick={handleTogglePause}
            />
          }
        >
          {isPausing ? (
            <RiLoader4Line className="size-4.5 animate-spin" aria-hidden />
          ) : invoice.reminders_paused ? (
            <RiPlayLine className="size-4.5" />
          ) : (
            <RiPauseLine className="size-4.5" />
          )}
        </TooltipTrigger>
        <TooltipContent>
          <p>{pauseLabel}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * Tytuł dla czytników ekranu. Poprawka 21.10.2026: ekran to zakładka „Po terminie”
 * Faktur — nazwę niesie zakładka, więc widocznego nagłówka nie ma (jak w Finorze).
 */
function OverdueHeading() {
  return <h1 className="sr-only">Faktury po terminie</h1>;
}

/** Lista, której nie da się potwierdzić w całości: komunikat zamiast kwot (w karcie z zakładkami). */
export function OverdueDashboardError({ message }: { message: string }) {
  return (
    <div className="ff-tab-panel flex w-full flex-1 flex-col">
      <OverdueHeading />
      <div className="px-4 pt-2">
        <Alert variant="destructive">
          <AlertTitle>Nie udało się pobrać listy: {message}</AlertTitle>
          <AlertDescription>
            Odśwież stronę za chwilę. Jeśli komunikat wraca, napisz do pomocy FaktWay — sprawdzimy dane faktur.
          </AlertDescription>
        </Alert>
      </div>
    </div>
  );
}

/**
 * Kolumny tabeli P7. `onPrepare` otwiera podgląd przypomnienia, `onMarkPaid`
 * oznacza zapłatę (bez niego — rola bez prawa — przycisku nie ma); eksport dla
 * testu filtra „Status przypomnienia”.
 */
export function overdueColumns(
  onPrepare: (invoice: OverdueInvoice) => void,
  onMarkPaid?: (invoice: OverdueInvoice) => void,
): ColumnDef<OverdueInvoice>[] {
  return [
    {
      header: 'Faktura',
      accessorKey: 'internal_number',
      cell: ({ row }) => (
        <div className="flex flex-col">
          <Link
            href={`/invoices/${row.original.id}`}
            // Wariant PIERWSZY: tailwind-merge zostawia późniejszą z dwóch sprzecznych klas. Dotyk: 28 px,
            // nie 44 px z bazy, bo wiersz trzymają na 44 px przyciski „Akcje”, a niżej jest linia 16 px.
            className={cn(
              buttonVariants({ variant: 'link' }),
              'h-auto justify-start px-0 font-mono [@media(pointer:coarse)]:min-h-7',
            )}
          >
            {row.original.internal_number || '—'}
          </Link>
          <span className="text-muted-foreground tabular-nums">Do zapłaty {money(row.original.amount_due)}</span>
        </div>
      ),
      size: 160,
    },
    {
      header: 'Kontrahent',
      id: 'buyer',
      accessorFn: (row) => row.buyer_name,
      cell: ({ row }) => <BuyerCell invoice={row.original} />,
      size: 260,
    },
    {
      header: 'Termin płatności',
      id: 'dueDate',
      accessorFn: (row) => row.payment_due_date,
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="text-muted-foreground tabular-nums">{dueLabel(row.original)}</span>
          <span className="text-destructive">{daysOverdueLabel(row.original.days_overdue)}</span>
        </div>
      ),
    },
    {
      header: 'Przypomnienie',
      id: 'remindOn',
      accessorFn: (row) => {
        const latest = row.latest_reminder;
        return latest && latest !== 'unavailable' ? latest.scheduledFor : '';
      },
      cell: ({ row }) => <ReminderCell invoice={row.original} />,
    },
    {
      header: 'Status',
      id: 'status',
      accessorFn: (row) => rowStatus(row),
      filterFn: 'equalsString', // filtr select: cała wartość, jak w Finorze
      cell: ({ row }) => <StatusAvatar status={rowStatus(row.original)} />,
      size: 100,
    },
    {
      id: 'actions',
      header: () => 'Akcje',
      cell: ({ row }) => (
        <OverdueRowActions invoice={row.original} onPrepare={() => onPrepare(row.original)} onMarkPaid={onMarkPaid} />
      ),
      size: 220,
      enableHiding: false,
      enableSorting: false,
    },
  ];
}

export function OverdueDashboard({
  overdueInvoices: serverInvoices,
  stats: serverStats,
  limitReached = false,
  canManageSettings = false,
  canMarkPaid = false,
}: Props) {
  const router = useRouter();
  // „Zapłacone” zdejmuje wiersz od razu, zanim odpowie serwer; przy błędzie wiersz wraca sam.
  const [overdueInvoices, applyChange] = useOptimistic(serverInvoices, overdueReducer);
  // Stabilne, bo od `mark` zależą kolumny tabeli: nowe kolumny przy każdym renderze to przeliczanie całego modelu.
  const onPaid = useCallback(({ id }: PayableOverdue) => applyChange({ type: 'hide', id }), [applyChange]);
  const onRestored = useCallback(({ invoice }: PayableOverdue) => applyChange({ type: 'show', invoice }), [applyChange]);
  const { mark } = useInvoicePayment<PayableOverdue>({ onPaid, onRestored });
  const markPaid = useMemo(
    () => (canMarkPaid
      ? (invoice: OverdueInvoice) => mark({ id: invoice.id, number: invoice.internal_number || null, invoice })
      : undefined),
    [canMarkPaid, mark],
  );
  // Kafle też bez czekania. Liczby są sumą pokazanych wierszy (jak na serwerze), więc liczymy je tak samo.
  const stats = overdueInvoices === serverInvoices
    ? serverStats
    : {
      ...serverStats,
      totalCount: overdueInvoices.length,
      totalAmount: overdueInvoices.reduce((sum, invoice) => sum + invoice.amount_due, 0),
      avgDaysOverdue: overdueInvoices.length
        ? Math.round(overdueInvoices.reduce((sum, invoice) => sum + invoice.days_overdue, 0) / overdueInvoices.length)
        : 0,
      pausedCount: overdueInvoices.filter((invoice) => invoice.reminders_paused).length,
    };
  const [reminderInvoice, setReminderInvoice] = useState<OverdueInvoice | null>(null);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });

  const columns = useMemo(() => overdueColumns(setReminderInvoice, markPaid), [markPaid]);

  // eslint-disable-next-line react-hooks/incompatible-library -- tanstack zwraca funkcje, których React Compiler nie zapamiętuje (jak w Finorze)
  const table = useReactTable({
    data: overdueInvoices,
    columns,
    state: { columnFilters, globalFilter, pagination },
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: (row, _columnId, filterValue) => {
      const search = String(filterValue).toLowerCase();
      return (
        row.original.internal_number.toLowerCase().includes(search) ||
        row.original.buyer_name.toLowerCase().includes(search) ||
        (row.original.buyer_nip ?? '').includes(search)
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

  // Poprawka Bartosza 21.10.2026: stała nota nad kaflami („brzydka”) zniknęła.
  // Jej zastrzeżenia stoją tam, gdzie dotyczą: zakres sumy w podpisie kafla
  // „Po terminie” (RECEIVABLES_NOTE), limit 100 pod „Faktur po terminie” tylko
  // przy ucięciu, orientacyjny stan pod kaflem przypomnień, saldo w oknie zgody.
  const averageNote = `średnio ${daysOverdueLabel(stats.avgDaysOverdue)}`;
  const reminderStateNote = overdueInvoices.length > 0 ? 'Stan przypomnień jest orientacyjny' : null;
  const statItems = [
    {
      label: 'Po terminie',
      value: money(stats.totalAmount),
      note: (
        <>
          Suma pokazanych pozycji
          <br />
          {RECEIVABLES_NOTE}
        </>
      ),
    },
    {
      label: 'Faktur po terminie',
      value: formatPlInt(stats.totalCount),
      note: stats.totalCount === 0 ? undefined : limitReached ? (
        <>
          {averageNote}
          <br />
          Pokazujemy pierwsze {formatPlInt(stats.totalCount)}, od najdłużej zaległych
        </>
      ) : averageNote,
    },
    {
      label: 'Przypomnień wysłanych w miesiącu',
      value: stats.sentThisMonth === null ? '—' : formatPlInt(stats.sentThisMonth),
      note: stats.sentThisMonth === null ? (
        <>
          Nie udało się odczytać — odśwież za chwilę
          {reminderStateNote ? <><br />{reminderStateNote}</> : null}
        </>
      ) : reminderStateNote ?? undefined,
    },
    {
      label: 'Wstrzymanych',
      value: formatPlInt(stats.pausedCount),
      note: 'z pokazanych faktur',
    },
  ];

  // Zawartość karty sekcji Faktur (`(faktury)/layout.tsx` daje kafle, kartę
  // i rząd zakładek). Liczby tej zakładki stoją w pasku nad tabelą, nie
  // w osobnych kaflach — przełączenie zakładki nie rusza niczego nad kartą
  // (decyzja Bartosza 25.10.2026).
  return (
    <div className="ff-tab-panel flex w-full flex-1 flex-col">
      <OverdueHeading />
      <PanelStats label="Podsumowanie faktur po terminie" items={statItems} />

      {overdueInvoices.length === 0 ? (
        <>
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center">
            <div className="bg-muted flex size-12 items-center justify-center">
              <RiCheckboxCircleLine className="text-foreground size-6" aria-hidden />
            </div>
            <h3 className="text-lg font-semibold tracking-tight">Brak pozycji gotowych do przypomnienia</h3>
            <p className="text-muted-foreground mx-auto max-w-md text-sm">
              Inne dokumenty mogą nadal wymagać sprawdzenia salda i korekt.
            </p>
            {canManageSettings ? (
              <Link href="/settings/reminders" className={buttonVariants({ variant: 'outline' })}>
                <RiSettings3Line aria-hidden />
                Ustawienia przypomnień
              </Link>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <div className="flex w-full flex-1 flex-col pt-4">
            <div className="flex-1 border-b">
              <div className="flex gap-6 p-4 pt-0 max-lg:flex-col lg:items-center lg:justify-between">
                <div className="flex items-center gap-4">
                  <PageSizeSelect table={table} />
                  {canManageSettings ? (
                    <Link href="/settings/reminders" className={buttonVariants({ variant: 'default' })}>
                      <RiSettings3Line aria-hidden />
                      Ustawienia przypomnień
                    </Link>
                  ) : null}
                </div>
                <div className="flex flex-1 flex-wrap items-center gap-4 lg:justify-end">
                  <TableSearch
                    value={globalFilter}
                    onChange={setGlobalFilter}
                    placeholder="Szukaj po numerze lub kontrahencie"
                    className="max-w-2xs sm:max-w-2xs"
                  />
                  <ColumnSelectFilter
                    column={table.getColumn('status')!}
                    labels={STATUS_LABELS}
                    allLabel="Wszystkie statusy"
                    label="Status przypomnienia"
                  />
                </div>
              </div>
              <DataTableView
                table={table}
                renderCard={(row) => {
                  const invoice = row.original;
                  const status = rowStatus(invoice);
                  return (
                    <FinoraListCard
                      leading={<StatusAvatar status={status} />}
                      title={invoice.buyer_name ? shortenLegalForm(invoice.buyer_name) : '—'}
                      subtitle={invoice.buyer_nip ? `NIP ${invoice.buyer_nip}` : undefined}
                      amount={money(invoice.amount_due)}
                      amountNote={daysOverdueLabel(invoice.days_overdue)}
                      meta={
                        <>
                          <Link href={`/invoices/${invoice.id}`} className="text-primary font-mono font-medium hover:underline">
                            {invoice.internal_number || '—'}
                          </Link>
                          <span>Termin {dueLabel(invoice)}</span>
                          <span>{STATUS_LABELS[status]}</span>
                          <ReminderCell invoice={invoice} />
                        </>
                      }
                      actions={
                        <OverdueRowActions
                          invoice={invoice}
                          onPrepare={() => setReminderInvoice(invoice)}
                          onMarkPaid={markPaid}
                        />
                      }
                    />
                  );
                }}
              />
            </div>
            <DataTablePagination table={table} />
          </div>
        </>
      )}
      {reminderInvoice ? (
        <ReminderConsentDialog key={reminderInvoice.id}
          source={{ invoiceId: reminderInvoice.id, recipientEmail: reminderInvoice.buyer_email ?? undefined }}
          onClose={() => setReminderInvoice(null)}
          onSent={() => { toast.success('Przypomnienie przekazane do wysyłki'); router.refresh(); }} />
      ) : null}
    </div>
  );
}
