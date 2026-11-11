/**
 * Zlecenia archiwum dokumentów w bazie (`document_archives`, migracja 00178;
 * plan kompletnej aplikacji, krok 6.4). Klient z sesji: RLS wpuszcza tylko
 * właściciela i administratora firmy, a wyzwalacz przed INSERT pilnuje
 * limitu jednego zlecenia na 10 minut i zamyka zlecenia, które utknęły.
 * Stan, plik i powiadomienie zapisuje tylko zadanie (service_role).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { ArchiveKind } from './okres';

export type ArchiveStatus = 'pending' | 'generating' | 'completed' | 'failed';

export interface ArchiveOrderRow {
  id: string;
  kind: ArchiveKind;
  period_start: string;
  period_end: string;
  status: ArchiveStatus;
  created_at: string;
  finished_at: string | null;
  expires_at: string | null;
  size_bytes: number | null;
  files_count: number | null;
  missing_count: number | null;
  error_message: string | null;
  /** Plik paczki usunięty z magazynu po wygaśnięciu linku (00190); wiersz zostaje jako historia. */
  file_deleted_at: string | null;
}

const COLUMNS =
  'id, kind, period_start, period_end, status, created_at, finished_at, expires_at, size_bytes, files_count, missing_count, error_message, file_deleted_at';

export const ARCHIVE_FORBIDDEN_MESSAGE = 'Archiwum może zlecić właściciel albo administrator firmy.';
export const ARCHIVE_ACTIVE_MESSAGE = 'Paczka za ten okres jest już w przygotowaniu. Wyślemy e-mail, gdy będzie gotowa.';
const ARCHIVE_LIMIT_FALLBACK = 'Kolejną paczkę można zlecić 10 minut po poprzedniej.';
const ARCHIVE_ERROR_MESSAGE = 'Nie udało się zlecić paczki. Spróbuj ponownie za chwilę.';

export type CreateArchiveOrderResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'limit' | 'active' | 'forbidden' | 'error'; message: string };

interface DbError {
  code?: string;
  hint?: string | null;
  message?: string;
}

/**
 * Zakłada zlecenie. Odmowy bazy zamienia na komunikat dla człowieka: limit
 * (wyzwalacz podaje godzinę), aktywne zlecenie na ten okres (indeks
 * `document_archives_one_active`), brak uprawnień (RLS albo wyzwalacz).
 */
export async function createArchiveOrder(
  client: SupabaseClient,
  tenantId: string,
  input: { kind: ArchiveKind; periodStart: string; periodEnd: string },
): Promise<CreateArchiveOrderResult> {
  const { data, error } = await client
    .from('document_archives')
    .insert({ tenant_id: tenantId, kind: input.kind, period_start: input.periodStart, period_end: input.periodEnd })
    .select('id')
    .single();
  if (!error && data) return { ok: true, id: (data as { id: string }).id };
  const e = (error ?? {}) as DbError;
  if (e.hint === 'document_archive_rate_limit') {
    return { ok: false, reason: 'limit', message: e.message?.startsWith('Kolejną paczkę') ? e.message : ARCHIVE_LIMIT_FALLBACK };
  }
  if (e.code === '23505') return { ok: false, reason: 'active', message: ARCHIVE_ACTIVE_MESSAGE };
  if (e.code === '42501') return { ok: false, reason: 'forbidden', message: ARCHIVE_FORBIDDEN_MESSAGE };
  return { ok: false, reason: 'error', message: ARCHIVE_ERROR_MESSAGE };
}

/**
 * Ostatnie zlecenia firmy, od najnowszego. Błąd odczytu (np. przed migracją
 * 00178) to pusta lista: formularz działa, a zlecenie samo powie, co nie tak.
 */
export async function readArchiveOrders(client: SupabaseClient, tenantId: string, limit = 5): Promise<ArchiveOrderRow[]> {
  try {
    const { data, error } = await client
      .from('document_archives')
      .select(COLUMNS)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data as unknown as ArchiveOrderRow[];
  } catch {
    // Lista jest dodatkiem do strony ustawień: jej błąd nie wywraca zakładki „Firma”.
    return [];
  }
}

export interface ArchiveDownloadRow {
  id: string;
  status: ArchiveStatus;
  file_key: string | null;
  expires_at: string | null;
  file_deleted_at: string | null;
  kind: ArchiveKind;
  period_start: string;
  period_end: string;
}

/** Jedno zlecenie firmy do pobrania; `null`, gdy RLS go nie pokazuje albo odczyt padł. */
export async function readArchiveOrder(client: SupabaseClient, tenantId: string, id: string): Promise<ArchiveDownloadRow | null> {
  const { data, error } = await client
    .from('document_archives')
    .select('id, status, file_key, expires_at, file_deleted_at, kind, period_start, period_end')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as ArchiveDownloadRow;
}

/** Zlecenie, którego zadanie nie wyszło: RLS pozwala usunąć tylko stan 'pending'. */
export async function deletePendingOrder(client: SupabaseClient, tenantId: string, id: string): Promise<void> {
  await client.from('document_archives').delete().eq('id', id).eq('tenant_id', tenantId).eq('status', 'pending');
}
