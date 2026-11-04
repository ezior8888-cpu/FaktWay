import Link from 'next/link';
import {
  RiBuilding2Line,
  RiContactsBook3Line,
  RiDownloadCloud2Line,
  RiFileExcel2Line,
  RiHistoryLine,
} from '@remixicon/react';

import StatsCards, { type StatItem } from '@/components/dashboard/stats-cards';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatPlInt } from '@/lib/format/pl';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import type { KsefHistorySyncStatus } from '@/lib/ksef/history-sync/status';
import { cn } from '@/lib/utils';

import { ImportHistory } from './import-history';
import { IMPORT_HISTORY_LIMIT, summarizeImports, type ImportHistoryJob } from './import-model';
import { ImportSourceGrid } from './import-source-grid';
import { KsefHistoryCard } from './ksef-history-card';
import type { PauseError } from './ksef-history-model';

/**
 * Centrum importu — ekran `/import-danych` (poprawka Bartosza 22.10.2026:
 * import danych w stylu Finory). Układ Accounts z Finory: nagłówek z podpisem,
 * kafle z liczbami, karta „Historia z KSeF”, siatka „Przeprowadzka z innego
 * programu”, a na końcu karta z historią importów sięgająca stopki
 * (`ff-page-fill`).
 *
 * Decyzja Bartosza 22.10.2026: Magiczny import znika. Historię z KSeF
 * FaktWay pobiera sam (`ksef-history-sync`), a z pliku zostają tylko cztery
 * duże programy. Kafle rozdzielają więc KSeF od plików.
 *
 * Ten plik tylko składa ekran (bez `'use client'` i bez zapytań): strona
 * podaje dane z `tenants`, `import_jobs` i stanu synchronizacji historii.
 *
 * Kafle pokazujemy dopiero, gdy jest cokolwiek do pokazania (import z pliku,
 * synchronizacja z KSeF albo pobrane faktury) — przy pierwszej wizycie rząd
 * zer niczego nie mówi, a pusta historia ma trzy kroki „jak to działa”. Gdy
 * historii importów nie da się wczytać, kafli nie ma wcale (nie znamy liczb),
 * a karta historii mówi o błędzie i daje „Odśwież”.
 */

export interface ImportCenterProps {
  tenantId: string;
  tenantName?: string | null;
  nip?: string | null;
  hasCertificate: boolean;
  /**
   * Certyfikat potwierdzony dla skonfigurowanego środowiska KSeF — tylko
   * takim firmom cron pobiera historię (poprawka po przeglądzie, decyzja
   * Bartosza 22.10.2026).
   */
  certificateConfirmed: boolean;
  /** `null` — historii nie udało się wczytać. */
  jobs: ImportHistoryJob[] | null;
  /** Stan pobierania historii z KSeF; `null` — nie udało się go wczytać. */
  ksefHistory: KsefHistorySyncStatus | null;
  /** Tylko właściciel wstrzymuje i wznawia pobieranie historii. */
  isOwner: boolean;
  /** `?wstrzymanie=blad|2fa` — poprzednia zmiana wstrzymania się nie udała. */
  pauseError?: PauseError | null;
  now?: Date;
}

export function ImportHeader({ tenantName, nip }: { tenantName?: string | null; nip?: string | null }) {
  return (
    <div className="flex justify-between gap-3 max-sm:flex-col sm:items-center">
      <div>
        <h1 className="text-2xl font-semibold">Import danych</h1>
        <p className="text-muted-foreground text-sm">
          Faktury z KSeF pobieramy automatycznie. Z poprzedniego programu przeniesiesz je plikiem.
        </p>
      </div>
      {nip ? (
        // Do której firmy trafią faktury — ważne przy kilku firmach na jednym koncie.
        <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-sm">
          <RiBuilding2Line className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            {tenantName ? <span className="text-foreground font-medium">{tenantName}</span> : null}
            {tenantName ? ' · ' : null}NIP <span className="font-mono">{nip}</span>
          </span>
        </p>
      ) : null}
    </div>
  );
}

/** Czy synchronizacja historii z KSeF już coś ma (strumień albo pobrane faktury). */
function hasKsefHistory(status: KsefHistorySyncStatus | null): boolean {
  if (!status) return false;
  return (
    status.outgoing.phase !== 'waiting' ||
    status.incoming.phase !== 'waiting' ||
    status.outgoing.counts.imported + status.incoming.counts.imported > 0
  );
}

