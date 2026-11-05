/**
 * Dostęp do tabel synchronizacji historii KSeF (00155, decyzja Bartosza
 * 22.10.2026) — typy wierszy i zapisy warunkowe (CAS).
 *
 * `types/database.ts` generujemy z produkcji PO wgraniu migracji (AGENTS.md:
 * „Typy bazy po migracji”) — w kolejnym PR. Do tego czasu JEDNO lokalne
 * rozszerzenie typów (`HistoryDatabase`) i jedno rzutowanie klienta
 * (`asHistoryClient`), jak `CursorClient` w `lib/flo/functions/inbox-cursor.ts`
 * i `untyped()` w `lib/ksef/duplicate-decision-rpc.ts`.
 *
 * Każda zmiana stanu jest warunkowa (CAS): kursory na poprzednich wartościach
 * kursora, pozycje dziennika na poprzednim `status`, `attempts` i `updated_at`.
 * Przegrany wyścig = brak wiersza w odpowiedzi, nigdy nadpisanie cudzego zapisu.
 * Ponowienie przebiegu (pg-boss wykonuje cały handler od nowa) trafia w te
 * same warunki.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { POSTGREST_MAX_ROWS } from '@/lib/pagination/keyset';

import type { HistoryDirection, InitialStream } from './windows';

export type KsefHistoryEnvironment = 'test' | 'demo' | 'production';
export type KsefHistoryItemStatus = 'pending' | 'imported' | 'skipped' | 'deferred' | 'blocked';

export type KsefHistoryPendingReason = 'repair_content' | 'ksef_not_ready';
export type KsefHistoryImportedReason = 'jpk_note' | 'repaired';
export type KsefHistorySkippedReason = 'own_invoice' | 'already_present' | 'retired_draft';
export type KsefHistoryDeferredReason = 'duplicate_decision' | 'own_send_pending';
export type KsefHistoryBlockedReason =
  | 'currency_not_supported'
  | 'parse_failed'
  | 'number_conflict'
  | 'number_taken_local'
  | 'file_import_mismatch'
  | 'local_conflict'
  | 'own_send_unresolved'
  | 'save_failed'
  | 'repair_failed'
  | 'download_failed'
  | 'archive_conflict'
  | 'metadata_mismatch';
export type KsefHistoryReason =
  | KsefHistoryPendingReason
  | KsefHistoryImportedReason
  | KsefHistorySkippedReason
  | KsefHistoryDeferredReason
  | KsefHistoryBlockedReason;

export const KSEF_HISTORY_BLOCKED_REASONS: readonly KsefHistoryBlockedReason[] = [
  'currency_not_supported', 'parse_failed', 'number_conflict', 'number_taken_local',
  'file_import_mismatch', 'local_conflict', 'own_send_unresolved', 'save_failed',
  'repair_failed', 'download_failed', 'archive_conflict', 'metadata_mismatch',
];

/** Powody zależne od stanu lokalnego — sprawdzane ponownie co godzinę (D7, punkt 9 krytyki). */
export const KSEF_HISTORY_RECHECK_BLOCKED_REASONS: readonly KsefHistoryBlockedReason[] = [
  'number_conflict', 'number_taken_local', 'file_import_mismatch', 'local_conflict', 'own_send_unresolved',
];

export type KsefHistorySessionErrorCode =
  | 'credentials'
  | 'certificate_expired'
  | 'permission'
  | 'ksef_unavailable'
  | 'internal';

export type KsefHistorySyncRow = {
  id: string;
  tenant_id: string;
  environment: KsefHistoryEnvironment;
  direction: HistoryDirection;
  history_floor: string;
  boundary_at: string;
  backfill_window_end: string;
  backfill_cursor: string;
  backfill_page_offset: number;
  backfill_completed_at: string | null;
  backfill_progress_at: string | null;
  backfill_issue: 'waiting_for_ksef' | 'internal' | 'capacity' | null;
  backfill_issue_at: string | null;
  live_hwm: string | null;
  live_page_offset: number;
  live_checked_at: string | null;
  live_issue: 'waiting_for_ksef' | 'internal' | null;
  live_issue_at: string | null;
  paused_until: string | null;
  rate_limited_at: string | null;
  rate_limit_hits: number;
  client_paused_at: string | null;
  client_paused_by: string | null;
  lease_until: string | null;
  last_enqueued_at: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error_code: KsefHistorySessionErrorCode | null;
  last_error_detail: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
};

