/**
 * Stan synchronizacji historii KSeF dla ekranu Import danych (decyzja
 * Bartosza 22.10.2026) — kontrakt z kartą „Historia z KSeF”.
 *
 * Czyta KLIENTEM SESJI użytkownika (RLS: tylko własna firma) i WYŁĄCZNIE
 * kolumnami, do których klient ma GRANT (00155): bez `last_error_detail`
 * i `detail` — to dane operatora. Bez klucza serwisowego i bez `'use server'`.
 *
 * Zasada tekstów (punkt 6 krytyki): faza `live`/`done` tylko, gdy nic nie
 * czeka ani nie jest odłożone; termin końca dopiero po przeszukaniu całej
 * historii i tylko z tempa zmierzonego w ostatnich 6 godzinach; naprawy
 * treści (`repaired`) nie liczą się do pobranych.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import type { Database } from '@/types/database';

import { KSEF_HISTORY_FLOOR, KSEF_HISTORY_RATE_WINDOW_H } from './constants';
import {
  asHistoryClient,
  KSEF_HISTORY_BLOCKED_REASONS,
  type KsefHistoryCountRow,
  type KsefHistoryExportChangeRow,
  type KsefHistoryItemRow,
  type KsefHistorySyncRow,
} from './db';

export { KSEF_HISTORY_FLOOR } from './constants';

export type KsefHistoryDirection = 'outgoing' | 'incoming';
export type KsefHistoryPhase = 'waiting' | 'searching' | 'downloading' | 'live' | 'done';
//  waiting: no stream row; searching: backfill_completed_at NULL (and not capacity);
//  downloading: backfill complete (or capacity) and pending+deferred > 0;
//  live (outgoing) / done (incoming): backfill complete and pending+deferred = 0
export type KsefHistoryErrorCode = 'credentials' | 'certificate_expired' | 'permission' | 'ksef_unavailable' | 'internal';
export type KsefHistoryDeferredReason = 'duplicate_decision' | 'own_send_pending';
export type KsefHistoryBlockedReason = 'currency_not_supported' | 'parse_failed' | 'number_conflict' | 'number_taken_local'
  | 'file_import_mismatch' | 'local_conflict' | 'own_send_unresolved' | 'save_failed' | 'repair_failed'
  | 'download_failed' | 'archive_conflict' | 'metadata_mismatch';
export interface KsefHistoryCounts {
  pending: number; imported: number /* bez 'repaired' */; repaired: number; skipped: number;
  retiredDraft: number; deferred: number; blocked: number;
}
export interface KsefHistoryStreamStatus {
  direction: KsefHistoryDirection;
  phase: KsefHistoryPhase;
  enabledAt: string | null;            // created_at
  historyFloor: string;                // stream history_floor or KSEF_HISTORY_FLOOR when no row
  coveredFrom: string | null;          // null when waiting; history_floor when completed; else backfill_window_end
  backfillCompletedAt: string | null;
  capacityReached: boolean;            // backfill_issue = 'capacity'
  stuck: boolean;                      // backfill_issue|live_issue = 'internal' set within the last 24 h
  lastSuccessAt: string | null;        // tenant-level, copied to both
  counts: KsefHistoryCounts;
  measuredPerHour: number | null;      // imported (incl. repaired) with resolved_at > now-6h, /6, rounded; null if 0
  estimatedFinishAt: string | null;    // only phase 'downloading', pending > 0 and measuredPerHour >= 1: now + pending/measuredPerHour h
}
interface KsefHistoryItemBase {
  ksefNumber: string; direction: KsefHistoryDirection; invoiceNumber: string; issueDate: string;
  counterpartyName: string | null; grossAmount: number | null; currency: string | null;
  localInvoiceId: string | null; updatedAt: string;
}
export interface KsefHistoryBlockedItem extends KsefHistoryItemBase { reason: KsefHistoryBlockedReason }
export interface KsefHistoryDeferredItem extends KsefHistoryItemBase { reason: KsefHistoryDeferredReason }
export interface KsefHistorySyncStatus {
  environment: 'test' | 'demo' | 'production';
  outgoing: KsefHistoryStreamStatus;
  incoming: KsefHistoryStreamStatus;
  rateLimitedUntil: string | null;     // paused_until > now (outgoing row)
  clientPausedAt: string | null;
  error: { code: KsefHistoryErrorCode; at: string; certificateExpiry: string | null } | null; // last_error_code && consecutive_failures > 0 (certificate_expired: while the tenant certificate is expired or its expiry unknown)
  blocked: KsefHistoryBlockedItem[];   blockedTotal: number;   // max 20, updated_at DESC
  deferred: KsefHistoryDeferredItem[]; deferredTotal: number;  // max 20, updated_at DESC
  periodsChangedAfterExport: Array<{ period: string /* YYYY-MM */; count: number }>; // max 12, newest first
}
export type KsefHistorySyncRead = { ok: true; status: KsefHistorySyncStatus } | { ok: false };

