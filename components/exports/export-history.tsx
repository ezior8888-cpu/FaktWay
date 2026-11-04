'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
  type ColumnDef,
  type PaginationState,
} from '@tanstack/react-table';
import {
  RiCheckLine,
  RiCloseLine,
  RiDownloadLine,
  RiFileChart2Line,
  RiFolderOpenLine,
  RiInboxLine,
  RiLoader4Line,
  RiMailSendLine,
  RiTimeLine,
  type RemixiconComponentType,
} from '@remixicon/react';
import { toast } from 'sonner';

import { downloadExportFileAction, startExportAction } from '@/app/actions/exports';
import { DataTablePagination, DataTableView, FinoraListCard } from '@/components/lists/finora-data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { saveBlob } from '@/lib/download';
import { isExportFormatSuspended, SUSPENDED_EXPORT_FORMATS } from '@/lib/exports/suspended-formats';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import { countLabel } from '@/lib/i18n/plural';
import { cn } from '@/lib/utils';

import { exportFixFor, friendlyStartError } from './export-fixes';
import {
  FORMAT_ICONS,
  formatFileSize,
  formatLabel,
  includesForJob,
  type ExportFormat,
  type ExportJobStatus,
  type ManualExportJobWithFiles,
} from './export-formats';
import { describeExportPeriod, formatExportRange } from './export-period';

/**
 * Historia ręcznych eksportów w karcie z zakładkami Księgowości (poprawka
 * Bartosza 21.10.2026: przeprojektowanie Księgowości). Tabela Finory od `lg`,
 * karty niżej (`DataTableView`), 10 wierszy na stronę.
 *
 * Co się zmieniło względem listy z P13:
 * - powód odmowy tylko przy „Błąd” i zawsze z przyciskiem naprawy
 *   (`exportFixFor`); gotowy plik nigdy nie pokazuje starego błędu;
 * - zakończony eksport bez pliku to „Pusty” z wyjaśnieniem, nie zielone „Gotowe”;
 * - wiersze „Oczekuje” / „Generowanie” odświeżają się same (co 4 s, gdy karta
 *   jest widoczna, najwyżej 45 razy — potem ręczne „Odśwież”), a gotowy plik
 *   zgłasza się powiadomieniem z „Pobierz”;
 * - pobranie nie odświeża strony (licznik pobrań nie jest tu pokazywany).
 */

/** Co ile odpytujemy serwer o eksporty w toku i ile razy najwyżej (3 minuty). */
export const POLL_INTERVAL_MS = 4000;
export const MAX_POLL_TICKS = 45;

type HistoryStatus = ExportJobStatus | 'empty';

// Kolory statusów jak `TRANSACTION_STATUS_STYLES` w Finorze (klasy bez zmian względem P13).
const STATUS_MAP: Record<
  HistoryStatus,
  { icon: RemixiconComponentType; label: string; className: string; spin?: boolean }
> = {
  completed: {
    icon: RiCheckLine,
    label: 'Gotowe',
    className: 'bg-green-600/10 text-green-700 dark:bg-green-400/10 dark:text-green-400',
  },
  empty: {
    icon: RiInboxLine,
    label: 'Pusty',
    className: 'bg-muted text-muted-foreground',
  },
  failed: {
    icon: RiCloseLine,
    label: 'Błąd',
    className: 'bg-destructive/10 text-destructive',
  },
  generating: {
    icon: RiLoader4Line,
    label: 'Generowanie',
    className: 'bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400',
    spin: true,
  },
  pending: {
    icon: RiTimeLine,
    label: 'Oczekuje',
    className: 'bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400',
  },
  expired: {
    icon: RiTimeLine,
    label: 'Wygasłe',
    className: 'bg-muted text-muted-foreground',
  },
};

const fileOf = (job: ManualExportJobWithFiles) => job.export_files?.[0];

const isInProgress = (job: ManualExportJobWithFiles) => job.status === 'pending' || job.status === 'generating';

function historyStatus(job: ManualExportJobWithFiles): HistoryStatus {
  return job.status === 'completed' && !fileOf(job) ? 'empty' : job.status;
}

