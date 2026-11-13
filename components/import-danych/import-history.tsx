'use client';

import { useEffect, useRef, useState } from 'react';
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
  RiFileCodeLine,
  RiFileExcel2Line,
  RiForbidLine,
  RiHistoryLine,
  RiLoader4Line,
  type RemixiconComponentType,
} from '@remixicon/react';
import { toast } from 'sonner';

import { getImportJobStatusesAction } from '@/app/actions/job-statuses';
import { DataTablePagination, DataTableView, FinoraListCard } from '@/components/lists/finora-data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Progress } from '@/components/ui/progress';
import { useStatusPoll } from '@/hooks/use-status-poll';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import { countLabel } from '@/lib/i18n/plural';
import { cn } from '@/lib/utils';

import {
  completedSummary,
  failureNote,
  importProgressHref,
  INTERRUPTED_LEGACY_NOTE,
  isInterruptedLegacyImport,
  isKsefSource,
  isRunning,
  jobStatusGroup,
  progressPercent,
  runningStep,
  sourceDetail,
  sourceLabel,
  warningCount,
  type ImportHistoryJob,
  type ImportStatusGroup,
} from './import-model';

/**
 * Historia importów w karcie Finory sięgającej stopki (poprawka Bartosza
 * 22.10.2026: import danych w stylu Finory). Tabela od `lg`, karty niżej
 * (`DataTableView`), 10 wierszy na stronę — jak historia eksportów.
 *
 * Dane to wiersze `import_jobs` (RLS, klient użytkownika). Szczegóły joba
 * (liczniki, ostrzeżenia, „Spróbuj ponownie”) zostają na istniejącej stronie
 * postępu `/onboarding/progress/[id]` — wiersz tylko do niej prowadzi.
 *
 * Gdy coś się importuje, lista aktualizuje się sama: lekkie pytanie o status
 * z rosnącym odstępem, tylko na widocznej karcie, a stronę odświeżamy raz,
 * gdy status się zmieni (postęp idzie razem ze statusem); po 3 minutach
 * ręczne „Odśwież” (`hooks/use-status-poll.ts`). Koniec importu zgłasza
 * powiadomienie i jeden ukryty komunikat dla czytnika ekranu.
 *
 * Decyzja Bartosza 22.10.2026: dawny ręczny import z KSeF, który został
 * „w toku” albo się nie udał, jest przerwany (jego kolejki już nie ma) —
 * pokazujemy go jako „Anulowano” z notką i liczbą zapisanych faktur, bez
 * powodu „ponów import” i bez odpytywania serwera.
 */

const STATUS: Record<
  ImportStatusGroup,
  { icon: RemixiconComponentType; label: string; className: string; spin?: boolean }
> = {
  completed: {
    icon: RiCheckLine,
    label: 'Gotowe',
    className: 'bg-green-600/10 text-green-700 dark:bg-green-400/10 dark:text-green-400',
  },
  running: {
    icon: RiLoader4Line,
    label: 'W toku',
    className: 'bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400',
    spin: true,
  },
  failed: {
    icon: RiCloseLine,
    label: 'Błąd',
    className: 'bg-destructive/10 text-destructive',
  },
  cancelled: {
    icon: RiForbidLine,
    label: 'Anulowano',
    className: 'bg-muted text-muted-foreground',
  },
};

function StatusBadge({ job }: { job: ImportHistoryJob }) {
  const status = STATUS[jobStatusGroup(job)];
  const Icon = status.icon;
  return (
    <Badge className={status.className}>
      <Icon className={cn(status.spin && 'animate-spin')} aria-hidden />
      {status.label}
    </Badge>
  );
}

function SourceSquare({ job }: { job: ImportHistoryJob }) {
  const Icon = isKsefSource(job.source) ? RiHistoryLine : job.source === 'jpk_fa' ? RiFileCodeLine : RiFileExcel2Line;
  return (
    <span className="bg-muted flex size-9 shrink-0 items-center justify-center">
      <Icon className="size-5" aria-hidden />
    </span>
  );
}

function SourceCell({ job }: { job: ImportHistoryJob }) {
  const detail = sourceDetail(job);
  return (
    <div className="flex items-center gap-3">
      <SourceSquare job={job} />
      <div className="min-w-0">
        <p className="font-medium">{sourceLabel(job.source)}</p>
        {detail ? <p className="text-muted-foreground max-w-64 truncate text-xs">{detail}</p> : null}
      </div>
    </div>
  );
}

