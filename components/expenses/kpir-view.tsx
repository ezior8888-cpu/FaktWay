'use client';

import { useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
import { RiArrowLeftDownLine, RiArrowRightUpLine, RiBook2Line, RiCloseLine, RiErrorWarningLine } from '@remixicon/react';

import {
  ColumnSelectFilter,
  DataTablePagination,
  DataTableView,
  FinoraListCard,
  PageSizeSelect,
  TableSearch,
} from '@/components/lists/finora-data-table';
import { KpirCostStructureCard } from '@/components/reports/kpir/kpir-cost-structure-card';
import {
  buildKpirEntries,
  COLUMN_BADGE_TEXT,
  COLUMN_FILTER_LABELS,
  COLUMN_FILTER_ORDER,
  COLUMN_TITLES,
  costSlices,
  entryMatchesSearch,
  kpirDailySeries,
  kpirMonthTitle,
  nonDeductedVatSum,
  signedEntryMoney,
  uncountedCosts,
  type CostSlice,
  type KpirColumnKey,
  type KpirEntry,
  type KpirSeriesPoint,
} from '@/components/reports/kpir/kpir-model';
import { KpirResultCard, REVENUE_TINT } from '@/components/reports/kpir/kpir-result-card';
import { KpirToolbar } from '@/components/reports/kpir/kpir-toolbar';
import { SegmentedControl, type SegmentedOption } from '@/components/reports/segmented-control';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { companyInitials, shortenLegalForm } from '@/lib/format/legal-form';
import { kpirTotals, type KpirExpenseRow, type KpirInvoiceRow, type KpirTotals } from '@/lib/reports/kpir-totals';
import { cn } from '@/lib/utils';

export type { KpirExpenseRow, KpirInvoiceRow } from '@/lib/reports/kpir-totals';

/**
 * Ekran KPiR (zakładka „KPiR” Księgowości). Poprawka Bartosza 21.10.2026:
 * przeprojektowanie Księgowości — zamiast czterech kafli i tabeli z kolumną
 * „Akcje”: pasek miesiąca, karta wyniku (dochód, marża, przychody i koszty
 * narastająco) z pierścieniem kosztów według kolumn, a pod nimi księga
 * w karcie z zakładkami KPiR | Eksport, sięgającej stopki.
 *
 * Zwraca fragment: karta księgi musi być bezpośrednim dzieckiem korzenia
 * strony (`ff-page-fill flex flex-col`), żeby `flex-1` doniósł ją do stopki.
 * Wszystkie kwoty liczą funkcje z `lib` (`kpirTotals`, `kpirInvoiceRevenue`,
 * `kpirCostAmount`) przez model `components/reports/kpir/kpir-model.ts`.
 * Z nawigacji tylko `useRouter()` (`refresh` w obsłudze kliknięcia) — testy
 * renderują ten widok z atrapą samego `push`.
 */

interface KpirViewProps {
  month: number;
  year: number;
  expenses: KpirExpenseRow[];
  invoices: KpirInvoiceRow[];
  /** Zaliczek ROZ nie odczytano (`getKpirData`): baner nad księgą, bez marży. */
  settledError?: string | null;
  /** Dziś RRRR-MM-DD w Polsce; domyślnie `todayInWarsaw()`. */
  today?: string;
  /** Dane przykładowe (firma przed weryfikacją KSeF) — plakietka w pasku. */
  demo?: boolean;
}

/** Segment nad księgą: wszystkie wpisy, przychody, koszty albo koszty poza sumą. */
type LedgerView = 'all' | 'revenue' | 'cost' | 'check';

const HIDDEN_COLUMNS = { kind: false, check: false };

// Plakietki kolumn: przychód zielony, koszt z sum `primary/10` (tekst
// `accent-foreground`, nie `primary` — 4,44:1 to za mało, WCAG 1.4.3),
// koszt poza sumą bursztynowy (-800 / -300 dla kontrastu tekstu 12 px).
const WARNING_BADGE = 'bg-amber-500/15 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300';
const COLUMN_BADGE_STYLES: Record<KpirColumnKey, string> = {
  '7': REVENUE_TINT,
  '10': 'bg-primary/10 text-accent-foreground',
  '11': 'bg-primary/10 text-accent-foreground',
  '12': 'bg-primary/10 text-accent-foreground',
  '13': 'bg-primary/10 text-accent-foreground',
  '15': 'bg-primary/10 text-accent-foreground',
  brak: WARNING_BADGE,
  poza: WARNING_BADGE,
};

function amountTone(entry: KpirEntry): string {
  if (entry.kind === 'revenue') return 'text-green-700 dark:text-green-400';
  return entry.inSum ? 'text-destructive' : 'text-muted-foreground';
}

function remarkTone(entry: KpirEntry): string {
  return entry.amountRemarkTone === 'warning' ? 'text-amber-800 dark:text-amber-300' : 'text-muted-foreground';
}

function counterpartyName(entry: KpirEntry): string {
  return entry.counterparty === '—' ? '—' : shortenLegalForm(entry.counterparty);
}

/** „Faktura FV/1” / „Wydatek ZAK/7” — nazwa dokumentu dla linku i czytnika. */
function documentLabel(entry: KpirEntry): string {
  return `${entry.kind === 'revenue' ? 'Faktura' : 'Wydatek'} ${entry.documentNumber ?? 'bez numeru'}`;
}

function ColumnBadge({ entry }: { entry: KpirEntry }) {
  return (
    <Badge className={COLUMN_BADGE_STYLES[entry.column]} title={COLUMN_TITLES[entry.column]}>
      {COLUMN_BADGE_TEXT[entry.column]}
    </Badge>
  );
}

/** „faktura z 03.09” pod datą; pełna uwaga o przychodzie okresu sprzedaży w `title` i dla czytnika. */
function SaleChip({ entry }: { entry: KpirEntry }) {
  if (!entry.saleChip) return null;
  return (
    <>
      <span className="block text-xs text-amber-800 dark:text-amber-300" title={entry.dateRemark ?? undefined} aria-hidden>
        {entry.saleChip}
      </span>
      <span className="sr-only">{entry.dateRemark}</span>
    </>
  );
}

function AmountRemark({ entry }: { entry: KpirEntry }) {
  if (!entry.amountRemark) return null;
  // `whitespace-normal`: komórka tabeli ma `whitespace-nowrap`, więc dopisek ROZ
  // („zamówienie 10 000,00, minus zaliczki 4000,00”) wychodził za kartę i ucinał
  // kwotę zaliczek; `max-w-40` mieści się w kolumnie 170 px (poprawka Bartosza
  // 21.10.2026: przeprojektowanie Księgowości).
  return (
    <span className={cn('max-w-40 text-right text-xs whitespace-normal', remarkTone(entry))}>{entry.amountRemark}</span>
  );
}

/** Kolumny księgi (stałe). Eksport dla testu filtrów („Rodzaj”, „Kolumna”, „Do sprawdzenia”). */
export const KPIR_COLUMNS: ColumnDef<KpirEntry>[] = [
  {
    header: 'Lp.',
    accessorKey: 'lp',
    cell: ({ row }) => <span className="text-muted-foreground tabular-nums">{row.original.lp}</span>,
    size: 56,
  },
  {
    header: 'Data',
    accessorKey: 'date',
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span className="tabular-nums">{formatIsoDatePl(row.original.date)}</span>
        <SaleChip entry={row.original} />
      </div>
    ),
    size: 120,
  },
  {
    // Numer dowodu to link do faktury albo wydatku — zamiast kolumny „Akcje”.
    header: 'Nr dowodu',
    id: 'documentNumber',
    accessorFn: (row) => row.documentNumber ?? '',
    cell: ({ row }) => {
      const entry = row.original;
      const number = entry.documentNumber ?? 'bez numeru';
      return (
        <Link
          href={entry.href}
          className="font-medium underline-offset-4 hover:underline"
          aria-label={documentLabel(entry)}
        >
          {number}
        </Link>
      );
    },
    size: 160,
  },
  {
    header: 'Kontrahent',
    id: 'counterparty',
    accessorKey: 'counterparty',
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <Avatar className="size-9 items-center justify-center">
          <AvatarFallback className="text-xs">{companyInitials(row.original.counterparty)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col">
          <span className="max-w-56 truncate font-medium" title={row.original.counterparty}>
            {counterpartyName(row.original)}
          </span>
          {row.original.counterpartyNip ? (
            <span className="text-muted-foreground text-xs">NIP {row.original.counterpartyNip}</span>
          ) : null}
        </div>
      </div>
    ),
    size: 260,
  },
  {
    header: 'Opis',
    accessorKey: 'description',
    cell: ({ row }) => (
      <span className="text-muted-foreground block max-w-48 truncate" title={row.original.description}>
        {row.original.description}
      </span>
    ),
    size: 180,
  },
  {
    header: 'Kolumna',
    id: 'column',
    accessorFn: (row) => row.column,
    filterFn: 'equalsString', // filtr select: cała wartość, jak w Finorze
    cell: ({ row }) => <ColumnBadge entry={row.original} />,
    size: 140,
  },
  {
    header: 'Rodzaj',
    id: 'kind',
    accessorKey: 'kind',
    filterFn: 'equalsString',
    enableHiding: true,
  },
  {
    // Segment „Do sprawdzenia”: koszt, który nie wchodzi do sum (bez kolumny / poza sumą).
    header: 'Do sprawdzenia',
    id: 'check',
    accessorFn: (row) => (row.kind === 'cost' && !row.inSum ? 'tak' : 'nie'),
    filterFn: 'equalsString',
    enableHiding: true,
  },
  {
    // `w-full`: nagłówek sortowalny to rząd flex — samo `block text-right` zostawiało „Kwota” po lewej.
    header: () => <span className="block w-full text-right">Kwota</span>,
    id: 'amount',
    accessorFn: (row) => (row.kind === 'revenue' ? row.amount : -row.amount),
    cell: ({ row }) => (
      <div className="flex flex-col items-end pr-2 text-right">
        <span className={cn('font-medium tabular-nums whitespace-nowrap', amountTone(row.original))}>
          {signedEntryMoney(row.original)}
        </span>
        <AmountRemark entry={row.original} />
      </div>
    ),
    size: 170,
  },
];