/**
 * Kolumny czytane przez ekran — wyłącznie z GRANT SELECT dla `authenticated`
 * (00155). Strażnik: tests/unit/ksef-historia-status.test.ts (bez `detail`
 * i `last_error_detail`).
 */
export const STATUS_STREAM_COLUMNS =
  'direction, created_at, history_floor, backfill_window_end, backfill_completed_at, backfill_issue, backfill_issue_at, live_issue, live_issue_at, last_success_at, paused_until, client_paused_at, last_error_code, last_error_at, consecutive_failures';
export const STATUS_ITEM_COLUMNS =
  'ksef_number, direction, invoice_number, issue_date, counterparty_name, gross_amount, currency, invoice_id, updated_at, reason_code';
export const STATUS_COUNT_COLUMNS = 'direction, status, reason_code, item_count';
export const STATUS_EXPORT_CHANGE_COLUMNS = 'period, item_count';

const LIST_LIMIT = 20;
const PERIODS_LIMIT = 12;
const STUCK_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFERRED_REASONS: readonly KsefHistoryDeferredReason[] = ['duplicate_decision', 'own_send_pending'];

type StreamRow = Pick<KsefHistorySyncRow,
  'direction' | 'created_at' | 'history_floor' | 'backfill_window_end' | 'backfill_completed_at' | 'backfill_issue'
  | 'backfill_issue_at' | 'live_issue' | 'live_issue_at' | 'last_success_at' | 'paused_until' | 'client_paused_at'
  | 'last_error_code' | 'last_error_at' | 'consecutive_failures'>;
type ItemRow = Pick<KsefHistoryItemRow,
  'ksef_number' | 'direction' | 'invoice_number' | 'issue_date' | 'counterparty_name' | 'gross_amount' | 'currency'
  | 'invoice_id' | 'updated_at' | 'reason_code'>;
type CountRow = Pick<KsefHistoryCountRow, 'direction' | 'status' | 'reason_code' | 'item_count'>;
type ExportChangeRow = Pick<KsefHistoryExportChangeRow, 'period' | 'item_count'>;

function emptyCounts(): KsefHistoryCounts {
  return { pending: 0, imported: 0, repaired: 0, skipped: 0, retiredDraft: 0, deferred: 0, blocked: 0 };
}

/** Liczniki kierunku z widoku. `skipped` bez `retired_draft` (osobny licznik), `imported` bez `repaired`. */
export function countsFor(rows: CountRow[], direction: KsefHistoryDirection): KsefHistoryCounts {
  const counts = emptyCounts();
  for (const row of rows) {
    if (row.direction !== direction) continue;
    const n = Number(row.item_count) || 0;
    switch (row.status) {
      case 'pending': counts.pending += n; break;
      case 'imported':
        if (row.reason_code === 'repaired') counts.repaired += n;
        else counts.imported += n;
        break;
      case 'skipped':
        if (row.reason_code === 'retired_draft') counts.retiredDraft += n;
        else counts.skipped += n;
        break;
      case 'deferred': counts.deferred += n; break;
      case 'blocked': counts.blocked += n; break;
    }
  }
  return counts;
}

function recentInternal(issue: string | null, at: string | null, now: Date): boolean {
  if (issue !== 'internal' || !at) return false;
  const ms = Date.parse(at);
  return Number.isFinite(ms) && now.getTime() - ms < STUCK_WINDOW_MS;
}

