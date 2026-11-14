'use server';

import { readJobStatuses, type JobStatusesResult } from '@/lib/polling/read-statuses';

/**
 * Lekkie akcje statusu do odpytywania historii (plan skalowania 3000,
 * sesja 11; REQ-08, CAC-V01). Zwracają tylko `id` i `status` zadań z listy;
 * całą stronę przeglądarka odświeża dopiero przy zmianie
 * (`hooks/use-status-poll.ts`). Szczegóły odczytu i uprawnień:
 * `lib/polling/read-statuses.ts`.
 *
 * Osobny plik, a nie dopisek w `exports.ts`, `import-danych.ts` czy
 * `archiwum.ts`: tamte zlecają i zapisują zadania, a te tylko czytają status.
 */

/** Statusy eksportów w toku (`export_jobs`). */
export async function getExportJobStatusesAction(ids: unknown): Promise<JobStatusesResult> {
  return readJobStatuses('export_jobs', ids);
}

/** Statusy importów w toku (`import_jobs`). */
export async function getImportJobStatusesAction(ids: unknown): Promise<JobStatusesResult> {
  return readJobStatuses('import_jobs', ids);
}

/** Statusy zleceń archiwum dokumentów w przygotowaniu (`document_archives`). */
export async function getDocumentArchiveStatusesAction(ids: unknown): Promise<JobStatusesResult> {
  return readJobStatuses('document_archives', ids);
}