/** Tekst filtra kolumny („13 · Pozostałe”) dla wartości z tabeli. */
function columnLabel(value: string): string {
  return COLUMN_FILTER_LABELS[value as KpirColumnKey] ?? value;
}

function viewFilters(view: LedgerView): ColumnFiltersState {
  if (view === 'revenue' || view === 'cost') return [{ id: 'kind', value: view }];
  if (view === 'check') return [{ id: 'check', value: 'tak' }];
  return [];
}

/**
 * Przewija do księgi i przenosi tam fokus — na zaznaczony segment, więc
 * czytnik słyszy, co księga teraz pokazuje („Do sprawdzenia”, „Koszty”),
 * a następny Tab nie skacze z powrotem nad księgę (poprawka Bartosza
 * 21.10.2026: przeprojektowanie Księgowości). Wołane po `flushSync`, żeby
 * segment był już zaznaczony.
 */
function revealLedger() {
  const ledger = document.getElementById('ksiega');
  if (!ledger) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  ledger.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  ledger.querySelector<HTMLElement>('[role="radiogroup"] [role="radio"][aria-checked="true"]')?.focus({ preventScroll: true });
}

/**
 * Wiersz księgi jako karta poniżej `lg` (bez „Lp.” i bez wiersza akcji — tytuł to link).
 *
 * Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): dopisek pod
 * kwotą idzie osobnym wierszem w `meta`, nie jako `amountNote` — ta kolumna
 * (`shrink-0`) rosła do całej długości dopisku i ściskała kontrahenta i numer
 * do jednej litery. Bez nazwy kontrahenta link mówi, jaki to dokument, a nie „—”.
 */
