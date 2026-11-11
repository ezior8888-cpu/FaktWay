// lib/jobs/runners/document-archive-cleanup.ts
// Pliki wygasłych paczek archiwum (plan kompletnej aplikacji, krok 6.4,
// część 2; kolumna `file_deleted_at` i funkcja
// `mark_document_archive_file_deleted`, migracja 00190).
//
// Raz na dobę usuwa z magazynu plik paczki `completed`, której link wygasł
// (`expires_at`) ponad `ARCHIVE_FILE_GRACE_MS` temu. Granice (ryzyko R1,
// usuwanie danych):
//   - jeden obiekt na wiersz: klucz `file_key` z wiersza i tylko w katalogu
//     tego zlecenia (`exports/<firma>/archiwum/<zlecenie>/<plik>`, bez `..`);
//     żadnego usuwania po prefiksie ani listowania katalogu firmy;
//   - tylko `completed` z wygasłym linkiem; nigdy `pending`, `generating`
//     ani `failed` (te nie mają klucza pliku, 00178 zapisuje go razem
//     z gotowością); dokumenty firmy leżą pod innymi kluczami;
//   - wiersz zostaje jako historia i dostaje znacznik razem z wpisem
//     `audit_logs` (jedna transakcja w funkcji bazy).
//
// Ponowienie od zera (worker pg-boss wykonuje cały handler ponownie):
//   1. odczyt kandydatów: tylko odczyt, strony po kluczu `id`, limit stron;
//   2. usunięcie obiektu: idempotentne, brak obiektu to sukces;
//   3. znacznik i audyt: UPDATE z warunkiem w funkcji bazy (ten sam klucz,
//      stan, wygaśnięcie, `file_deleted_at IS NULL`); drugie wywołanie
//      zwraca false, więc ponowienie po kroku 3 nie dopisze drugiego wpisu.
//   Błąd magazynu: wiersz bez znacznika, reszta partii idzie dalej, na końcu
//   zadanie rzuca (ponowienie). Po `CLEANUP_MAX_STORAGE_ERRORS` błędach
//   przerywa od razu: magazyn najpewniej nie działa.

import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { JobContext } from '@/lib/jobs/registry';
import { deleteDocumentArchiveFile } from '@/lib/storage/r2';
import { isDocumentArchiveFileKey } from '@/lib/storage/tenant-path';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Zapas po wygaśnięciu linku. Podpisany link do pobrania żyje 5 minut
 * (`app/actions/archiwum.ts`), a pobieranie dużej paczki potrafi trwać dłużej.
 */
export const ARCHIVE_FILE_GRACE_MS = 60 * 60 * 1000;
/** Wierszy na stronę; PostgREST i tak ucina odpowiedź do 1000 bez błędu. */
export const CLEANUP_PAGE_SIZE = 100;
/** Stron w jednym przebiegu; reszta czeka do następnego. */
export const CLEANUP_MAX_PAGES = 10;
/** Tyle błędów magazynu w jednym przebiegu i koniec: magazyn najpewniej nie działa. */
export const CLEANUP_MAX_STORAGE_ERRORS = 3;

const COLUMNS = 'id, tenant_id, status, file_key, expires_at';

interface CandidateRow {
  id: string;
  tenant_id: string;
  status: string;
  file_key: string | null;
  expires_at: string | null;
}