/** Wynik: liczby po imporcie, pasek w toku, powód przy błędzie. */
function ResultCell({ job }: { job: ImportHistoryJob }) {
  const group = jobStatusGroup(job);

  if (group === 'running') {
    const percent = progressPercent(job);
    return (
      <div className="w-full max-w-56 space-y-1.5">
        <p className="text-muted-foreground text-xs">
          {runningStep(job.status)} · <span className="tabular-nums">{percent}%</span>
        </p>
        <Progress
          value={percent}
          aria-label={`Postęp importu: ${sourceLabel(job.source)}`}
          className="*:data-[slot=progress-track]:h-1.5"
        />
      </div>
    );
  }

  if (group === 'completed') {
    const warnings = warningCount(job);
    return (
      <div className="space-y-0.5">
        <p>{completedSummary(job)}</p>
        {warnings > 0 ? (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {countLabel(warnings, ['ostrzeżenie', 'ostrzeżenia', 'ostrzeżeń'])}
          </p>
        ) : null}
      </div>
    );
  }

  if (group === 'cancelled') {
    if (!isInterruptedLegacyImport(job)) return <span className="text-muted-foreground">—</span>;
    // Zapisane faktury zostają w FaktWay — mówimy, ile ich jest; powodu „ponów import” nie pokazujemy.
    const { saved } = failureNote(job);
    return (
      <div className="max-w-md space-y-0.5 whitespace-normal">
        <p className="text-muted-foreground text-xs">{INTERRUPTED_LEGACY_NOTE}</p>
        {saved ? <p className="text-muted-foreground text-xs">{saved}</p> : null}
      </div>
    );
  }

  const { reason, saved } = failureNote(job);
  return (
    <div className="max-w-md space-y-0.5 whitespace-normal">
      <p className="text-destructive text-xs">{reason}</p>
      {saved ? <p className="text-muted-foreground text-xs">{saved}</p> : null}
    </div>
  );
}

function JobAction({ job, className }: { job: ImportHistoryJob; className?: string }) {
  const running = isRunning(job);
  return (
    <Button
      variant="outline"
      size="sm"
      className={className}
      render={<Link href={importProgressHref(job.id)} />}
      nativeButton={false}
      aria-label={`${running ? 'Postęp' : 'Szczegóły'}: ${sourceLabel(job.source)}, ${formatWarsawDateTime(job.created_at)}`}
    >
      {running ? 'Postęp' : 'Szczegóły'}
    </Button>
  );
}

const COLUMNS: ColumnDef<ImportHistoryJob>[] = [
  { header: 'Źródło', id: 'source', cell: ({ row }) => <SourceCell job={row.original} />, size: 300 },
  {
    header: 'Rozpoczęto',
    id: 'created',
    cell: ({ row }) => (
      <span className="text-muted-foreground tabular-nums">{formatWarsawDateTime(row.original.created_at)}</span>
    ),
    size: 160,
  },
  { header: 'Wynik', id: 'result', cell: ({ row }) => <ResultCell job={row.original} />, size: 300 },
  { header: 'Status', id: 'status', cell: ({ row }) => <StatusBadge job={row.original} />, size: 120 },
  {
    id: 'actions',
    header: () => <span className="sr-only">Akcje</span>,
    cell: ({ row }) => (
      <div className="pr-2 text-right">
        <JobAction job={row.original} />
      </div>
    ),
    size: 120,
  },
];

function JobCard({ job }: { job: ImportHistoryJob }) {
  return (
    <FinoraListCard
      leading={<SourceSquare job={job} />}
      title={sourceLabel(job.source)}
      subtitle={sourceDetail(job) ?? undefined}
      subtitleClassName="font-sans"
      amount={<StatusBadge job={job} />}
      meta={
        <>
          <span className="tabular-nums">{formatWarsawDateTime(job.created_at)}</span>
          <div className="text-foreground basis-full text-sm">
            <ResultCell job={job} />
          </div>
        </>
      }
      actions={<JobAction job={job} className="w-full sm:w-auto" />}
    />
  );
}

const PAGE_SIZE = 10;