function EntryCard({ entry }: { entry: KpirEntry }) {
  const revenue = entry.kind === 'revenue';
  return (
    <FinoraListCard
      leading={
        <span className={cn('flex size-9 shrink-0 items-center justify-center', revenue ? REVENUE_TINT : 'bg-muted text-foreground')}>
          {revenue ? <RiArrowLeftDownLine className="size-4.5" aria-hidden /> : <RiArrowRightUpLine className="size-4.5" aria-hidden />}
        </span>
      }
      title={
        <Link href={entry.href} className="hover:underline">
          {entry.counterparty === '—' ? documentLabel(entry) : counterpartyName(entry)}
        </Link>
      }
      subtitle={entry.documentNumber ?? 'bez numeru'}
      subtitleClassName="font-sans"
      amount={<span className={amountTone(entry)}>{signedEntryMoney(entry)}</span>}
      meta={
        <>
          <span className="tabular-nums">{formatIsoDatePl(entry.date)}</span>
          <ColumnBadge entry={entry} />
          {entry.saleChip ? (
            <span>
              <SaleChip entry={entry} />
            </span>
          ) : null}
          <span>{entry.description}</span>
          {entry.amountRemark ? <span className={cn('basis-full', remarkTone(entry))}>{entry.amountRemark}</span> : null}
        </>
      }
    />
  );
}