export interface DocumentArchiveCleanupResult {
  /** Plik usunięty, znacznik i wpis audytu zapisane. */
  deleted: number;
  /** Plik usunięty, ale funkcja bazy nie zmieniła wiersza (znacznik zapisał już inny przebieg). */
  alreadyMarked: number;
  /** Klucz spoza katalogu zlecenia: bez usuwania i bez znacznika (ostrzeżenie dla operatora). */
  refused: number;
  /** Błędy magazynu: bez znacznika, ponowienie. */
  storageErrors: number;
  /** Limit stron osiągnięty: reszta w następnym przebiegu. */
  truncated: boolean;
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-a.ts (kolejka cron.document-archive-cleanup).
 */
export async function runDocumentArchiveCleanup({ logger }: JobContext): Promise<DocumentArchiveCleanupResult> {
  const client = createAdminClient() as unknown as SupabaseClient;
  const cutoffMs = Date.now() - ARCHIVE_FILE_GRACE_MS;
  const cutoff = new Date(cutoffMs).toISOString();
  const result: DocumentArchiveCleanupResult = { deleted: 0, alreadyMarked: 0, refused: 0, storageErrors: 0, truncated: false };
  const refusedIds: string[] = [];
  const failedIds: string[] = [];
  let after: string | null = null;

  pages: for (let page = 0; page < CLEANUP_MAX_PAGES; page += 1) {
    let query = client
      .from('document_archives')
      .select(COLUMNS)
      .eq('status', 'completed')
      .is('file_deleted_at', null)
      .not('file_key', 'is', null)
      .lt('expires_at', cutoff)
      .order('id', { ascending: true })
      .limit(CLEANUP_PAGE_SIZE);
    if (after) query = query.gt('id', after);
    const { data, error } = await query;
    if (error) throw new Error(`document_archives: ${error.message}`);
    const rows = (data ?? []) as unknown as CandidateRow[];

    for (const row of rows) {
      // Warunek zapytania jeszcze raz w kodzie: usunięcia pliku nie da się cofnąć.
      if (row.status !== 'completed' || !row.expires_at || !(Date.parse(row.expires_at) < cutoffMs)) continue;
      if (!row.file_key || !isDocumentArchiveFileKey(row.file_key, row.tenant_id, row.id)) {
        result.refused += 1;
        refusedIds.push(row.id);
        continue;
      }

      try {
        await deleteDocumentArchiveFile(row.file_key, row.tenant_id, row.id);
      } catch (e) {
        result.storageErrors += 1;
        failedIds.push(row.id);
        logger.warn('Plik paczki archiwum nie usunięty, wiersz bez znacznika', {
          archiveId: row.id,
          error: e instanceof Error ? e.message : String(e),
        });
        if (result.storageErrors >= CLEANUP_MAX_STORAGE_ERRORS) break pages;
        continue;
      }

      const { data: marked, error: markError } = await client.rpc('mark_document_archive_file_deleted', {
        p_archive_id: row.id,
        p_file_key: row.file_key,
      });
      // Plik już usunięty: ponowienie usunie go jeszcze raz bez skutku i zapisze znacznik.
      if (markError) throw new Error(`mark_document_archive_file_deleted: ${markError.message}`);
      if (marked === true) {
        result.deleted += 1;
      } else {
        result.alreadyMarked += 1;
        logger.warn('Znacznik usunięcia pliku paczki już zapisany albo wiersz poza warunkiem', { archiveId: row.id });
      }
    }

    if (rows.length < CLEANUP_PAGE_SIZE) break;
    after = rows[rows.length - 1]!.id;
    if (page === CLEANUP_MAX_PAGES - 1) result.truncated = true;
  }

  if (refusedIds.length > 0) {
    // Ścieżka operatora: docs/runbooks/joby-pg-boss.md, „Typowe sytuacje”.
    Sentry.captureMessage('Sprzątanie paczek archiwum: klucz pliku spoza katalogu zlecenia, plik zostaje w magazynie', {
      level: 'warning',
      tags: { job: 'document-archive-cleanup' },
      extra: { archiveIds: refusedIds },
    });
  }
  if (result.truncated) {
    Sentry.captureMessage('Sprzątanie paczek archiwum: limit przebiegu, reszta w następnym przebiegu', {
      level: 'warning',
      tags: { job: 'document-archive-cleanup' },
      extra: { ...result },
    });
  }
  logger.info('Sprzątanie plików paczek archiwum', { ...result });

  if (failedIds.length > 0) {
    throw new Error(
      `Sprzątanie paczek archiwum: błąd magazynu przy ${failedIds.length} plikach (${failedIds.join(', ')}), ponowienie`,
    );
  }
  return result;
}