/** Faza i pochodne jednego strumienia (czysta funkcja — testy). */
export function streamStatus(input: {
  direction: KsefHistoryDirection;
  row: StreamRow | null;
  counts: KsefHistoryCounts;
  lastSuccessAt: string | null;
  importedLastWindow: number;
  now: Date;
}): KsefHistoryStreamStatus {
  const { direction, row, counts, now } = input;
  const rate = Math.round(input.importedLastWindow / KSEF_HISTORY_RATE_WINDOW_H);
  const measuredPerHour = rate > 0 ? rate : null;
  if (!row) {
    return {
      direction, phase: 'waiting', enabledAt: null, historyFloor: KSEF_HISTORY_FLOOR, coveredFrom: null,
      backfillCompletedAt: null, capacityReached: false, stuck: false, lastSuccessAt: input.lastSuccessAt,
      counts, measuredPerHour, estimatedFinishAt: null,
    };
  }
  const capacityReached = row.backfill_issue === 'capacity';
  const discoveryDone = Boolean(row.backfill_completed_at) || capacityReached;
  const open = counts.pending + counts.deferred;
  const phase: KsefHistoryPhase = !discoveryDone
    ? 'searching'
    : open > 0 ? 'downloading' : direction === 'outgoing' ? 'live' : 'done';
  // Termin tylko, gdy jest co pobierać: same odłożone (decyzja klienta przy
  // duplikacie, uzgodnienie wysyłki) nie mają tempa — termin „teraz” byłby
  // nieprawdą (poprawka po przeglądzie, decyzja Bartosza 22.10.2026).
  const estimatedFinishAt = phase === 'downloading' && counts.pending > 0
      && measuredPerHour !== null && measuredPerHour >= 1
    ? new Date(now.getTime() + (counts.pending / measuredPerHour) * 3_600_000).toISOString()
    : null;
  return {
    direction,
    phase,
    enabledAt: row.created_at,
    historyFloor: row.history_floor,
    coveredFrom: row.backfill_completed_at ? row.history_floor : row.backfill_window_end,
    backfillCompletedAt: row.backfill_completed_at,
    capacityReached,
    stuck: recentInternal(row.backfill_issue, row.backfill_issue_at, now)
      || recentInternal(row.live_issue, row.live_issue_at, now),
    lastSuccessAt: input.lastSuccessAt,
    counts,
    measuredPerHour,
    estimatedFinishAt,
  };
}

function itemBase(row: ItemRow): KsefHistoryItemBase {
  const gross = row.gross_amount === null || row.gross_amount === undefined ? null : Number(row.gross_amount);
  return {
    ksefNumber: row.ksef_number,
    direction: row.direction,
    invoiceNumber: row.invoice_number,
    issueDate: row.issue_date,
    counterpartyName: row.counterparty_name,
    grossAmount: gross !== null && Number.isFinite(gross) ? gross : null,
    currency: row.currency,
    localInvoiceId: row.invoice_id,
    updatedAt: row.updated_at,
  };
}

function isBlockedReason(reason: string | null): reason is KsefHistoryBlockedReason {
  return reason !== null && (KSEF_HISTORY_BLOCKED_REASONS as readonly string[]).includes(reason);
}

function isDeferredReason(reason: string | null): reason is KsefHistoryDeferredReason {
  return reason !== null && (DEFERRED_REASONS as readonly string[]).includes(reason);
}