/** Kroki „jak to działa” w pustej historii (decyzja Bartosza 22.10.2026: historia z KSeF bez ręcznego startu). */
export const EMPTY_STEPS = [
  'Wgraj certyfikat KSeF',
  'Historię z KSeF pobieramy sami',
  'Pliki z innego programu wgrasz tu raz',
] as const;

/** Pusta historia: trzy kroki zamiast samego „Brak importów”. */
function HistoryEmpty() {
  return (
    <Empty className="flex-1 border-t py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RiHistoryLine />
        </EmptyMedia>
        <EmptyTitle>Brak importów</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <ol className="text-muted-foreground grid w-full gap-2 text-left text-xs sm:grid-cols-3 sm:text-center">
          {EMPTY_STEPS.map((step, index) => (
            <li key={step} className="flex items-center gap-2 sm:flex-col sm:gap-1.5">
              <span className="text-foreground flex size-6 shrink-0 items-center justify-center border text-xs font-medium tabular-nums">
                {index + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      </EmptyContent>
    </Empty>
  );
}

export function ImportHistory({ jobs }: { jobs: ImportHistoryJob[] }) {
  const router = useRouter();
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE });
  const liveRef = useRef<HTMLParagraphElement>(null);
  const seenRunning = useRef(new Set<string>());

  // Plan skalowania, sesja 11: takt pyta lekką akcją o statusy importów
  // w toku, a stronę odświeżamy raz, gdy status się zmieni (dawniej
  // `router.refresh()` co 4 s). Postęp importu zmienia się razem ze statusem
  // (`lib/jobs/runners/bulk-import.ts`), więc pasek nadąża. Dawny ręczny import
  // z KSeF „w toku” nie jest `isRunning`, więc go nie odpytujemy.
  const { capped: pollingCapped, resume: resumePolling } = useStatusPoll({
    jobs: jobs.filter(isRunning),
    read: getImportJobStatusesAction,
  });

  // Powiadomienie tylko o importach, które trwały w czasie tej wizyty.
  useEffect(() => {
    const announce = (text: string) => {
      if (liveRef.current) liveRef.current.textContent = text;
    };
    for (const job of jobs) {
      if (isRunning(job)) {
        seenRunning.current.add(job.id);
        continue;
      }
      if (!seenRunning.current.has(job.id)) continue;
      seenRunning.current.delete(job.id);
      const name = sourceLabel(job.source);
      const group = jobStatusGroup(job);
      if (group === 'completed') {
        toast.success('Import zakończony', { description: completedSummary(job) });
        announce(`Import zakończony: ${name}. ${completedSummary(job)}`);
      } else if (group === 'failed') {
        toast.error('Import się nie udał', { description: failureNote(job).reason });
        announce(`Import się nie udał: ${name}`);
      }
    }
  }, [jobs]);

  // eslint-disable-next-line react-hooks/incompatible-library -- tanstack zwraca funkcje, których React Compiler nie zapamiętuje (jak w Finorze)
  const table = useReactTable({
    data: jobs,
    columns: COLUMNS,
    getRowId: (row) => row.id,
    state: { pagination },
    // Odświeżenie po zmianie statusu podmienia `jobs` — bez tego tabela wracałaby na stronę 1.
    autoResetPageIndex: false,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const lastPageIndex = Math.max(0, table.getPageCount() - 1);
  if (pagination.pageIndex > lastPageIndex) setPagination((p) => ({ ...p, pageIndex: lastPageIndex }));

  const showPagination = jobs.length > PAGE_SIZE;

  return (
    <div className="flex w-full flex-1 flex-col">
      <div className="flex min-h-7 items-center justify-between gap-3 p-4 pt-0">
        <h2 className="text-base font-semibold">Historia importów</h2>
        {pollingCapped ? (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => {
              resumePolling();
              router.refresh();
            }}
          >
            Odśwież
          </Button>
        ) : null}
      </div>

      {jobs.length === 0 ? (
        <HistoryEmpty />
      ) : (
        <>
          <div className={cn('flex-1', showPagination && 'border-b')}>
            <DataTableView table={table} renderCard={(row) => <JobCard job={row.original} />} />
          </div>
          {showPagination ? <DataTablePagination table={table} /> : null}
        </>
      )}

      <p ref={liveRef} className="sr-only" aria-live="polite" />
    </div>
  );
}