const periodOf = (job: ManualExportJobWithFiles) => describeExportPeriod(job.period_start, job.period_end);

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/** Pobranie pliku — przebieg bez zmian: akcja serwera → Blob → zapis; błąd w powiadomieniu. */
async function downloadFile(fileId: string): Promise<void> {
  const result = await downloadExportFileAction(fileId).catch(() => ({
    success: false as const,
    error: 'Nie udało się pobrać pliku. Spróbuj ponownie.',
  }));
  if (!result.success) {
    toast.error(result.error);
    return;
  }
  saveBlob(base64ToBlob(result.base64, result.mimeType), result.filename);
  toast.success('Plik pobrany');
}

/** Ikona formatu; wartość spoza enuma (stare dane, podgląd) dostaje ikonę ogólną, nie wywraca listy. */
const ICON_BY_FORMAT: Readonly<Partial<Record<string, RemixiconComponentType>>> = FORMAT_ICONS;

function FormatSquare({ format }: { format: ExportFormat }) {
  const Icon = ICON_BY_FORMAT[format] ?? RiFileChart2Line;
  return (
    <span className="bg-muted flex size-9 shrink-0 items-center justify-center">
      <Icon className="size-5" aria-hidden />
    </span>
  );
}

/**
 * Plakietka bez `aria-live` (poprawka Bartosza 21.10.2026: przeprojektowanie
 * Księgowości): przy odpytywaniu czytnik mówił samo „Generowanie”, „Gotowe”
 * — bez pliku i okresu, a zaraz potem to samo powtarzał komunikat niżej.
 * Zmianę statusu ogłasza tylko ukryty komunikat w `RecentExports`.
 */
function StatusBadge({ job }: { job: ManualExportJobWithFiles }) {
  const status = STATUS_MAP[historyStatus(job)];
  const Icon = status.icon;
  return (
    <Badge className={status.className}>
      <Icon className={cn(status.spin && 'animate-spin')} aria-hidden />
      {status.label}
    </Badge>
  );
}

function SuspendedBadge({ format }: { format: string }) {
  if (!isExportFormatSuspended(format)) return null;
  return (
    <Badge variant="outline" title={SUSPENDED_EXPORT_FORMATS[format]}>
      Wycofany
    </Badge>
  );
}

/** „12 faktur · 14,2 KB”; KPiR bez liczby faktur, bo `invoices_count` pomija koszty. */
function fileSummary(job: ManualExportJobWithFiles): string | null {
  const parts: string[] = [];
  if (job.status === 'completed' && job.format !== 'kpir_excel') {
    parts.push(countLabel(job.invoices_count ?? 0, ['faktura', 'faktury', 'faktur']));
  }
  const size = formatFileSize(fileOf(job)?.size_bytes);
  if (size) parts.push(size);
  return parts.length ? parts.join(' · ') : null;
}

/** Powód pod nazwą pliku: błąd tylko przy „Błąd”, wyjaśnienie przy „Pusty”. */
function jobNote(job: ManualExportJobWithFiles): { text: string; tone: 'error' | 'muted' } | null {
  if (job.status === 'failed' && job.error_message) return { text: job.error_message, tone: 'error' };
  if (historyStatus(job) === 'empty') {
    return { text: job.progress_message ?? 'Brak dokumentów w tym okresie', tone: 'muted' };
  }
  return null;
}