export type KsefHistorySyncInsert = {
  tenant_id: string;
  environment: KsefHistoryEnvironment;
  direction: HistoryDirection;
} & InitialStream & Partial<KsefHistorySyncRow>;

export type KsefHistoryItemRow = {
  id: string;
  tenant_id: string;
  environment: KsefHistoryEnvironment;
  direction: HistoryDirection;
  ksef_number: string;
  invoice_number: string;
  issue_date: string;
  acquisition_at: string | null;
  permanent_storage_at: string | null;
  invoice_type: string | null;
  counterparty_nip: string | null;
  counterparty_name: string | null;
  gross_amount: number | null;
  currency: string | null;
  invoice_hash: string | null;
  status: KsefHistoryItemStatus;
  reason_code: KsefHistoryReason | null;
  detail: string | null;
  attempts: number;
  next_attempt_at: string | null;
  first_deferred_at: string | null;
  invoice_id: string | null;
  discovered_at: string;
  resolved_at: string | null;
  updated_at: string;
};

export type KsefHistoryItemInsert = {
  tenant_id: string;
  environment: KsefHistoryEnvironment;
  direction: HistoryDirection;
  ksef_number: string;
  invoice_number: string;
  issue_date: string;
  acquisition_at: string | null;
  permanent_storage_at: string | null;
  invoice_type: string | null;
  counterparty_nip: string | null;
  counterparty_name: string | null;
  gross_amount: number | null;
  currency: string | null;
  invoice_hash: string | null;
  status: KsefHistoryItemStatus;
  reason_code: KsefHistoryReason | null;
  invoice_id: string | null;
  resolved_at: string | null;
};

export type KsefHistoryItemPatch = Partial<Pick<KsefHistoryItemRow,
  'status' | 'reason_code' | 'detail' | 'attempts' | 'next_attempt_at' | 'first_deferred_at' | 'invoice_id' | 'resolved_at'>>;

export type KsefHistoryCountRow = {
  tenant_id: string;
  environment: KsefHistoryEnvironment;
  direction: HistoryDirection;
  status: KsefHistoryItemStatus;
  reason_code: KsefHistoryReason | null;
  item_count: number;
};

/** Widok `ksef_history_export_changes` (00155): miesiąc wyeksportowanego okresu z fakturami pobranymi po eksporcie. */
export type KsefHistoryExportChangeRow = {
  tenant_id: string;
  environment: KsefHistoryEnvironment;
  /** RRRR-MM daty wystawienia. */
  period: string;
  item_count: number;
};

type LocalTable<Row, Insert> = {
  Row: Row;
  Insert: Insert;
  Update: Partial<Row>;
  Relationships: [];
};

