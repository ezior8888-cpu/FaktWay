'use client';

// Plan Finora P15 (E10b): postęp importu na prymitywach Finory (`Card`,
// belka postępu w kolorze `--primary` jak `ui/progress` Finory, `Button`,
// ikony Remix) zamiast szkła i gradientu. Logika bez zmian: stan z SSR
// + Supabase Realtime.
//
// Decyzja Bartosza 22.10.2026: Magiczny import znika. Dawny ręczny import
// z KSeF, który został „w toku”, już się nie skończy (kolejki nie ma) —
// pokazujemy go jako przerwany i odsyłamy do Importu danych, gdzie historia
// z KSeF pobiera się sama. Tak samo nieudany (poprawka po przeglądzie): jego
// zapisany powód kazał „ponowić import”, a „Spróbuj ponownie” prowadził na
// ekran, na którym tego importu już nie ma. Bez obietnicy e-maila po imporcie.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  RiArrowRightLine,
  RiBox3Line,
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiFileTextLine,
  RiForbidLine,
  RiGroupLine,
  RiLoader4Line,
  RiSparkling2Line,
} from '@remixicon/react';

import { INTERRUPTED_LEGACY_NOTE, isInterruptedLegacyImport } from '@/components/import-danych/import-model';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { countLabel } from '@/lib/i18n/plural';
import { createClient } from '@/lib/supabase/client';
import type { Database, Json } from '@/types/database';

export type ImportJobRow = Database['public']['Tables']['import_jobs']['Row'];

interface ImportJob {
  id: string;
  status: string;
  progress_percent: number;
  progress_message: string | null;
  source: string;
  invoices_found: number;
  invoices_imported: number;
  contractors_created: number;
  contractors_updated: number;
  products_created: number;
  warnings: Json;
  error_message: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Inicjalizacja',
  queued: 'Kolejkowanie',
  parsing: 'Wczytywanie danych',
  extracting: 'Pobieranie faktur',
  deduplicating: 'Analiza danych',
  inserting: 'Zapisywanie',
  completed: 'Gotowe',
  failed: 'Błąd',
  cancelled: 'Anulowano',
};

function normalizeJob(row: ImportJobRow): ImportJob {
  return {
    id: row.id,
    status: row.status,
    progress_percent: row.progress_percent,
    progress_message: row.progress_message,
    source: row.source ?? '',
    invoices_found: row.invoices_found ?? 0,
    invoices_imported: row.invoices_imported ?? 0,
    contractors_created: row.contractors_created ?? 0,
    contractors_updated: row.contractors_updated ?? 0,
    products_created: row.products_created ?? 0,
    warnings: row.warnings,
    error_message: row.status === 'failed' ? row.progress_message : null,
  };
}

interface ImportProgressViewProps {
  initialJob: ImportJobRow;
}