export function KpirView({ month, year, expenses, invoices, settledError = null, today: todayProp, demo = false }: KpirViewProps) {
  const router = useRouter();
  const today = todayProp ?? todayInWarsaw();
  const period = `${year}-${String(month).padStart(2, '0')}`;
  const periodStart = `${period}-01`;
  const periodEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const lastDay = Number(periodEnd.slice(8, 10));
  const settledUnavailable = Boolean(settledError);

  const { entries, totals, series, slices, uncounted, vatInCosts } = useMemo(() => {
    const sums = kpirTotals(expenses, invoices);
    return {
      entries: buildKpirEntries(invoices, expenses, { periodStart, settledUnavailable }),
      totals: sums,
      series: kpirDailySeries({ invoices, expenses, periodStart, periodEnd, today }),
      slices: costSlices(sums),
      uncounted: uncountedCosts(expenses),
      vatInCosts: nonDeductedVatSum(expenses),
    };
  }, [invoices, expenses, periodStart, periodEnd, today, settledUnavailable]);

  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 });
  const [view, setView] = useState<LedgerView>('all');

  // Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): Next 16
  // trzyma stan strony bez parametrów adresu — po zmianie miesiąca segment,
  // filtr kolumny, szukanie i strona tabeli zostawały z poprzedniego.
  // Strona daje `key` na miesiąc; tu to samo dla innych miejsc, które rysują
  // widok (wzór „poprzednia wartość w stanie”, bez efektu). „Do sprawdzenia”
  // bez kosztów poza sumą (np. po odświeżeniu) wraca do „Wszystko” — inaczej
  // żaden segment nie jest zaznaczony, a księga pusta.
  const [filtersPeriod, setFiltersPeriod] = useState(period);
  if (filtersPeriod !== period) {
    setFiltersPeriod(period);
    setView('all');
    setColumnFilters([]);
    setGlobalFilter('');
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  } else if (view === 'check' && uncounted.count === 0) {
    setView('all');
    setColumnFilters([]);
  }

  const firstPage = () => setPagination((p) => (p.pageIndex === 0 ? p : { ...p, pageIndex: 0 }));

  // eslint-disable-next-line react-hooks/incompatible-library -- tanstack zwraca funkcje, których React Compiler nie zapamiętuje (jak w Finorze)
  const table = useReactTable({
    data: entries,
    columns: KPIR_COLUMNS,
    state: { columnFilters, globalFilter, pagination, columnVisibility: HIDDEN_COLUMNS },
    // Bez automatu tanstacka: kolejkował reset strony już przy pierwszym
    // renderze (w dev „Can't perform a React state update on a component that
    // hasn't mounted yet”, „1 Issue”) i wyrzucał na stronę 1 po każdym
    // `router.refresh`. Filtry i szukanie wracają na stronę 1 same (niżej).
    autoResetPageIndex: false,
    onColumnFiltersChange: (updater) => {
      setColumnFilters(updater);
      firstPage();
    },
    onGlobalFilterChange: (updater) => {
      setGlobalFilter(updater);
      firstPage();
    },
    globalFilterFn: (row, _columnId, filterValue) => entryMatchesSearch(row.original, String(filterValue)),
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    enableSortingRemoval: false,
    getPaginationRowModel: getPaginationRowModel(),
    onPaginationChange: setPagination,
  });

  // Krótsza lista po odświeżeniu: strona poza zakresem cofa się na ostatnią.
  const lastPageIndex = Math.max(0, table.getPageCount() - 1);
  if (pagination.pageIndex > lastPageIndex) setPagination((p) => ({ ...p, pageIndex: lastPageIndex }));

  const monthTitle = kpirMonthTitle(month, year);
  const exportHref = `/reports/exports?period=${period}&format=kpir_excel`;
  const activeColumn = columnFilters.find((filter) => filter.id === 'column')?.value as string | undefined;

  const changeView = (next: LedgerView) => {
    setView(next);
    setColumnFilters(viewFilters(next));
    firstPage();
  };

  // Klik w legendę pierścienia: koszty tej kolumny (jedyne miejsce, które łączy
  // „Koszty” z kolumną); drugi klik zdejmuje filtr kolumny i zostawia fokus
  // w legendzie.
  const selectColumn = (column: KpirColumnKey) => {
    const off = activeColumn === column;
    flushSync(() => {
      setView('cost');
      setColumnFilters(off ? viewFilters('cost') : [...viewFilters('cost'), { id: 'column', value: column }]);
      firstPage();
    });
    if (!off) revealLedger();
  };

  // Znacznik filtra kolumny poniżej `lg`: tam nie ma selecta kolumn, a legenda
  // pierścienia (od `sm`) potrafi go ustawić — bez znacznika księga wyglądała
  // jak „wszystkie koszty”.
  const clearColumn = () => {
    setColumnFilters((filters) => filters.filter((filter) => filter.id !== 'column'));
    firstPage();
  };

  const showUncounted = () => {
    flushSync(() => changeView('check'));
    revealLedger();
  };

  const viewOptions: SegmentedOption<LedgerView>[] = [
    { value: 'all', label: 'Wszystko', count: entries.length },
    { value: 'revenue', label: 'Przychody', count: invoices.length },
    { value: 'cost', label: 'Koszty', count: expenses.length },
    ...(uncounted.count > 0
      ? [{ value: 'check' as const, label: 'Do sprawdzenia', shortLabel: 'Sprawdź', count: uncounted.count }]
      : []),
  ];

  return (
    <>
      <KpirToolbar period={period} currentMonth={today.slice(0, 7)} monthTitle={monthTitle} exportHref={exportHref} demo={demo} />

      {settledError ? (
        <Alert variant="destructive">
          <RiErrorWarningLine aria-hidden />
          {/* Tytuł bez technicznego ogona po dwukropku (komunikat bazy). */}
          <AlertTitle>{settledError.split(':')[0]}</AlertTitle>
          <AlertDescription>Kwoty faktur rozliczeniowych mogą być zawyżone.</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => router.refresh()}>
              Odśwież
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {entries.length > 0 ? (
        <SummaryRow
          totals={totals}
          slices={slices}
          monthTitle={monthTitle}
          series={series}
          lastDay={lastDay}
          vatInCosts={vatInCosts}
          uncountedCount={uncounted.count}
          settledError={settledUnavailable}
          activeColumn={activeColumn}
          onSelectColumn={selectColumn}
          onShowUncounted={showUncounted}
        />
      ) : null}

      <Card id="ksiega" className="flex-1 scroll-mt-24">
        <div className="flex w-full flex-1 flex-col">
          {entries.length === 0 ? (
            <Empty className="flex-1 py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RiBook2Line aria-hidden />
                </EmptyMedia>
                <EmptyTitle>Brak przychodów i wydatków w tym okresie</EmptyTitle>
                <EmptyDescription>Liczą się faktury przyjęte w KSeF i wydatki oznaczone jako koszt.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent className="flex-row justify-center gap-2">
                <Button render={<Link href="/invoices/new" />} nativeButton={false}>
                  Wystaw fakturę
                </Button>
                <Button variant="outline" render={<Link href={`/expenses?miesiac=${period}`} />} nativeButton={false}>
                  Dodaj wydatek
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <>
              <div className="flex flex-1 flex-col border-b">
                <div className="flex gap-4 p-4 pt-0 max-lg:flex-col lg:items-center lg:justify-between">
                  <SegmentedControl ariaLabel="Rodzaj wpisu" value={view} onValueChange={changeView} options={viewOptions} />
                  <div className="flex flex-1 flex-wrap items-center gap-3 lg:justify-end">
                    <TableSearch
                      value={globalFilter}
                      onChange={(value) => {
                        setGlobalFilter(value);
                        firstPage();
                      }}
                      placeholder="Szukaj w księdze"
                    />
                    {activeColumn ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="lg:hidden"
                        onClick={clearColumn}
                        aria-label={`Usuń filtr kolumny ${columnLabel(activeColumn)}`}
                      >
                        {columnLabel(activeColumn)}
                        <RiCloseLine aria-hidden />
                      </Button>
                    ) : null}
                    <div className="max-lg:hidden">
                      <ColumnSelectFilter
                        column={table.getColumn('column')!}
                        labels={COLUMN_FILTER_LABELS}
                        order={COLUMN_FILTER_ORDER}
                        allLabel="Wszystkie kolumny"
                        label="Kolumna KPiR"
                      />
                    </div>
                    <div className="max-lg:hidden">
                      <PageSizeSelect table={table} />
                    </div>
                  </div>
                </div>
                <DataTableView
                  table={table}
                  emptyText="Brak wpisów dla tych filtrów"
                  renderCard={(row) => <EntryCard entry={row.original} />}
                />
              </div>
              <DataTablePagination table={table} />
            </>
          )}
        </div>
      </Card>
    </>
  );
}