export async function readKsefHistorySyncStatus(
  supabase: SupabaseClient<Database>,
  tenantId: string,
  now: Date = new Date(),
): Promise<KsefHistorySyncRead> {
  const environment = configuredKsefEnvironment();
  if (!environment) return { ok: false };
  const history = asHistoryClient(supabase);
  const rateSince = new Date(now.getTime() - KSEF_HISTORY_RATE_WINDOW_H * 3_600_000).toISOString();

  try {
    const importedSince = (direction: KsefHistoryDirection) => history
      .from('ksef_history_items')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('environment', environment)
      .eq('direction', direction)
      .eq('status', 'imported')
      .gt('resolved_at', rateSince);

    const [streams, counts, blocked, deferred, ratesOut, ratesIn, exportChanges, tenant] = await Promise.all([
      history.from('ksef_history_sync').select(STATUS_STREAM_COLUMNS)
        .eq('tenant_id', tenantId).eq('environment', environment),
      history.from('ksef_history_item_counts').select(STATUS_COUNT_COLUMNS)
        .eq('tenant_id', tenantId).eq('environment', environment),
      history.from('ksef_history_items').select(STATUS_ITEM_COLUMNS)
        .eq('tenant_id', tenantId).eq('environment', environment).eq('status', 'blocked')
        .order('updated_at', { ascending: false }).limit(LIST_LIMIT),
      history.from('ksef_history_items').select(STATUS_ITEM_COLUMNS)
        .eq('tenant_id', tenantId).eq('environment', environment).eq('status', 'deferred')
        .order('updated_at', { ascending: false }).limit(LIST_LIMIT),
      importedSince('outgoing'),
      importedSince('incoming'),
      // Okresy zmienione po eksporcie liczy baza (widok 00155) — dokładnie,
      // bez próbki pozycji, więc przy dużej historii żaden okres nie ginie.
      history.from('ksef_history_export_changes').select(STATUS_EXPORT_CHANGE_COLUMNS)
        .eq('tenant_id', tenantId).eq('environment', environment)
        .order('period', { ascending: false }).limit(PERIODS_LIMIT),
      supabase.from('tenants').select('ksef_certificate_expiry').eq('id', tenantId).maybeSingle(),
    ]);
    if (streams.error || counts.error || blocked.error || deferred.error || ratesOut.error
        || ratesIn.error || exportChanges.error || tenant.error) {
      return { ok: false };
    }

    const streamRows = (streams.data ?? []) as unknown as StreamRow[];
    const countRows = (counts.data ?? []) as unknown as CountRow[];
    const outgoingRow = streamRows.find((r) => r.direction === 'outgoing') ?? null;
    const incomingRow = streamRows.find((r) => r.direction === 'incoming') ?? null;
    const lastSuccessAt = outgoingRow?.last_success_at ?? null;
    const outgoingCounts = countsFor(countRows, 'outgoing');
    const incomingCounts = countsFor(countRows, 'incoming');

    const blockedItems = ((blocked.data ?? []) as unknown as ItemRow[])
      .filter((r) => isBlockedReason(r.reason_code))
      .map((r) => ({ ...itemBase(r), reason: r.reason_code as KsefHistoryBlockedReason }));
    const deferredItems = ((deferred.data ?? []) as unknown as ItemRow[])
      .filter((r) => isDeferredReason(r.reason_code))
      .map((r) => ({ ...itemBase(r), reason: r.reason_code as KsefHistoryDeferredReason }));

    const pausedUntil = outgoingRow?.paused_until ?? null;
    const errorCode = outgoingRow?.last_error_code ?? null;
    const certificateExpiry = (tenant.data as { ksef_certificate_expiry: string | null } | null)?.ksef_certificate_expiry ?? null;
    // `certificate_expired` to stan, nie zdarzenie: pokazujemy go, dopóki
    // certyfikat firmy jest wygasły (albo data nieznana). Po wgraniu nowego
    // zapisany kod czeka na najbliższy przebieg — ekran nie może wtedy mówić
    // „wygasł <przyszła data>” (poprawka po przeglądzie, decyzja Bartosza 22.10.2026).
    const expiryMs = certificateExpiry ? Date.parse(certificateExpiry) : Number.NaN;
    const certificateStillExpired = !Number.isFinite(expiryMs) || expiryMs < now.getTime();
    const showError = errorCode !== null && (errorCode === 'certificate_expired'
      ? certificateStillExpired
      : (outgoingRow?.consecutive_failures ?? 0) > 0);

    return {
      ok: true,
      status: {
        environment,
        outgoing: streamStatus({
          direction: 'outgoing', row: outgoingRow, counts: outgoingCounts, lastSuccessAt,
          importedLastWindow: ratesOut.count ?? 0, now,
        }),
        incoming: streamStatus({
          direction: 'incoming', row: incomingRow, counts: incomingCounts, lastSuccessAt,
          importedLastWindow: ratesIn.count ?? 0, now,
        }),
        rateLimitedUntil: pausedUntil && Date.parse(pausedUntil) > now.getTime() ? pausedUntil : null,
        clientPausedAt: outgoingRow?.client_paused_at ?? null,
        error: showError && errorCode
          ? { code: errorCode, at: outgoingRow?.last_error_at ?? now.toISOString(), certificateExpiry }
          : null,
        blocked: blockedItems,
        blockedTotal: outgoingCounts.blocked + incomingCounts.blocked,
        deferred: deferredItems,
        deferredTotal: outgoingCounts.deferred + incomingCounts.deferred,
        periodsChangedAfterExport: ((exportChanges.data ?? []) as unknown as ExportChangeRow[])
          .map((r) => ({ period: r.period, count: Number(r.item_count) || 0 }))
          .filter((r) => r.count > 0),
      },
    };
  } catch {
    return { ok: false };
  }
}