/** Postęp importu: SSR + Supabase Realtime (`import_jobs`). */
export function ImportProgressView({ initialJob }: ImportProgressViewProps) {
  const router = useRouter();
  const [job, setJob] = useState<ImportJob>(() => normalizeJob(initialJob));

  useEffect(() => {
    const supabase = createClient();
    const jobId = initialJob.id;

    const channel = supabase
      .channel(`import-job-${jobId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'import_jobs',
          filter: `id=eq.${jobId}`,
        },
        (payload) => {
          setJob(normalizeJob(payload.new as ImportJobRow));
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [initialJob.id]);

  const isCompleted = job.status === 'completed';
  const isFailed = job.status === 'failed';
  // Ta sama reguła co w historii importów: dawny import z KSeF „w toku” albo nieudany.
  const isInterruptedLegacy = isInterruptedLegacyImport(job);
  const warningList = Array.isArray(job.warnings)
    ? job.warnings.filter((w): w is string => typeof w === 'string')
    : [];

  if (isCompleted) {
    return (
      <div className="space-y-6">
        <div className="space-y-3">
          <div className="flex size-12 items-center justify-center bg-primary/10 text-primary">
            <RiCheckboxCircleLine className="size-6" />
          </div>
          <h1 className="mb-2 text-2xl font-semibold">
            Import zakończony!
          </h1>
          <p className="text-muted-foreground">
            Twoje konto jest gotowe. Możesz wystawiać faktury od ręki.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Card size="sm" className="items-center text-center">
            <RiFileTextLine className="mx-auto mb-2 size-5 text-muted-foreground" />
            <p className="font-mono text-2xl font-semibold">
              {job.invoices_imported}
            </p>
            <p className="text-xs text-muted-foreground">Faktury</p>
          </Card>
          <Card size="sm" className="items-center text-center">
            <RiGroupLine className="mx-auto mb-2 size-5 text-muted-foreground" />
            <p className="font-mono text-2xl font-semibold">
              {job.contractors_created + job.contractors_updated}
            </p>
            <p className="text-xs text-muted-foreground">Kontrahenci</p>
          </Card>
          <Card size="sm" className="items-center text-center">
            <RiBox3Line className="mx-auto mb-2 size-5 text-muted-foreground" />
            <p className="font-mono text-2xl font-semibold">
              {job.products_created}
            </p>
            <p className="text-xs text-muted-foreground">Produkty</p>
          </Card>
        </div>

        {warningList.length > 0 && (
          <div className="border border-amber-500/40 bg-card p-3">
            <p className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-400">
              Ostrzeżenia ({warningList.length})
            </p>
            <ul className="text-sm text-muted-foreground space-y-1 max-h-32 overflow-y-auto">
              {warningList.slice(0, 5).map((w, i) => (
                <li key={`${w}-${i}`}>• {w}</li>
              ))}
              {warningList.length > 5 && (
                <li className="italic">...i {warningList.length - 5} więcej</li>
              )}
            </ul>
          </div>
        )}

        <Button
          type="button"
          onClick={() => router.push('/dashboard?welcome=1')}
          size="lg"
          className="w-full"
        >
          Przejdź do panelu
          <RiArrowRightLine />
        </Button>
      </div>
    );
  }

  if (isInterruptedLegacy) {
    return (
      <div className="space-y-5">
        <div className="space-y-3">
          <div className="flex size-12 items-center justify-center bg-muted text-muted-foreground">
            <RiForbidLine className="size-6" />
          </div>
          <h1 className="mb-2 text-2xl font-semibold">Import przerwany</h1>
          <p role="status" className="text-muted-foreground">
            {`${INTERRUPTED_LEGACY_NOTE}. Historię z KSeF pobieramy teraz sami — postęp zobaczysz w Imporcie danych.`}
          </p>
          {job.invoices_imported > 0 ? (
            <p className="text-muted-foreground text-sm">
              {`Zapisano ${countLabel(job.invoices_imported, ['fakturę', 'faktury', 'faktur'])}.`}
            </p>
          ) : null}
        </div>

        <Button type="button" onClick={() => router.push('/import-danych')} size="lg" className="w-full">
          Przejdź do Importu danych
          <RiArrowRightLine />
        </Button>
      </div>
    );
  }

  if (isFailed) {
    return (
      <div className="space-y-5">
        <div className="space-y-3">
          <div className="flex size-12 items-center justify-center bg-destructive/10 text-destructive">
            <RiCloseCircleLine className="size-6" />
          </div>
          <h1 className="mb-2 text-2xl font-semibold">
            Import się nie udał
          </h1>
          <p role="alert" className="text-muted-foreground">
            {job.error_message ?? job.progress_message ?? 'Wystąpił nieoczekiwany błąd'}
          </p>
        </div>

        <div className="flex gap-2">
          <Button
            type="button"
            onClick={() => router.push('/onboarding/import-source')}
            variant="outline"
            size="lg"
            className="flex-1"
          >
            Spróbuj ponownie
          </Button>
          <Button
            type="button"
            onClick={() => router.push('/dashboard?welcome=1')}
            size="lg"
            className="flex-1"
          >
            Pomiń
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex size-12 items-center justify-center bg-primary/10 text-primary">
          <RiSparkling2Line className="size-6" />
        </div>
        <h1 className="mb-2 text-2xl font-semibold">
          {STATUS_LABELS[job.status] ?? 'Import w toku'}
        </h1>
        <p role="status" className="text-muted-foreground">
          {job.progress_message ?? 'Pracujemy nad Twoimi danymi...'}
        </p>
      </div>

      <div className="space-y-2">
        <div
          className="h-1 overflow-hidden bg-muted"
          role="progressbar"
          aria-label="Postęp importu"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, Math.max(0, job.progress_percent))}
        >
          <div
            className="h-full bg-primary transition-all duration-500"
            style={{
              width: `${Math.min(100, Math.max(0, job.progress_percent))}%`,
            }}
          />
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="font-mono">{job.progress_percent}%</span>
          {job.invoices_found > 0 && <span>{job.invoices_found} faktur znalezionych</span>}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        <RiLoader4Line className="mr-1 inline size-3 animate-spin" aria-hidden />
        Możesz zamknąć tę stronę — skończymy w tle. Wynik zobaczysz w Imporcie danych.
      </p>
    </div>
  );
}
