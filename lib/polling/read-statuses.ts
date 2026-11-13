import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { isUuid } from '@/lib/supabase/active-org';
import { createClient } from '@/lib/supabase/server';

/**
 * Odczyt samych statusów zadań w toku dla lekkiego odpytywania (plan
 * skalowania 3000, sesja 11; REQ-08, CAC-V01). Woła go
 * `app/actions/job-statuses.ts`, a przeglądarka (`hooks/use-status-poll.ts`)
 * odświeża stronę dopiero, gdy status się zmieni.
 *
 * - Klient z sesji użytkownika, jak `getOcrJobStatusAction`: RLS wpuszcza
 *   tylko wiersze aktywnej firmy (nagłówek `x-active-org`,
 *   `get_current_tenant_id()` z 00037), archiwum tylko właścicielowi
 *   i administratorowi (00178). Bez service_role i bez
 *   `requireUserAndActiveOrg()`: to drugie dokłada zapytania o użytkownika
 *   i członkostwo na każdy takt, a RLS i tak odcina cudze wiersze.
 * - Zadanie spoza firmy albo usunięte po prostu nie wraca; przeglądarka
 *   uzna brak za zmianę i odświeży stronę (np. wylogowanie → logowanie).
 * - Tylko `id` i `status`, bez komunikatów błędów i danych zadania.
 * - Błąd bazy jest chwilowy (`retryable`) i bez treści; do logu sam kod.
 */

/** Najwięcej id w jednym pytaniu (historia eksportów pokazuje 20 zadań, archiwum 5). */
export const STATUS_IDS_MAX = 100;

export type JobStatusTable = 'export_jobs' | 'import_jobs' | 'document_archives';

export type JobStatusRow = { id: string; status: string };

export type JobStatusesResult =
  | { success: true; statuses: JobStatusRow[] }
  | { success: false; retryable: boolean };

/** Lista 1–100 UUID z przeglądarki, bez powtórzeń; `null`, gdy nie pasuje. */
function parseIds(ids: unknown): string[] | null {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > STATUS_IDS_MAX) return null;
  if (!ids.every((id) => isUuid(id))) return null;
  return [...new Set<string>(ids)];
}

export async function readJobStatuses(table: JobStatusTable, ids: unknown): Promise<JobStatusesResult> {
  const list = parseIds(ids);
  // Zła lista to nie chwilowy błąd: odmowa bez zapytania do bazy.
  if (!list) return { success: false, retryable: false };

  try {
    // `document_archives` (00178) nie ma w wygenerowanych typach bazy — jak w `lib/archiwum/zlecenia.ts`.
    const supabase = (await createClient()) as unknown as SupabaseClient;
    const { data, error } = await supabase.from(table).select('id, status').in('id', list);
    if (error) {
      console.error('[job-statuses] odczyt statusów nieudany', { table, code: error.code });
      return { success: false, retryable: true };
    }
    const rows = (data ?? []) as Array<{ id: unknown; status: unknown }>;
    return { success: true, statuses: rows.map((row) => ({ id: String(row.id), status: String(row.status) })) };
  } catch {
    // Odrzucone zapytanie (sieć do bazy): bez treści wyjątku, może nieść adres.
    console.error('[job-statuses] odczyt statusów nieudany', { table, code: 'exception' });
    return { success: false, retryable: true };
  }
}