function FileCell({ job }: { job: ManualExportJobWithFiles }) {
  const summary = fileSummary(job);
  const note = jobNote(job);
  return (
    <div className="flex items-start gap-3">
      <FormatSquare format={job.format} />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          {formatLabel(job.format)}
          <SuspendedBadge format={job.format} />
        </p>
        {summary ? <p className="text-muted-foreground text-xs">{summary}</p> : null}
        {note ? (
          <p
            className={cn(
              'mt-1 max-w-md text-xs whitespace-normal',
              note.tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {note.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Przycisk w wierszu: „Pobierz” przy gotowym pliku, naprawa przy błędzie / wygaśnięciu. */
function JobAction({ job, className }: { job: ManualExportJobWithFiles; className?: string }) {
  const router = useRouter();
  const [isDownloading, startDownload] = useTransition();
  const [isRunning, startRun] = useTransition();
  const file = fileOf(job);

  if (job.status === 'completed' && file) {
    return (
      <Button
        variant="outline"
        size="sm"
        type="button"
        className={className}
        disabled={isDownloading}
        aria-label={`Pobierz ${formatLabel(job.format)}, ${periodOf(job)}`}
        onClick={() => startDownload(() => downloadFile(file.id))}
      >
        {isDownloading ? <RiLoader4Line className="animate-spin" aria-hidden /> : <RiDownloadLine aria-hidden />}
        Pobierz
      </Button>
    );
  }

  const fix = exportFixFor(job);
  if (!fix) return null;

  if (fix.kind === 'link') {
    return (
      <Button variant="outline" size="sm" className={className} render={<Link href={fix.href} />} nativeButton={false}>
        {fix.label}
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      type="button"
      className={className}
      disabled={isRunning}
      onClick={() =>
        startRun(async () => {
          const result = await startExportAction({
            format: job.format,
            periodStart: job.period_start,
            periodEnd: job.period_end,
            ...includesForJob(job),
          }).catch(() => ({ success: false as const, error: '' }));
          if (result.success) {
            toast.success('Generujemy plik');
            router.refresh();
          } else {
            toast.error(friendlyStartError(result.error));
          }
        })
      }
    >
      {isRunning ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
      {fix.label}
    </Button>
  );
}

const COLUMNS: ColumnDef<ManualExportJobWithFiles>[] = [
  {
    header: 'Plik',
    id: 'file',
    cell: ({ row }) => <FileCell job={row.original} />,
    size: 320,
  },
  {
    header: 'Okres',
    id: 'period',
    cell: ({ row }) => (
      <span title={formatExportRange(row.original.period_start, row.original.period_end)}>{periodOf(row.original)}</span>
    ),
    size: 180,
  },
  {
    header: 'Utworzono',
    id: 'created',
    cell: ({ row }) => (
      <span className="text-muted-foreground tabular-nums">
        {row.original.created_at ? formatWarsawDateTime(row.original.created_at) : '—'}
      </span>
    ),
    size: 160,
  },
  {
    header: 'Status',
    id: 'status',
    cell: ({ row }) => <StatusBadge job={row.original} />,
    size: 140,
  },
  {
    id: 'actions',
    header: () => <span className="sr-only">Akcje</span>,
    cell: ({ row }) => (
      <div className="pr-2 text-right">
        <JobAction job={row.original} />
      </div>
    ),
    size: 140,
  },
];

function JobCard({ job }: { job: ManualExportJobWithFiles }) {
  const note = jobNote(job);
  const size = formatFileSize(fileOf(job)?.size_bytes);
  const action = <JobAction job={job} className="w-full sm:w-auto" />;
  return (
    <FinoraListCard
      leading={<FormatSquare format={job.format} />}
      title={
        <span className="inline-flex items-center gap-2">
          {formatLabel(job.format)}
          <SuspendedBadge format={job.format} />
        </span>
      }
      amount={<StatusBadge job={job} />}
      meta={
        <>
          <span title={formatExportRange(job.period_start, job.period_end)}>{periodOf(job)}</span>
          {job.created_at ? <span className="tabular-nums">{formatWarsawDateTime(job.created_at)}</span> : null}
          {size ? <span className="tabular-nums">{size}</span> : null}
          {note ? (
            <span
              className={cn(
                'basis-full text-xs whitespace-normal',
                note.tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {note.text}
            </span>
          ) : null}
        </>
      }
      actions={(job.status === 'completed' && fileOf(job)) || exportFixFor(job) ? action : undefined}
    />
  );
}

const PAGE_SIZE = 10;

export function RecentExports({ jobs }: { jobs: ManualExportJobWithFiles[] }) {
  const router = useRouter();
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE });
  const [ticks, setTicks] = useState(0);
  const liveRef = useRef<HTMLParagraphElement>(null);
  const seenInProgress = useRef(new Set<string>());

  const inProgressKey = jobs
    .filter(isInProgress)
    .map((job) => job.id)
    .join(',');
  // Nowy eksport w toku (albo któryś się skończył) — licznik odpytań od nowa.
  // Stan dopasowany w trakcie renderu (wzorzec z dokumentacji Reacta), bez efektu.
  const [pollKey, setPollKey] = useState(inProgressKey);
  if (pollKey !== inProgressKey) {
    setPollKey(inProgressKey);
    setTicks(0);
  }
  const polling = inProgressKey !== '' && ticks < MAX_POLL_TICKS;
  const pollingCapped = inProgressKey !== '' && ticks >= MAX_POLL_TICKS;

  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      // Karta w tle nie odpytuje serwera — nie wydajemy też limitu odpytań.
      if (document.visibilityState !== 'visible') return;
      setTicks((count) => count + 1);
      router.refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [polling, router]);

  // Powiadomienie tylko o eksportach, które były w toku w czasie tej wizyty —
  // nie o tych, które skończyły się, zanim strona się otworzyła. Czytnik ekranu
  // dostaje jeden komunikat na zdarzenie, zawsze z nazwą pliku i okresem — także
  // przy błędzie (dawniej tylko bezimienne „Błąd” z plakietki).
  useEffect(() => {
    const announce = (text: string) => {
      if (liveRef.current) liveRef.current.textContent = text;
    };
    for (const job of jobs) {
      if (isInProgress(job)) {
        seenInProgress.current.add(job.id);
        continue;
      }
      if (!seenInProgress.current.has(job.id)) continue;
      seenInProgress.current.delete(job.id);
      const file = fileOf(job);
      const name = `${formatLabel(job.format)}, ${periodOf(job)}`;
      if (job.status === 'completed' && file) {
        toast.success('Plik gotowy', { action: { label: 'Pobierz', onClick: () => void downloadFile(file.id) } });
        announce(`Plik gotowy: ${name}`);
      } else if (job.status === 'failed') {
        toast.error('Eksport nie powstał');
        announce(`Eksport nie powstał: ${name}`);
      } else if (historyStatus(job) === 'empty') {
        // Bez powiadomienia (nie ma czego pobrać), ale czytnik słyszał to dawniej z plakietki.
        announce(`Plik pusty: ${name}`);
      }
    }
  }, [jobs]);

  // eslint-disable-next-line react-hooks/incompatible-library -- tanstack zwraca funkcje, których React Compiler nie zapamiętuje (jak w Finorze)
  const table = useReactTable({
    data: jobs,
    columns: COLUMNS,
    getRowId: (row) => row.id,
    state: { pagination },
    // Odpytywanie podmienia `jobs` co 4 s — bez tego tabela wracałaby na stronę 1.
    autoResetPageIndex: false,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const lastPageIndex = Math.max(0, table.getPageCount() - 1);
  if (pagination.pageIndex > lastPageIndex) setPagination((p) => ({ ...p, pageIndex: lastPageIndex }));

  const showPagination = jobs.length > PAGE_SIZE;

  return (
    <>
      <div className="flex items-center justify-between gap-3 p-4 pt-0">
        <h2 className="text-base font-semibold">Historia</h2>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {pollingCapped ? (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => {
                setTicks(0);
                router.refresh();
              }}
            >
              Odśwież
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" render={<Link href="/settings/accountant" />} nativeButton={false}>
            <RiMailSendLine aria-hidden />
            Wysyłka do księgowej
          </Button>
        </div>
      </div>

      {jobs.length === 0 ? (
        <Empty className="flex-1 border-t py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RiFolderOpenLine />
            </EmptyMedia>
            <EmptyTitle>Brak eksportów</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className={cn('flex-1', showPagination && 'border-b')}>
            <DataTableView table={table} renderCard={(row) => <JobCard job={row.original} />} />
          </div>
          {showPagination ? <DataTablePagination table={table} /> : null}
        </>
      )}

      <p ref={liveRef} className="sr-only" aria-live="polite" />
    </>
  );
}

/** Szkielet historii (Suspense i loading.tsx): nagłówek i pięć wierszy, bez napisu. */
export function ExportHistorySkeleton() {
  return (
    <div className="flex flex-1 flex-col" aria-busy="true">
      <div className="flex items-center justify-between gap-3 p-4 pt-0">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-7 w-44" />
      </div>
      <div className="space-y-2 border-t p-4">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-14 w-full" />
        ))}
      </div>
    </div>
  );
}