/** Kafle pokazujemy, gdy jest jakikolwiek import albo synchronizacja z KSeF. */
export function showsImportStats(jobs: readonly ImportHistoryJob[], ksefHistory: KsefHistorySyncStatus | null): boolean {
  return jobs.length > 0 || hasKsefHistory(ksefHistory);
}

/**
 * Kafle: historia z KSeF (automatyczna + dawny ręczny import), faktury
 * z plików, nowi kontrahenci z plików i ostatnie pobranie z KSeF.
 * Naprawione faktury (`repaired`) nie są nowymi — kafel ich nie liczy.
 */
export function importStats(jobs: readonly ImportHistoryJob[], ksefHistory: KsefHistorySyncStatus | null): StatItem[] {
  const summary = summarizeImports(jobs);
  const partialNote = summary.partial ? `z ostatnich ${IMPORT_HISTORY_LIMIT} importów` : undefined;

  let ksefTile: StatItem;
  if (ksefHistory) {
    const sales = ksefHistory.outgoing.counts.imported + summary.legacyKsefIssued;
    const purchases = ksefHistory.incoming.counts.imported + summary.legacyKsefReceived;
    ksefTile = {
      label: 'Historia z KSeF',
      value: formatPlInt(sales + purchases),
      icon: RiHistoryLine,
      note: `sprzedaż ${formatPlInt(sales)} · zakupy ${formatPlInt(purchases)}`,
    };
  } else {
    // Stanu nie znamy — nie pokazujemy liczby mniejszej niż prawdziwa.
    ksefTile = { label: 'Historia z KSeF', value: '—', icon: RiHistoryLine, note: 'nie udało się wczytać' };
  }

  const lastFetch = ksefHistory?.outgoing.lastSuccessAt ?? ksefHistory?.incoming.lastSuccessAt ?? null;

  return [
    ksefTile,
    {
      label: 'Zaimportowane z plików',
      value: formatPlInt(summary.fileInvoices),
      icon: RiFileExcel2Line,
      note: partialNote,
    },
    {
      label: 'Nowi kontrahenci',
      value: formatPlInt(summary.fileContractors),
      icon: RiContactsBook3Line,
      note: partialNote ? `z importów plików, ${partialNote}` : 'z importów plików',
    },
    {
      label: 'Ostatnie pobranie z KSeF',
      value: lastFetch ? formatWarsawDateTime(lastFetch) : '—',
      valueClassName: lastFetch ? 'text-lg' : undefined,
      icon: RiDownloadCloud2Line,
    },
  ];
}

function HistoryError() {
  return (
    <div className="flex flex-1 flex-col gap-4 px-4">
      <h2 className="text-base font-semibold">Historia importów</h2>
      <Alert variant="destructive">
        <AlertTitle>Nie udało się wczytać historii</AlertTitle>
        <AlertDescription>Import możesz uruchomić mimo to.</AlertDescription>
        <AlertAction>
          {/* `text-foreground`: bez tego przycisk dziedziczy czerwień alertu. */}
          <Link href="/import-danych" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'text-foreground')}>
            Odśwież
          </Link>
        </AlertAction>
      </Alert>
    </div>
  );
}

export function ImportCenter({
  tenantId,
  tenantName,
  nip,
  hasCertificate,
  certificateConfirmed,
  jobs,
  ksefHistory,
  isOwner,
  pauseError = null,
  now,
}: ImportCenterProps) {
  return (
    <div className="ff-page-fill flex flex-col gap-6">
      <ImportHeader tenantName={tenantName} nip={nip} />
      {jobs && showsImportStats(jobs, ksefHistory) ? <StatsCards stats={importStats(jobs, ksefHistory)} /> : null}
      <KsefHistoryCard
        hasCertificate={hasCertificate}
        certificateConfirmed={certificateConfirmed}
        status={ksefHistory}
        isOwner={isOwner}
        pauseError={pauseError}
        now={now}
      />
      <ImportSourceGrid tenantId={tenantId} />
      <Card className="flex-1">{jobs ? <ImportHistory jobs={jobs} /> : <HistoryError />}</Card>
    </div>
  );
}