/**
 * Rząd nad księgą: karta wyniku i (gdy są koszty z sum) pierścień kosztów.
 * Pierścień chowa się na telefonie i bez kosztów — karta wyniku bierze wtedy
 * całą szerokość.
 */
function SummaryRow({
  totals,
  slices,
  monthTitle,
  series,
  lastDay,
  vatInCosts,
  uncountedCount,
  settledError,
  activeColumn,
  onSelectColumn,
  onShowUncounted,
}: {
  totals: KpirTotals;
  slices: readonly CostSlice[];
  monthTitle: string;
  series: readonly KpirSeriesPoint[];
  lastDay: number;
  vatInCosts: number;
  uncountedCount: number;
  settledError: boolean;
  activeColumn: string | undefined;
  onSelectColumn: (column: KpirColumnKey) => void;
  onShowUncounted: () => void;
}) {
  const donut = slices.some((slice) => slice.amount > 0);

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <KpirResultCard
        className={donut ? 'xl:col-span-2' : 'xl:col-span-3'}
        totals={totals}
        monthTitle={monthTitle}
        series={series}
        lastDay={lastDay}
        nonDeductedVat={vatInCosts}
        uncountedCount={uncountedCount}
        settledError={settledError}
        onShowUncounted={onShowUncounted}
      />
      {donut ? (
        <KpirCostStructureCard
          slices={slices}
          totalExpenses={totals.totalExpenses}
          activeColumn={activeColumn}
          onSelectColumn={onSelectColumn}
        />
      ) : null}
    </div>
  );
}