/** Lokalne rozszerzenie typów bazy o obiekty 00155 (do regeneracji `types/database.ts`). */
export type HistoryDatabase = {
  __InternalSupabase: { PostgrestVersion: '14.6' };
  public: {
    Tables: {
      ksef_history_sync: LocalTable<KsefHistorySyncRow, KsefHistorySyncInsert>;
      ksef_history_items: LocalTable<KsefHistoryItemRow, KsefHistoryItemInsert>;
    };
    Views: {
      ksef_history_item_counts: { Row: KsefHistoryCountRow; Relationships: [] };
      ksef_history_export_changes: { Row: KsefHistoryExportChangeRow; Relationships: [] };
    };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

export type HistoryClient = SupabaseClient<HistoryDatabase>;

/** Jedyne rzutowanie klienta (admin albo sesji) na typy 00155 — do regeneracji typów. */
export function asHistoryClient(client: object): HistoryClient {
  return client as unknown as HistoryClient;
}

const ITEMS_PER_UPSERT = 100;

function dbError(context: string, error: { message?: string } | null): Error {
  return new Error(`Historia KSeF: ${context}: ${error?.message ?? 'błąd bazy'}`);
}

// ═══════════════════════════════════════════════════════════════
// Strumienie
// ═══════════════════════════════════════════════════════════════

/**
 * Zakłada brakujące strumienie (INSERT … ON CONFLICT DO NOTHING) — ponowienie
 * nie zmienia istniejących. Zwraca liczbę nowo założonych.
 */
export async function ensureStreams(
  client: HistoryClient,
  rows: KsefHistorySyncInsert[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const { data, error } = await client
    .from('ksef_history_sync')
    .upsert(rows, { onConflict: 'tenant_id,environment,direction', ignoreDuplicates: true })
    .select('id');
  if (error) throw dbError('zakładanie strumieni', error);
  return data?.length ?? 0;
}

export function outgoingStreamInsert(
  tenantId: string,
  environment: KsefHistoryEnvironment,
  initial: InitialStream,
): KsefHistorySyncInsert {
  return { tenant_id: tenantId, environment, direction: 'outgoing', ...initial };
}

export function incomingStreamInsert(
  tenantId: string,
  environment: KsefHistoryEnvironment,
  initial: InitialStream,
): KsefHistorySyncInsert {
  return { tenant_id: tenantId, environment, direction: 'incoming', ...initial, live_hwm: null };
}

export async function ensureOutgoingStreams(
  client: HistoryClient,
  environment: KsefHistoryEnvironment,
  rows: Array<{ tenantId: string; initial: InitialStream }>,
): Promise<number> {
  return ensureStreams(client, rows.map((r) => outgoingStreamInsert(r.tenantId, environment, r.initial)));
}

export async function ensureIncomingStreams(
  client: HistoryClient,
  environment: KsefHistoryEnvironment,
  rows: Array<{ tenantId: string; initial: InitialStream }>,
): Promise<number> {
  return ensureStreams(client, rows.map((r) => incomingStreamInsert(r.tenantId, environment, r.initial)));
}

/** Strumienie jednej firmy w środowisku (najwyżej 2: sprzedaż i zakupy). */
export async function loadStreams(
  client: HistoryClient,
  environment: KsefHistoryEnvironment,
  tenantId: string,
): Promise<KsefHistorySyncRow[]> {
  const { data, error } = await client
    .from('ksef_history_sync')
    .select('*')
    .eq('environment', environment)
    .eq('tenant_id', tenantId);
  if (error) throw dbError('odczyt strumieni', error);
  return (data ?? []) as KsefHistorySyncRow[];
}

/** Firmy na jedno zapytanie strumieni: `in.(…)` ze 100 uuid to ok. 3,9 KB adresu. */
export const STREAM_TENANTS_PER_QUERY = 100;

/**
 * Strumienie wskazanych firm (cron: bieżąca strona firm, sesja 27 planu
 * skalowania). Dawniej cron czytał strumienie CAŁEGO środowiska jednym
 * zapytaniem — od ok. 500 firm (2 strumienie na firmę) PostgREST ucinał
 * odpowiedź do 1000 wierszy bez błędu, a firma bez wczytanego strumienia
 * sprzedaży po cichu wypadała z cyklu.
 *
 * Paczki po 100 firm: UNIQUE (tenant_id, environment, direction) daje
 * najwyżej 2 wiersze na firmę, czyli ≤ 200 na odpowiedź. Więcej = schemat
 * się zmienił — wyjątek zamiast liczenia na niepełnej liście.
 */
export async function loadStreamsForTenants(
  client: HistoryClient,
  environment: KsefHistoryEnvironment,
  tenantIds: readonly string[],
): Promise<KsefHistorySyncRow[]> {
  const out: KsefHistorySyncRow[] = [];
  for (let i = 0; i < tenantIds.length; i += STREAM_TENANTS_PER_QUERY) {
    const part = tenantIds.slice(i, i + STREAM_TENANTS_PER_QUERY);
    const { data, error } = await client
      .from('ksef_history_sync')
      .select('*')
      .eq('environment', environment)
      .in('tenant_id', part);
    if (error) throw dbError('odczyt strumieni', error);
    const rows = (data ?? []) as KsefHistorySyncRow[];
    if (rows.length > part.length * 2) {
      throw dbError('odczyt strumieni', { message: `${rows.length} wierszy dla ${part.length} firm — więcej niż 2 kierunki na firmę` });
    }
    out.push(...rows);
  }
  return out;
}

/**
 * Dzierżawa przebiegu firmy na wierszu sprzedaży: tylko gdy wolna, bez pauzy
 * klienta i bez pauzy po 429. JEDEN warunkowy UPDATE — warunek (dzierżawa
 * wolna, brak pauz) sprawdza baza w chwili zapisu, więc z dwóch równoległych
 * przebiegów wygrywa jeden, a pauza ustawiona tuż przed zapisem jest
 * respektowana. Bez CAS na `updated_at`: niezależny zapis tego wiersza
 * (znacznik kolejki crona `last_enqueued_at`) nie odbiera już dzierżawy
 * i nie blokuje firmy na godzinę (poprawka po przeglądzie, decyzja Bartosza
 * 22.10.2026). `null` = zajęte, wstrzymane albo brak strumienia.
 */
export async function claimLease(
  client: HistoryClient,
  tenantId: string,
  environment: KsefHistoryEnvironment,
  now: Date,
  leaseMs: number,
): Promise<KsefHistorySyncRow | null> {
  const at = now.toISOString();
  const { data: claimed, error } = await client
    .from('ksef_history_sync')
    .update({ lease_until: new Date(now.getTime() + leaseMs).toISOString(), last_run_at: at })
    .eq('tenant_id', tenantId)
    .eq('environment', environment)
    .eq('direction', 'outgoing')
    .is('client_paused_at', null)
    // Dwa `or` = dwa parametry PostgREST łączone przez AND.
    .or(`lease_until.is.null,lease_until.lte.${at}`)
    .or(`paused_until.is.null,paused_until.lte.${at}`)
    .select('*')
    .maybeSingle();
  if (error) throw dbError('dzierżawa przebiegu', error);
  return (claimed as KsefHistorySyncRow | null) ?? null;
}

/** Zwolnienie TEJ dzierżawy (nie cudzej, jeśli nasza wygasła i ktoś przejął). */
export async function releaseLease(client: HistoryClient, stream: { id: string; lease_until: string | null }): Promise<void> {
  if (!stream.lease_until) return;
  const { error } = await client
    .from('ksef_history_sync')
    .update({ lease_until: null })
    .eq('id', stream.id)
    .eq('lease_until', stream.lease_until);
  if (error) throw dbError('zwolnienie dzierżawy', error);
}

/** Zapis warunkowy na `updated_at` (stan firmy, pola bez kursora). `null` = ktoś zmienił wiersz. */
export async function updateStreamCas(
  client: HistoryClient,
  stream: Pick<KsefHistorySyncRow, 'id' | 'updated_at'>,
  patch: Partial<KsefHistorySyncRow>,
): Promise<KsefHistorySyncRow | null> {
  const { data, error } = await client
    .from('ksef_history_sync')
    .update(patch)
    .eq('id', stream.id)
    .eq('updated_at', stream.updated_at)
    .select('*')
    .maybeSingle();
  if (error) throw dbError('zapis strumienia', error);
  return (data as KsefHistorySyncRow | null) ?? null;
}

/** Zapis bezwarunkowy pól stanu firmy (pod naszą dzierżawą) — błąd, pauza, sukces. */
export async function updateStreamById(
  client: HistoryClient,
  streamId: string,
  patch: Partial<KsefHistorySyncRow>,
): Promise<KsefHistorySyncRow | null> {
  const { data, error } = await client
    .from('ksef_history_sync')
    .update(patch)
    .eq('id', streamId)
    .select('*')
    .maybeSingle();
  if (error) throw dbError('zapis stanu firmy', error);
  return (data as KsefHistorySyncRow | null) ?? null;
}

/** Kursor zaległości: CAS na poprzednim oknie, kursorze i stronie (nigdy wstecz po wyścigu). */
export async function updateBackfillCas(
  client: HistoryClient,
  stream: Pick<KsefHistorySyncRow, 'id' | 'backfill_cursor' | 'backfill_window_end' | 'backfill_page_offset'>,
  patch: Partial<KsefHistorySyncRow>,
): Promise<KsefHistorySyncRow | null> {
  const { data, error } = await client
    .from('ksef_history_sync')
    .update(patch)
    .eq('id', stream.id)
    .eq('backfill_cursor', stream.backfill_cursor)
    .eq('backfill_window_end', stream.backfill_window_end)
    .eq('backfill_page_offset', stream.backfill_page_offset)
    .select('*')
    .maybeSingle();
  if (error) throw dbError('kursor zaległości', error);
  return (data as KsefHistorySyncRow | null) ?? null;
}

/** Kursor bieżący: CAS na poprzednim HWM i stronie. */
export async function updateLiveCas(
  client: HistoryClient,
  stream: Pick<KsefHistorySyncRow, 'id' | 'live_hwm' | 'live_page_offset'>,
  patch: Partial<KsefHistorySyncRow>,
): Promise<KsefHistorySyncRow | null> {
  if (!stream.live_hwm) return null;
  const { data, error } = await client
    .from('ksef_history_sync')
    .update(patch)
    .eq('id', stream.id)
    .eq('live_hwm', stream.live_hwm)
    .eq('live_page_offset', stream.live_page_offset)
    .select('*')
    .maybeSingle();
  if (error) throw dbError('kursor bieżący', error);
  return (data as KsefHistorySyncRow | null) ?? null;
}

// ═══════════════════════════════════════════════════════════════
// Dziennik faktur
// ═══════════════════════════════════════════════════════════════

/** Zapis strony w dzienniku — duplikaty klucza tożsamości pomijane (ponowienie, zakładka granicy). */
export async function upsertItems(client: HistoryClient, rows: KsefHistoryItemInsert[]): Promise<void> {
  for (let i = 0; i < rows.length; i += ITEMS_PER_UPSERT) {
    const { error } = await client
      .from('ksef_history_items')
      .upsert(rows.slice(i, i + ITEMS_PER_UPSERT), {
        onConflict: 'tenant_id,environment,direction,ksef_number',
        ignoreDuplicates: true,
      });
    if (error) throw dbError('zapis dziennika', error);
  }
}

/**
 * Kolejka pobrań firmy: najpierw naprawy treści (`repair_content`), potem
 * najnowsze faktury (data wystawienia malejąco, numer KSeF rosnąco).
 */
export async function selectDownloadQueue(
  client: HistoryClient,
  tenantId: string,
  environment: KsefHistoryEnvironment,
  now: Date,
  limit: number,
): Promise<KsefHistoryItemRow[]> {
  if (limit <= 0) return [];
  const due = `next_attempt_at.is.null,next_attempt_at.lte.${now.toISOString()}`;
  const [repair, rest] = await Promise.all([
    client
      .from('ksef_history_items')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('environment', environment)
      .eq('status', 'pending')
      .eq('reason_code', 'repair_content')
      .or(due)
      .order('issue_date', { ascending: false })
      .order('ksef_number', { ascending: true })
      .limit(limit),
    client
      .from('ksef_history_items')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('environment', environment)
      .eq('status', 'pending')
      .or(due)
      .order('issue_date', { ascending: false })
      .order('ksef_number', { ascending: true })
      .limit(limit),
  ]);
  if (repair.error) throw dbError('kolejka napraw', repair.error);
  if (rest.error) throw dbError('kolejka pobrań', rest.error);
  const seen = new Set<string>();
  const out: KsefHistoryItemRow[] = [];
  for (const row of [...((repair.data ?? []) as KsefHistoryItemRow[]), ...((rest.data ?? []) as KsefHistoryItemRow[])]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out.slice(0, limit);
}

/**
 * Pozycje do ponownego sprawdzenia (tylko baza): odłożone po terminie,
 * zablokowane z powodem zależnym od stanu lokalnego starsze niż godzina,
 * wycofane szkice starsze niż doba. Najdawniej sprawdzane pierwsze.
 */
export async function selectRecheckItems(
  client: HistoryClient,
  tenantId: string,
  environment: KsefHistoryEnvironment,
  now: Date,
  opts: { blockedRecheckMs: number; retiredRecheckMs: number; limit: number },
): Promise<KsefHistoryItemRow[]> {
  const base = () => client
    .from('ksef_history_items')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('environment', environment);
  const [deferred, blocked, retired] = await Promise.all([
    base().eq('status', 'deferred').lte('next_attempt_at', now.toISOString())
      .order('updated_at', { ascending: true }).limit(opts.limit),
    base().eq('status', 'blocked').in('reason_code', [...KSEF_HISTORY_RECHECK_BLOCKED_REASONS])
      .lt('updated_at', new Date(now.getTime() - opts.blockedRecheckMs).toISOString())
      .order('updated_at', { ascending: true }).limit(opts.limit),
    base().eq('status', 'skipped').eq('reason_code', 'retired_draft')
      .lt('updated_at', new Date(now.getTime() - opts.retiredRecheckMs).toISOString())
      .order('updated_at', { ascending: true }).limit(opts.limit),
  ]);
  for (const r of [deferred, blocked, retired]) if (r.error) throw dbError('pozycje do sprawdzenia', r.error);
  return [
    ...((deferred.data ?? []) as KsefHistoryItemRow[]),
    ...((blocked.data ?? []) as KsefHistoryItemRow[]),
    ...((retired.data ?? []) as KsefHistoryItemRow[]),
  ]
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
    .slice(0, opts.limit);
}

/**
 * Zmiana pozycji warunkowo na poprzednim `status`, `attempts` i `updated_at`
 * (wyzwalacz podbija `updated_at` przy każdym zapisie, także bez zmiany pól).
 * `false` = pozycja zmieniła się w międzyczasie.
 */
export async function updateItemCas(
  client: HistoryClient,
  item: Pick<KsefHistoryItemRow, 'id' | 'status' | 'attempts' | 'updated_at'>,
  patch: KsefHistoryItemPatch,
): Promise<boolean> {
  const { data, error } = await client
    .from('ksef_history_items')
    .update(patch)
    .eq('id', item.id)
    .eq('status', item.status)
    .eq('attempts', item.attempts)
    .eq('updated_at', item.updated_at)
    .select('id')
    .maybeSingle();
  if (error) throw dbError('zapis pozycji', error);
  return Boolean(data);
}

/** Liczba pozycji strumienia (limit 25 000 na strumień). */
export async function countStreamItems(
  client: HistoryClient,
  tenantId: string,
  environment: KsefHistoryEnvironment,
  direction: HistoryDirection,
): Promise<number> {
  const { count, error } = await client
    .from('ksef_history_items')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('environment', environment)
    .eq('direction', direction);
  if (error || typeof count !== 'number') throw dbError('liczba pozycji', error);
  return count;
}

/**
 * Najwięcej grup widoku `ksef_history_item_counts` na firmę w jednym
 * środowisku: CHECK `ksef_history_items_status_reason` (00155) dopuszcza na
 * kierunek pending ×3 (bez powodu + 2 powody), imported ×3 (bez powodu + 2),
 * skipped ×3, deferred ×2 i blocked ×12 — razem 23, a kierunki są dwa.
 * Pilnuje tego tests/unit/strony-po-kluczu-historia.test.ts (czyta CHECK z migracji).
 */
export const KSEF_HISTORY_COUNT_GROUPS_PER_TENANT = 46;

/**
 * Firmy na jedno zapytanie liczników: 21 × 46 = 966 wierszy, mniej niż limit
 * PostgREST. Widok nie ma kolumny `id`, więc zamiast stron po kluczu cała
 * odpowiedź musi się zmieścić poniżej limitu.
 */
export const COUNT_TENANTS_PER_QUERY = Math.floor((POSTGREST_MAX_ROWS - 1) / KSEF_HISTORY_COUNT_GROUPS_PER_TENANT);

/**
 * Liczniki wskazanych firm z widoku (cron: szacunek przebiegu dla bieżącej
 * strony firm). Dawniej jedno zapytanie dla CAŁEGO środowiska — przy kilku
 * grupach na firmę PostgREST ucinał odpowiedź do 1000 wierszy już od
 * ok. 125–330 firm, a ucięta firma dostawała `pending` = 0 i zaniżony
 * szacunek (sesja 27 planu skalowania).
 */
export async function readCounts(
  client: HistoryClient,
  environment: KsefHistoryEnvironment,
  statuses: KsefHistoryItemStatus[],
  tenantIds: readonly string[],
): Promise<KsefHistoryCountRow[]> {
  const out: KsefHistoryCountRow[] = [];
  for (let i = 0; i < tenantIds.length; i += COUNT_TENANTS_PER_QUERY) {
    const part = tenantIds.slice(i, i + COUNT_TENANTS_PER_QUERY);
    const { data, error } = await client
      .from('ksef_history_item_counts')
      .select('tenant_id, environment, direction, status, reason_code, item_count')
      .eq('environment', environment)
      .in('status', statuses)
      .in('tenant_id', part);
    if (error) throw dbError('liczniki dziennika', error);
    const rows = (data ?? []) as KsefHistoryCountRow[];
    // Odpowiedź równa limitowi jest nieodróżnialna od uciętej; więcej grup niż
    // dopuszcza CHECK = schemat się zmienił. W obu przypadkach liczby byłyby
    // zaniżone po cichu — wyjątek.
    if (rows.length >= POSTGREST_MAX_ROWS || rows.length > part.length * KSEF_HISTORY_COUNT_GROUPS_PER_TENANT) {
      throw dbError('liczniki dziennika', { message: `${rows.length} grup dla ${part.length} firm — odpowiedź mogła zostać ucięta` });
    }
    out.push(...rows);
  }
  return out;
}
